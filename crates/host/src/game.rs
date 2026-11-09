use anyhow::{Context, Result};
use deno_core::{FsModuleLoader, JsRuntime, OpState, RuntimeOptions, extension, op2};
use std::{cell::RefCell, fs::File, io::Write, rc::Rc, time::Instant};

pub type Log = Rc<RefCell<File>>;
struct State {
    color: [f64; 4],
    start: Instant,
    log: Log,
}

#[op2(fast)]
fn op_clear(state: &mut OpState, r: f64, g: f64, b: f64, a: f64) {
    state.borrow_mut::<State>().color = [r, g, b, a];
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
extension!(host_ext, ops = [op_clear, op_now, op_log]);

pub struct Game {
    js: JsRuntime,
}
impl Game {
    pub fn new(entry: &str, log: Log, runtime: &tokio::runtime::Runtime) -> Result<Self> {
        let mut js = JsRuntime::new(RuntimeOptions {
            module_loader: Some(Rc::new(FsModuleLoader)),
            extensions: vec![host_ext::init()],
            ..Default::default()
        });
        js.op_state().borrow_mut().put(State {
            color: [0.0, 0.0, 0.0, 1.0],
            start: Instant::now(),
            log,
        });
        js.execute_script("host:bootstrap", include_str!("bootstrap.js"))?;
        let specifier = deno_core::resolve_path(entry, &std::env::current_dir()?)?;
        runtime
            .block_on(async {
                let id = js.load_main_es_module(&specifier).await?;
                let result = js.mod_evaluate(id);
                js.run_event_loop(Default::default()).await?;
                result.await?;
                Ok::<(), anyhow::Error>(())
            })
            .context("load entry module")?;
        Ok(Self { js })
    }
    pub fn event(&mut self, event: &serde_json::Value) -> Result<()> {
        self.js
            .execute_script("host:event", format!("__hostDispatch({event})"))?;
        Ok(())
    }
    pub fn frame(&mut self) -> Result<[f64; 4]> {
        self.js.execute_script("host:frame", "__hostFrame()")?;
        Ok(self.js.op_state().borrow().borrow::<State>().color)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promise_jobs_run_after_frames_and_events() -> Result<()> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let _entered = runtime.enter();
        let log_path = std::env::temp_dir().join(format!("threejsc-jobs-{}.log", std::process::id()));
        let log = Rc::new(RefCell::new(File::create(log_path)?));
        let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/jobs.js");
        let mut game = Game::new(entry, log, &runtime)?;

        game.frame()?;
        assert_eq!(game.frame()?, [0.0, 1.0, 0.0, 1.0]);
        game.event(&serde_json::json!({"type": "keydown"}))?;
        assert_eq!(game.frame()?, [1.0, 0.0, 0.0, 1.0]);
        Ok(())
    }
}
