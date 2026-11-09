// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use threejsc_ipc as proto;

use std::{
    cell::{Cell, RefCell},
    fs::File,
    io::BufReader,
    os::windows::io::FromRawHandle,
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};

use dpi::PhysicalSize;
use euclid::{Scale, default::Size2D};
use glow::HasContext;
use proto::Msg;
use servo::{
    DevicePoint, EventLoopWaker, InputEvent, JSValue, MouseButton, MouseButtonAction,
    MouseButtonEvent, MouseMoveEvent, Preferences, ServoBuilder, WebView, WebViewBuilder,
    WebViewDelegate,
};
use servo_wgpu_interop_adapter::ServoWgpuRenderingContext;
use url::Url;
use windows::{
    Win32::{
        Foundation::{CloseHandle, GENERIC_ALL, GENERIC_READ, GENERIC_WRITE, HANDLE},
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
            Threading::GetCurrentProcess,
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
}

impl WebViewDelegate for Delegate {
    fn notify_new_frame_ready(&self, _webview: WebView) {
        self.new_frame.set(true);
    }
    fn notify_crashed(&self, _webview: WebView, reason: String, _backtrace: Option<String>) {
        eprintln!("[ui-host] servo crash: {reason}");
    }
}

/// One ring entry. `pub_id == 0` means never published.
struct Slot {
    texture: ID3D11Texture2D,
    _handle: HANDLE, // kept open for the process lifetime so the game can duplicate it
    pub_id: u64,
    used: bool,
    last_use: u64,
}

impl Drop for Slot {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self._handle);
        }
    }
}

#[derive(Default)]
struct Samples(Vec<f64>);

impl Samples {
    fn push(&mut self, d: Duration) {
        self.0.push(d.as_secs_f64() * 1000.0);
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
    first_paint: Option<Duration>,
    paint: Samples,
    export: Samples,
    swap: Samples,
    total: Samples,
    published: u64,
    skipped_no_free_slot: u64,
    patches_received: u64,
    patches_evaluated: u64,
    eval_errors: u64,
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

    let mut slots: Vec<Slot> = (0..ring)
        .map(|_| {
            let texture = create_shared_texture(&d3d11, size);
            let handle = export_nt_handle(&texture);
            Slot {
                texture,
                _handle: handle,
                pub_id: 0,
                used: false,
                last_use: 0,
            }
        })
        .collect();
    send(&Msg::Slots {
        handles: slots.iter().map(|s| s._handle.0 as u64).collect(),
        width: size.width,
        height: size.height,
    });

    let preferences = Preferences {
        shell_background_color_rgba: [0.0, 0.0, 0.0, 0.0],
        ..Preferences::default()
    };
    let servo = ServoBuilder::default()
        .preferences(preferences)
        .event_loop_waker(Box::new(Waker(tx.clone())))
        .build();
    servo.setup_logging();
    let new_frame = Rc::new(Cell::new(false));
    let webview = WebViewBuilder::new(&servo, ctx.clone())
        .url(Url::from_file_path(&hud).expect("hud path"))
        .hidpi_scale_factor(Scale::new(1.0))
        .delegate(Rc::new(Delegate {
            new_frame: new_frame.clone(),
        }))
        .build();

    let stats = Rc::new(RefCell::new(Stats::default()));
    let send = Rc::new(send);
    let mut next_pub: u64 = 0;
    let mut ready_value = ready_base;
    let mut picked: u64 = 0;
    let mut shutting_down = false;
    let mut last_paint = Instant::now();

    loop {
        let mut events = Vec::new();
        match rx.recv_timeout(Duration::from_millis(16)) {
            Ok(e) => events.push(e),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        events.extend(rx.try_iter());

        // Coalesce patches: state patches are snapshots, so only the newest needs evaluating.
        let mut newest_patch: Option<(u64, String)> = None;
        for event in events {
            match event {
                Event::Msg(Msg::Patch { seq, json }) => {
                    stats.borrow_mut().patches_received += 1;
                    newest_patch = Some((seq, json));
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
                }
                Event::Msg(Msg::Pointer {
                    action,
                    x,
                    y,
                    button,
                }) => {
                    let point = DevicePoint::new(x, y).into();
                    let input = if action == 0 {
                        InputEvent::MouseMove(MouseMoveEvent::new(point))
                    } else {
                        InputEvent::MouseButton(MouseButtonEvent::new(
                            if action == 1 {
                                MouseButtonAction::Down
                            } else {
                                MouseButtonAction::Up
                            },
                            MouseButton::from(button),
                            point,
                        ))
                    };
                    webview.notify_input_event(input);
                }
                Event::Msg(Msg::Resize { width, height }) if width > 0 && height > 0 => {
                    size = PhysicalSize::new(width, height);
                    webview.resize(size);
                    slots = (0..ring)
                        .map(|_| {
                            let texture = create_shared_texture(&d3d11, size);
                            let handle = export_nt_handle(&texture);
                            Slot {
                                texture,
                                _handle: handle,
                                pub_id: 0,
                                used: false,
                                last_use: 0,
                            }
                        })
                        .collect();
                    picked = 0;
                    send(&Msg::Slots {
                        handles: slots.iter().map(|s| s._handle.0 as u64).collect(),
                        width,
                        height,
                    });
                }
                Event::Msg(Msg::Shutdown) => shutting_down = true,
                Event::Disconnected => std::process::exit(0),
                Event::Msg(_) | Event::Wake => {}
            }
        }
        if shutting_down {
            break;
        }

        if let Some((seq, json)) = newest_patch {
            stats.borrow_mut().patches_evaluated += 1;
            let send = send.clone();
            let stats = stats.clone();
            webview.evaluate_javascript(
                format!("__bridge.tick({json})"),
                move |result| match result {
                    Ok(JSValue::String(events)) => send(&Msg::Events { seq, json: events }),
                    _ => stats.borrow_mut().eval_errors += 1,
                },
            );
        }

        servo.spin_event_loop();

        if new_frame.get() || last_paint.elapsed() >= Duration::from_millis(100) {
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
            let Some(index) = free else {
                stats.borrow_mut().skipped_no_free_slot += 1;
                continue;
            };
            new_frame.set(false);
            last_paint = Instant::now();

            let t0 = Instant::now();
            webview.paint();
            let t1 = Instant::now();
            ready_value += 1;
            export_into(&frame_ctx, &slots[index].texture, size);
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

            next_pub += 1;
            let slot = &mut slots[index];
            slot.pub_id = next_pub;
            slot.used = false;
            send(&Msg::FrameReady {
                slot: index as u8,
                pub_id: next_pub,
                ready_value,
            });

            let mut s = stats.borrow_mut();
            s.first_paint.get_or_insert(started.elapsed());
            s.paint.push(t1 - t0);
            s.export.push(t2 - t1);
            s.swap.push(t3 - t2);
            s.total.push(t3 - t0);
            s.published += 1;
        }
    }

    let s = stats.borrow();
    let mut report = String::new();
    report += &format!("ui-host first painted frame after {:?}\n", s.first_paint);
    report += &format!(
        "ui-host frames published: {}, skipped (no free ring slot): {}\n",
        s.published, s.skipped_no_free_slot
    );
    report += &format!(
        "ui-host patches received {} / evaluated {} (coalesced) / eval errors {}\n",
        s.patches_received, s.patches_evaluated, s.eval_errors
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
    report += &memory_line();
    send(&Msg::Report { text: report });
    std::process::exit(0);
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

/// Copy Servo's just-painted back buffer into `target` through a transient EGL pbuffer.
/// No `glFinish`: the caller orders the copy with a D3D11 fence signal on the same context.
/// Adapted from grafting's surfman_gl/windows_dx12_shared.rs (MPL-2.0).
fn export_into(
    frame_ctx: &grafting::surfman_gl::SurfmanFrameContext,
    target: &ID3D11Texture2D,
    size: PhysicalSize<u32>,
) {
    let device = frame_ctx.device.borrow();
    let mut context = frame_ctx.context.borrow_mut();
    device.make_context_current(&context).expect("make current");
    let source_fbo = device
        .context_surface_info(&context)
        .ok()
        .flatten()
        .and_then(|info| info.framebuffer_object)
        .map(|fb| fb.0.get())
        .unwrap_or(0);
    let gl = &frame_ctx.glow_gl;
    // SAFETY: the texture outlives the transient pbuffer; ComPtr takes its own reference.
    let surface_texture = unsafe {
        let raw = target.clone().into_raw();
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
    unsafe {
        let draw = gl.create_framebuffer().expect("fbo");
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(draw));
        gl.framebuffer_texture_2d(
            glow::DRAW_FRAMEBUFFER,
            glow::COLOR_ATTACHMENT0,
            glow::TEXTURE_2D,
            Some(gl_texture),
            0,
        );
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
        gl.delete_framebuffer(draw);
    }
    let mut surface = device
        .destroy_surface_texture(&mut context, surface_texture)
        .map_err(|(e, _)| e)
        .expect("destroy pbuffer texture");
    device
        .destroy_surface(&mut context, &mut surface)
        .expect("destroy pbuffer");
}
