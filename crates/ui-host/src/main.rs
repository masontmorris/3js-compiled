// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use threejsc_ipc as proto;

use std::{
    cell::{Cell, RefCell},
    collections::{HashSet, VecDeque},
    fs::File,
    io::BufReader,
    os::windows::io::{FromRawHandle, OwnedHandle},
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};

use dpi::PhysicalSize;
use euclid::{Scale, default::Size2D};
use glow::HasContext;
use proto::Msg;
use servo::profile_traits::mem::MemoryReportResult;
use servo::{
    DevicePoint, EventLoopWaker, InputEvent, InputEventId, InputEventResult, JSValue, LoadStatus,
    MouseButton, MouseButtonAction, MouseButtonEvent, MouseLeftViewportEvent, MouseMoveEvent,
    Preferences, ServoBuilder, WebView, WebViewBuilder, WebViewDelegate,
};
use servo_base::generic_channel::GenericCallback;
use servo_wgpu_interop_adapter::ServoWgpuRenderingContext;
use url::Url;
use windows::{
    Win32::{
        Foundation::{FILETIME, GENERIC_ALL, GENERIC_READ, GENERIC_WRITE, HANDLE},
        Graphics::{
            Direct3D11::{
                D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_SHARED,
                D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
                ID3D11Device, ID3D11Device5, ID3D11DeviceContext4, ID3D11Fence, ID3D11Texture2D,
            },
            Dxgi::{
                Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC},
                IDXGIResource1,
            },
        },
        Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE, OPEN_EXISTING},
        System::{
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{GetCurrentProcess, GetProcessTimes},
        },
    },
    core::{HSTRING, IUnknown, Interface, PCWSTR},
};

enum Event {
    Msg(Msg),
    Disconnected,
    Wake,
}

#[derive(Clone)]
struct Waker(mpsc::Sender<Event>);

impl EventLoopWaker for Waker {
    fn clone_box(&self) -> Box<dyn EventLoopWaker> {
        Box::new(self.clone())
    }
    fn wake(&self) {
        let _ = self.0.send(Event::Wake);
    }
}

struct Delegate {
    new_frame: Rc<Cell<bool>>,
    input_handled: Rc<Cell<bool>>,
    /// Pointer events given to Servo and not yet reported handled.
    unhandled: Rc<RefCell<HashSet<InputEventId>>>,
    tick_script: Rc<RefCell<TickScript>>,
}

impl WebViewDelegate for Delegate {
    fn notify_load_status_changed(&self, _webview: WebView, _status: LoadStatus) {
        self.tick_script.borrow_mut().navigated();
    }

    fn notify_new_frame_ready(&self, _webview: WebView) {
        self.new_frame.set(true);
    }
    fn notify_input_event_handled(
        &self,
        _webview: WebView,
        event_id: InputEventId,
        _result: InputEventResult,
    ) {
        self.input_handled.set(true);
        self.unhandled.borrow_mut().remove(&event_id);
    }
    fn notify_crashed(&self, _webview: WebView, reason: String, _backtrace: Option<String>) {
        eprintln!("[ui-host] servo crash: {reason}");
    }
}

/// Gives Servo a placed pointer event, after the page's reply number `reply`.
fn give(
    webview: &WebView,
    unhandled: &RefCell<HashSet<InputEventId>>,
    pointer: proto::place::Placed,
    reply: u64,
) {
    eprintln!(
        "[ui-host] pointer {} given to Servo at ({}, {}) after reply {reply}",
        pointer.action, pointer.x, pointer.y
    );
    let point = DevicePoint::new(pointer.x, pointer.y).into();
    let input = match pointer.action {
        0 => InputEvent::MouseMove(MouseMoveEvent::new(point)),
        proto::place::LEFT => {
            // Servo reports this handled only when the page has the pointer, so no resize may
            // wait for it.
            let left = MouseLeftViewportEvent::default();
            webview.notify_input_event(InputEvent::MouseLeftViewport(left));
            return;
        }
        action => InputEvent::MouseButton(MouseButtonEvent::new(
            if action == 1 {
                MouseButtonAction::Down
            } else {
                MouseButtonAction::Up
            },
            MouseButton::from(pointer.button),
            point,
        )),
    };
    unhandled
        .borrow_mut()
        .insert(webview.notify_input_event(input));
}

/// One ring entry. `pub_id == 0` means never published.
struct Slot {
    _texture: ID3D11Texture2D,
    surface_texture: Option<surfman::SurfaceTexture>,
    framebuffer: glow::NativeFramebuffer,
    pub_id: u64,
    published: Instant,
    used: bool,
    last_use: u64,
}

/// Longest wait for a Servo frame after an evaluation starts, for evaluations that change
/// nothing on screen.
const FRAME_FALLBACK: Duration = Duration::from_millis(50);
/// Longest time between two evaluations once the game has sent state, so that page events
/// that no input caused still reach the game.
const IDLE_POLL: Duration = Duration::from_millis(100);

/// Servo 0.7.0 starts a rendering update no sooner than 20 ms after the previous one, and at
/// once for a page change that arrives later (servo-script's
/// `maybe_schedule_rendering_opportunity_after_ipc_message`). Evaluations this far apart each
/// render as soon as they finish.
const RENDER_INTERVAL: Duration = Duration::from_millis(20);

/// Longest wait for the page to finish loading before ui-host asks the host for state. Servo's
/// `LoadStatus::Complete` waits for every subresource, while Edge shows a page as its images and
/// fonts load, so a page with a stalled load is taken as loaded after this.
const LOAD_FALLBACK: Duration = Duration::from_millis(500);

/// Evaluations that may wait for their Servo frame at once. Two let one evaluation run while
/// the previous one renders.
const UNPAINTED: usize = 2;

#[derive(Default)]
struct TickScript {
    initialized: bool,
    generation: u64,
}

impl TickScript {
    fn next(&self, state: &str) -> String {
        if self.initialized {
            format!("globalThis[Symbol.for(\"threejsc.tick\")](() => __bridge.tick({state}))")
        } else {
            format!(
                "(globalThis[Symbol.for(\"threejsc.tick\")] ??= {})(() => __bridge.tick({state}))",
                proto::TICK
            )
        }
    }

    fn finished(&mut self, generation: u64, succeeded: bool) {
        if generation == self.generation {
            self.initialized = succeeded;
        }
    }

    fn navigated(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.initialized = false;
    }
}

/// Decides when ui-host evaluates `__bridge.tick`: no more often than Servo frames arrive, no
/// sooner than `RENDER_INTERVAL` after the previous evaluation, always with the newest state.
/// It asks for that state early by the host's last response time, so the state arrives fresh
/// when the next evaluation may start. Without new state it evaluates the current state again
/// (a poll) after input and when the page has been idle, to collect the page's events.
#[derive(Default)]
struct Pacer {
    state: Option<String>,
    unevaluated: Option<u64>,
    poll: bool,
    evaluating: bool,
    unpainted: VecDeque<Instant>,
    last_started: Option<Instant>,
    ready_sent: Option<Instant>,
    response: Duration,
}

impl Pacer {
    fn patch(&mut self, seq: u64, json: String, now: Instant) {
        if let Some(at) = self.ready_sent.take() {
            self.response = (now - at).min(RENDER_INTERVAL);
        }
        self.state = Some(json);
        self.unevaluated = Some(seq);
    }
    fn input_handled(&mut self) {
        self.poll = true;
    }
    fn finished(&mut self) {
        self.evaluating = false;
    }
    /// Records a new Servo frame and returns how long ago the evaluation it answers started.
    fn painted(&mut self, now: Instant) -> Option<Duration> {
        self.unpainted.pop_front().map(|at| now - at)
    }
    /// The next time `next` or `ready` can change its answer with no other event.
    fn deadline(&self, now: Instant) -> Option<Instant> {
        let start = self.last_started?;
        [
            start + RENDER_INTERVAL - self.response,
            start + RENDER_INTERVAL,
            start + IDLE_POLL,
        ]
        .into_iter()
        .chain(self.unpainted.front().map(|at| *at + FRAME_FALLBACK))
        .filter(|&at| at > now)
        .min()
    }
    /// The next evaluation to start, as the patch sequence number (0 for a poll) and state.
    fn next(&mut self, now: Instant) -> Option<(u64, String)> {
        let state = self.state.as_ref()?;
        while self
            .unpainted
            .front()
            .is_some_and(|at| now - *at >= FRAME_FALLBACK)
        {
            self.unpainted.pop_front();
        }
        let spaced = self
            .last_started
            .is_none_or(|at| now - at >= RENDER_INTERVAL);
        if self.evaluating || !spaced || self.unpainted.len() >= UNPAINTED {
            return None;
        }
        let idle_poll = self.last_started.is_none_or(|at| now - at >= IDLE_POLL);
        let seq = match self.unevaluated.take() {
            Some(seq) => seq,
            None if self.poll || idle_poll => 0,
            None => return None,
        };
        self.poll = false;
        self.evaluating = true;
        self.unpainted.push_back(now);
        self.last_started = Some(now);
        Some((seq, state.to_owned()))
    }
    /// Whether to ask the host for its next state now.
    fn ready(&mut self, now: Instant) -> bool {
        let due = self
            .last_started
            .is_none_or(|at| now + self.response >= at + RENDER_INTERVAL);
        let ready = self.ready_sent.is_none() && self.unevaluated.is_none() && due;
        if ready {
            self.ready_sent = Some(now);
        }
        ready
    }
}

/// How long after the page first reports a new viewport size display lists built before the
/// resize may still reach the screen: two rendering updates.
const RELAYOUT_SETTLE: Duration = Duration::from_millis(40);
/// Longest wait for the page to report a new viewport size, for pages whose tick fails. Kept
/// under 250 ms less two loop passes, so a continuous resize still publishes a frame at a
/// current size every 250 ms.
const RELAYOUT_FALLBACK: Duration = Duration::from_millis(200);

/// A resize whose new ring receives no frame until the page is laid out at the new size. Servo
/// first repaints the previous display list into the resized surface, and the host hit-tests a
/// frame by its ring's size, so each frame in a ring must show the page at that size.
struct Relayout {
    size: (u32, u32),
    since: Instant,
    measured: Option<Instant>,
}

impl Relayout {
    fn new(size: (u32, u32), now: Instant) -> Self {
        Self {
            size,
            since: now,
            measured: None,
        }
    }
    /// An evaluation found the page laid out at `size`.
    fn measured(&mut self, size: (u32, u32), now: Instant) {
        if size == self.size {
            self.measured.get_or_insert(now);
        }
    }
    fn done(&self, now: Instant) -> bool {
        self.measured.is_some_and(|at| now - at >= RELAYOUT_SETTLE)
            || now - self.since >= RELAYOUT_FALLBACK
    }
}

/// Longest wait for the host to show a ring's first frame before a newer resize may replace the
/// ring. The host has taken up to 71 ms to open a ring.
const SHOW_WAIT: Duration = Duration::from_millis(100);

/// The first frame published into the current ring, from its publication until the host shows
/// a frame of the ring. The host shows frames of its newest ring only, so a ring replaced before
/// then never reaches the screen, and during a drag the HUD would keep an old size.
#[derive(Default)]
struct Unshown(Option<(u64, Instant)>);

impl Unshown {
    fn published(&mut self, pub_id: u64, now: Instant) {
        self.0.get_or_insert((pub_id, now));
    }
    /// The host shows frame `pub_id`.
    fn picked(&mut self, pub_id: u64) {
        if self.0.is_some_and(|(first, _)| pub_id >= first) {
            self.0 = None;
        }
    }
    /// Whether a newer resize waits for the host to show the ring's first frame.
    fn holds(&self, now: Instant) -> bool {
        self.0.is_some_and(|(_, at)| now - at < SHOW_WAIT)
    }
}

/// The viewport size to apply now. Resizes that arrive while the page is laid out for the
/// last one wait, so each ring receives a frame before a newer resize replaces it, and they
/// wait for the host to show that frame. They also wait while Servo has pointer events it has
/// not handled, so each is hit-tested in the layout it was placed in.
fn next_resize(
    current: (u32, u32),
    waiting: &mut Vec<(u32, u32)>,
    blocked: bool,
) -> Option<(u32, u32)> {
    if blocked {
        return None;
    }
    proto::next_ring_size(current, waiting.drain(..))
}

#[derive(Default)]
struct Samples(VecDeque<f64>);

impl Samples {
    fn push(&mut self, d: Duration) {
        if self.0.len() == 1024 {
            self.0.pop_front();
        }
        self.0.push_back(d.as_secs_f64() * 1000.0);
    }
    fn summary(&self) -> String {
        if self.0.is_empty() {
            return "n=0".into();
        }
        let mut v: Vec<_> = self.0.iter().copied().collect();
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
    first_paint: Option<Duration>,
    paint: Samples,
    export: Samples,
    swap: Samples,
    total: Samples,
    round_trip: Samples,
    eval_to_frame: Samples,
    published: u64,
    skipped_no_free_slot: u64,
    patches_received: u64,
    patches_evaluated: u64,
    polls: u64,
    eval_errors: u64,
    rings: u64,
    resizes_held: u64,
    pointers_unplaced: u64,
    /// Rects of page replies that outline no element of the page.
    rects_unnamed: u64,
    gpu_waits: u64,
    since: Option<(Instant, Duration, u64)>,
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn open_pipe(name: &str, access: u32) -> File {
    let handle = unsafe {
        CreateFileW(
            &HSTRING::from(name),
            access,
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .unwrap_or_else(|e| panic!("open pipe {name}: {e}"));
    // SAFETY: fresh handle from CreateFileW, ownership moves into File.
    unsafe { File::from_raw_handle(handle.0) }
}

fn main() {
    // The pacer waits for deadlines a few milliseconds apart; the default 15.6 ms timer
    // resolution would round each wait up to the next tick.
    // SAFETY: plain call; the period lasts until the process exits.
    unsafe { windows::Win32::Media::timeBeginPeriod(1) };
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("install rustls provider");
    let started = Instant::now();
    let args: Vec<String> = std::env::args().collect();
    let pipe = arg(&args, "--pipe").expect("--pipe");
    let (luid_hi, luid_lo) = {
        let s = arg(&args, "--luid").expect("--luid");
        let (h, l) = s.split_once(':').expect("HIGH:LOW");
        (h.parse::<i32>().unwrap(), l.parse::<u32>().unwrap())
    };
    let mut size = {
        let s = arg(&args, "--size").unwrap_or_else(|| "1920x1080".into());
        let (w, h) = s.split_once('x').unwrap();
        PhysicalSize::new(w.parse::<u32>().unwrap(), h.parse::<u32>().unwrap())
    };
    let hud = arg(&args, "--hud").expect("--hud");
    let ring = arg(&args, "--ring")
        .and_then(|s| s.parse().ok())
        .unwrap_or(4usize);

    let down = open_pipe(&format!("{pipe}-down"), GENERIC_READ.0);
    let up = Rc::new(RefCell::new(open_pipe(
        &format!("{pipe}-up"),
        GENERIC_WRITE.0,
    )));
    let send = {
        let up = up.clone();
        move |msg: &Msg| {
            if proto::write_msg(&mut *up.borrow_mut(), msg).is_err() {
                std::process::exit(0);
            }
        }
    };

    let (tx, rx) = mpsc::channel::<Event>();
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(down);
            loop {
                match proto::read_msg(&mut reader) {
                    Ok(msg) => {
                        if tx.send(Event::Msg(msg)).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(Event::Disconnected);
                        break;
                    }
                }
            }
        });
    }

    let (ready_fence_handle, done_fence_handle, ready_base) = loop {
        match rx.recv() {
            Ok(Event::Msg(Msg::Hello {
                ready_fence,
                done_fence,
                ready_base,
                width,
                height,
            })) => {
                assert_eq!((width, height), (size.width, size.height));
                break (ready_fence, done_fence, ready_base);
            }
            Ok(Event::Msg(_)) | Ok(Event::Wake) => {}
            Ok(Event::Disconnected) | Err(_) => return,
        }
    };

    let ctx = Rc::new(
        ServoWgpuRenderingContext::new_for_luid(size, (luid_hi, luid_lo))
            .expect("surfman context on the game's GPU"),
    );
    let frame_ctx = ctx.frame_context();
    let d3d11: ID3D11Device = {
        let ptr = frame_ctx.device.borrow().native_device().d3d11_device;
        // SAFETY: native_device() AddRefs the device it returns; from_raw takes that reference.
        unsafe { IUnknown::from_raw(ptr as *mut _) }
            .cast()
            .expect("ID3D11Device")
    };
    let device5: ID3D11Device5 = d3d11.cast().expect("ID3D11Device5 (D3D11.4 fences)");
    // SAFETY: the game duplicated both fence handles into this process before sending Hello.
    let ready_fence: ID3D11Fence = unsafe {
        let mut fence: Option<ID3D11Fence> = None;
        device5
            .OpenSharedFence(HANDLE(ready_fence_handle as *mut _), &mut fence)
            .expect("OpenSharedFence(ready)");
        fence.unwrap()
    };
    let done_fence: ID3D11Fence = unsafe {
        let mut fence: Option<ID3D11Fence> = None;
        device5
            .OpenSharedFence(HANDLE(done_fence_handle as *mut _), &mut fence)
            .expect("OpenSharedFence(done)");
        fence.unwrap()
    };
    let immediate: ID3D11DeviceContext4 = unsafe { d3d11.GetImmediateContext() }
        .expect("immediate context")
        .cast()
        .expect("ID3D11DeviceContext4");

    let send = Rc::new(send);
    let stats = Rc::new(RefCell::new(Stats::default()));
    let mut unimported: Vec<(u64, OwnedHandle)> = Vec::new();
    let new_ring = |size: PhysicalSize<u32>, unimported: &mut Vec<(u64, OwnedHandle)>| {
        let mut stats = stats.borrow_mut();
        stats.rings += 1;
        let (slots, handles): (Vec<_>, Vec<_>) = (0..ring)
            .map(|_| create_slot(&d3d11, &frame_ctx, size))
            .unzip();
        send(&Msg::Slots {
            generation: stats.rings,
            handles: handles.iter().map(|h| h.0 as u64).collect(),
            width: size.width,
            height: size.height,
        });
        // SAFETY: each handle is a fresh NT handle from CreateSharedHandle.
        unimported.extend(
            handles
                .into_iter()
                .map(|h| (stats.rings, unsafe { OwnedHandle::from_raw_handle(h.0) })),
        );
        slots
    };
    let mut slots = new_ring(size, &mut unimported);
    let mut ring_at = Instant::now();
    // The start of the current run of frames skipped for no free slot, and its length.
    let mut skipping: Option<(Instant, u64)> = None;
    // The ready value of this process's latest publication, and whether a due frame waits for
    // the GPU to finish it.
    let mut last_ready: Option<u64> = None;
    let mut gpu_wait = false;

    let preferences = Preferences {
        shell_background_color_rgba: [0.0, 0.0, 0.0, 0.0],
        // SpiderMonkey's GC triggers do not count DOM nodes, which Servo allocates outside the
        // JS heap. Without a low malloc trigger, a HUD that replaces text every frame keeps its
        // detached nodes for minutes.
        js_mem_gc_malloc_threshold_base_mb: 1,
        ..Preferences::default()
    };
    let servo = ServoBuilder::default()
        .preferences(preferences)
        .event_loop_waker(Box::new(Waker(tx.clone())))
        .build();
    servo.setup_logging();
    let new_frame = Rc::new(Cell::new(false));
    let input_handled = Rc::new(Cell::new(false));
    let unhandled = Rc::new(RefCell::new(HashSet::new()));
    // The replies sent so far, numbered as the host numbers them, and the number sent before each
    // of the latest publications.
    let replies = Rc::new(Cell::new(0u64));
    let mut after_reply: VecDeque<(u64, u64)> = VecDeque::new();
    let tick_script = Rc::new(RefCell::new(TickScript::default()));
    let webview = WebViewBuilder::new(&servo, ctx.clone())
        .url(Url::from_file_path(&hud).expect("hud path"))
        .hidpi_scale_factor(Scale::new(1.0))
        .delegate(Rc::new(Delegate {
            new_frame: new_frame.clone(),
            input_handled: input_handled.clone(),
            unhandled: unhandled.clone(),
            tick_script: tick_script.clone(),
        }))
        .build();
    let loading = Instant::now();

    let mut next_pub: u64 = 0;
    let mut ready_value = ready_base;
    let mut picked: u64 = 0;
    let mut unshown = Unshown::default();
    let mut shutting_down = false;
    let mut last_paint = Instant::now();
    let mut last_report = Instant::now();
    let pacer = Rc::new(RefCell::new(Pacer::default()));
    let memory_report = std::env::var("THREEJSC_UI_MEMORY_REPORT")
        .ok()
        .and_then(|seconds| seconds.parse().ok())
        .map(Duration::from_secs);
    let mut last_memory_report = Instant::now();
    let mut warmed_at: Option<Instant> = None;
    let applied = Rc::new(Cell::new(false));
    let relayout: Rc<RefCell<Option<Relayout>>> = Rc::default();
    let placer = Rc::new(RefCell::new(proto::place::Placer::new((
        size.width,
        size.height,
    ))));
    let mut resizes = Vec::new();

    loop {
        let mut events = Vec::new();
        let now = Instant::now();
        let longest = Duration::from_millis(if gpu_wait { 1 } else { 16 });
        let wait = pacer
            .borrow()
            .deadline(now)
            .map_or(longest, |at| (at - now).min(longest));
        match rx.recv_timeout(wait) {
            Ok(e) => events.push(e),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        events.extend(rx.try_iter());

        for event in events {
            match event {
                Event::Msg(Msg::Patch { seq, json }) => {
                    stats.borrow_mut().patches_received += 1;
                    pacer.borrow_mut().patch(seq, json, Instant::now());
                }
                Event::Msg(Msg::SlotsImported { generation }) => {
                    unimported.retain(|(g, _)| *g > generation);
                }
                Event::Msg(Msg::Picked {
                    pub_id,
                    first_frame,
                }) => {
                    for slot in slots.iter_mut() {
                        if picked != 0 && slot.pub_id == picked {
                            slot.used = true;
                            slot.last_use = first_frame.saturating_sub(1);
                        }
                    }
                    picked = pub_id;
                    unshown.picked(pub_id);
                }
                Event::Msg(Msg::Pointer(pointer)) => {
                    let shown = after_reply.iter().find(|(id, _)| *id == picked);
                    eprintln!(
                        "[ui-host] pointer {} from the host over publication {picked}, published \
                         after reply {}",
                        pointer.action,
                        shown.map_or(0, |(_, reply)| *reply)
                    );
                    if let Some(placed) = placer.borrow_mut().pointer(pointer) {
                        give(&webview, &unhandled, placed, replies.get());
                    }
                }
                Event::Msg(Msg::Resize { width, height }) if width > 0 && height > 0 => {
                    if relayout.borrow().is_some() {
                        stats.borrow_mut().resizes_held += 1;
                    }
                    resizes.push((width, height));
                }
                Event::Msg(Msg::Report { text }) => eprintln!("{text}"),
                Event::Msg(Msg::Shutdown) => shutting_down = true,
                Event::Disconnected => shutting_down = true,
                Event::Msg(_) | Event::Wake => {}
            }
        }
        if shutting_down {
            break;
        }
        let blocked = relayout.borrow().is_some()
            || !unhandled.borrow().is_empty()
            || unshown.holds(Instant::now());
        if let Some((width, height)) = next_resize((size.width, size.height), &mut resizes, blocked)
        {
            size = PhysicalSize::new(width, height);
            webview.resize(size);
            if ctx.size() != size {
                // Frames of this size would come from smaller surfaces. A new ui-host makes its
                // surfaces at the window's size.
                let text = format!(
                    "[ui-host] its surfaces could not grow to {width}x{height}, so it stops for \
                     the host to start another"
                );
                eprintln!("{text}");
                send(&Msg::Report { text });
                break;
            }
            placer.borrow_mut().resized((width, height));
            *relayout.borrow_mut() = Some(Relayout::new((width, height), Instant::now()));
            destroy_slots(&frame_ctx, &mut slots);
            slots = new_ring(size, &mut unimported);
            ring_at = Instant::now();
            picked = 0;
            unshown = Unshown::default();
        }
        if input_handled.take() {
            pacer.borrow_mut().input_handled();
        }

        let next = pacer.borrow_mut().next(Instant::now());
        if let Some((seq, state)) = next {
            let script = tick_script.borrow().next(&state);
            let generation = tick_script.borrow().generation;
            let started = Instant::now();
            {
                let mut stats = stats.borrow_mut();
                if seq == 0 {
                    stats.polls += 1;
                } else {
                    stats.patches_evaluated += 1;
                }
            }
            let send = send.clone();
            let stats = stats.clone();
            let applied = applied.clone();
            let new_frame = new_frame.clone();
            let pacer = pacer.clone();
            let relayout = relayout.clone();
            let placer = placer.clone();
            let replies = replies.clone();
            let tick_script = tick_script.clone();
            webview.evaluate_javascript(script, move |result| {
                stats.borrow_mut().round_trip.push(started.elapsed());
                pacer.borrow_mut().finished();
                tick_script.borrow_mut().finished(generation, result.is_ok());
                if !applied.replace(true) {
                    new_frame.set(false);
                }
                let failure = match result.as_ref().map(|value| match value {
                    JSValue::Array(values) => values.as_slice(),
                    _ => &[],
                }) {
                    Ok(
                        [
                            JSValue::Number(width),
                            JSValue::Number(height),
                            JSValue::String(json),
                            JSValue::Array(named),
                            JSValue::Array(also),
                            JSValue::Array(missing),
                        ],
                    ) => {
                        let number = |value: Option<&JSValue>| match value {
                            Some(JSValue::Number(n)) => *n as u32,
                            _ => 0,
                        };
                        let ids: Vec<proto::place::Ids> = (0..named.len())
                            .map(|i| {
                                let more = |k| number(also.get(3 * i + k));
                                [number(named.get(i)), more(0), more(1), more(2)]
                            })
                            .collect();
                        if proto::events_fit(json, &ids) {
                            let rects = proto::reply::parse(json, &ids).rects;
                            // The rects a whole document scan found no element for; a rect still
                            // being looked for has id 0 too, but is not counted.
                            let unnamed = missing.len() as u64;
                            if let Some(first) = missing.first()
                                && stats.borrow().rects_unnamed == 0
                            {
                                let text = format!(
                                    "[ui-host] patch {seq}: rects[{}] outlines no element of the \
                                     page ({unnamed} such rects in this reply), so input over it \
                                     during a resize keeps its window point",
                                    number(Some(first))
                                );
                                eprintln!("{text}");
                                send(&Msg::Report { text });
                            }
                            stats.borrow_mut().rects_unnamed += unnamed;
                            placer.borrow_mut().replied(rects);
                            if let Some(relayout) = relayout.borrow_mut().as_mut() {
                                relayout.measured((*width as u32, *height as u32), Instant::now());
                            }
                            replies.set(replies.get() + 1);
                            send(&Msg::Events {
                                seq,
                                width: *width as u32,
                                height: *height as u32,
                                json: json.clone(),
                                ids,
                            });
                            return;
                        }
                        format!(
                            "page reply of {} bytes and {} rect ids exceeds {} bytes and was dropped",
                            json.len(),
                            ids.len(),
                            proto::MAX_JSON
                        )
                    }
                    Ok([_, _, other, ..]) => format!("page tick did not return a string: {other:?}"),
                    _ => format!("page tick did not return a string: {result:?}"),
                };
                stats.borrow_mut().eval_errors += 1;
                let text: String = format!("[ui-host] patch {seq}: {failure}")
                    .chars()
                    .take(500)
                    .collect();
                eprintln!("{text}");
                send(&Msg::Report { text });
            });
        }

        servo.spin_event_loop();

        if last_report.elapsed() >= Duration::from_secs(5) {
            report_stats(&mut stats.borrow_mut());
            last_report = Instant::now();
        }
        if memory_report.is_some_and(|period| last_memory_report.elapsed() >= period) {
            last_memory_report = Instant::now();
            let at = started.elapsed().as_secs();
            let callback = GenericCallback::new(move |result: Result<MemoryReportResult, _>| {
                for report in result
                    .iter()
                    .flat_map(|r| &r.results)
                    .flat_map(|r| &r.reports)
                {
                    eprintln!(
                        "ui-host servo memory {at} {} {}",
                        report.path.join("/"),
                        report.size
                    );
                }
            });
            if let Ok(callback) = callback {
                servo.create_memory_report(callback);
            }
        }

        let now = Instant::now();
        let relaying = relayout.borrow().as_ref().is_some_and(|r| !r.done(now));
        let ended = (!relaying).then(|| relayout.borrow_mut().take()).flatten();
        let relaid = ended.is_some();
        if let Some(ended) = ended {
            let placed = placer.borrow_mut().relaid();
            if ended.measured.is_none() {
                stats.borrow_mut().pointers_unplaced += placed.len() as u64;
            }
            for pointer in placed {
                give(&webview, &unhandled, pointer, replies.get());
            }
        }
        let due = new_frame.get()
            || relaid
            || gpu_wait
            || last_paint.elapsed() >= Duration::from_millis(100);
        // Until the first patch is applied, a published frame would show the page without
        // state, so these paints are not published. The first paint of the loaded page takes
        // 70 to 110 ms; the host sends state only after it, so the first patch is current
        // when it arrives. A game that never sends state gets the page as loaded 250 ms later.
        let warming =
            !applied.get() && warmed_at.is_none_or(|at| at.elapsed() < Duration::from_millis(250));
        let painted = |fresh: bool| {
            if fresh && let Some(waited) = pacer.borrow_mut().painted(Instant::now()) {
                stats.borrow_mut().eval_to_frame.push(waited);
            }
        };
        if due && (warming || relaying) {
            gpu_wait = false;
            let fresh = new_frame.replace(false);
            last_paint = Instant::now();
            webview.paint();
            ctx.present_without_wait();
            painted(fresh);
            if warmed_at.is_none()
                && (webview.load_status() == LoadStatus::Complete
                    || loading.elapsed() >= LOAD_FALLBACK)
            {
                warmed_at = Some(Instant::now());
            }
        } else if due
            && last_ready.is_some_and(|value| unsafe { ready_fence.GetCompletedValue() } < value)
        {
            // The GPU has not finished this process's latest publication. The host cannot pick a
            // frame published now before then, and the frame would hold a slot meanwhile.
            if !gpu_wait {
                stats.borrow_mut().gpu_waits += 1;
            }
            gpu_wait = true;
        } else if due {
            gpu_wait = false;
            let done_completed = unsafe { done_fence.GetCompletedValue() };
            let free = slots
                .iter()
                .enumerate()
                .filter(|(_, s)| {
                    s.pub_id == 0
                        || (s.pub_id < picked && (!s.used || done_completed >= s.last_use))
                })
                .min_by_key(|(_, s)| s.pub_id)
                .map(|(i, _)| i);
            if let Some(index) = free {
                if let Some((since, n)) = skipping.take() {
                    eprintln!(
                        "[ui-host] skipped {n} frames for no free ring slot over {} ms; then \
                         picked {picked}, done fence {done_completed}",
                        since.elapsed().as_millis()
                    );
                }
                let fresh = new_frame.replace(false);
                last_paint = Instant::now();

                let t0 = Instant::now();
                webview.paint();
                let t1 = Instant::now();
                ready_value += 1;
                export_into(&frame_ctx, slots[index].framebuffer, size);
                // SAFETY: the fence and context belong to ANGLE's D3D11 device; same thread as GL.
                unsafe {
                    immediate
                        .Signal(&ready_fence, ready_value)
                        .expect("D3D11 Signal");
                    immediate.Flush();
                }
                let t2 = Instant::now();
                ctx.present_without_wait();
                let t3 = Instant::now();
                painted(fresh);

                next_pub += 1;
                unshown.published(next_pub, Instant::now());
                last_ready = Some(ready_value);
                let slot = &mut slots[index];
                slot.pub_id = next_pub;
                slot.published = Instant::now();
                slot.used = false;
                send(&Msg::FrameReady {
                    slot: index as u8,
                    pub_id: next_pub,
                    ready_value,
                });
                after_reply.push_back((next_pub, replies.get()));
                if after_reply.len() > 64 {
                    after_reply.pop_front();
                }

                let mut s = stats.borrow_mut();
                s.first_paint.get_or_insert(started.elapsed());
                s.paint.push(t1 - t0);
                s.export.push(t2 - t1);
                s.swap.push(t3 - t2);
                s.total.push(t3 - t0);
                s.published += 1;
            } else {
                let mut stats = stats.borrow_mut();
                stats.skipped_no_free_slot += 1;
                match &mut skipping {
                    Some((_, n)) => *n += 1,
                    None => {
                        skipping = Some((Instant::now(), 1));
                        let state: Vec<_> = slots
                            .iter()
                            .map(|s| {
                                let age = s.published.elapsed().as_millis();
                                (s.pub_id, s.used, s.last_use, age)
                            })
                            .collect();
                        // SAFETY: the fence belongs to ANGLE's D3D11 device; same thread as GL.
                        let ready = unsafe { ready_fence.GetCompletedValue() };
                        eprintln!(
                            "[ui-host] no free ring slot in ring {} ({}x{}, {} ms old, handles {}): \
                             picked {picked}, done fence {done_completed}, ready fence {ready} \
                             of {ready_value}, slots (pub_id, used, last_use, ms since \
                             published) {state:?}",
                            stats.rings,
                            size.width,
                            size.height,
                            ring_at.elapsed().as_millis(),
                            if unimported.iter().any(|(g, _)| *g == stats.rings) {
                                "not yet duplicated by the host"
                            } else {
                                "duplicated by the host"
                            },
                        );
                    }
                }
            }
        }
        if warmed_at.is_some() && pacer.borrow_mut().ready(Instant::now()) {
            send(&Msg::Ready);
        }
    }

    report_stats(&mut stats.borrow_mut());
    destroy_slots(&frame_ctx, &mut slots);
}

fn process_cpu() -> Duration {
    let [mut created, mut exited, mut kernel, mut user] = [FILETIME::default(); 4];
    // SAFETY: four valid out-parameters for the current process.
    let times = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    let ticks = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
    match times {
        Ok(()) => Duration::from_nanos((ticks(kernel) + ticks(user)) * 100),
        Err(_) => Duration::ZERO,
    }
}

fn report_stats(s: &mut Stats) {
    let mut report = String::new();
    let now = (Instant::now(), process_cpu(), s.patches_evaluated + s.polls);
    if let Some((at, cpu, evaluations)) = s.since.replace(now) {
        let seconds = (now.0 - at).as_secs_f64();
        report += &format!(
            "ui-host per second: cpu {:.1} ms, evaluations {:.1}\n",
            (now.1 - cpu).as_secs_f64() * 1000.0 / seconds,
            (now.2 - evaluations) as f64 / seconds
        );
    }
    report += &format!("ui-host first painted frame after {:?}\n", s.first_paint);
    report += &format!(
        "ui-host frames published: {}, skipped (no free ring slot): {}\n",
        s.published, s.skipped_no_free_slot
    );
    report += &format!(
        "ui-host patches received {} / evaluated {} / polls {} / eval errors {} / rings {}\n",
        s.patches_received, s.patches_evaluated, s.polls, s.eval_errors, s.rings
    );
    report += &format!(
        "ui-host resizes held for a pending relayout: {}\n",
        s.resizes_held
    );
    report += &format!(
        "ui-host pointer events placed without the page's layout at its size: {}\n",
        s.pointers_unplaced
    );
    report += &format!(
        "ui-host rects that outline no element of the page: {}\n",
        s.rects_unnamed
    );
    report += &format!(
        "ui-host frames that waited for the GPU to finish the previous publication: {}\n",
        s.gpu_waits
    );
    report += &format!(
        "ui-host per published frame ms: paint {}\n",
        s.paint.summary()
    );
    report += &format!(
        "ui-host per published frame ms: export (blit+flush+Signal) {}\n",
        s.export.summary()
    );
    report += &format!(
        "ui-host per published frame ms: swap {}\n",
        s.swap.summary()
    );
    report += &format!(
        "ui-host per published frame ms: total {}\n",
        s.total.summary()
    );
    report += &format!("ui-host patch evaluation ms: {}\n", s.round_trip.summary());
    report += &format!(
        "ui-host evaluation start to Servo frame ms: {}\n",
        s.eval_to_frame.summary()
    );
    report += &memory_line();
    eprint!("{report}");
}

fn memory_line() -> String {
    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    // SAFETY: correctly sized out-parameter for the current process.
    let ok = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if ok.is_ok() {
        format!(
            "ui-host memory: working set {:.0} MB, peak {:.0} MB, private {:.0} MB\n",
            counters.WorkingSetSize as f64 / 1048576.0,
            counters.PeakWorkingSetSize as f64 / 1048576.0,
            counters.PagefileUsage as f64 / 1048576.0
        )
    } else {
        String::new()
    }
}

// Adapted from grafting's surfman_gl/windows_dx12_shared.rs (MPL-2.0).
fn create_shared_texture(device: &ID3D11Device, size: PhysicalSize<u32>) -> ID3D11Texture2D {
    let mut texture: Option<ID3D11Texture2D> = None;
    // SAFETY: valid descriptor; out-parameter receives the new texture.
    unsafe {
        device.CreateTexture2D(
            &D3D11_TEXTURE2D_DESC {
                Width: size.width,
                Height: size.height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: (D3D11_RESOURCE_MISC_SHARED.0 | D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0)
                    as u32,
            },
            None,
            Some(&mut texture),
        )
    }
    .expect("CreateTexture2D(shared)");
    texture.unwrap()
}

fn export_nt_handle(texture: &ID3D11Texture2D) -> HANDLE {
    // SAFETY: the texture was created SHARED | SHARED_NTHANDLE.
    unsafe {
        texture
            .cast::<IDXGIResource1>()
            .expect("IDXGIResource1")
            .CreateSharedHandle(None, GENERIC_ALL.0, PCWSTR::null())
            .expect("CreateSharedHandle")
    }
}

fn create_slot(
    d3d11: &ID3D11Device,
    frame_ctx: &grafting::surfman_gl::SurfmanFrameContext,
    size: PhysicalSize<u32>,
) -> (Slot, HANDLE) {
    let texture = create_shared_texture(d3d11, size);
    let handle = export_nt_handle(&texture);
    let device = frame_ctx.device.borrow();
    let mut context = frame_ctx.context.borrow_mut();
    device.make_context_current(&context).expect("make current");
    // SAFETY: Slot holds the texture until its surface texture is destroyed.
    let surface_texture = unsafe {
        let raw = texture.clone().into_raw();
        let comptr = wio::com::ComPtr::from_raw(raw as *mut _);
        device
            .create_surface_texture_from_texture(
                &mut context,
                &Size2D::new(size.width as i32, size.height as i32),
                comptr,
            )
            .expect("pbuffer from shared texture")
    };
    let gl_texture = device
        .surface_texture_object(&surface_texture)
        .expect("pbuffer GL texture");
    let gl = &frame_ctx.glow_gl;
    let framebuffer = unsafe {
        let draw = gl.create_framebuffer().expect("fbo");
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(draw));
        gl.framebuffer_texture_2d(
            glow::DRAW_FRAMEBUFFER,
            glow::COLOR_ATTACHMENT0,
            glow::TEXTURE_2D,
            Some(gl_texture),
            0,
        );
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None);
        draw
    };
    (
        Slot {
            _texture: texture,
            surface_texture: Some(surface_texture),
            framebuffer,
            pub_id: 0,
            published: Instant::now(),
            used: false,
            last_use: 0,
        },
        handle,
    )
}

fn destroy_slots(frame_ctx: &grafting::surfman_gl::SurfmanFrameContext, slots: &mut [Slot]) {
    let device = frame_ctx.device.borrow();
    let mut context = frame_ctx.context.borrow_mut();
    device.make_context_current(&context).expect("make current");
    for slot in slots {
        unsafe { frame_ctx.glow_gl.delete_framebuffer(slot.framebuffer) };
        let mut surface = device
            .destroy_surface_texture(&mut context, slot.surface_texture.take().unwrap())
            .map_err(|(e, _)| e)
            .expect("destroy pbuffer texture");
        device
            .destroy_surface(&mut context, &mut surface)
            .expect("destroy pbuffer");
    }
}

fn export_into(
    frame_ctx: &grafting::surfman_gl::SurfmanFrameContext,
    target: glow::NativeFramebuffer,
    size: PhysicalSize<u32>,
) {
    let device = frame_ctx.device.borrow();
    let context = frame_ctx.context.borrow();
    device.make_context_current(&context).expect("make current");
    let source_fbo = device
        .context_surface_info(&context)
        .ok()
        .flatten()
        .and_then(|info| info.framebuffer_object)
        .map(|fb| fb.0.get())
        .unwrap_or(0);
    let gl = &frame_ctx.glow_gl;
    unsafe {
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(target));
        gl.bind_framebuffer(
            glow::READ_FRAMEBUFFER,
            std::num::NonZeroU32::new(source_fbo).map(glow::NativeFramebuffer),
        );
        let (w, h) = (size.width as i32, size.height as i32);
        gl.blit_framebuffer(
            0,
            0,
            w,
            h,
            0,
            0,
            w,
            h,
            glow::COLOR_BUFFER_BIT,
            glow::NEAREST,
        );
        gl.flush();
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_resize_publishes_once_the_page_reports_the_new_size_and_settles() {
        let t = Instant::now();
        let ms = |n| t + Duration::from_millis(n);
        let mut relayout = Relayout::new((1680, 720), t);
        relayout.measured((1280, 720), ms(5));
        assert!(!relayout.done(ms(100)), "still laid out at the old size");
        relayout.measured((1680, 720), ms(120));
        relayout.measured((1680, 720), ms(140));
        assert!(!relayout.done(ms(159)));
        assert!(relayout.done(ms(160)));
        assert!(
            Relayout::new((1680, 720), t).done(ms(200)),
            "a page whose tick fails"
        );
    }

    /// The window grows 8 px every 16 ms for 2 s, the main loop runs every 4 ms, and the page
    /// reports the size it is laid out at 20 ms after each resize ui-host applies.
    #[test]
    fn a_continuous_resize_publishes_a_frame_at_a_current_size_every_250_ms() {
        let t = Instant::now();
        let mut size = (1280, 720);
        let mut waiting = Vec::new();
        let mut relayout: Option<Relayout> = None;
        let mut published = vec![(0, size)];
        for ms in (4..2000).step_by(4) {
            let now = t + Duration::from_millis(ms);
            if ms % 16 == 0 {
                waiting.push((1280 + ms as u32 / 2, 720));
            }
            if let Some(next) = next_resize(size, &mut waiting, relayout.is_some()) {
                size = next;
                relayout = Some(Relayout::new(size, now));
            }
            if let Some(relayout) = relayout.as_mut()
                && now - relayout.since >= Duration::from_millis(20)
            {
                relayout.measured(size, now);
            }
            if relayout.as_ref().is_some_and(|r| r.done(now)) {
                relayout = None;
                published.push((ms, size));
            }
        }
        published.push((2000, size));
        for pair in published.windows(2) {
            let ((from, a), (to, b)) = (pair[0], pair[1]);
            assert!(to - from <= 250, "no frame from {from} ms to {to} ms");
            assert!(
                to == 2000 || b.0 > a.0,
                "frame at {to} ms not at a newer size"
            );
        }
    }

    /// Frames as (ms, size).
    type Frames = Vec<(u64, (u32, u32))>;

    /// The drag above, with a host that opens each ring 70 ms after ui-host creates it and
    /// shows a ring's newest frame 4 ms after the later of the two. Returns the frames ui-host
    /// published and those the host showed.
    fn drag_with_a_host(opens: Option<u64>) -> (Frames, Frames) {
        let t = Instant::now();
        let mut size = (1280, 720);
        let mut waiting = Vec::new();
        let mut relayout: Option<Relayout> = None;
        let mut unshown = Unshown::default();
        let (mut ring_at, mut pub_id) = (0, 0);
        let mut pending: Option<(u64, u64)> = None;
        let (mut published, mut shown) = (vec![(0, size)], vec![(0, size)]);
        for ms in (4..2000).step_by(4) {
            let now = t + Duration::from_millis(ms);
            if ms % 16 == 0 {
                waiting.push((1280 + ms as u32 / 2, 720));
            }
            let blocked = relayout.is_some() || unshown.holds(now);
            if let Some(next) = next_resize(size, &mut waiting, blocked) {
                size = next;
                relayout = Some(Relayout::new(size, now));
                unshown = Unshown::default();
                (ring_at, pending) = (ms, None);
            }
            if let Some(relayout) = relayout.as_mut()
                && now - relayout.since >= Duration::from_millis(20)
            {
                relayout.measured(size, now);
            }
            if relayout.as_ref().is_some_and(|r| r.done(now)) {
                relayout = None;
                pub_id += 1;
                unshown.published(pub_id, now);
                pending = Some((pub_id, ms));
                published.push((ms, size));
            }
            if let (Some(open), Some((id, at))) = (opens, pending)
                && ms >= (ring_at + open).max(at) + 4
            {
                unshown.picked(id);
                pending = None;
                shown.push((ms, size));
            }
        }
        (published, shown)
    }

    #[test]
    fn a_continuous_resize_shows_a_frame_of_every_ring_it_publishes() {
        let (published, shown) = drag_with_a_host(Some(70));
        for pair in published.windows(2) {
            let ((from, size), (to, _)) = (pair[0], pair[1]);
            assert!(
                shown
                    .iter()
                    .any(|&(at, s)| s == size && (from..to).contains(&at)),
                "the frame published at {from} ms at {size:?} was not shown before {to} ms"
            );
        }
        for pair in shown.windows(2) {
            let ((from, a), (to, b)) = (pair[0], pair[1]);
            assert!(
                to - from <= 250,
                "the HUD kept {a:?} from {from} ms to {to} ms"
            );
            assert!(b.0 > a.0);
        }
    }

    #[test]
    fn a_continuous_resize_goes_on_when_the_host_shows_nothing() {
        let (published, shown) = drag_with_a_host(None);
        assert_eq!(shown.len(), 1);
        for pair in published.windows(2) {
            let ((from, _), (to, _)) = (pair[0], pair[1]);
            assert!(to - from <= 250, "no frame from {from} ms to {to} ms");
        }
        assert!(published.len() > 10);
    }

    #[test]
    fn timing_samples_remain_bounded() {
        let mut samples = Samples::default();
        for i in 0..10_000 {
            samples.push(Duration::from_millis(i));
        }
        assert_eq!(samples.0.len(), 1024);
        assert_eq!(samples.0.front(), Some(&8976.0));
    }

    #[test]
    fn tick_source_is_retained_only_after_a_successful_evaluation() {
        let mut script = TickScript::default();
        assert!(script.next("1").contains(proto::TICK));
        script.finished(0, false);
        assert!(script.next("2").contains(proto::TICK));
        script.finished(0, true);
        let cached = script.next("3");
        assert!(!cached.contains(proto::TICK));
        assert!(cached.contains("__bridge.tick(3)"));
        script.finished(0, false);
        assert!(script.next("4").contains(proto::TICK));
        assert!(TickScript::default().next("5").contains(proto::TICK));
    }

    #[test]
    fn an_old_document_cannot_acknowledge_a_new_documents_tick_source() {
        let mut script = TickScript::default();
        script.finished(0, true);
        script.navigated();
        script.finished(0, true);
        assert!(script.next("1").contains(proto::TICK));
        script.finished(1, true);
        assert!(!script.next("2").contains(proto::TICK));
    }

    fn tick(seq: u64, state: &str) -> Option<(u64, String)> {
        Some((seq, state.to_owned()))
    }

    #[test]
    fn evaluates_the_newest_state_no_faster_than_frames() {
        let t = Instant::now();
        let ms = |n| t + Duration::from_millis(n);
        let mut pacer = Pacer::default();
        assert!(pacer.ready(t));
        assert!(!pacer.ready(t));
        pacer.patch(1, "1".into(), ms(2));
        assert_eq!(pacer.next(ms(2)), tick(1, "1"));
        assert_eq!(pacer.next(ms(2)), None);
        pacer.finished();
        pacer.patch(2, "2".into(), ms(5));
        pacer.patch(3, "3".into(), ms(6));
        assert_eq!(pacer.next(ms(10)), None, "sooner than the render interval");
        assert_eq!(pacer.next(ms(22)), tick(3, "3"));
        pacer.finished();
        pacer.patch(4, "4".into(), ms(30));
        assert_eq!(pacer.next(ms(45)), None, "two evaluations await frames");
        assert_eq!(pacer.painted(ms(46)), Some(Duration::from_millis(44)));
        assert_eq!(pacer.next(ms(46)), tick(4, "4"));
        pacer.finished();
        assert!(!pacer.ready(ms(50)));
        assert!(
            pacer.ready(ms(64)),
            "asks for state early by the response time"
        );
        assert_eq!(pacer.deadline(ms(64)), Some(ms(66)));
        pacer.patch(5, "5".into(), ms(67));
        assert_eq!(pacer.next(ms(67)), None);
        assert_eq!(pacer.next(ms(72)), tick(5, "5"), "a frame that never came");
    }

    #[test]
    fn polls_the_current_state_after_input_and_when_idle() {
        let t = Instant::now();
        let ms = |n| t + Duration::from_millis(n);
        let mut pacer = Pacer::default();
        pacer.input_handled();
        assert_eq!(pacer.next(ms(200)), None, "no state yet");
        pacer.patch(5, "5".into(), t);
        assert_eq!(pacer.next(t), tick(5, "5"));
        pacer.finished();
        pacer.painted(t);
        assert_eq!(pacer.next(ms(30)), None);
        pacer.input_handled();
        assert_eq!(pacer.next(ms(30)), tick(0, "5"));
        pacer.finished();
        pacer.painted(ms(31));
        assert_eq!(pacer.next(ms(100)), None);
        assert_eq!(pacer.next(ms(130)), tick(0, "5"));
    }
}
