//! xproc-game (spike 1b): the game process. V8 (latest deno_core) runs the game logic, wgpu 30
//! on DX12 renders, and the HUD comes from a separate `ui-host` process (Servo + ANGLE) through
//! shared D3D11 textures this process opens on its own D3D12 device.
//!
//! - Textures: ui-host creates a ring of NT-handle shared textures; this process (the parent,
//!   holding the child's process handle) duplicates each handle into its own table and opens it
//!   with `ID3D12Device::OpenSharedHandle`.
//! - Sync: this process creates two shared D3D12 fences and duplicates them into ui-host.
//!   `ready`: ui-host signals it (D3D11) after copying a frame into a slot. `done`: this process
//!   signals the frame number after each submit, so ui-host knows when a slot is free again.
//! - IPC: two one-way named pipes (see `proto.rs`).
//!
//! Usage: xproc-game [--frames N] [--novsync] [--sync poll|gpuwait] [--no-ui]
//!                   [--kill-ui-at FRAME] [--relaunch-delay-ms MS] [--ring N]

#[path = "../../proto.rs"]
mod proto;

use std::{
    borrow::Cow,
    fs::File,
    io::BufReader,
    os::windows::io::{AsRawHandle, FromRawHandle},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use deno_core::{JsRuntime, OpState, RuntimeOptions, extension, op2};
use proto::Msg;
use windows::{
    Win32::{
        Foundation::{
            CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, FILETIME, GENERIC_ALL, HANDLE,
        },
        Graphics::Direct3D12::{
            D3D12_FENCE_FLAG_SHARED, ID3D12CommandQueue, ID3D12Device, ID3D12Fence, ID3D12Resource,
        },
        Storage::FileSystem::{PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND},
        System::{
            Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT},
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{GetCurrentProcess, GetProcessTimes},
        },
    },
    core::{HSTRING, PCWSTR},
};
use winit::{
    application::ApplicationHandler,
    dpi::PhysicalSize,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    window::Window,
};

// ── JS bridge ops ───────────────────────────────────────────────────────────

#[derive(Default)]
struct BridgeState {
    outgoing_patch: Option<String>,
    incoming: Vec<String>,
}

#[op2(fast)]
fn op_send_patch(state: &mut OpState, #[string] patch: String) {
    state.borrow_mut::<BridgeState>().outgoing_patch = Some(patch);
}

#[op2]
#[string]
fn op_take_events(state: &mut OpState) -> String {
    let incoming = std::mem::take(&mut state.borrow_mut::<BridgeState>().incoming);
    format!("[{}]", incoming.join(","))
}

extension!(
    bridge_ext,
    ops = [op_send_patch, op_take_events],
    state = |state| {
        state.put(BridgeState::default());
    }
);

const GAME_JS: &str = r#"
let hp = 100;
let clicks = 0;
globalThis.tick = (frame) => {
  for (const event of JSON.parse(Deno.core.ops.op_take_events()).flat()) {
    if (event.type === "click") clicks++;
  }
  if (frame % 6 === 0) hp = hp > 0 ? hp - 1 : 100;
  Deno.core.ops.op_send_patch(JSON.stringify({ seq: frame, hp }));
};
"#;

// ── Stats ───────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Samples(Vec<f64>);

impl Samples {
    fn push_ms(&mut self, ms: f64) {
        self.0.push(ms);
    }
    fn push(&mut self, d: Duration) {
        self.push_ms(d.as_secs_f64() * 1000.0);
    }
    fn summary(&self) -> String {
        if self.0.is_empty() {
            return "n=0".into();
        }
        let mut v = self.0.clone();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let pct = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
        format!(
            "n={} avg={:.3} p50={:.3} p95={:.3} max={:.3}",
            v.len(),
            v.iter().sum::<f64>() / v.len() as f64,
            pct(0.5),
            pct(0.95),
            pct(1.0)
        )
    }
}

#[derive(Default)]
struct Stats {
    frame_interval: Samples,
    frame_cpu: Samples,
    drain: Samples,
    js_tick: Samples,
    pick: Samples,
    render: Samples,
    rtt_ms: Samples,
    rtt_frames: Samples,
    pixel_ms: Samples,
    pixel_frames: Samples,
    ready_wait_frames: Samples,
    picks: u64,
    frames_with_ui: u64,
    frames_without_ui: u64,
    ui_disconnects: u64,
}

const RING: usize = 1 << 16;

// ── UI process link ─────────────────────────────────────────────────────────

enum Inbound {
    Msg(Msg),
    Disconnected,
}

struct UiSlot {
    texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
}

struct Published {
    slot: usize,
    pub_id: u64,
    ready_value: u64,
    arrived_frame: u64,
}

struct UiLink {
    generation: u32,
    child: Child,
    tx: mpsc::Sender<Msg>,
    rx: mpsc::Receiver<Inbound>,
    slots: Vec<UiSlot>,
    published: Vec<Published>,
    current: Option<(usize, u64)>,
    pending_wait: Option<u64>,
    spawned_at: Instant,
    spawned_frame: u64,
    slots_at: Option<Duration>,
    first_ready_at: Option<Duration>,
    first_pick_at: Option<Duration>,
    startup_max_interval_ms: f64,
    startup_frames: u64,
}

impl UiLink {
    fn child_handle(&self) -> HANDLE {
        HANDLE(self.child.as_raw_handle())
    }
}

struct D3d {
    device: ID3D12Device,
    queue: ID3D12CommandQueue,
    ready: ID3D12Fence,
    done: ID3D12Fence,
    ready_handle: HANDLE,
    done_handle: HANDLE,
    max_ready_announced: u64,
    luid: (i32, u32),
}

fn create_pipe(name: &str, outbound: bool) -> usize {
    let access = if outbound { PIPE_ACCESS_OUTBOUND } else { PIPE_ACCESS_INBOUND };
    // SAFETY: plain CreateNamedPipeW; the handle is moved into a File once connected.
    let handle = unsafe {
        CreateNamedPipeW(
            &HSTRING::from(name),
            access,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            1 << 16,
            1 << 16,
            0,
            None,
        )
    };
    assert!(!handle.is_invalid(), "CreateNamedPipeW {name}");
    handle.0 as usize
}

fn connect(raw: usize) -> File {
    // SAFETY: `raw` is a pipe server handle we created; ERROR_PIPE_CONNECTED (client won the
    // race) is fine, any real failure surfaces as an I/O error on first use.
    unsafe {
        let _ = ConnectNamedPipe(HANDLE(raw as *mut _), None);
        File::from_raw_handle(raw as *mut _)
    }
}

/// Duplicate one of our handles into `child`; returns the value valid in the child.
fn dup_into(child: HANDLE, handle: HANDLE) -> u64 {
    let mut out = HANDLE::default();
    // SAFETY: both process handles are valid; out receives the duplicated handle.
    unsafe {
        DuplicateHandle(GetCurrentProcess(), handle, child, &mut out, 0, false, DUPLICATE_SAME_ACCESS)
    }
    .expect("DuplicateHandle into ui-host");
    out.0 as u64
}

/// Duplicate a handle value from `child`'s table into ours.
fn dup_from(child: HANDLE, value: u64) -> HANDLE {
    let mut out = HANDLE::default();
    // SAFETY: the parent holds PROCESS_ALL_ACCESS on the child it spawned.
    unsafe {
        DuplicateHandle(child, HANDLE(value as *mut _), GetCurrentProcess(), &mut out, 0, false, DUPLICATE_SAME_ACCESS)
    }
    .expect("DuplicateHandle from ui-host");
    out
}

fn spawn_ui(d3d: &mut D3d, generation: u32, size: PhysicalSize<u32>, options: &Options, frame: u64) -> UiLink {
    let name = format!(r"\\.\pipe\xproc-{}-{generation}", std::process::id());
    let down = create_pipe(&format!("{name}-down"), true);
    let up = create_pipe(&format!("{name}-up"), false);
    let exe = std::env::current_exe().unwrap().with_file_name("ui-host.exe");
    let log = File::create(std::env::temp_dir().join(format!("xproc-ui-host-{generation}.log"))).unwrap();
    let child = Command::new(exe)
        .args([
            "--pipe",
            &name,
            "--luid",
            &format!("{}:{}", d3d.luid.0, d3d.luid.1),
            "--size",
            &format!("{}x{}", size.width, size.height),
            "--hud",
            &options.hud,
            "--ring",
            &options.ring.to_string(),
        ])
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .expect("spawn ui-host");
    let child_handle = HANDLE(child.as_raw_handle());
    // SAFETY: plain fence query.
    let completed = unsafe { d3d.ready.GetCompletedValue() };
    let ready_base = completed.max(d3d.max_ready_announced) + 1;
    let hello = Msg::Hello {
        ready_fence: dup_into(child_handle, d3d.ready_handle),
        done_fence: dup_into(child_handle, d3d.done_handle),
        ready_base,
        width: size.width,
        height: size.height,
    };

    let (tx, out_rx) = mpsc::channel::<Msg>();
    tx.send(hello).unwrap();
    std::thread::spawn(move || {
        let mut pipe = connect(down);
        while let Ok(msg) = out_rx.recv() {
            if proto::write_msg(&mut pipe, &msg).is_err() {
                break;
            }
        }
    });
    let (in_tx, rx) = mpsc::channel::<Inbound>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(connect(up));
        loop {
            match proto::read_msg(&mut reader) {
                Ok(msg) => {
                    if in_tx.send(Inbound::Msg(msg)).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = in_tx.send(Inbound::Disconnected);
                    break;
                }
            }
        }
    });

    UiLink {
        generation,
        child,
        tx,
        rx,
        slots: Vec::new(),
        published: Vec::new(),
        current: None,
        pending_wait: None,
        spawned_at: Instant::now(),
        spawned_frame: frame,
        slots_at: None,
        first_ready_at: None,
        first_pick_at: None,
        startup_max_interval_ms: 0.0,
        startup_frames: 0,
    }
}

// ── App ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
enum SyncMode {
    Poll,
    GpuWait,
}

struct Options {
    frames: u64,
    novsync: bool,
    sync: SyncMode,
    no_ui: bool,
    kill_ui_at: Option<u64>,
    relaunch_delay: Duration,
    ring: usize,
    hud: String,
    /// `--patch-hz N`: send at most N bridge patches per second (default: every frame).
    patch_interval: Option<Duration>,
}

enum App {
    Initial(Options),
    Running(Box<AppState>),
    Done,
}

struct Probe {
    buffer: wgpu::Buffer,
    state: Arc<AtomicU8>, // 0 idle, 1 mapping, 2 mapped
    frame: u64,
}

struct AppState {
    window: Arc<Window>,
    renderer: Renderer,
    d3d: D3d,
    js: JsRuntime,
    ui: Option<UiLink>,
    next_generation: u32,
    relaunch_at: Option<Instant>,
    frame: u64,
    send_times: Vec<Option<Instant>>,
    submit_times: Vec<Option<Instant>>,
    probes: Vec<Probe>,
    next_probe: usize,
    last_seen_seq: u64,
    killed_at: Option<(Instant, u64)>,
    kill_window_max_interval_ms: f64,
    startups: Vec<String>,
    stats: Stats,
    started: Instant,
    last_frame_at: Option<Instant>,
    options: Options,
    probed_colors: bool,
    js_inbox: Vec<String>,
    last_patch_at: Option<Instant>,
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let default_hud = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("ui-host")
        .join("hud.html")
        .canonicalize()?
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string();
    let options = Options {
        frames: arg(&args, "--frames").and_then(|s| s.parse().ok()).unwrap_or(1200),
        novsync: args.iter().any(|a| a == "--novsync"),
        sync: match arg(&args, "--sync").as_deref() {
            Some("gpuwait") => SyncMode::GpuWait,
            _ => SyncMode::Poll,
        },
        no_ui: args.iter().any(|a| a == "--no-ui"),
        kill_ui_at: arg(&args, "--kill-ui-at").and_then(|s| s.parse().ok()),
        relaunch_delay: Duration::from_millis(
            arg(&args, "--relaunch-delay-ms").and_then(|s| s.parse().ok()).unwrap_or(500),
        ),
        ring: arg(&args, "--ring").and_then(|s| s.parse().ok()).unwrap_or(3),
        patch_interval: arg(&args, "--patch-hz")
            .and_then(|s| s.parse::<f64>().ok())
            .map(|hz| Duration::from_secs_f64(1.0 / hz)),
        hud: arg(&args, "--hud").unwrap_or(default_hud),
    };
    // deno_core 0.413 needs a tokio runtime context for V8's delayed tasks (0.398 did not);
    // without it the process aborts on the first delayed task.
    let tokio = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let _tokio = tokio.enter();
    let event_loop = EventLoop::new()?;
    let mut app = App::Initial(options);
    event_loop.run_app(&mut app)?;
    Ok(())
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let App::Initial(options) = std::mem::replace(self, App::Done) else {
            return;
        };
        let started = Instant::now();
        let window = Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes()
                        .with_title("xproc-game")
                        .with_inner_size(PhysicalSize::new(1920u32, 1080u32)),
                )
                .expect("create window"),
        );
        let renderer =
            pollster::block_on(Renderer::new(window.clone(), options.novsync)).expect("renderer");

        // SAFETY: the device/queue are DX12 (forced in Renderer::new); fences are new objects.
        let d3d = unsafe {
            let device: ID3D12Device = renderer
                .device
                .as_hal::<wgpu::wgc::api::Dx12>()
                .expect("DX12 device")
                .raw_device()
                .clone();
            let queue: ID3D12CommandQueue = renderer
                .queue
                .as_hal::<wgpu::wgc::api::Dx12>()
                .expect("DX12 queue")
                .as_raw()
                .clone();
            let ready: ID3D12Fence = device.CreateFence(0, D3D12_FENCE_FLAG_SHARED).unwrap();
            let done: ID3D12Fence = device.CreateFence(0, D3D12_FENCE_FLAG_SHARED).unwrap();
            let ready_handle = device.CreateSharedHandle(&ready, None, GENERIC_ALL.0, PCWSTR::null()).unwrap();
            let done_handle = device.CreateSharedHandle(&done, None, GENERIC_ALL.0, PCWSTR::null()).unwrap();
            let luid = device.GetAdapterLuid();
            D3d {
                device,
                queue,
                ready,
                done,
                ready_handle,
                done_handle,
                max_ready_announced: 0,
                luid: (luid.HighPart, luid.LowPart),
            }
        };
        println!("adapter LUID {:?}", d3d.luid);

        let t_js = Instant::now();
        let mut js = JsRuntime::new(RuntimeOptions {
            extensions: vec![bridge_ext::init()],
            ..Default::default()
        });
        js.execute_script("game.js", GAME_JS).expect("load game.js");
        println!(
            "deno_core 0.413.0 / V8 {} ready in {:.1} ms",
            deno_core::v8::V8::get_version(),
            t_js.elapsed().as_secs_f64() * 1000.0
        );

        let probes = (0..16)
            .map(|_| Probe {
                buffer: renderer.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("probe"),
                    size: wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as u64,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                }),
                state: Arc::new(AtomicU8::new(0)),
                frame: 0,
            })
            .collect();

        window.request_redraw();
        let mut state = AppState {
            window,
            renderer,
            d3d,
            js,
            ui: None,
            next_generation: 1,
            relaunch_at: None,
            frame: 0,
            send_times: vec![None; RING],
            submit_times: vec![None; RING],
            probes,
            next_probe: 0,
            last_seen_seq: 0,
            killed_at: None,
            kill_window_max_interval_ms: 0.0,
            startups: Vec::new(),
            stats: Stats::default(),
            started,
            last_frame_at: None,
            options,
            probed_colors: false,
            js_inbox: Vec::new(),
            last_patch_at: None,
        };
        if !state.options.no_ui {
            state.launch_ui();
        }
        *self = App::Running(Box::new(state));
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: winit::window::WindowId, event: WindowEvent) {
        let App::Running(state) = self else { return };
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::RedrawRequested => {
                if state.frame_tick() {
                    state.finish();
                    std::process::exit(0);
                }
                state.window.request_redraw();
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        event_loop.set_control_flow(ControlFlow::Poll);
    }
}

impl AppState {
    fn launch_ui(&mut self) {
        let generation = self.next_generation;
        self.next_generation += 1;
        let size = self.window.inner_size();
        let t = Instant::now();
        self.ui = Some(spawn_ui(&mut self.d3d, generation, size, &self.options, self.frame));
        println!(
            "spawn_ui gen {generation} (pipes + CreateProcess + handle dup) took {:.2} ms on the render thread",
            t.elapsed().as_secs_f64() * 1000.0
        );
    }

    fn drop_ui(&mut self, kill: bool) {
        if let Some(mut ui) = self.ui.take() {
            if kill {
                let _ = ui.child.kill();
            }
            let _ = ui.child.wait();
        }
    }

    /// One game frame. Returns true when the requested frame count is reached.
    fn frame_tick(&mut self) -> bool {
        let t0 = Instant::now();
        let mut interval_ms = 0.0;
        if let Some(last) = self.last_frame_at.replace(t0) {
            interval_ms = (t0 - last).as_secs_f64() * 1000.0;
            self.stats.frame_interval.push_ms(interval_ms);
        }
        let frame = self.frame;

        // Crash-isolation test: kill ui-host, keep rendering, relaunch after a delay.
        if Some(frame) == self.options.kill_ui_at && self.ui.is_some() {
            self.drop_ui(true);
            self.killed_at = Some((t0, frame));
            self.relaunch_at = Some(t0 + self.options.relaunch_delay);
            println!("frame {frame}: killed ui-host");
        }
        if let Some((killed, _)) = self.killed_at {
            if t0 - killed < Duration::from_secs(3) {
                self.kill_window_max_interval_ms = self.kill_window_max_interval_ms.max(interval_ms);
            }
        }
        if self.relaunch_at.is_some_and(|at| t0 >= at) {
            self.relaunch_at = None;
            self.launch_ui();
            println!("frame {frame}: relaunched ui-host");
        }

        // 1. Drain messages from ui-host.
        let mut disconnected = false;
        if let Some(ui) = self.ui.as_mut() {
            if ui.first_pick_at.is_none() {
                ui.startup_max_interval_ms = ui.startup_max_interval_ms.max(interval_ms);
                ui.startup_frames += 1;
            }
            loop {
                match ui.rx.try_recv() {
                    Ok(Inbound::Msg(Msg::Slots { handles, width, height })) => {
                        let child = ui.child_handle();
                        ui.slots = handles
                            .iter()
                            .map(|h| self.renderer.import_slot(&self.d3d.device, dup_from(child, *h), width, height))
                            .collect();
                        ui.slots_at = Some(ui.spawned_at.elapsed());
                    }
                    Ok(Inbound::Msg(Msg::FrameReady { slot, pub_id, ready_value })) => {
                        ui.first_ready_at.get_or_insert(ui.spawned_at.elapsed());
                        self.d3d.max_ready_announced = self.d3d.max_ready_announced.max(ready_value);
                        ui.published.push(Published { slot: slot as usize, pub_id, ready_value, arrived_frame: frame });
                    }
                    Ok(Inbound::Msg(Msg::Events { seq, json })) => {
                        if let Some(sent) = self.send_times[seq as usize % RING] {
                            self.stats.rtt_ms.push(t0 - sent);
                            self.stats.rtt_frames.push_ms((frame - seq) as f64);
                        }
                        self.js_inbox.push(json);
                    }
                    Ok(Inbound::Msg(other)) => println!("unexpected message {other:?}"),
                    Ok(Inbound::Disconnected) | Err(mpsc::TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }
        }
        if disconnected {
            println!("frame {frame}: ui-host disconnected");
            self.stats.ui_disconnects += 1;
            self.killed_at.get_or_insert((t0, frame));
            self.drop_ui(false);
            if self.relaunch_at.is_none() {
                self.relaunch_at = Some(t0 + self.options.relaunch_delay);
            }
        }
        let t1 = Instant::now();

        // 2. Game tick in V8: consume HUD events, produce a state patch.
        {
            let op_state = self.js.op_state();
            let mut op_state = op_state.borrow_mut();
            op_state.borrow_mut::<BridgeState>().incoming.append(&mut self.js_inbox);
        }
        self.js.execute_script("tick", format!("tick({frame})")).expect("tick");
        let patch = self.js.op_state().borrow_mut().borrow_mut::<BridgeState>().outgoing_patch.take();
        let patch_due = self.options.patch_interval.is_none_or(|every| {
            self.last_patch_at.is_none_or(|last| t1 - last >= every)
        });
        if let (Some(patch), Some(ui), true) = (patch, self.ui.as_ref(), patch_due) {
            if ui.first_ready_at.is_some() {
                self.last_patch_at = Some(t1);
                self.send_times[frame as usize % RING] = Some(Instant::now());
                let _ = ui.tx.send(Msg::Patch { seq: frame, json: patch });
            }
        }
        let t2 = Instant::now();

        // 3. Pick the newest UI frame whose copy is complete (poll) or queue a GPU wait for it.
        let mut hud: Option<(usize, Option<u64>)> = None;
        if let Some(ui) = self.ui.as_mut().filter(|ui| !ui.slots.is_empty()) {
            // SAFETY: plain fence query.
            let completed = unsafe { self.d3d.ready.GetCompletedValue() };
            let current_pub = ui.current.map_or(0, |(_, p)| p);
            let mode = self.options.sync;
            if let Some(candidate) = ui
                .published
                .iter()
                .filter(|p| p.pub_id > current_pub && (mode == SyncMode::GpuWait || p.ready_value <= completed))
                .max_by_key(|p| p.pub_id)
            {
                self.stats.ready_wait_frames.push_ms((frame - candidate.arrived_frame) as f64);
                self.stats.picks += 1;
                let pick = (candidate.slot, candidate.pub_id);
                if mode == SyncMode::GpuWait {
                    ui.pending_wait = Some(candidate.ready_value);
                }
                ui.current = Some(pick);
                ui.published.retain(|p| p.pub_id > pick.1);
                ui.first_pick_at.get_or_insert(ui.spawned_at.elapsed());
                let _ = ui.tx.send(Msg::Picked { pub_id: pick.1, first_frame: frame });
            }
            hud = ui.current.map(|(slot, _)| (slot, ui.pending_wait.take()));
        }
        let t3 = Instant::now();

        // 4. Render the game, composite the HUD, copy a probe pixel, submit, signal `done`.
        let probe = match hud {
            Some(_) if self.probes[self.next_probe].state.load(Ordering::Acquire) == 0 => {
                Some(self.next_probe)
            }
            _ => None,
        };
        let ui_slots = self.ui.as_ref().map(|ui| &ui.slots);
        let hud_slot = hud.and_then(|(slot, _)| ui_slots.and_then(|s| s.get(slot)));
        let wait = hud.and_then(|(_, wait)| wait).map(|v| (&self.d3d.ready, v));
        self.renderer
            .render(
                self.started.elapsed().as_secs_f32(),
                hud_slot,
                probe.map(|i| &self.probes[i].buffer),
                wait,
                &self.d3d.queue,
                (&self.d3d.done, frame),
            )
            .expect("render");
        self.submit_times[frame as usize % RING] = Some(Instant::now());
        if let Some(i) = probe {
            let p = &mut self.probes[i];
            p.frame = frame;
            p.state.store(1, Ordering::Release);
            let state = p.state.clone();
            p.buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                state.store(if r.is_ok() { 2 } else { 0 }, Ordering::Release);
            });
            self.next_probe = (self.next_probe + 1) % self.probes.len();
        }
        if hud_slot.is_some() {
            self.stats.frames_with_ui += 1;
        } else {
            self.stats.frames_without_ui += 1;
        }
        let t4 = Instant::now();

        // 5. Collect finished probe readbacks: when did each patch seq become visible?
        let _ = self.renderer.device.poll(wgpu::PollType::Poll);
        for p in &mut self.probes {
            if p.state.load(Ordering::Acquire) != 2 {
                continue;
            }
            let px = {
                let view = p.buffer.slice(..).get_mapped_range().expect("mapped probe");
                [view[0], view[1], view[2], view[3]]
            };
            p.buffer.unmap();
            p.state.store(0, Ordering::Release);
            let seq = px[0] as u64 | (px[1] as u64) << 8 | (px[2] as u64) << 16;
            if px[3] == 255 && seq > self.last_seen_seq && seq <= p.frame {
                self.last_seen_seq = seq;
                self.stats.pixel_frames.push_ms((p.frame - seq) as f64);
                if let (Some(sent), Some(shown)) =
                    (self.send_times[seq as usize % RING], self.submit_times[p.frame as usize % RING])
                {
                    self.stats.pixel_ms.push(shown - sent);
                }
            }
        }

        if !self.probed_colors && self.started.elapsed() > Duration::from_secs(4) && hud_slot.is_some() {
            self.probed_colors = true;
            self.probe_colors(hud.unwrap().0);
        }

        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        if interval_ms > 20.0 {
            println!("hitch: interval before frame {frame} = {interval_ms:.2} ms");
        }
        if ms(t4 - t0) > 20.0 {
            println!(
                "hitch: frame {frame} CPU {:.2} ms (drain {:.2}, js {:.2}, pick {:.2}, render+present {:.2}); ui present={}",
                ms(t4 - t0), ms(t1 - t0), ms(t2 - t1), ms(t3 - t2), ms(t4 - t3), self.ui.is_some()
            );
        }
        self.stats.drain.push(t1 - t0);
        self.stats.js_tick.push(t2 - t1);
        self.stats.pick.push(t3 - t2);
        self.stats.render.push(t4 - t3);
        self.stats.frame_cpu.push(Instant::now() - t0);

        if let Some(ui) = self.ui.as_ref() {
            if let (Some(first_pick), true) = (ui.first_pick_at, ui.startups_unrecorded(self.startups.len())) {
                self.startups.push(format!(
                    "ui-host gen {}: spawned at game frame {}; slots after {:?}, first FrameReady after {:?}, first composited frame after {:?}; game kept rendering {} frames meanwhile, max frame interval {:.2} ms",
                    ui.generation, ui.spawned_frame, ui.slots_at, ui.first_ready_at, first_pick, ui.startup_frames, ui.startup_max_interval_ms
                ));
            }
        }

        self.frame += 1;
        self.frame >= self.options.frames
    }

    fn probe_colors(&self, slot: usize) {
        let Some(ui) = self.ui.as_ref() else { return };
        let texture = &ui.slots[slot].texture;
        let h = texture.height();
        // Page coordinates (top-left origin) -> texture rows (bottom-left origin).
        for (label, x, y) in [
            ("half-transparent red rgba(255,0,0,0.5)", 140, 50),
            ("opaque green", 140, 110),
            ("empty page area", 960, 1070),
        ] {
            match self.renderer.read_pixel(texture, x, h - 1 - y) {
                Ok(px) => println!("probe {label} @page({x},{y}) = {px:?}"),
                Err(e) => println!("probe {label} failed: {e}"),
            }
        }
    }

    fn finish(&mut self) {
        let mut child_mem = String::new();
        let mut child_cpu = None;
        if let Some(ui) = self.ui.as_ref() {
            child_mem = memory_of(ui.child_handle(), "ui-host");
            child_cpu = cpu_seconds(ui.child_handle()).map(|c| (c, ui.spawned_at.elapsed().as_secs_f64()));
            let _ = ui.tx.send(Msg::Shutdown);
            let deadline = Instant::now() + Duration::from_secs(3);
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                match ui.rx.recv_timeout(left) {
                    Ok(Inbound::Msg(Msg::Report { text })) => {
                        print!("{text}");
                        break;
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        }
        let elapsed = self.started.elapsed().as_secs_f64();
        let s = &self.stats;
        println!(
            "=== xproc-game report ({} frames in {:.1} s, vsync={}, sync={:?}, ring={}, ui={})",
            self.frame, elapsed, !self.options.novsync, self.options.sync, self.options.ring, !self.options.no_ui
        );
        for line in &self.startups {
            println!("{line}");
        }
        if let Some((_, kill_frame)) = self.killed_at {
            println!(
                "kill test: killed at frame {kill_frame}; max game frame interval in the 3 s after the kill {:.2} ms; disconnects seen {}",
                self.kill_window_max_interval_ms, s.ui_disconnects
            );
        }
        println!("frames with HUD composited {} / without {}", s.frames_with_ui, s.frames_without_ui);
        println!("HUD publications picked: {} ({:.1}/s)", s.picks, s.picks as f64 / elapsed);
        println!("frame interval ms:          {}", s.frame_interval.summary());
        println!("frame CPU ms:               {}", s.frame_cpu.summary());
        println!("  drain pipe msgs ms:       {}", s.drain.summary());
        println!("  js tick ms:               {}", s.js_tick.summary());
        println!("  pick (fence poll) ms:     {}", s.pick.summary());
        println!("  render+composite+present: {}", s.render.summary());
        println!("FrameReady->picked frames:  {}", s.ready_wait_frames.summary());
        println!("bridge RTT ms:              {}", s.rtt_ms.summary());
        println!("bridge RTT frames:          {}", s.rtt_frames.summary());
        println!("patch->HUD pixels ms:       {}", s.pixel_ms.summary());
        println!("patch->HUD pixels frames:   {}", s.pixel_frames.summary());
        // SAFETY: current-process pseudo handle.
        print!("{}", memory_of(unsafe { GetCurrentProcess() }, "game"));
        print!("{child_mem}");
        // SAFETY: current-process pseudo handle.
        if let Some(cpu) = cpu_seconds(unsafe { GetCurrentProcess() }) {
            println!("game CPU time {cpu:.2} s ({:.0}% of one core)", 100.0 * cpu / elapsed);
        }
        if let Some((cpu, alive)) = child_cpu {
            println!("ui-host CPU time {cpu:.2} s over {alive:.1} s alive ({:.0}% of one core)", 100.0 * cpu / alive);
        }
        if let Some(mut ui) = self.ui.take() {
            let _ = ui.child.wait();
        }
    }
}

impl UiLink {
    fn startups_unrecorded(&self, recorded: usize) -> bool {
        recorded < self.generation as usize
    }
}

fn memory_of(process: HANDLE, label: &str) -> String {
    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    // SAFETY: correctly sized out-parameter; `process` has query rights.
    let ok = unsafe { GetProcessMemoryInfo(process, &mut counters, std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32) };
    if ok.is_ok() {
        format!(
            "{label} memory: working set {:.0} MB, peak {:.0} MB, private {:.0} MB\n",
            counters.WorkingSetSize as f64 / 1048576.0,
            counters.PeakWorkingSetSize as f64 / 1048576.0,
            counters.PagefileUsage as f64 / 1048576.0
        )
    } else {
        String::new()
    }
}

fn cpu_seconds(process: HANDLE) -> Option<f64> {
    let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: valid out-parameters; `process` has query rights.
    unsafe { GetProcessTimes(process, &mut c, &mut e, &mut k, &mut u) }.ok()?;
    let t = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 * 1e-7;
    Some(t(k) + t(u))
}

// ── Renderer ────────────────────────────────────────────────────────────────

struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    game_pipeline: wgpu::RenderPipeline,
    game_bind_group: wgpu::BindGroup,
    uniforms: wgpu::Buffer,
    aspect: f32,
    composite_pipeline: wgpu::RenderPipeline,
    composite_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    size: PhysicalSize<u32>,
}

impl Renderer {
    async fn new(window: Arc<Window>, novsync: bool) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12,
            flags: wgpu::InstanceFlags::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::default(),
            display: None,
        });
        let surface = instance.create_surface(window.clone()).map_err(|e| e.to_string())?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
                apply_limit_buckets: false,
            })
            .await
            .map_err(|e| e.to_string())?;
        let info = adapter.get_info();
        println!("using adapter: {} ({:?}) driver {}", info.name, info.backend, info.driver_info);
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("xproc-game"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(|e| e.to_string())?;
        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats.iter().copied().find(wgpu::TextureFormat::is_srgb).unwrap_or(caps.formats[0]);
        let size = window.inner_size();
        let present_mode = if novsync { wgpu::PresentMode::AutoNoVsync } else { wgpu::PresentMode::Fifo };
        surface.configure(
            &device,
            &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format,
                width: size.width.max(1),
                height: size.height.max(1),
                present_mode,
                desired_maximum_frame_latency: 2,
                alpha_mode: caps.alpha_modes[0],
                view_formats: vec![],
                color_space: wgpu::SurfaceColorSpace::Auto,
            },
        );
        println!("window {}x{}, surface {format:?}, {present_mode:?}", size.width, size.height);

        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("game-uniforms"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let game_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("game-layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let game_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("game-bind-group"),
            layout: &game_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() }],
        });
        let game_pipeline = make_pipeline(&device, &game_layout, GAME_WGSL, format, None);
        let composite_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite-layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        // Servo/WebRender output is premultiplied alpha.
        let premultiplied_over = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let composite_pipeline =
            make_pipeline(&device, &composite_layout, COMPOSITE_WGSL, format, Some(premultiplied_over));
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor { label: Some("hud-sampler"), ..Default::default() });
        Ok(Self {
            surface,
            device,
            queue,
            game_pipeline,
            game_bind_group,
            uniforms,
            aspect: size.width as f32 / size.height.max(1) as f32,
            composite_pipeline,
            composite_layout,
            sampler,
            size,
        })
    }

    /// Open a duplicated NT handle on our D3D12 device and wrap it as a wgpu texture.
    fn import_slot(&self, device: &ID3D12Device, handle: HANDLE, width: u32, height: u32) -> UiSlot {
        let mut resource: Option<ID3D12Resource> = None;
        // SAFETY: `handle` is our duplicate of ui-host's NT shared-texture handle.
        unsafe {
            device.OpenSharedHandle(handle, &mut resource).expect("OpenSharedHandle(slot)");
            let _ = CloseHandle(handle);
        }
        let extent = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
        // SAFETY: the resource is a 2D R8G8B8A8_UNORM texture on this device's adapter, opened in
        // COMMON state (which wgpu calls UNINITIALIZED for imports).
        let texture = unsafe {
            let hal = wgpu_hal::dx12::Device::texture_from_raw(
                resource.unwrap(),
                wgpu::TextureFormat::Rgba8Unorm,
                wgpu::TextureDimension::D2,
                extent,
                1,
                1,
            );
            self.device.create_texture_from_hal::<wgpu_hal::api::Dx12>(
                hal,
                &wgpu::TextureDescriptor {
                    label: Some("ui-slot"),
                    size: extent,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                },
                wgpu::TextureUses::UNINITIALIZED,
            )
        };
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ui-slot-bind-group"),
            layout: &self.composite_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        UiSlot { texture, bind_group }
    }

    fn render(
        &self,
        time: f32,
        hud: Option<&UiSlot>,
        probe: Option<&wgpu::Buffer>,
        wait: Option<(&ID3D12Fence, u64)>,
        raw_queue: &ID3D12CommandQueue,
        done: (&ID3D12Fence, u64),
    ) -> Result<(), String> {
        self.queue.write_buffer(&self.uniforms, 0, &[time, self.aspect, 0.0, 0.0].map(f32::to_le_bytes).concat());
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => return Ok(()),
            other => return Err(format!("surface texture unavailable: {other:?}")),
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        {
            let pulse = 0.5 + 0.5 * time.sin() as f64;
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("game+hud"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.05, g: 0.1 * pulse, b: 0.25, a: 1.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.game_pipeline);
            pass.set_bind_group(0, &self.game_bind_group, &[]);
            pass.draw(0..3, 0..1);
            if let Some(hud) = hud {
                pass.set_pipeline(&self.composite_pipeline);
                pass.set_bind_group(0, &hud.bind_group, &[]);
                pass.draw(0..3, 0..1);
            }
        }
        if let (Some(hud), Some(buffer)) = (hud, probe) {
            // The seq square is at page (0..32, 0..32); texture rows are bottom-left origin.
            copy_pixel(&mut encoder, &hud.texture, 16, hud.texture.height() - 1 - 16, buffer);
        }
        // SAFETY: queue-level wait on the shared fence, issued before this frame's submit.
        if let Some((fence, value)) = wait {
            unsafe { raw_queue.Wait(fence, value) }.map_err(|e| e.to_string())?;
        }
        self.queue.submit(Some(encoder.finish()));
        // SAFETY: signal after this frame's ExecuteCommandLists; ui-host reads it to free slots.
        unsafe { raw_queue.Signal(done.0, done.1) }.map_err(|e| e.to_string())?;
        self.queue.present(frame);
        let _ = self.size;
        Ok(())
    }

    fn read_pixel(&self, texture: &wgpu::Texture, x: u32, y: u32) -> Result<[u8; 4], String> {
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("probe-sync"),
            size: wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("probe") });
        copy_pixel(&mut encoder, texture, x, y, &buffer);
        self.queue.submit(Some(encoder.finish()));
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| e.to_string())?;
        let data = slice.get_mapped_range().map_err(|e| e.to_string())?;
        Ok([data[0], data[1], data[2], data[3]])
    }
}

fn copy_pixel(encoder: &mut wgpu::CommandEncoder, texture: &wgpu::Texture, x: u32, y: u32, buffer: &wgpu::Buffer) {
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo {
            buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT),
                rows_per_image: Some(1),
            },
        },
        wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
    );
}

fn make_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    wgsl: &str,
    format: wgpu::TextureFormat,
    blend: Option<wgpu::BlendState>,
) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(wgsl)),
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[Some(layout)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vs_main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs_main"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })],
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

const GAME_WGSL: &str = r#"
struct U { t: f32, aspect: f32, p0: f32, p1: f32 };
@group(0) @binding(0) var<uniform> u: U;
struct VO { @builtin(position) pos: vec4f, @location(0) col: vec3f };
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VO {
    let a = u.t + f32(i) * 2.0943951;
    var o: VO;
    o.pos = vec4f(0.6 * cos(a) / u.aspect, 0.6 * sin(a), 0.0, 1.0);
    o.col = vec3f(f32(i == 0u), f32(i == 1u), f32(i == 2u));
    return o;
}
@fragment fn fs_main(v: VO) -> @location(0) vec4f { return vec4f(v.col, 1.0); }
"#;

// The shared texture is Rgba8Unorm, bottom-left origin, holding sRGB-encoded premultiplied
// values. Flip V while sampling and decode to linear for the sRGB swapchain.
const COMPOSITE_WGSL: &str = r#"
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VO {
    var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
    var t = array<vec2f, 3>(vec2f(0.0, 2.0), vec2f(0.0, 0.0), vec2f(2.0, 0.0));
    var o: VO;
    o.pos = vec4f(p[i], 0.0, 1.0);
    o.uv = vec2f(t[i].x, 1.0 - t[i].y);
    return o;
}
@group(0) @binding(0) var hud: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
fn to_linear(c: vec3f) -> vec3f {
    return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}
@fragment fn fs_main(v: VO) -> @location(0) vec4f {
    let c = textureSample(hud, samp, v.uv);
    if (c.a <= 0.0) { return vec4f(0.0); }
    return vec4f(to_linear(c.rgb / c.a) * c.a, c.a);
}
"#;
