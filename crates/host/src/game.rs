use anyhow::{Context, Result};
use deno_core::{FsModuleLoader, JsRuntime, OpState, RuntimeOptions, extension, op2};
use std::{
    cell::RefCell,
    collections::HashMap,
    fs::File,
    future::Future,
    io::Write,
    pin::Pin,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

pub type Log = Rc<RefCell<File>>;
struct State {
    color: [f64; 4],
    commands: Option<Vec<u8>>,
    readbacks: HashMap<u32, Vec<u8>>,
    start: Instant,
    log: Log,
    render: Option<Arc<RenderProgress>>,
}

/// How many frames the game thread has handed to the render thread, and how many it has
/// rendered. The next frame is due once the render thread has caught up, as a browser's rendering
/// opportunity comes once its compositor is ready.
#[derive(Default)]
pub struct RenderProgress {
    pub submitted: AtomicU64,
    pub finished: AtomicU64,
}

/// Whether the render thread has rendered every frame handed to it. A host with no render
/// thread, as in the unit tests, never reports a frame due.
#[op2(fast)]
fn op_frame_due(state: &mut OpState) -> bool {
    state
        .borrow::<State>()
        .render
        .as_ref()
        .is_some_and(|render| {
            render.finished.load(Ordering::Acquire) >= render.submitted.load(Ordering::Acquire)
        })
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
        op_frame_due,
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
            render: None,
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
    /// Lets the frame's turn of timers end once the render thread has caught up with `render`.
    pub fn set_render_progress(&mut self, render: Arc<RenderProgress>) {
        self.js.op_state().borrow_mut().borrow_mut::<State>().render = Some(render);
    }
    /// Sets the display's refresh interval, which ends a frame's turn of timers.
    pub fn set_display_interval(&mut self, ms: f64) -> Result<()> {
        self.js.execute_script(
            "host:display",
            format!("globalThis.__displayInterval = {ms};"),
        )?;
        Ok(())
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

    /// Runs `entry` in `scene` until it turns the clear color green, for at most 10 seconds, and
    /// returns its log.
    fn run_until_green(name: &str, entry: &str, scene: Option<&str>) -> Result<String> {
        run_paced(name, entry, scene, std::time::Duration::from_millis(1))
    }

    /// Runs `entry` a frame every `period`, as a display's refresh paces them, until it turns
    /// the clear colour green, and returns its log.
    fn run_paced(
        name: &str,
        entry: &str,
        scene: Option<&str>,
        period: std::time::Duration,
    ) -> Result<String> {
        run_cycled(name, entry, scene, &[period])
    }

    /// Runs `entry` with the gaps between frame starts taken from `periods` in turn, on a display
    /// whose refresh interval is their mean, until it turns the clear colour green, and returns
    /// its log.
    fn run_cycled(
        name: &str,
        entry: &str,
        scene: Option<&str>,
        periods: &[std::time::Duration],
    ) -> Result<String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _entered = runtime.enter();
        let log_path =
            std::env::temp_dir().join(format!("threejsc-{name}-{}.log", std::process::id()));
        let log = Rc::new(RefCell::new(File::create(&log_path)?));
        let mut game = Game::new(entry, log, &runtime, scene, (1280, 720), None)?;
        let display = periods.iter().sum::<std::time::Duration>() / periods.len() as u32;
        game.set_display_interval(display.as_secs_f64() * 1000.0)?;
        let started = Instant::now();
        let mut next = started;
        let mut periods = periods.iter().cycle();
        while game.frame()? != [0.0, 1.0, 0.0, 1.0] {
            assert!(
                started.elapsed().as_secs() < 10,
                "{name} never turned green"
            );
            next += *periods.next().expect("at least one period");
            std::thread::sleep(next.saturating_duration_since(Instant::now()));
        }
        Ok(std::fs::read_to_string(log_path)?)
    }

    /// Runs `entry` as the host's loop does, until it turns the clear colour green, and returns
    /// its log. Each frame is handed to a render thread once the one before it is rendered, and
    /// a frame finishes rendering at the first tick of a display that refreshes every `period`.
    fn run_rendered(
        name: &str,
        entry: &str,
        scene: Option<&str>,
        period: std::time::Duration,
    ) -> Result<String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _entered = runtime.enter();
        let log_path =
            std::env::temp_dir().join(format!("threejsc-{name}-{}.log", std::process::id()));
        let log = Rc::new(RefCell::new(File::create(&log_path)?));
        let mut game = Game::new(entry, log, &runtime, scene, (1280, 720), None)?;
        game.set_display_interval(period.as_secs_f64() * 1000.0)?;
        let progress = Arc::new(RenderProgress::default());
        game.set_render_progress(progress.clone());
        let started = Instant::now();
        let mut rendering: Option<std::thread::JoinHandle<()>> = None;
        while game.frame()? != [0.0, 1.0, 0.0, 1.0] {
            assert!(
                started.elapsed().as_secs() < 10,
                "{name} never turned green"
            );
            if let Some(previous) = rendering.take() {
                previous.join().expect("the render thread finishes");
            }
            let ticks = started.elapsed().as_nanos() / period.as_nanos() + 1;
            let vsync = started + period * u32::try_from(ticks)?;
            progress.submitted.fetch_add(1, Ordering::Release);
            let render = progress.clone();
            rendering = Some(std::thread::spawn(move || {
                std::thread::sleep(vsync.saturating_duration_since(Instant::now()));
                render.finished.fetch_add(1, Ordering::Release);
            }));
        }
        Ok(std::fs::read_to_string(log_path)?)
    }

    #[test]
    fn a_timer_backlog_runs_while_the_frame_before_renders() -> Result<()> {
        // Eight loops that yield through zero-delay timers and work 1 ms, while each frame
        // callback works 3 ms. Edge draws 211 frames in the window at 169 Hz, 7.08 ms apart
        // (C:\3jsc\swarm\e3-r16v\lane-v\kit\out\edge\deadline-loaders), where a turn that
        // takes a whole refresh before the frame callbacks draws 165.
        let log = run_rendered(
            "timer-deadline-rendered-loaders",
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-deadline.js"),
            Some("loaders"),
            std::time::Duration::from_millis(6),
        )?;
        let frames: f64 = result(&log, "loaders frames inside the 1500 ms window").parse()?;
        assert!(
            frames >= 0.95 * 211.0 * 5.92 / 6.0,
            "{frames} frames, {} ms apart",
            result(&log, "loaders mean frame interval ms")
        );
        Ok(())
    }

    #[test]
    fn timers_run_between_frames_in_edges_order() -> Result<()> {
        // Edge's results for the same page, from C:\3jsc\swarm\e3-r13\kit\out\edge\timers-default.
        let log = run_until_green(
            "timers",
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timers.js"),
            None,
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

    /// The timer page's log, a frame every 6 ms. Lane T's host ran this page a frame every
    /// 5.9 ms (median), and headless Edge's order puts its frames 4 to 8 ms apart: frame 10 comes
    /// after the 20 ms interval's first run and before its second.
    fn timer_rules(scene: &str) -> Result<String> {
        run_paced(
            &format!("timer-rules-{scene}"),
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-rules.js"),
            Some(scene),
            std::time::Duration::from_millis(6),
        )
    }

    /// The `R <name>: <value>` result `name` that `log` holds.
    fn result<'a>(log: &'a str, name: &str) -> &'a str {
        let prefix = format!("R {name}: ");
        log.lines()
            .find_map(|line| line.strip_prefix(&prefix))
            .unwrap_or_else(|| panic!("no result {name}\n{log}"))
    }

    #[test]
    fn timer_rules_match_edges_order_conversions_and_error_event() -> Result<()> {
        // Edge's results for the same page, from
        // C:\3jsc\swarm\e3-r14v\lane-t\out\edge\timers-default\console.txt.
        let log = timer_rules("default")?;
        assert_eq!(
            result(&log, "order"),
            "rafA rafA.promise rafA.microtask rafB rafB.promise d0 e1 e2 e3 args(1,x,null,undefined) \
             string-handler throws iv1(p) fromPromise fromRafB iv2(p) iv3(p) raf-from-rafA crossInterval1 \
             frame10 never-early-1 never-early-4 never-early-16 never-early-30 never-early-100",
            "a pending timer cleared by its id as a string never runs"
        );
        assert_eq!(result(&log, "timing order"), "d1 d4 d16");
        assert_eq!(result(&log, "early"), "none");
        // Levels 2 to 6 of a zero-delay chain run in one turn and level 7 waits at least 4 ms,
        // as in Edge. Level 1, set in a frame callback, runs at the next frame's turn, where Edge
        // runs it as soon as the frame ends: one frame later at most.
        let gaps: Vec<(u32, f64)> = result(&log, "chain gaps")
            .split(' ')
            .map(|item| {
                let (level, gap) = item.split_once(':').unwrap();
                (level.parse().unwrap(), gap.parse().unwrap())
            })
            .collect();
        for (level, gap) in gaps {
            assert!(
                (level >= 7) == (gap >= 3.5) || level == 1,
                "chain level {level} waited {gap} ms"
            );
        }
        assert_eq!(result(&log, "10 ms interval early"), "false");
        assert_eq!(result(&log, "window error events"), "1");
        // WebIDL converts a delay to a long: Infinity, 2^31, -5 and NaN wait 0 ms, and 2^32 + 5
        // waits 5 ms, so all seven run.
        let odd = result(&log, "odd delays that ran within 900 ms");
        let names: Vec<_> = odd
            .split(' ')
            .map(|item| item.split('@').next().unwrap())
            .collect();
        for name in ["Infinity", "2^31", "2^32+5", "-5", "'7'", "NaN", "4.9"] {
            assert!(names.contains(&name), "{name} never ran: {odd}");
        }
        Ok(())
    }

    #[test]
    fn busy_timers_leave_frames_their_rate_as_in_edge() -> Result<()> {
        // Edge runs the busy timer once a frame, 124 ticks in 125 frames, and the two busy
        // intervals each once a frame, 249 ticks in 125 frames.
        for (scene, ticks_per_frame) in [("busy", 1), ("busy2", 2)] {
            let log = timer_rules(scene)?;
            let ticks: usize = result(&log, &format!("{scene} timer ticks in 1500 ms")).parse()?;
            let frames: usize =
                result(&log, &format!("{scene} frames inside the 1500 ms window")).parse()?;
            assert!(
                frames + 2 >= ticks / ticks_per_frame,
                "{scene}: {frames} frames for {ticks} ticks"
            );
        }
        Ok(())
    }

    /// The attack page's log, a frame every 6 ms as for the timer page.
    fn timer_attack(scene: &str) -> Result<String> {
        run_paced(
            &format!("timer-attack-{scene}"),
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-attack.js"),
            Some(scene),
            std::time::Duration::from_millis(6),
        )
    }

    #[test]
    fn timers_from_promise_jobs_keep_their_nesting_and_leave_frames_their_rate() -> Result<()> {
        // Edge draws 253 or 254 frames in each window and clamps from tick 7, from
        // C:\3jsc\swarm\e3-r15v\lane-v\kit\out\edge\attack-*\console.txt.
        for scene in ["promise0", "promisethen", "microtask"] {
            let log = timer_attack(scene)?;
            let frames: usize =
                result(&log, &format!("{scene} frames inside the 1500 ms window")).parse()?;
            assert!(frames >= 150, "{scene}: {frames} frames in 1.5 s");
            assert_eq!(
                result(&log, &format!("{scene} first tick whose gap >= 3.5 ms")),
                "7",
                "{scene}"
            );
        }
        // The chain from a frame callback is left to the GPU runs: its first timer waits for the next frame's turn,
        // which this test's 6 ms sleep after each frame turns into a clamp-sized gap.
        let log = timer_attack("deep")?;
        for (chain, level) in [("timer", "7"), ("interval", "2"), ("then", "2")] {
            assert_eq!(
                result(
                    &log,
                    &format!("{chain} chain first level whose gap >= 3.5 ms")
                ),
                level,
                "{chain} chain"
            );
        }
        Ok(())
    }

    #[test]
    fn a_turn_of_timers_ends_when_the_next_frame_is_due() -> Result<()> {
        // 63 zero-delay timers that each work 1 ms would hold a frame back 63 ms in one turn.
        let log = timer_attack("fanout")?;
        let gap: f64 = result(&log, "fanout longest frame gap ms").parse()?;
        assert!(gap < 20.0, "a frame waited {gap} ms");
        assert_eq!(result(&log, "fanout ticks in 1500 ms"), "63");
        Ok(())
    }

    /// The deadline page's log, a frame every 6 ms.
    fn timer_deadline(scene: &str) -> Result<String> {
        run_paced(
            &format!("timer-deadline-{scene}"),
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-deadline.js"),
            Some(scene),
            std::time::Duration::from_millis(6),
        )
    }

    #[test]
    fn thousands_of_due_timers_drain_within_twice_edges_time_at_the_frame_rate() -> Result<()> {
        // Edge runs 10,000 zero-delay timers set at once in 39 ms and 100,000 in 340 ms, at its
        // frame rate (C:\3jsc\swarm\e3-r16v\lane-v\kit\out\edge\deadline-many*).
        for (scene, edge_ms) in [("many10k", 39.0), ("many100k", 340.0)] {
            let log = timer_deadline(scene)?;
            let done = result(&log, &format!("{scene} ms until every timer ran"));
            let ms: f64 = done
                .parse()
                .map_err(|_| anyhow::anyhow!("{scene}: {done}"))?;
            assert!(
                ms <= 2.0 * edge_ms,
                "{scene}: every timer ran after {ms} ms"
            );
            let interval: f64 = result(&log, &format!("{scene} mean frame interval ms")).parse()?;
            assert!(interval <= 7.5, "{scene}: frames {interval} ms apart");
        }
        Ok(())
    }

    #[test]
    fn a_turn_keeps_its_zero_delay_timers_when_frames_arrive_unevenly() -> Result<()> {
        // The host's game thread starts some frames 0.5 ms after the last, when it catches up
        // after a late one (C:\3jsc\swarm\e3-r15\kit\out\runs\head\attack-rearm0\frames.csv).
        // Those starts must not cut a turn short: Edge runs a zero-delay chain's first 6 ticks
        // together and clamps from tick 7.
        let periods = [
            std::time::Duration::from_micros(500),
            std::time::Duration::from_micros(11_500),
        ];
        for scene in ["rearm0", "promise0"] {
            let log = run_cycled(
                &format!("timer-attack-uneven-{scene}"),
                concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-attack.js"),
                Some(scene),
                &periods,
            )?;
            assert_eq!(
                result(&log, &format!("{scene} first tick whose gap >= 3.5 ms")),
                "7",
                "{scene}: {}",
                result(&log, &format!("{scene} first tick gaps"))
            );
        }
        Ok(())
    }

    #[test]
    fn errors_report_and_dom_exceptions_take_edges_shape() -> Result<()> {
        // Edge's lines, from C:\3jsc\swarm\e3-r15v\lane-v\kit\out\edge\attack-cancel and domex-domex.
        let log = timer_attack("cancel")?;
        for (index, line) in [
            "timer, listener cancels: ErrorEvent type=error message=\"Uncaught Error: lane-v timer throws, canceled\" errorIsThrown=true cancelable=true filename=string lineno=number",
            "rAF, listener cancels: ErrorEvent type=error message=\"Uncaught Error: lane-v rAF throws, canceled\" errorIsThrown=true cancelable=true filename=string lineno=number",
            "timer, onerror returns true: onerror args=string,string,number,number,true",
            "timer, listener throws: ErrorEvent type=error message=\"Uncaught Error: lane-v timer throws, not canceled\" errorIsThrown=true cancelable=true filename=string lineno=number",
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(result(&log, &format!("event {index}")), *line);
        }
        let log = timer_attack("domex")?;
        assert_eq!(
            result(&log, "domex"),
            "name=OperationError ownName=false code=0 abort=20 default=Error/0 tag=[object DOMException] string=OperationError: m instanceofError=true"
        );
        Ok(())
    }

    #[test]
    fn frames_and_timers_run_while_the_entry_module_awaits() -> Result<()> {
        run_until_green(
            "top-level-await",
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/top-level-await.js"),
            None,
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
