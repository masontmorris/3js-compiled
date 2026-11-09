//! Spike 2: one process with V8 (deno_core) driving a "game", wgpu (DX12) rendering it, and
//! Servo rendering a transparent HUD that is imported zero-copy (via grafting) and
//! alpha-composited over the game. The game talks to the HUD only through a one-round-trip-
//! per-frame bridge: JS -> op -> WebView::evaluate_javascript -> page -> result -> op -> JS.
//!
//! Usage: spike-host [--frames N] [--novsync] [--paint-every-frame]

use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use deno_core::{JsRuntime, OpState, RuntimeOptions, extension, op2};
use euclid::Scale;
use servo::{
    EventLoopWaker, JSValue, Preferences, Servo, ServoBuilder, WebView, WebViewBuilder,
    WebViewDelegate,
};
use servo_wgpu_interop_adapter::ServoWgpuInteropAdapter;
use url::Url;
use winit::{
    application::ApplicationHandler,
    dpi::PhysicalSize,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy},
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
        let avg = v.iter().sum::<f64>() / v.len() as f64;
        format!(
            "n={} avg={avg:.3} p50={:.3} p95={:.3} max={:.3}",
            v.len(),
            pct(0.5),
            pct(0.95),
            pct(1.0)
        )
    }
}

#[derive(Default)]
struct Stats {
    spin: Samples,
    js_tick: Samples,
    servo_paint_import: Samples,
    servo_paint: Samples,
    import_present: Samples,
    game_composite: Samples,
    frame_cpu: Samples,
    frame_interval: Samples,
    bridge_rtt_ms: Samples,
    bridge_rtt_frames: Samples,
    bridge_errors: u64,
    imports: u64,
}

// ── Servo glue ──────────────────────────────────────────────────────────────

#[derive(Debug)]
struct WakerEvent;

#[derive(Clone)]
struct AppWaker(EventLoopProxy<WakerEvent>);

impl EventLoopWaker for AppWaker {
    fn clone_box(&self) -> Box<dyn EventLoopWaker> {
        Box::new(self.clone())
    }
    fn wake(&self) {
        let _ = self.0.send_event(WakerEvent);
    }
}

struct Delegate {
    window: Arc<Window>,
    new_frame: Rc<Cell<bool>>,
}

impl WebViewDelegate for Delegate {
    fn notify_new_frame_ready(&self, _webview: WebView) {
        self.new_frame.set(true);
        self.window.request_redraw();
    }
    fn notify_crashed(&self, _webview: WebView, reason: String, _backtrace: Option<String>) {
        eprintln!("[servo] CRASH: {reason}");
    }
}

// ── App ─────────────────────────────────────────────────────────────────────

struct Options {
    frames: u64,
    novsync: bool,
    paint_every_frame: bool,
}

enum App {
    Initial(AppWaker, Options),
    Running(Box<AppState>),
    Done,
}

struct AppState {
    window: Arc<Window>,
    servo: Servo,
    webview: WebView,
    interop: ServoWgpuInteropAdapter,
    renderer: Renderer,
    js: JsRuntime,
    new_frame: Rc<Cell<bool>>,
    inbox: Rc<RefCell<Vec<String>>>,
    frame_counter: Rc<Cell<u64>>,
    stats: Rc<RefCell<Stats>>,
    started: Instant,
    first_import_at: Option<Duration>,
    last_frame_at: Option<Instant>,
    options: Options,
    probed: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("failed to install rustls aws-lc provider");
    let args: Vec<String> = std::env::args().collect();
    let frames = args
        .iter()
        .position(|a| a == "--frames")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    let options = Options {
        frames,
        novsync: args.iter().any(|a| a == "--novsync"),
        paint_every_frame: args.iter().any(|a| a == "--paint-every-frame"),
    };
    let event_loop = EventLoop::with_user_event().build()?;
    let waker = AppWaker(event_loop.create_proxy());
    let mut app = App::Initial(waker, options);
    event_loop.run_app(&mut app)?;
    Ok(())
}

impl ApplicationHandler<WakerEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let App::Initial(waker, options) = std::mem::replace(self, App::Done) else {
            return;
        };
        let started = Instant::now();
        let window = Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes()
                        .with_title("spike-host")
                        .with_inner_size(PhysicalSize::new(1920u32, 1080u32)),
                )
                .expect("create window"),
        );
        let renderer = pollster::block_on(Renderer::new(window.clone(), options.novsync))
            .expect("create renderer");
        let size = window.inner_size();
        println!("window inner size: {}x{} scale={}", size.width, size.height, window.scale_factor());

        let interop =
            ServoWgpuInteropAdapter::new(renderer.device.clone(), renderer.queue.clone(), size)
                .expect("create Servo interop adapter");
        println!("interop capabilities: {:?}", interop.importer().host().capabilities());

        let mut preferences = Preferences::default();
        // Transparent page background so the HUD can sit over the game.
        preferences.shell_background_color_rgba = [0.0, 0.0, 0.0, 0.0];
        let servo = ServoBuilder::default()
            .preferences(preferences)
            .event_loop_waker(Box::new(waker))
            .build();
        servo.setup_logging();

        let new_frame = Rc::new(Cell::new(false));
        let hud = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("hud.html");
        let webview = WebViewBuilder::new(&servo, interop.rendering_context())
            .url(Url::from_file_path(&hud).expect("hud path"))
            .hidpi_scale_factor(Scale::new(window.scale_factor() as f32))
            .delegate(Rc::new(Delegate {
                window: window.clone(),
                new_frame: new_frame.clone(),
            }))
            .build();

        let t_js = Instant::now();
        let mut js = JsRuntime::new(RuntimeOptions {
            extensions: vec![bridge_ext::init()],
            ..Default::default()
        });
        js.execute_script("game.js", include_str!("../game.js"))
            .expect("load game.js");
        println!("deno_core runtime ready in {:.1} ms", t_js.elapsed().as_secs_f64() * 1000.0);

        window.request_redraw();
        *self = App::Running(Box::new(AppState {
            window,
            servo,
            webview,
            interop,
            renderer,
            js,
            new_frame,
            inbox: Rc::new(RefCell::new(Vec::new())),
            frame_counter: Rc::new(Cell::new(0)),
            stats: Rc::new(RefCell::new(Stats::default())),
            started,
            first_import_at: None,
            last_frame_at: None,
            options,
            probed: false,
        }));
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, _event: WakerEvent) {
        if let App::Running(state) = self {
            state.servo.spin_event_loop();
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _id: winit::window::WindowId,
        event: WindowEvent,
    ) {
        let App::Running(state) = self else { return };
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::RedrawRequested => {
                if state.frame() {
                    state.report();
                    // Skip Servo/V8 global teardown; this is a measurement run.
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
    /// Run one frame. Returns true when the requested frame count is reached.
    fn frame(&mut self) -> bool {
        let t0 = Instant::now();
        if let Some(last) = self.last_frame_at.replace(t0) {
            self.stats.borrow_mut().frame_interval.push(t0 - last);
        }

        // 1. Let Servo deliver evaluation results from earlier frames.
        self.servo.spin_event_loop();
        let t1 = Instant::now();

        // 2. Game tick in V8: consume HUD events, produce a state patch.
        {
            let op_state = self.js.op_state();
            let mut op_state = op_state.borrow_mut();
            let bridge = op_state.borrow_mut::<BridgeState>();
            bridge.incoming.append(&mut self.inbox.borrow_mut());
        }
        self.js.execute_script("tick", "tick()").expect("tick");
        let patch = self
            .js
            .op_state()
            .borrow_mut()
            .borrow_mut::<BridgeState>()
            .outgoing_patch
            .take();
        let t2 = Instant::now();

        // 3. Send the patch to the HUD page; the result (queued UI events) comes back async.
        if let Some(patch) = patch {
            let sent_at = Instant::now();
            let sent_frame = self.frame_counter.get();
            let frame_counter = self.frame_counter.clone();
            let inbox = self.inbox.clone();
            let stats = self.stats.clone();
            self.webview.evaluate_javascript(
                format!("__bridge.tick({patch})"),
                move |result| {
                    let mut stats = stats.borrow_mut();
                    match result {
                        Ok(JSValue::String(events)) => {
                            stats.bridge_rtt_ms.push(sent_at.elapsed());
                            stats
                                .bridge_rtt_frames
                                .push_ms((frame_counter.get() - sent_frame) as f64);
                            inbox.borrow_mut().push(events);
                        }
                        _ => stats.bridge_errors += 1,
                    }
                },
            );
        }

        // 4. Paint Servo and import its frame (GPU copy into a wgpu texture, no CPU readback).
        let t3 = Instant::now();
        if self.new_frame.replace(false) || self.options.paint_every_frame {
            self.webview.paint();
            let tp = Instant::now();
            self.interop.rendering_context().present();
            {
                let mut stats = self.stats.borrow_mut();
                stats.servo_paint.push(tp - t3);
                stats.import_present.push(tp.elapsed());
            }
            if let Some(imported) = self.interop.take_imported_texture() {
                self.stats.borrow_mut().imports += 1;
                if self.first_import_at.is_none() {
                    self.first_import_at = Some(self.started.elapsed());
                }
                self.renderer.set_hud(&imported.texture);
            }
        }
        let t4 = Instant::now();

        // 5. Draw the game, composite the HUD over it, present.
        self.renderer
            .render(self.started.elapsed().as_secs_f32())
            .expect("render");
        let t5 = Instant::now();

        {
            let mut stats = self.stats.borrow_mut();
            stats.spin.push(t1 - t0);
            stats.js_tick.push(t2 - t1);
            stats.servo_paint_import.push(t4 - t3);
            stats.game_composite.push(t5 - t4);
            stats.frame_cpu.push(t5 - t0);
        }

        let frame = self.frame_counter.get() + 1;
        self.frame_counter.set(frame);
        if !self.probed && frame >= 240 && self.renderer.hud_texture.is_some() {
            self.probed = true;
            self.probe_pixels();
        }
        frame >= self.options.frames
    }

    fn probe_pixels(&self) {
        let scale = self.window.scale_factor();
        let size = self.window.inner_size();
        let flip = flip_hud();
        let at = |x: f64, y: f64| {
            let y = (y * scale) as u32;
            ((x * scale) as u32, if flip { size.height - 1 - y } else { y })
        };
        let probes = [
            ("half-transparent red rgba(255,0,0,0.5)", at(100.0, 50.0)),
            ("opaque green", at(100.0, 110.0)),
            ("empty page area", at(size.width as f64 / 2.0 / scale, (size.height - 10) as f64 / scale)),
        ];
        for (label, (x, y)) in probes {
            match self.renderer.read_hud_pixel(x, y) {
                Ok(px) => println!("probe {label} @({x},{y}) = {px:?}"),
                Err(e) => println!("probe {label} failed: {e}"),
            }
        }
    }

    fn report(&self) {
        let stats = self.stats.borrow();
        let elapsed = self.started.elapsed().as_secs_f64();
        let frames = self.frame_counter.get();
        println!("=== spike-host report ({frames} frames, vsync={})", !self.options.novsync);
        println!("first imported HUD frame after {:?}", self.first_import_at);
        println!("servo imports: {} ({:.1}/s over run)", stats.imports, stats.imports as f64 / elapsed);
        println!("frame interval ms:        {}", stats.frame_interval.summary());
        println!("frame CPU ms:             {}", stats.frame_cpu.summary());
        println!("  servo spin ms:          {}", stats.spin.summary());
        println!("  js tick ms:             {}", stats.js_tick.summary());
        println!("  servo paint+import ms:  {}", stats.servo_paint_import.summary());
        println!("    WebView::paint ms:    {}", stats.servo_paint.summary());
        println!("    import+swap ms:       {}", stats.import_present.summary());
        println!("  game+composite ms:      {}", stats.game_composite.summary());
        println!("bridge RTT ms:            {}", stats.bridge_rtt_ms.summary());
        println!("bridge RTT frames:        {}", stats.bridge_rtt_frames.summary());
        println!("bridge errors (before page load): {}", stats.bridge_errors);
        print_memory();
    }
}

fn flip_hud() -> bool {
    std::env::var_os("SPIKE_NO_NORMALIZE").is_some()
}

fn print_memory() {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    // SAFETY: counters is a valid, correctly sized out-parameter for the current process.
    let ok = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if ok.is_ok() {
        println!(
            "memory: working set {:.0} MB, peak {:.0} MB, private {:.0} MB",
            counters.WorkingSetSize as f64 / 1048576.0,
            counters.PeakWorkingSetSize as f64 / 1048576.0,
            counters.PagefileUsage as f64 / 1048576.0
        );
    }
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
    hud_texture: Option<wgpu::Texture>,
    hud_bind_group: Option<wgpu::BindGroup>,
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
        for adapter in instance.enumerate_adapters(wgpu::Backends::all()).await {
            let info = adapter.get_info();
            println!("available adapter: {} ({:?}, {:?})", info.name, info.backend, info.device_type);
        }
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
                label: Some("spike-host-device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(|e| e.to_string())?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(wgpu::TextureFormat::is_srgb)
            .unwrap_or(caps.formats[0]);
        let size = window.inner_size();
        let present_mode = if novsync {
            wgpu::PresentMode::AutoNoVsync
        } else {
            wgpu::PresentMode::Fifo
        };
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
        println!("surface format {format:?}, present mode {present_mode:?}");

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
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms.as_entire_binding(),
            }],
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
        // With SPIKE_NO_NORMALIZE the HUD texture is the raw GL-orientation (bottom-left) shared
        // texture, so flip V while sampling instead of paying for the importer's copy pass.
        let composite_wgsl = if flip_hud() {
            COMPOSITE_WGSL.replace("o.uv = t[i];", "o.uv = vec2f(t[i].x, 1.0 - t[i].y);")
        } else {
            COMPOSITE_WGSL.to_string()
        };
        let composite_pipeline = make_pipeline(
            &device,
            &composite_layout,
            &composite_wgsl,
            format,
            Some(premultiplied_over),
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("hud-sampler"),
            ..Default::default()
        });

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
            hud_texture: None,
            hud_bind_group: None,
        })
    }

    fn set_hud(&mut self, texture: &wgpu::Texture) {
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.hud_bind_group = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("hud-bind-group"),
            layout: &self.composite_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        }));
        self.hud_texture = Some(texture.clone());
    }

    fn render(&self, time: f32) -> Result<(), String> {
        self.queue
            .write_buffer(&self.uniforms, 0, &[time, self.aspect, 0.0, 0.0].map(f32::to_le_bytes).concat());
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => return Ok(()),
            other => return Err(format!("surface texture unavailable: {other:?}")),
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
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
            if let Some(hud) = &self.hud_bind_group {
                pass.set_pipeline(&self.composite_pipeline);
                pass.set_bind_group(0, hud, &[]);
                pass.draw(0..3, 0..1);
            }
        }
        self.queue.submit(Some(encoder.finish()));
        self.queue.present(frame);
        Ok(())
    }

    fn read_hud_pixel(&self, x: u32, y: u32) -> Result<[u8; 4], String> {
        let texture = self.hud_texture.as_ref().ok_or("no HUD texture yet")?;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("probe"),
            size: wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("probe") });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT),
                    rows_per_image: Some(1),
                },
            },
            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        );
        self.queue.submit(Some(encoder.finish()));
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|e| e.to_string())?;
        let data = slice.get_mapped_range().map_err(|e| e.to_string())?;
        let px = [data[0], data[1], data[2], data[3]];
        drop(data);
        buffer.unmap();
        Ok(px)
    }
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
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend,
                write_mask: wgpu::ColorWrites::ALL,
            })],
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

// The imported texture is Rgba8Unorm holding sRGB-encoded, premultiplied values. Decode to
// linear for the sRGB swapchain (blending then happens in linear space, unlike a browser).
const COMPOSITE_WGSL: &str = r#"
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VO {
    var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
    var t = array<vec2f, 3>(vec2f(0.0, 2.0), vec2f(0.0, 0.0), vec2f(2.0, 0.0));
    var o: VO;
    o.pos = vec4f(p[i], 0.0, 1.0);
    o.uv = t[i];
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
