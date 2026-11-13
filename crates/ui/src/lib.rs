// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

mod pointers;
mod rings;

use anyhow::{Context, Result, bail};
use std::{
    collections::VecDeque,
    fs::{File, OpenOptions},
    io::{BufReader, Write},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use threejsc_ipc::{self as proto, Msg, place, reply};
use windows::{
    Win32::{
        Foundation::{
            DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING,
            GENERIC_ALL, HANDLE,
        },
        Graphics::Direct3D12::{
            D3D12_FENCE_FLAG_SHARED, ID3D12CommandQueue, ID3D12Device, ID3D12Fence, ID3D12Resource,
        },
        Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX},
        System::{
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_NOWAIT,
                PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
                SetNamedPipeHandleState,
            },
            Threading::GetCurrentProcess,
        },
    },
    core::{HSTRING, PCWSTR},
};

struct D3d {
    device: ID3D12Device,
    queue: ID3D12CommandQueue,
    ready: ID3D12Fence,
    done: ID3D12Fence,
    ready_handle: OwnedHandle,
    done_handle: OwnedHandle,
    luid: (i32, u32),
}
struct Slot {
    _texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
}
/// What a worker thread needs to wrap a ring's shared textures for compositing.
#[derive(Clone)]
struct Importer {
    d3d: ID3D12Device,
    device: wgpu::Device,
    layout: wgpu::BindGroupLayout,
}
/// A ring whose textures a worker is opening, off the game thread.
struct Import {
    generation: u64,
    slots: mpsc::Receiver<Result<Vec<Slot>>>,
    started: Instant,
}
/// A message from ui-host. The pipe reader parses replies so the game thread does not.
enum Incoming {
    Msg(Msg),
    Reply(u64, pointers::Size, reply::Reply),
}
struct Link {
    child: Child,
    tx: mpsc::Sender<Msg>,
    rx: mpsc::Receiver<Incoming>,
    rings: rings::Rings<Slot>,
    import: Option<Import>,
    /// The size ui-host was last asked to render at.
    requested: (u32, u32),
    shown: bool,
    /// The publication on screen.
    shown_pub: u64,
    sent_patches: VecDeque<(u64, Instant)>,
    rtt_ms: Vec<f64>,
    last_report: Instant,
    connected_at: Instant,
}
enum Connection {
    Launching(mpsc::Receiver<Result<Link>>),
    Running(Box<Link>),
    Backoff(Instant),
}

/// Largest UI state, as JSON text, that the game may send.
pub const MAX_STATE_BYTES: usize = proto::MAX_JSON;
/// Most page events the game receives in one frame.
pub const MAX_EVENTS_PER_FRAME: usize = 256;
/// Most page events waiting for the game; events past it count as dropped.
pub const MAX_QUEUED_EVENTS: usize = 4096;

/// What the game receives from the UI this frame.
#[derive(Debug, Default, PartialEq)]
pub struct Delivery {
    /// Page events as a JSON array, when there are any.
    pub events: Option<String>,
    /// Page events dropped since the last delivery.
    pub dropped: u64,
    /// Diagnostics for the host log.
    pub notes: Vec<String>,
}

fn retry_delay(failures: u32) -> Duration {
    if failures <= 1 {
        Duration::ZERO
    } else {
        Duration::from_millis(500)
    }
}

fn create_pipe(name: &str) -> Result<File> {
    let handle = unsafe {
        CreateNamedPipeW(
            &HSTRING::from(name),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            1 << 16,
            1 << 16,
            0,
            None,
        )
    };
    if handle.is_invalid() {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_handle(handle.0) })
}

fn connect(pipe: &File, child: &mut Child, deadline: Instant) -> Result<()> {
    let handle = HANDLE(pipe.as_raw_handle());
    loop {
        match unsafe { ConnectNamedPipe(handle, None) } {
            Ok(()) => break,
            Err(error) if error.code() == ERROR_PIPE_CONNECTED.to_hresult() => break,
            Err(error) if error.code() == ERROR_PIPE_LISTENING.to_hresult() => {
                if let Some(status) = child.try_wait()? {
                    bail!("ui-host exited before pipe connection: {status}");
                }
                if Instant::now() >= deadline {
                    bail!("ui-host pipe connection timed out");
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(error.into()),
        }
    }
    let mut pid = 0;
    unsafe { GetNamedPipeClientProcessId(handle, &mut pid)? };
    if pid != child.id() {
        bail!("unexpected ui-host pipe client {pid}");
    }
    unsafe { SetNamedPipeHandleState(handle, Some(&PIPE_WAIT), None, None)? };
    Ok(())
}

fn dup_into(child: HANDLE, handle: HANDLE) -> Result<u64> {
    let mut out = HANDLE::default();
    // SAFETY: both process handles are valid; out receives the duplicated handle.
    unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle,
            child,
            &mut out,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    }?;
    Ok(out.0 as u64)
}

fn dup_from(child: HANDLE, value: u64) -> Result<OwnedHandle> {
    let mut out = HANDLE::default();
    // SAFETY: the parent holds PROCESS_ALL_ACCESS on the child it spawned.
    unsafe {
        DuplicateHandle(
            child,
            HANDLE(value as *mut _),
            GetCurrentProcess(),
            &mut out,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    }?;
    // SAFETY: DuplicateHandle returned a new handle that nothing else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(out.0) })
}

fn launch(
    luid: (i32, u32),
    ready: usize,
    done: usize,
    base: u64,
    size: (u32, u32),
    page: String,
    log: File,
) -> Result<Link> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|error| anyhow::anyhow!("pipe name: {error}"))?;
    let name = format!(
        r"\\.\pipe\threejsc-{}",
        nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    let down = create_pipe(&format!("{name}-down"))?;
    let up = create_pipe(&format!("{name}-up"))?;
    let exe = std::env::current_exe()?.with_file_name("ui-host.exe");
    let mut child = Command::new(exe)
        .args([
            "--pipe",
            &name,
            "--luid",
            &format!("{}:{}", luid.0, luid.1),
            "--size",
            &format!("{}x{}", size.0, size.1),
            "--hud",
            &page,
            "--ring",
            "4",
        ])
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .spawn()
        .context("spawn ui-host")?;
    let connected = (|| -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        connect(&down, &mut child, deadline)?;
        connect(&up, &mut child, deadline)?;
        Ok(())
    })();
    if let Err(error) = connected {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let process = HANDLE(child.as_raw_handle());
    let hello = (|| -> Result<Msg> {
        Ok(Msg::Hello {
            ready_fence: dup_into(process, HANDLE(ready as *mut _))?,
            done_fence: dup_into(process, HANDLE(done as *mut _))?,
            ready_base: base,
            width: size.0,
            height: size.1,
        })
    })();
    let hello = match hello {
        Ok(hello) => hello,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let (tx, out) = mpsc::channel();
    tx.send(hello)?;
    std::thread::spawn(move || {
        let mut pipe = down;
        while let Ok(message) = out.recv() {
            if proto::write_msg(&mut pipe, &message).is_err() {
                break;
            }
        }
    });
    let (incoming, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut pipe = BufReader::new(up);
        while let Ok(message) = proto::read_msg(&mut pipe) {
            let message = match message {
                Msg::Events {
                    seq,
                    width,
                    height,
                    json,
                    ids,
                } => Incoming::Reply(seq, (width, height), reply::parse(&json, &ids)),
                message => Incoming::Msg(message),
            };
            if incoming.send(message).is_err() {
                break;
            }
        }
    });
    Ok(Link {
        child,
        tx,
        rx,
        rings: rings::Rings::default(),
        import: None,
        requested: size,
        shown: false,
        shown_pub: 0,
        sent_patches: VecDeque::new(),
        rtt_ms: Vec::new(),
        last_report: Instant::now(),
        connected_at: Instant::now(),
    })
}
impl Importer {
    fn import(&self, handle: OwnedHandle, width: u32, height: u32) -> Result<Slot> {
        let mut resource: Option<ID3D12Resource> = None;
        unsafe {
            self.d3d
                .OpenSharedHandle(HANDLE(handle.as_raw_handle()), &mut resource)?
        };
        let resource = resource.context("shared UI texture")?;
        let desc = unsafe { resource.GetDesc() };
        if (desc.Width, desc.Height) != (u64::from(width), height) {
            bail!(
                "shared UI texture is {}x{}, expected {width}x{height}",
                desc.Width,
                desc.Height
            );
        }
        let extent = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let texture = unsafe {
            let hal = wgpu_hal::dx12::Device::texture_from_raw(
                resource,
                wgpu::TextureFormat::Rgba8Unorm,
                wgpu::TextureDimension::D2,
                extent,
                1,
                1,
            );
            self.device.create_texture_from_hal::<wgpu_hal::api::Dx12>(
                hal,
                &wgpu::TextureDescriptor {
                    label: Some("ui slot"),
                    size: extent,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::TextureUses::UNINITIALIZED,
            )
        };
        let view = texture.create_view(&Default::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ui slot"),
            layout: &self.layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            }],
        });
        Ok(Slot {
            _texture: texture,
            bind_group,
        })
    }
    /// Opens the ring on a worker thread. The handles are already this process's.
    fn spawn(&self, handles: Vec<OwnedHandle>, generation: u64, size: (u32, u32)) -> Import {
        let importer = self.clone();
        let (tx, slots) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(
                handles
                    .into_iter()
                    .map(|handle| importer.import(handle, size.0, size.1))
                    .collect(),
            );
        });
        Import {
            generation,
            slots,
            started: Instant::now(),
        }
    }
}
/// Composites a blank texture into a scratch target, so that the first HUD frame does not
/// pay for the pipeline's first use: without this, the game's submission after its first
/// composite pass took about 0.5 ms longer. `Ui::new` runs off the game thread.
fn warm_up(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    pipeline: &wgpu::RenderPipeline,
    layout: &wgpu::BindGroupLayout,
    format: wgpu::TextureFormat,
) {
    let texture = |format, usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("ui warm-up"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    };
    let source = texture(
        wgpu::TextureFormat::Rgba8Unorm,
        wgpu::TextureUsages::TEXTURE_BINDING,
    );
    let target = texture(format, wgpu::TextureUsages::RENDER_ATTACHMENT);
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("ui warm-up"),
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(&source.create_view(&Default::default())),
        }],
    });
    let view = target.create_view(&Default::default());
    for _ in 0..2 {
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("ui warm-up"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit(Some(encoder.finish()));
    }
}
fn retire(mut link: Link, kill: bool) {
    let _ = link.tx.send(Msg::Shutdown);
    std::thread::spawn(move || {
        if kill {
            let _ = link.child.kill();
        }
        let _ = link.child.wait();
    });
}

impl D3d {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Result<Self> {
        unsafe {
            let raw = device
                .as_hal::<wgpu::wgc::api::Dx12>()
                .context("DX12 device")?
                .raw_device()
                .clone();
            let q = queue
                .as_hal::<wgpu::wgc::api::Dx12>()
                .context("DX12 queue")?
                .as_raw()
                .clone();
            let ready = raw.CreateFence(0, D3D12_FENCE_FLAG_SHARED)?;
            let done = raw.CreateFence(0, D3D12_FENCE_FLAG_SHARED)?;
            let ready_handle = OwnedHandle::from_raw_handle(
                raw.CreateSharedHandle(&ready, None, GENERIC_ALL.0, PCWSTR::null())?
                    .0,
            );
            let done_handle = OwnedHandle::from_raw_handle(
                raw.CreateSharedHandle(&done, None, GENERIC_ALL.0, PCWSTR::null())?
                    .0,
            );
            let luid = raw.GetAdapterLuid();
            Ok(D3d {
                device: raw,
                queue: q,
                ready,
                done,
                ready_handle,
                done_handle,
                luid: (luid.HighPart, luid.LowPart),
            })
        }
    }
}

/// The pipeline that composites a HUD slot over a `format` target, and its bind group layout.
fn composite_pipeline(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
) -> (wgpu::BindGroupLayout, wgpu::RenderPipeline) {
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("ui layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        }],
    });
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("ui composite"),
        source: wgpu::ShaderSource::Wgsl(COMPOSITE_WGSL.into()),
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("ui pipeline"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("ui composite"),
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
                blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    (layout, pipeline)
}

pub struct Ui {
    d3d: D3d,
    connection: Connection,
    page: String,
    size: (u32, u32),
    max_ready: u64,
    failures: u32,
    pipeline: wgpu::RenderPipeline,
    importer: Importer,
    /// The game's latest state, resent to each new ui-host.
    state: Option<String>,
    state_sent: bool,
    can_send: bool,
    pointers: pointers::Pointers,
    events: VecDeque<String>,
    dropped: u64,
    notes: Vec<String>,
    last_failure: Option<String>,
    /// The game frame of the last `update`.
    frame: u64,
}
impl Ui {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        page: String,
        size: (u32, u32),
    ) -> Result<Self> {
        let d3d = D3d::new(device, queue)?;
        let (layout, pipeline) = composite_pipeline(device, format);
        warm_up(device, queue, &pipeline, &layout, format);
        let importer = Importer {
            d3d: d3d.device.clone(),
            device: device.clone(),
            layout,
        };
        let mut ui = Self {
            d3d,
            connection: Connection::Backoff(Instant::now()),
            page,
            size,
            max_ready: 0,
            failures: 0,
            pipeline,
            importer,
            state: None,
            state_sent: false,
            can_send: false,
            pointers: pointers::Pointers::default(),
            events: VecDeque::new(),
            dropped: 0,
            notes: Vec::new(),
            last_failure: None,
            frame: 0,
        };
        ui.start();
        Ok(ui)
    }
    fn retry(&mut self, failure: String) -> Connection {
        self.notes.push(failure.clone());
        self.last_failure = Some(failure);
        self.failures = self.failures.saturating_add(1);
        Connection::Backoff(Instant::now() + retry_delay(self.failures))
    }
    /// Opens ui-host.log for the next ui-host: truncated for the process's first, appended to
    /// after, so a relaunch keeps the earlier instances' records. The count is the process's, not
    /// this UI's, because a UI that replaces another on a new device writes to the same log.
    fn open_log(&mut self) -> Result<File> {
        static LAUNCHES: AtomicU32 = AtomicU32::new(0);
        let launches = LAUNCHES.fetch_add(1, Ordering::Relaxed) + 1;
        if launches == 1 {
            return Ok(File::create("ui-host.log")?);
        }
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open("ui-host.log")?;
        writeln!(
            log,
            "[host] ui-host launch {} after: {}",
            launches,
            self.last_failure
                .as_deref()
                .unwrap_or("the GPU device was replaced")
        )?;
        Ok(log)
    }
    fn start(&mut self) {
        let log = match self.open_log() {
            Ok(log) => log,
            Err(error) => {
                self.connection = self.retry(format!("ui-host log: {error:#}"));
                return;
            }
        };
        let (tx, rx) = mpsc::channel();
        let (luid, ready, done, base, size, page) = (
            self.d3d.luid,
            self.d3d.ready_handle.as_raw_handle() as usize,
            self.d3d.done_handle.as_raw_handle() as usize,
            self.max_ready
                .max(unsafe { self.d3d.ready.GetCompletedValue() })
                + 1,
            self.size,
            self.page.clone(),
        );
        std::thread::spawn(move || {
            if let Err(mpsc::SendError(Ok(link))) =
                tx.send(launch(luid, ready, done, base, size, page, log))
            {
                retire(link, true);
            }
        });
        self.connection = Connection::Launching(rx);
    }
    /// The game's latest state, for the UI that replaces this one on a new device.
    pub fn into_state(mut self) -> Option<String> {
        self.state.take()
    }
    pub fn update(
        &mut self,
        frame: u64,
        size: (u32, u32),
        patch: Option<String>,
    ) -> Result<Delivery> {
        self.frame = frame;
        if let Some(patch) = patch {
            self.state = Some(patch);
            self.state_sent = false;
        }
        if size.0 > 0 && size.1 > 0 {
            self.size = size;
        }
        if let Connection::Launching(rx) = &self.connection {
            match rx.try_recv() {
                Ok(Ok(link)) => {
                    self.connection = Connection::Running(Box::new(link));
                }
                Ok(Err(error)) => {
                    self.connection = self.retry(format!("ui-host launch: {error:#}"))
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.connection = self.retry("ui-host launch thread stopped".into())
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if matches!(self.connection, Connection::Backoff(at) if Instant::now() >= at) {
            self.start();
        }
        let state = std::mem::replace(
            &mut self.connection,
            Connection::Backoff(Instant::now() + Duration::from_millis(500)),
        );
        self.connection = if let Connection::Running(mut link) = state {
            if link.requested != self.size {
                let _ = link.tx.send(Msg::Resize {
                    width: self.size.0,
                    height: self.size.1,
                });
                link.requested = self.size;
            }
            let mut failure = match link.child.try_wait() {
                Ok(Some(status)) => Some(format!("ui-host exited: {status}")),
                Ok(None) => None,
                Err(error) => Some(format!("ui-host status: {error}")),
            };
            while failure.is_none() {
                match link.rx.try_recv() {
                    Ok(Incoming::Msg(Msg::Slots {
                        generation,
                        handles,
                        width,
                        height,
                    })) => {
                        let child = HANDLE(link.child.as_raw_handle());
                        let owned = handles
                            .into_iter()
                            .map(|handle| dup_from(child, handle))
                            .collect::<Result<_>>();
                        match owned {
                            Ok(owned) => {
                                link.import =
                                    Some(self.importer.spawn(owned, generation, (width, height)));
                                if let Some((unseen, (w, h))) =
                                    link.rings.announced(generation, (width, height))
                                {
                                    self.notes.push(format!(
                                        "UI ring {unseen} ({w}x{h}) replaced by ring {generation} \
                                         before its published frame was shown"
                                    ));
                                }
                            }
                            Err(error) => failure = Some(format!("ui-host slot import: {error:#}")),
                        }
                        let _ = link.tx.send(Msg::SlotsImported { generation });
                    }
                    Ok(Incoming::Msg(Msg::FrameReady {
                        slot,
                        pub_id,
                        ready_value,
                    })) => {
                        self.max_ready = self.max_ready.max(ready_value);
                        link.rings.published(slot as usize, pub_id, ready_value);
                    }
                    Ok(Incoming::Msg(Msg::Ready)) => self.can_send = true,
                    Ok(Incoming::Reply(seq, size, reply)) => {
                        if let Some((_, sent)) = link.sent_patches.iter().find(|(id, _)| *id == seq)
                        {
                            link.rtt_ms.push(sent.elapsed().as_secs_f64() * 1000.0);
                        }
                        link.sent_patches.retain(|(id, _)| *id > seq);
                        self.receive(link.rings.view(), seq, size, reply);
                    }
                    Ok(Incoming::Msg(Msg::Report { text })) => self.notes.push(text),
                    Ok(Incoming::Msg(_)) => {}
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        failure = Some("ui-host closed its pipe".into())
                    }
                }
            }
            if failure.is_none()
                && let Some(import) = &link.import
            {
                match import.slots.try_recv() {
                    Ok(Ok(slots)) => {
                        let took = import.started.elapsed();
                        if took >= Duration::from_millis(40) {
                            self.notes.push(format!(
                                "UI ring {} opened {} ms after its handles arrived",
                                import.generation,
                                took.as_millis()
                            ));
                        }
                        link.rings.opened(import.generation, slots);
                        link.import = None;
                    }
                    Ok(Err(error)) => failure = Some(format!("ui-host slot import: {error:#}")),
                    Err(mpsc::TryRecvError::Disconnected) => {
                        failure = Some("ui slot import thread stopped".into())
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            }
            if let Some(failure) = failure {
                self.pointers.clear();
                self.can_send = false;
                self.state_sent = false;
                if link.connected_at.elapsed() >= Duration::from_secs(5) {
                    self.failures = 0;
                }
                retire(*link, true);
                self.retry(failure)
            } else {
                let ready = unsafe { self.d3d.ready.GetCompletedValue() };
                if let Some(pub_id) = link.rings.pick(ready) {
                    link.shown_pub = pub_id;
                    if !link.shown {
                        link.shown = true;
                        self.notes
                            .push(format!("ui-host first frame shown at game frame {frame}"));
                    }
                    let _ = link.tx.send(Msg::Picked {
                        pub_id,
                        first_frame: frame,
                    });
                }
                if self.can_send
                    && !self.state_sent
                    && let Some(json) = &self.state
                {
                    if link
                        .tx
                        .send(Msg::Patch {
                            seq: frame,
                            json: json.clone(),
                        })
                        .is_ok()
                    {
                        link.sent_patches.push_back((frame, Instant::now()));
                        if link.sent_patches.len() > 256 {
                            link.sent_patches.pop_front();
                        }
                    }
                    self.can_send = false;
                    self.state_sent = true;
                }
                if link.last_report.elapsed() >= Duration::from_secs(5) {
                    if !link.rtt_ms.is_empty() {
                        link.rtt_ms.sort_by(f64::total_cmp);
                        let n = link.rtt_ms.len();
                        let text = format!(
                            "ui-host patch round trip ms: n={n} p50={:.3} p95={:.3}",
                            link.rtt_ms[(n - 1) / 2],
                            link.rtt_ms[((n - 1) * 95) / 100]
                        );
                        let _ = link.tx.send(Msg::Report { text });
                        link.rtt_ms.clear();
                    }
                    link.last_report = Instant::now();
                }
                Connection::Running(link)
            }
        } else {
            state
        };
        Ok(self.deliver())
    }
    fn receive(
        &mut self,
        view: pointers::View,
        seq: u64,
        size: pointers::Size,
        reply: reply::Reply,
    ) {
        self.notes.extend(
            reply
                .rejected
                .into_iter()
                .map(|item| format!("UI reply {seq} rejected: {item}")),
        );
        self.pointers.measured(view, size, reply.rects);
        self.dropped += reply.dropped as u64;
        for event in reply.events {
            if self.events.len() < MAX_QUEUED_EVENTS {
                self.events.push_back(event);
            } else {
                self.dropped += 1;
            }
        }
    }
    fn deliver(&mut self) -> Delivery {
        let n = self.events.len().min(MAX_EVENTS_PER_FRAME);
        Delivery {
            events: (n > 0)
                .then(|| format!("[{}]", self.events.drain(..n).collect::<Vec<_>>().join(","))),
            dropped: std::mem::take(&mut self.dropped),
            notes: std::mem::take(&mut self.notes),
        }
    }
    /// Whether the pointer input belongs to the page: it lands on one of the page's rects in
    /// the HUD frame on screen or, from a button down to the last button up, the down did. The
    /// game receives the input this returns false for. Page input goes to ui-host with the rect
    /// it was made over, and ui-host places it there in the page's current layout.
    pub fn pointer(&mut self, action: u8, x: f64, y: f64, button: i16) -> bool {
        let pointer = pointers::Pointer {
            action,
            x,
            y,
            button,
        };
        let link = match &self.connection {
            Connection::Running(link) => Some(link),
            _ => None,
        };
        let shown = link.and_then(|link| link.rings.view().shown);
        match self.pointers.pointer(shown, pointer) {
            pointers::Route::Game => false,
            pointers::Route::Page(at) => {
                if let Some(link) = link {
                    let (w, h) = shown.unwrap_or_default();
                    self.notes.push(format!(
                        "page pointer {action} at ({x}, {y}): publication {} on screen at \
                         {w}x{h}, hit-tested on the rects of reply {}",
                        link.shown_pub,
                        self.pointers.reply_at(shown).unwrap_or(0)
                    ));
                    let _ = link.tx.send(Msg::Pointer(place::Pointer {
                        action,
                        x: x as f32,
                        y: y as f32,
                        button,
                        size: shown.unwrap_or_default(),
                        at,
                    }));
                }
                true
            }
            pointers::Route::Neither => true,
        }
    }
    /// The HUD for the frame of the last `update`, which the render thread draws: the frame
    /// shown then, or nothing while no frame is shown.
    pub fn composite(&self) -> Composite {
        let slot = match &self.connection {
            Connection::Running(link) => link.rings.shown().map(|slot| slot.bind_group.clone()),
            _ => None,
        };
        Composite {
            device: self.importer.device.clone(),
            pipeline: self.pipeline.clone(),
            slot,
            queue: self.d3d.queue.clone(),
            done: self.d3d.done.clone(),
            frame: self.frame,
        }
    }
}
/// One frame's HUD, which the render thread draws over the frame: the slot shown in that frame,
/// what draws it, and the fence that tells ui-host when the GPU has finished with the slot.
pub struct Composite {
    device: wgpu::Device,
    pipeline: wgpu::RenderPipeline,
    slot: Option<wgpu::BindGroup>,
    queue: ID3D12CommandQueue,
    done: ID3D12Fence,
    frame: u64,
}
impl Composite {
    /// Draws the HUD over `view` with `encoder`, which `device` made. A HUD made on another
    /// device, one the game has since replaced, draws nothing.
    pub fn draw(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
    ) {
        let Some(slot) = self.slot.as_ref().filter(|_| *device == self.device) else {
            return;
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("ui composite"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, slot, &[]);
        pass.draw(0..3, 0..1);
    }
    /// Tells ui-host that the GPU is done with the slots of this frame and earlier ones. Call it
    /// after the queue submission that draws the frame.
    pub fn signal(&self) -> Result<()> {
        unsafe {
            self.queue.Signal(&self.done, self.frame)?;
        }
        Ok(())
    }
}

impl Drop for Ui {
    fn drop(&mut self) {
        if let Connection::Running(link) =
            std::mem::replace(&mut self.connection, Connection::Backoff(Instant::now()))
        {
            retire(*link, false);
        }
    }
}

/// Copies HUD texels one to one from the window's top-left corner. ui-host's rows run
/// bottom-up. A frame of an older ring size keeps its size until the new ring's first frame.
const COMPOSITE_WGSL: &str = r#"
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
    return vec4f(p[i], 0.0, 1.0);
}
@group(0) @binding(0) var hud: texture_2d<f32>;
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let size = vec2i(textureDimensions(hud));
    let texel = vec2i(i32(pos.x), size.y - 1 - i32(pos.y));
    if (texel.x >= size.x || texel.y < 0) {
        return vec4f(0.0);
    }
    return textureLoad(hud, texel, 0);
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;

    fn warp() -> wgpu::Adapter {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12,
            flags: wgpu::InstanceFlags::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::default(),
            display: None,
        });
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            force_fallback_adapter: true,
            ..Default::default()
        }))
        .expect("WARP adapter")
    }

    /// The pixel a 1x1 black target shows after `composite` draws over it with `device`.
    fn composited(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        composite: &Composite,
    ) -> Result<[u8; 4]> {
        let extent = wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        };
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bgra8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: u64::from(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        composite.draw(device, &mut encoder, &view);
        encoder.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT),
                    rows_per_image: None,
                },
            },
            extent,
        );
        queue.submit([encoder.finish()]);
        if let Some(error) = pollster::block_on(scope.pop()) {
            bail!("the composite raised a validation error: {error}");
        }
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::wait_indefinitely())?;
        let bytes = slice.get_mapped_range()?;
        Ok([bytes[0], bytes[1], bytes[2], bytes[3]])
    }

    #[test]
    fn a_composite_draws_on_its_own_device_only_and_signals_its_frame() -> Result<()> {
        use wgpu::util::DeviceExt;
        let adapter = warp();
        let (device, queue) = pollster::block_on(adapter.request_device(&Default::default()))?;
        let (other, other_queue) = pollster::block_on(adapter.request_device(&Default::default()))?;
        let d3d = D3d::new(&device, &queue)?;
        let (layout, pipeline) = composite_pipeline(&device, wgpu::TextureFormat::Bgra8Unorm);
        let slot = device.create_texture_with_data(
            &queue,
            &wgpu::TextureDescriptor {
                label: None,
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &[255, 0, 0, 255],
        );
        let slot = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(
                    &slot.create_view(&Default::default()),
                ),
            }],
        });
        let composite = Composite {
            device: device.clone(),
            pipeline,
            slot: Some(slot),
            queue: d3d.queue.clone(),
            done: d3d.done.clone(),
            frame: 7,
        };
        assert_eq!(
            composited(&device, &queue, &composite)?,
            [0, 0, 255, 255],
            "the slot's red over black, in BGRA"
        );
        assert_eq!(
            composited(&other, &other_queue, &composite)?,
            [0, 0, 0, 255],
            "a HUD from another device leaves the frame as it was"
        );
        composite.signal()?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while unsafe { d3d.done.GetCompletedValue() } < 7 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(unsafe { d3d.done.GetCompletedValue() }, 7);
        Ok(())
    }

    fn name() -> String {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).unwrap();
        format!(
            r"\\.\pipe\threejsc-test-{:032x}",
            u128::from_le_bytes(bytes)
        )
    }

    #[test]
    fn isolated_failure_retries_immediately_but_repeated_failures_wait() {
        assert_eq!(retry_delay(1), Duration::ZERO);
        assert_eq!(retry_delay(2), Duration::from_millis(500));
    }

    #[test]
    fn exited_child_does_not_leave_a_pipe_waiting() {
        for _ in 0..10 {
            let pipe = create_pipe(&name()).unwrap();
            let mut child = Command::new("cmd.exe")
                .args(["/C", "exit", "0"])
                .spawn()
                .unwrap();
            let started = Instant::now();
            assert!(connect(&pipe, &mut child, started + Duration::from_secs(2)).is_err());
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }

    #[test]
    fn pipe_rejects_another_process_and_a_second_server() {
        let name = name();
        let pipe = create_pipe(&name).unwrap();
        assert!(create_pipe(&name).is_err());
        let _client = OpenOptions::new().read(true).open(&name).unwrap();
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping -n 10 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        let result = connect(&pipe, &mut child, Instant::now() + Duration::from_secs(2));
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("unexpected ui-host pipe client")
        );
    }

    fn device() -> (wgpu::Device, wgpu::Queue) {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12,
            flags: wgpu::InstanceFlags::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::default(),
            display: None,
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .expect("DX12 adapter");
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("DX12 device")
    }

    /// Copies ui-host.exe and ANGLE from the release build beside this test binary, where
    /// `launch` looks for them.
    fn install_ui_host() {
        let exe = std::env::current_exe().unwrap();
        let deps = exe.parent().unwrap();
        for file in ["ui-host.exe", "libEGL.dll", "libGLESv2.dll"] {
            let built = deps.parent().unwrap().join(file);
            let bytes = std::fs::read(&built).unwrap_or_else(|_| panic!("build {file} first"));
            if std::fs::read(deps.join(file)).ok() != Some(bytes.clone()) {
                std::fs::write(deps.join(file), bytes).unwrap();
            }
        }
    }

    fn next_slots(link: &Link) -> (u64, Vec<u64>, (u32, u32)) {
        loop {
            if let Incoming::Msg(Msg::Slots {
                generation,
                handles,
                width,
                height,
            }) = link.rx.recv_timeout(Duration::from_secs(10)).unwrap()
            {
                return (generation, handles, (width, height));
            }
        }
    }

    #[test]
    #[ignore = "needs a DX12 GPU and a release ui-host.exe with ANGLE"]
    fn a_replaced_ring_stays_importable_until_the_host_answers() {
        install_ui_host();
        let (device, queue) = device();
        let page =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/hud/index.html");
        let page = std::fs::canonicalize(page).unwrap();
        let mut ui = Ui::new(
            &device,
            &queue,
            wgpu::TextureFormat::Bgra8Unorm,
            page.to_string_lossy().into_owned(),
            (640, 360),
        )
        .unwrap();
        let Connection::Launching(rx) =
            std::mem::replace(&mut ui.connection, Connection::Backoff(Instant::now()))
        else {
            panic!("ui-host is not launching");
        };
        let mut link = rx.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
        assert_eq!(next_slots(&link).2, (640, 360));
        link.tx
            .send(Msg::Resize {
                width: 800,
                height: 450,
            })
            .unwrap();
        let (_, replaced, size) = next_slots(&link);
        assert_eq!(size, (800, 450));
        link.tx
            .send(Msg::Resize {
                width: 960,
                height: 540,
            })
            .unwrap();
        let (newest, _, _) = next_slots(&link);
        let child = HANDLE(link.child.as_raw_handle());
        let imported: Result<Vec<_>> = replaced
            .into_iter()
            .map(|handle| ui.importer.import(dup_from(child, handle)?, 800, 450))
            .collect();
        let _ = link.tx.send(Msg::SlotsImported { generation: newest });
        let _ = link.child.kill();
        let _ = link.child.wait();
        assert_eq!(imported.unwrap().len(), 4);
    }
}
