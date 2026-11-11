use anyhow::{Context, Result};
use deno_core::{FsModuleLoader, JsRuntime, OpState, RuntimeOptions, extension, op2};
use std::{
    cell::RefCell, collections::HashMap, fs::File, future::Future, io::Write, pin::Pin, rc::Rc,
    time::Instant,
};

pub type Log = Rc<RefCell<File>>;
struct State {
    color: [f64; 4],
    commands: Option<Vec<u8>>,
    readbacks: HashMap<u32, Vec<u8>>,
    start: Instant,
    log: Log,
}

#[op2(fast)]
fn op_clear(state: &mut OpState, r: f64, g: f64, b: f64, a: f64) {
    state.borrow_mut::<State>().color = [r, g, b, a];
}
#[op2(fast)]
fn op_gpu_submit(state: &mut OpState, #[buffer] bytes: &[u8]) -> bool {
    let state = state.borrow_mut::<State>();
    if state.commands.is_some() {
        return false;
    }
    state.commands = Some(bytes.to_vec());
    true
}
#[op2(fast)]
fn op_gpu_submitted(state: &mut OpState) -> bool {
    state.borrow::<State>().commands.is_some()
}
/// Never completes, so the runtime always has work pending and does not report an entry module
/// that awaits frames or timers as stalled.
#[op2]
async fn op_host_alive() {
    std::future::pending::<()>().await
}
#[op2]
#[arraybuffer]
fn op_gpu_readback(state: &mut OpState, request: u32) -> Vec<u8> {
    state
        .borrow_mut::<State>()
        .readbacks
        .remove(&request)
        .unwrap_or_default()
}
#[op2(fast)]
fn op_now(state: &mut OpState) -> f64 {
    state.borrow::<State>().start.elapsed().as_secs_f64() * 1000.0
}
#[op2(fast)]
fn op_log(state: &mut OpState, #[string] message: &str) {
    let state = state.borrow::<State>();
    let _ = writeln!(state.log.borrow_mut(), "{message}");
    eprintln!("{message}");
}
extension!(
    host_ext,
    ops = [
        op_clear,
        op_gpu_submit,
        op_gpu_submitted,
        op_host_alive,
        op_gpu_readback,
        op_now,
        op_log
    ]
);

/// The entry module's evaluation, which frames keep polling while its top level awaits.
type Evaluation = Pin<Box<dyn Future<Output = Result<(), deno_core::error::CoreError>>>>;
pub struct Game<'a> {
    js: JsRuntime,
    runtime: &'a tokio::runtime::Runtime,
    evaluation: Option<Evaluation>,
}
impl<'a> Game<'a> {
    pub fn new(
        entry: &str,
        log: Log,
        runtime: &'a tokio::runtime::Runtime,
        scene: Option<&str>,
        (width, height): (u32, u32),
        adapter: Option<&wgpu::Limits>,
    ) -> Result<Self> {
        let mut js = JsRuntime::new(RuntimeOptions {
            module_loader: Some(Rc::new(FsModuleLoader)),
            extensions: vec![host_ext::init()],
            ..Default::default()
        });
        js.op_state().borrow_mut().put(State {
            color: [0.0, 0.0, 0.0, 1.0],
            commands: None,
            readbacks: HashMap::new(),
            start: Instant::now(),
            log,
        });
        js.execute_script("host:bootstrap", include_str!("bootstrap.js"))?;
        let scene = serde_json::to_string(&scene)?;
        // NativeBackend checks a device's requested limits against the adapter's, as requestDevice() does.
        let limits = serde_json::to_string(&adapter)?;
        js.execute_script(
            "host:scene",
            format!(
                "globalThis.__sceneName = {scene}; globalThis.__gpuAdapterLimits = {limits}; globalThis.innerWidth = {width}; globalThis.innerHeight = {height};"
            ),
        )?;
        let specifier = deno_core::resolve_path(entry, &std::env::current_dir()?)?;
        // As in a browser, frames and timers run while the module's top level awaits.
        let evaluation = runtime
            .block_on(async {
                let id = js.load_main_es_module(&specifier).await?;
                Ok::<_, anyhow::Error>(js.mod_evaluate(id))
            })
            .context("load entry module")?;
        let mut game = Self {
            js,
            runtime,
            evaluation: Some(Box::pin(evaluation)),
        };
        game.tick().context("load entry module")?;
        Ok(game)
    }
    pub fn event(&mut self, event: &serde_json::Value) -> Result<()> {
        self.js
            .execute_script("host:event", format!("__hostDispatch({event})"))?;
        self.tick()
    }
    /// Dispatches a frame's GPU responses. A readback's bytes stay in the host until the
    /// `gpu-response` dispatch fetches them, so they cross into JavaScript as one ArrayBuffer.
    pub fn gpu_responses(
        &mut self,
        responses: Vec<serde_json::Value>,
        readbacks: HashMap<u32, Vec<u8>>,
    ) -> Result<()> {
        self.js
            .op_state()
            .borrow_mut()
            .borrow_mut::<State>()
            .readbacks = readbacks;
        self.event(&serde_json::json!({"type": "gpu-response", "responses": responses}))
    }
    pub fn frame(&mut self) -> Result<[f64; 4]> {
        self.js.execute_script("host:frame", "__hostFrame()")?;
        self.tick()?;
        Ok(self.js.op_state().borrow().borrow::<State>().color)
    }
    pub fn take_commands(&mut self) -> Option<Vec<u8>> {
        self.js
            .op_state()
            .borrow_mut()
            .borrow_mut::<State>()
            .commands
            .take()
    }
    fn tick(&mut self) -> Result<()> {
        self.runtime.block_on(async {
            tokio::task::yield_now().await;
            std::future::poll_fn(|cx| {
                if let std::task::Poll::Ready(Err(error)) =
                    self.js.poll_event_loop(cx, Default::default())
                {
                    return std::task::Poll::Ready(Err(anyhow::Error::from(error)));
                }
                // An entry module whose evaluation fails ends the host, as a module that fails to
                // load does.
                if let Some(evaluation) = &mut self.evaluation
                    && let std::task::Poll::Ready(result) = evaluation.as_mut().poll(cx)
                {
                    self.evaluation = None;
                    return std::task::Poll::Ready(result.context("evaluate entry module"));
                }
                std::task::Poll::Ready(Ok(()))
            })
            .await?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promise_jobs_run_after_frames_and_events() -> Result<()> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _entered = runtime.enter();
        let log_path =
            std::env::temp_dir().join(format!("threejsc-jobs-{}.log", std::process::id()));
        let log = Rc::new(RefCell::new(File::create(log_path)?));
        let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/jobs.js");
        let mut game = Game::new(entry, log, &runtime, None, (1280, 720), None)?;

        game.frame()?;
        assert_eq!(game.frame()?, [0.0, 1.0, 0.0, 1.0]);
        game.event(&serde_json::json!({"type": "keydown"}))?;
        assert_eq!(
            game.js.op_state().borrow().borrow::<State>().color,
            [1.0, 0.0, 0.0, 1.0]
        );
        game.event(&serde_json::json!({"type": "keyup"}))?;
        assert_eq!(
            game.js.op_state().borrow().borrow::<State>().color,
            [0.0, 0.0, 1.0, 1.0]
        );
        game.event(&serde_json::json!({"type": "asyncop"}))?;
        let mut color = [0.0; 4];
        for _ in 0..4 {
            color = game.frame()?;
        }
        assert_eq!(color, [1.0, 1.0, 0.0, 1.0]);
        Ok(())
    }

    /// Runs `entry` until it turns the clear color green, for at most 10 seconds, and returns its log.
    fn run_until_green(name: &str, entry: &str) -> Result<String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _entered = runtime.enter();
        let log_path =
            std::env::temp_dir().join(format!("threejsc-{name}-{}.log", std::process::id()));
        let log = Rc::new(RefCell::new(File::create(&log_path)?));
        let mut game = Game::new(entry, log, &runtime, None, (1280, 720), None)?;
        let started = Instant::now();
        while game.frame()? != [0.0, 1.0, 0.0, 1.0] {
            assert!(
                started.elapsed().as_secs() < 10,
                "{name} never turned green"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        Ok(std::fs::read_to_string(log_path)?)
    }

    #[test]
    fn timers_run_between_frames_in_edges_order() -> Result<()> {
        // Edge's results for the same page, from C:\3jsc\swarm\e3-r13\kit\out\edge\timers-default.
        let log = run_until_green(
            "timers",
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timers.js"),
        )?;
        for line in [
            "R order: rafA rafA.promise rafA.microtask rafB rafB.promise t1 t2 args(a,b) throws t3 t3.promise t4 t3.nested t3.nested.nested raf-from-timer",
            "R a timer ran inside a frame callback: false",
            "R a 30 ms timer runs no sooner than 30 ms: true",
            "R equal deadlines run in the order they were set: first,second",
            "R an interval cleared on its third run ran: 3",
            "R queueMicrotask is a function: function",
            "R setInterval returns a number: number",
        ] {
            assert!(log.contains(line), "{line}\n{log}");
        }
        assert!(
            log.contains("a timer callback throws"),
            "a timer's error is reported and frames go on\n{log}"
        );
        Ok(())
    }

    #[test]
    fn frames_and_timers_run_while_the_entry_module_awaits() -> Result<()> {
        run_until_green(
            "top-level-await",
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/top-level-await.js"),
        )?;
        Ok(())
    }

    #[test]
    fn bootstrap_provides_window_size_self_and_utf8_decoding() -> Result<()> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _entered = runtime.enter();
        let log_path =
            std::env::temp_dir().join(format!("threejsc-globals-{}.log", std::process::id()));
        let log = Rc::new(RefCell::new(File::create(log_path)?));
        let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/globals.js");
        let mut game = Game::new(entry, log, &runtime, None, (640, 360), None)?;
        assert_eq!(game.frame()?, [1.0, 1.0, 1.0, 1.0]);
        game.event(&serde_json::json!({"type": "resize", "width": 800, "height": 600}))?;
        assert_eq!(game.frame()?, [0.0, 0.0, 0.0, 0.5]);
        Ok(())
    }

    #[test]
    fn readbacks_reach_javascript_as_array_buffers() -> Result<()> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _entered = runtime.enter();
        let log_path =
            std::env::temp_dir().join(format!("threejsc-readback-{}.log", std::process::id()));
        let log = Rc::new(RefCell::new(File::create(log_path)?));
        let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/readback.js");
        let mut game = Game::new(entry, log, &runtime, None, (1280, 720), None)?;
        let started = Instant::now();
        game.gpu_responses(
            vec![serde_json::json!({"type": "readback", "request": 5})],
            HashMap::from([(5, vec![7; 1280 * 720 * 4])]),
        )?;
        println!("1280x720 readback dispatch took {:?}", started.elapsed());
        assert_eq!(
            game.js.op_state().borrow().borrow::<State>().color,
            [0.0, 1.0, 0.0, 1.0]
        );
        assert!(
            game.js
                .op_state()
                .borrow()
                .borrow::<State>()
                .readbacks
                .is_empty()
        );
        Ok(())
    }

    #[test]
    fn example_scenes_load_and_submit_frames() -> Result<()> {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let built = std::process::Command::new("node")
            .current_dir(root)
            .arg("tools/scenes/build.mjs")
            .status()?;
        assert!(built.success(), "scene bundle build failed");
        let names = std::fs::read_to_string(format!("{root}/examples/scenes/src/names.js"))?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _entered = runtime.enter();
        for scene in names.split('\'').skip(1).step_by(2) {
            let log_path = std::env::temp_dir()
                .join(format!("threejsc-scene-{scene}-{}.log", std::process::id()));
            let log = Rc::new(RefCell::new(File::create(&log_path)?));
            let entry = format!("{root}/examples/scenes/index.js");
            let mut game = Game::new(&entry, log, &runtime, Some(scene), (1280, 720), None)?;
            let mut submitted = 0;
            for _ in 0..4 {
                game.frame()?;
                submitted += usize::from(game.take_commands().is_some());
            }
            let output = std::fs::read_to_string(&log_path)?;
            assert_eq!(submitted, 4, "{scene}: {output}");
            assert!(!output.contains("Error"), "{scene}: {output}");
        }
        Ok(())
    }

    #[test]
    fn pending_ops_do_not_block_frames_and_resume_when_ready() -> Result<()> {
        use std::{
            cell::Cell,
            task::{Poll, Waker},
        };

        struct ReadGate {
            ready: Cell<bool>,
            waker: RefCell<Option<Waker>>,
        }
        impl deno_core::Resource for ReadGate {
            fn read(self: Rc<Self>, _limit: usize) -> deno_core::AsyncResult<deno_core::BufView> {
                Box::pin(std::future::poll_fn(move |cx| {
                    if self.ready.get() {
                        Poll::Ready(Ok(Vec::new().into()))
                    } else {
                        *self.waker.borrow_mut() = Some(cx.waker().clone());
                        Poll::Pending
                    }
                }))
            }
        }

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _entered = runtime.enter();
        let log_path =
            std::env::temp_dir().join(format!("threejsc-ops-{}.log", std::process::id()));
        let log = Rc::new(RefCell::new(File::create(log_path)?));
        let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/jobs.js");
        let mut game = Game::new(entry, log, &runtime, None, (1280, 720), None)?;
        let gate = Rc::new(ReadGate {
            ready: Cell::new(false),
            waker: RefCell::new(None),
        });
        let rid = game
            .js
            .op_state()
            .borrow_mut()
            .resource_table
            .add_rc(gate.clone());
        game.js.execute_script("test:pending", format!(
            "requestAnimationFrame(() => Deno.core.read({rid}, new Uint8Array(1)).then(() => setClearColor(1, 0, 1)))"
        ))?;
        game.frame()?;
        game.frame()?;
        assert!(gate.waker.borrow().is_some());
        gate.ready.set(true);
        gate.waker.borrow_mut().take().unwrap().wake();
        let mut color = [0.0; 4];
        for _ in 0..4 {
            color = game.frame()?;
        }
        assert_eq!(color, [1.0, 0.0, 1.0, 1.0]);
        Ok(())
    }
}
