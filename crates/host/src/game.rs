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
/// opportunity comes once its compositor is ready. `refreshed` is when the render thread last
/// waited for the display to take a frame, a display refresh, in nanoseconds after `epoch`, or 0.
pub struct RenderProgress {
    pub submitted: AtomicU64,
    pub finished: AtomicU64,
    refreshed: AtomicU64,
    epoch: Instant,
}

impl Default for RenderProgress {
    fn default() -> Self {
        Self {
            submitted: AtomicU64::default(),
            finished: AtomicU64::default(),
            refreshed: AtomicU64::default(),
            epoch: Instant::now(),
        }
    }
}

impl RenderProgress {
    /// When the display last took a frame that the render thread waited for, on the page's clock
    /// that starts at `start`, or None.
    fn refreshed(&self, start: Instant) -> Option<f64> {
        let nanos = self.refreshed.load(Ordering::Acquire);
        (nanos > 0).then(|| {
            let at = self.epoch + std::time::Duration::from_nanos(nanos);
            match at.checked_duration_since(start) {
                Some(after) => after.as_secs_f64() * 1000.0,
                None => -(start - at).as_secs_f64() * 1000.0,
            }
        })
    }
    /// Records that the display took a frame at `at`, which the render thread waited for.
    pub fn refreshed_at(&self, at: Instant) {
        let nanos =
            u64::try_from(at.saturating_duration_since(self.epoch).as_nanos()).unwrap_or(u64::MAX);
        self.refreshed.store(nanos.max(1), Ordering::Release);
    }
    fn caught_up(&self) -> bool {
        self.finished.load(Ordering::Acquire) >= self.submitted.load(Ordering::Acquire)
    }
}

/// Whether the render thread has rendered every frame handed to it. A host with no render
/// thread, as in the unit tests, never reports a frame due.
#[op2(fast)]
fn op_frame_due(state: &mut OpState) -> bool {
    state
        .borrow::<State>()
        .render
        .as_ref()
        .is_some_and(|render| render.caught_up())
}

/// The latest display refresh the render thread waited for, in ms on the page's clock, or NaN if
/// it has waited for none, as with vsync off or no render thread.
#[op2(fast)]
fn op_refreshed(state: &mut OpState) -> f64 {
    let state = state.borrow::<State>();
    state
        .render
        .as_ref()
        .and_then(|render| render.refreshed(state.start))
        .unwrap_or(f64::NAN)
}

/// Sleeps until `until` ms on the page's clock or, with `render`, until the render thread has
/// caught up, whichever comes first, and returns true. A host with no render thread, as in the
/// unit tests, returns false at once.
#[op2(fast)]
fn op_wait(state: &mut OpState, until: f64, render: bool) -> bool {
    let state = state.borrow::<State>();
    let Some(progress) = state.render.as_ref() else {
        return false;
    };
    loop {
        if render && progress.caught_up() {
            return true;
        }
        let left = until - state.start.elapsed().as_secs_f64() * 1000.0;
        if left <= 0.0 {
            return true;
        }
        // A sleep can overrun by a millisecond or more, which would make a 5 ms interval miss
        // its point, so the last millisecond yields instead.
        if left > 1.0 {
            std::thread::sleep(std::time::Duration::from_secs_f64(
                (left - 1.0).min(0.25) / 1000.0,
            ));
        } else {
            std::thread::yield_now();
        }
    }
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
        op_refreshed,
        op_wait,
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
    /// Starts each frame no sooner than `ms` after the frame before began its callbacks, as on a
    /// display of that interval, for testing a slower display than the one at hand.
    pub fn set_frame_pacing(&mut self, ms: f64) -> Result<()> {
        self.js
            .execute_script("host:pacing", format!("globalThis.__framePacing = {ms};"))?;
        Ok(())
    }
    /// Lets the frame's turn of timers end once the render thread has caught up with `render`.
    pub fn set_render_progress(&mut self, render: Arc<RenderProgress>) {
        self.js.op_state().borrow_mut().borrow_mut::<State>().render = Some(render);
    }
    /// Sets the display's refresh interval in ms, which ends a frame's turn of timers when no
    /// frame is rendering. An interval outside 24 to 360 Hz is clamped to that range, and one that
    /// is not a positive number, such as a display that reports no rate, gives 60 Hz.
    pub fn set_display_interval(&mut self, ms: f64) -> Result<()> {
        let ms = if ms.is_finite() && ms > 0.0 {
            ms.clamp(1000.0 / 360.0, 1000.0 / 24.0)
        } else {
            1000.0 / 60.0
        };
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
    /// Runs timers as they fall due until the render thread has caught up. The host calls it
    /// after it takes a frame's commands and before it hands the frame to the render thread.
    pub fn idle(&mut self) -> Result<()> {
        self.js.execute_script("host:idle", "__hostIdle()")?;
        self.tick()
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

    /// Held by each test that measures frame and timer timing, so those tests busy-wait one at a
    /// time rather than starving each other of the CPU.
    static TIMING: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn timing() -> std::sync::MutexGuard<'static, ()> {
        TIMING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

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
        run_cycled(name, entry, scene, &[period], None)
    }

    /// Runs `entry` with the gaps between frame starts taken from `periods` in turn, on a display
    /// whose refresh interval is `display` ms or else their mean, until it turns the clear colour
    /// green, and returns its log.
    fn run_cycled(
        name: &str,
        entry: &str,
        scene: Option<&str>,
        periods: &[std::time::Duration],
        display: Option<f64>,
    ) -> Result<String> {
        let _timing = timing();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _entered = runtime.enter();
        let log_path =
            std::env::temp_dir().join(format!("threejsc-{name}-{}.log", std::process::id()));
        let log = Rc::new(RefCell::new(File::create(&log_path)?));
        let mut game = Game::new(entry, log, &runtime, scene, (1280, 720), None)?;
        let mean = periods.iter().sum::<std::time::Duration>() / periods.len() as u32;
        game.set_display_interval(display.unwrap_or(mean.as_secs_f64() * 1000.0))?;
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
    /// its log. Each frame is handed to a render thread once the one before it is rendered. The
    /// render thread presents to a FIFO swapchain of a display that refreshes every `period`, with
    /// two images queued: a frame takes 0.5 ms to render, its present waits until the frame two
    /// before it is on screen, and each frame shows at the first refresh after the one before it.
    fn run_rendered(
        name: &str,
        entry: &str,
        scene: Option<&str>,
        period: std::time::Duration,
    ) -> Result<String> {
        let _timing = timing();
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
        let refresh_at = |at: Instant| {
            let ticks = (at - started).as_nanos().div_ceil(period.as_nanos());
            started + period * u32::try_from(ticks).expect("a short run")
        };
        let mut shown: Vec<Instant> = Vec::new();
        let mut rendering: Option<std::thread::JoinHandle<()>> = None;
        while game.frame()? != [0.0, 1.0, 0.0, 1.0] {
            assert!(
                started.elapsed().as_secs() < 10,
                "{name} never turned green"
            );
            game.idle()?;
            if let Some(previous) = rendering.take() {
                previous.join().expect("the render thread finishes");
            }
            let mut finish = Instant::now() + std::time::Duration::from_micros(500);
            // The render job waits for a swapchain image only while two frames are queued, until
            // the refresh that shows the first of them.
            let mut refresh = None;
            if let Some(&two_before) = shown.len().checked_sub(2).and_then(|i| shown.get(i))
                && two_before > finish
            {
                finish = two_before;
                refresh = Some(two_before);
            }
            let earliest = shown
                .last()
                .map_or(finish, |&last| finish.max(last + period));
            shown.push(refresh_at(earliest));
            progress.submitted.fetch_add(1, Ordering::Release);
            let render = progress.clone();
            rendering = Some(std::thread::spawn(move || {
                std::thread::sleep(finish.saturating_duration_since(Instant::now()));
                if let Some(at) = refresh {
                    render.refreshed_at(at);
                }
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
    fn heavy_frames_leave_loaders_their_share_of_each_frame() -> Result<()> {
        // Eight loops that yield through zero-delay timers and work 1 ms, while each frame
        // callback works 10 or 16 ms, so the render thread has caught up before each turn starts.
        // Edge runs a median of 4 loader ticks a frame, a mean of 3.8 to 4.0 and at most 8 or 9
        // (C:\3jsc\swarm\e3-r18\kit\out\superseded\f5351f3\edge\p1 and p2, game-slowload*), where a turn
        // that runs one timer once the frame is due gives 1. The checks count ticks in the frames
        // the run got, since other work on the PC stalls frames and ticks alike: at least 3 ticks
        // in the median frame, and a mean of no more than Edge's 8, so timers do not take the frames.
        for scene in ["slowload10", "slowload16"] {
            let log = run_rendered(
                &format!("timer-game-rendered-{scene}"),
                concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-game.js"),
                Some(scene),
                std::time::Duration::from_millis(6),
            )?;
            let per_frame = result(&log, &format!("{scene} loader ticks per frame"));
            let stat = |name: &str| -> Result<f64> {
                let field = per_frame
                    .split(' ')
                    .find_map(|field| field.strip_prefix(&format!("{name}=")))
                    .with_context(|| format!("no {name} in {per_frame}"))?;
                Ok(field.parse()?)
            };
            let (median, mean) = (stat("p50")?, stat("mean")?);
            assert!(
                (3.0..=8.0).contains(&median) && mean <= 8.0,
                "{scene}: loader ticks per frame {per_frame}"
            );
        }
        Ok(())
    }

    #[test]
    fn an_interval_keeps_to_its_schedule() -> Result<()> {
        // A 16 ms setInterval that works 1.5 ms, beside 3 ms frame callbacks. Edge ticks 187
        // times in the 3 s window and its last tick runs 1.5 ms after its place on the
        // schedule (C:\3jsc\swarm\e3-r17v\lane-v\kit\out\edge\game-tick16).
        let log = run_rendered(
            "timer-game-rendered-tick16",
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-game.js"),
            Some("tick16"),
            std::time::Duration::from_millis(6),
        )?;
        let ticks: f64 = result(&log, "tick16 ticks").parse()?;
        let drift: f64 = result(&log, "tick16 drift of the last tick ms").parse()?;
        assert!((ticks - 187.0).abs() <= 0.05 * 187.0, "{ticks} ticks");
        assert!(drift < 10.0, "the last tick ran {drift} ms after its place");
        Ok(())
    }

    #[test]
    fn intervals_shorter_than_a_frame_keep_their_schedule() -> Result<()> {
        // A setInterval of 5 or 10 ms that works 0.3 ms, beside 3 ms frame callbacks. Edge runs
        // a 5 ms interval 596 to 599 times in 3 s and its last tick 0.5 to 6.3 ms behind
        // schedule (C:\3jsc\swarm\e3-r18v\lane-v\kit\out). Its timers do not depend on the
        // display, so the schedule is the reference at 166.7 Hz and at 60 Hz alike.
        let mut misses = Vec::new();
        for (scene, every, hz) in [
            ("step5", 5.0, 166.7),
            ("step5", 5.0, 60.0),
            ("step10", 10.0, 60.0),
        ] {
            let log = run_rendered(
                &format!("timer-patterns-rendered-{scene}-{hz}hz"),
                concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-patterns.js"),
                Some(scene),
                std::time::Duration::from_secs_f64(1.0 / hz),
            )?;
            let ticks: f64 = result(&log, &format!("{scene} ticks")).parse()?;
            let behind: f64 = result(
                &log,
                &format!("{scene} behind schedule at the last tick ms"),
            )
            .parse()?;
            let schedule = 3000.0 / every;
            if ticks < 0.95 * schedule || ticks > schedule || behind > 1000.0 / hz + 2.0 {
                misses.push(format!(
                    "{scene} at {hz} Hz: {ticks} ticks, {behind} ms behind"
                ));
            }
        }
        assert!(misses.is_empty(), "{}", misses.join("; "));
        Ok(())
    }

    #[test]
    fn a_late_frame_does_not_start_the_next_before_its_refresh() -> Result<()> {
        // Frame callbacks that work 3 ms, and 9 ms every 30th frame, at 169.9 Hz. Edge begins
        // frames on its display's refresh: after a late frame it begins the next at once, then
        // waits for the refresh, so no refresh begins two frames (C:\3jsc\swarm\e3-r18\kit\out\edge,
        // diag-1 to diag-3 and frame-pacing). A host that begins a frame whenever the render thread
        // is free runs frames ahead after each late one, 3.5 ms apart.
        let period = std::time::Duration::from_secs_f64(1.0 / 169.9);
        let log = run_rendered(
            "frame-pacing-rendered",
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/frame-pacing.js"),
            None,
            period,
        )?;
        let starts: Vec<f64> = result(&log, "frame starts")
            .split(' ')
            .skip(10)
            .map(str::parse)
            .collect::<Result<_, _>>()?;
        let period = period.as_secs_f64() * 1000.0;
        // The refresh grid's phase is not known on the page's clock, so count the refreshes that
        // begin two frames at the phase with the fewest.
        let doubled = (0..200)
            .map(|step| {
                let phase = period * f64::from(step) / 200.0;
                let mut refreshes: Vec<i64> = starts
                    .iter()
                    .map(|start| ((start - phase) / period).floor() as i64)
                    .collect();
                let all = refreshes.len();
                refreshes.dedup();
                all - refreshes.len()
            })
            .min()
            .expect("phases");
        let short: Vec<String> = starts
            .windows(2)
            .filter(|pair| pair[1] - pair[0] < 0.75 * period)
            .map(|pair| format!("{:.2}+{:.2}", pair[0], pair[1] - pair[0]))
            .collect();
        assert_eq!(
            doubled,
            0,
            "refreshes that began two frames, at the best phase; short gaps {}",
            short.join(" ")
        );
        Ok(())
    }

    #[test]
    fn a_forced_frame_rate_paces_frames_and_keeps_intervals_on_schedule() -> Result<()> {
        // THREEJSC_DISPLAY_HZ=60 on a faster display: the host paces frames to 60 Hz, and a 10 ms
        // interval still keeps its schedule of 300 ticks in 3 s.
        let _timing = timing();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let _entered = runtime.enter();
        let log_path = std::env::temp_dir().join(format!(
            "threejsc-timer-patterns-paced-step10-{}.log",
            std::process::id()
        ));
        let log = Rc::new(RefCell::new(File::create(&log_path)?));
        let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-patterns.js");
        let mut game = Game::new(entry, log, &runtime, Some("step10"), (1280, 720), None)?;
        game.set_display_interval(1000.0 / 60.0)?;
        game.set_frame_pacing(1000.0 / 60.0)?;
        let progress = Arc::new(RenderProgress::default());
        game.set_render_progress(progress.clone());
        let started = Instant::now();
        while game.frame()? != [0.0, 1.0, 0.0, 1.0] {
            assert!(
                started.elapsed().as_secs() < 10,
                "step10 never turned green"
            );
            // A render thread that finishes each frame at once, as on a display much faster than
            // 60 Hz.
            game.idle()?;
            progress.submitted.fetch_add(1, Ordering::Release);
            progress.finished.fetch_add(1, Ordering::Release);
        }
        let log = std::fs::read_to_string(log_path)?;
        let frames: f64 = result(&log, "step10 frames inside the window").parse()?;
        let ticks: f64 = result(&log, "step10 ticks").parse()?;
        assert!((171.0..=181.0).contains(&frames), "{frames} frames in 3 s");
        assert!((285.0..=300.0).contains(&ticks), "{ticks} ticks in 3 s");
        Ok(())
    }

    #[test]
    fn overdue_frames_give_timers_their_share_on_average() -> Result<()> {
        // Four loaders that work 1 ms and await zero-delay timers, every tenth an 8 ms one, while
        // each frame callback works a seeded 2 to 14 ms, so the render thread has usually caught
        // up before a turn begins. Edge runs 3.4 loader steps a frame and draws 257 to 261
        // frames in 3 s (C:\3jsc\swarm\e3-r18v\lane-v\SUMMARY.md).
        let log = run_rendered(
            "timer-patterns-rendered-awaitload",
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-patterns.js"),
            Some("awaitload"),
            std::time::Duration::from_micros(5917),
        )?;
        let frames: f64 = result(&log, "awaitload frames inside the window").parse()?;
        // The scenario table holds the host to 97 percent of Edge's frames on the GPU. This
        // harness draws a few frames fewer than the host on this page, so it holds the host to 95
        // percent, still well above the 241 frames before the share averaged.
        assert!(
            frames >= 0.95 * 259.0,
            "{frames} frames, steps per frame {}",
            result(&log, "awaitload steps per frame")
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
        // A 10 ms interval keeps to its schedule, as in Edge: its fifth run comes 50 ms after its
        // first, give or take the two runs' lateness of less than a 6 ms frame each. A gap can be
        // shorter than 10 ms after a late run, as Edge's gaps of 8.6 to 11.4 ms show.
        let gaps: f64 = result(&log, "10 ms interval gaps")
            .split(' ')
            .map(|gap| gap.parse::<f64>().unwrap())
            .sum();
        assert!(
            (44.0..=56.0).contains(&gaps),
            "five 10 ms gaps took {gaps} ms"
        );
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
                None,
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
    fn a_display_interval_out_of_range_is_clamped_to_24_to_360_hz() -> Result<()> {
        // A display that reports 1 Hz would let one turn run for a second: 63 zero-delay timers
        // that each work 1 ms would hold one frame back 63 ms. At the 24 Hz floor a turn ends
        // after 41.7 ms.
        let log = run_cycled(
            "timer-attack-1hz-fanout",
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/timer-attack.js"),
            Some("fanout"),
            &[std::time::Duration::from_millis(6)],
            Some(1000.0),
        )?;
        let gap: f64 = result(&log, "fanout longest frame gap ms").parse()?;
        assert!(gap < 52.0, "a frame waited {gap} ms");
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
