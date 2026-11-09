// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use anyhow::{Context, Result, bail};
use std::{
    collections::VecDeque,
    fs::File,
    io::BufReader,
    os::windows::io::{AsRawHandle, FromRawHandle},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use threejsc_ipc::{self as proto, Msg};
use windows::{
    Win32::{
        Foundation::{
            CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_PIPE_CONNECTED,
            ERROR_PIPE_LISTENING, GENERIC_ALL, HANDLE,
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
    ready_handle: HANDLE,
    done_handle: HANDLE,
    luid: (i32, u32),
}
impl Drop for D3d {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.ready_handle);
            let _ = CloseHandle(self.done_handle);
        }
    }
}
struct Slot {
    _texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
}
struct Published {
    slot: usize,
    id: u64,
    ready: u64,
}
struct Link {
    child: Child,
    tx: mpsc::Sender<Msg>,
    rx: mpsc::Receiver<Msg>,
    slots: Vec<Slot>,
    published: Vec<Published>,
    current: Option<(usize, u64)>,
    size: (u32, u32),
    awaiting_resize: bool,
    sent_patches: VecDeque<(u64, Instant)>,
    rtt_ms: Vec<f64>,
    last_report: Instant,
    connected_at: Instant,
}
enum Connection {
    Launching(mpsc::Receiver<Result<Link>>),
    Running(Link),
    Backoff(Instant),
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

fn dup_from(child: HANDLE, value: u64) -> Result<HANDLE> {
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
    Ok(out)
}

fn launch(
    luid: (i32, u32),
    ready: usize,
    done: usize,
    base: u64,
    size: (u32, u32),
    page: String,
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
    let log = File::create("ui-host.log")?;
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
            if incoming.send(message).is_err() {
                break;
            }
        }
    });
    Ok(Link {
        child,
        tx,
        rx,
        slots: Vec::new(),
        published: Vec::new(),
        current: None,
        size,
        awaiting_resize: false,
        sent_patches: VecDeque::new(),
        rtt_ms: Vec::new(),
        last_report: Instant::now(),
        connected_at: Instant::now(),
    })
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

pub struct Ui {
    d3d: D3d,
    connection: Connection,
    page: String,
    size: (u32, u32),
    max_ready: u64,
    failures: u32,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    pending_patch: Option<String>,
    can_send: bool,
    rects: Vec<[f64; 4]>,
}
impl Ui {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        page: String,
        size: (u32, u32),
    ) -> Result<Self> {
        let d3d = unsafe {
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
            let ready_handle =
                raw.CreateSharedHandle(&ready, None, GENERIC_ALL.0, PCWSTR::null())?;
            let done_handle = raw.CreateSharedHandle(&done, None, GENERIC_ALL.0, PCWSTR::null())?;
            let luid = raw.GetAdapterLuid();
            D3d {
                device: raw,
                queue: q,
                ready,
                done,
                ready_handle,
                done_handle,
                luid: (luid.HighPart, luid.LowPart),
            }
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ui layout"),
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
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());
        let mut ui = Self {
            d3d,
            connection: Connection::Backoff(Instant::now()),
            page,
            size,
            max_ready: 0,
            failures: 0,
            pipeline,
            layout,
            sampler,
            pending_patch: None,
            can_send: false,
            rects: Vec::new(),
        };
        ui.start();
        Ok(ui)
    }
    fn retry(&mut self) -> Connection {
        self.failures = self.failures.saturating_add(1);
        Connection::Backoff(Instant::now() + retry_delay(self.failures))
    }
    fn start(&mut self) {
        let (tx, rx) = mpsc::channel();
        let (luid, ready, done, base, size, page) = (
            self.d3d.luid,
            self.d3d.ready_handle.0 as usize,
            self.d3d.done_handle.0 as usize,
            self.max_ready
                .max(unsafe { self.d3d.ready.GetCompletedValue() })
                + 1,
            self.size,
            self.page.clone(),
        );
        std::thread::spawn(move || {
            if let Err(mpsc::SendError(Ok(link))) =
                tx.send(launch(luid, ready, done, base, size, page))
            {
                retire(link, true);
            }
        });
        self.connection = Connection::Launching(rx);
    }
    fn import(
        &self,
        device: &wgpu::Device,
        handle: HANDLE,
        width: u32,
        height: u32,
    ) -> Result<Slot> {
        let mut resource: Option<ID3D12Resource> = None;
        unsafe {
            self.d3d.device.OpenSharedHandle(handle, &mut resource)?;
            let _ = CloseHandle(handle);
        }
        let extent = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let texture = unsafe {
            let hal = wgpu_hal::dx12::Device::texture_from_raw(
                resource.context("shared UI texture")?,
                wgpu::TextureFormat::Rgba8Unorm,
                wgpu::TextureDimension::D2,
                extent,
                1,
                1,
            );
            device.create_texture_from_hal::<wgpu_hal::api::Dx12>(
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
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ui slot"),
            layout: &self.layout,
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
        });
        Ok(Slot {
            _texture: texture,
            bind_group,
        })
    }
    pub fn update(
        &mut self,
        device: &wgpu::Device,
        frame: u64,
        size: (u32, u32),
        patch: Option<String>,
    ) -> Result<Vec<String>> {
        if let Some(patch) = patch {
            self.pending_patch = Some(patch);
        }
        if size.0 > 0 && size.1 > 0 && size != self.size {
            self.size = size;
            if let Connection::Running(link) = &mut self.connection
                && !link.slots.is_empty()
            {
                let _ = link.tx.send(Msg::Resize {
                    width: size.0,
                    height: size.1,
                });
                link.size = size;
                link.awaiting_resize = true;
                link.current = None;
                link.published.clear();
            }
        }
        if let Connection::Launching(rx) = &self.connection {
            match rx.try_recv() {
                Ok(Ok(link)) => {
                    self.connection = Connection::Running(link);
                    self.can_send = true;
                }
                Ok(Err(error)) => {
                    eprintln!("ui-host launch: {error:#}");
                    self.connection = self.retry();
                }
                Err(mpsc::TryRecvError::Disconnected) => self.connection = self.retry(),
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
        let mut events = Vec::new();
        self.connection = if let Connection::Running(mut link) = state {
            let mut disconnected = matches!(link.child.try_wait(), Ok(Some(_)) | Err(_));
            while !disconnected {
                match link.rx.try_recv() {
                    Ok(Msg::Slots {
                        handles,
                        width,
                        height,
                    }) => {
                        let child = HANDLE(link.child.as_raw_handle());
                        let imported = handles
                            .into_iter()
                            .map(|handle| {
                                self.import(device, dup_from(child, handle)?, width, height)
                            })
                            .collect::<Result<_>>();
                        match imported {
                            Ok(slots) => link.slots = slots,
                            Err(error) => {
                                eprintln!("ui-host slot import: {error:#}");
                                disconnected = true;
                                break;
                            }
                        }
                        link.current = None;
                        link.published.clear();
                        link.awaiting_resize = (width, height) != self.size;
                        if link.size != self.size {
                            link.size = self.size;
                            let _ = link.tx.send(Msg::Resize {
                                width: self.size.0,
                                height: self.size.1,
                            });
                        }
                    }
                    Ok(Msg::FrameReady {
                        slot,
                        pub_id,
                        ready_value,
                    }) => {
                        self.max_ready = self.max_ready.max(ready_value);
                        if link.awaiting_resize {
                            continue;
                        }
                        link.published.push(Published {
                            slot: slot as usize,
                            id: pub_id,
                            ready: ready_value,
                        });
                        self.can_send = true;
                    }
                    Ok(Msg::Events { seq, json }) => {
                        if let Some((_, sent)) = link.sent_patches.iter().find(|(id, _)| *id == seq)
                        {
                            link.rtt_ms.push(sent.elapsed().as_secs_f64() * 1000.0);
                        }
                        link.sent_patches.retain(|(id, _)| *id > seq);
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
                            if let Some(rects) = value.get("rects")
                                && let Ok(new_rects) = serde_json::from_value(rects.clone())
                            {
                                self.rects = new_rects;
                            }
                            if let Some(items) = value.get("events").and_then(|v| v.as_array()) {
                                events.extend(items.iter().map(ToString::to_string));
                            }
                        }
                    }
                    Ok(Msg::Report { text }) => eprintln!("{text}"),
                    Ok(_) => {}
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
            if disconnected {
                self.rects.clear();
                self.can_send = false;
                if link.connected_at.elapsed() >= Duration::from_secs(5) {
                    self.failures = 0;
                }
                retire(link, true);
                self.retry()
            } else {
                let ready = unsafe { self.d3d.ready.GetCompletedValue() };
                let current = link.current.map_or(0, |(_, id)| id);
                if let Some(candidate) = link
                    .published
                    .iter()
                    .filter(|p| p.id > current && p.ready <= ready && p.slot < link.slots.len())
                    .max_by_key(|p| p.id)
                {
                    let pick = (candidate.slot, candidate.id);
                    link.current = Some(pick);
                    link.published.retain(|p| p.id > pick.1);
                    let _ = link.tx.send(Msg::Picked {
                        pub_id: pick.1,
                        first_frame: frame,
                    });
                }
                if self.can_send
                    && let Some(json) = self.pending_patch.take()
                {
                    if link.tx.send(Msg::Patch { seq: frame, json }).is_ok() {
                        link.sent_patches.push_back((frame, Instant::now()));
                        if link.sent_patches.len() > 256 {
                            link.sent_patches.pop_front();
                        }
                    }
                    self.can_send = false;
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
        Ok(events)
    }
    pub fn pointer(&self, action: u8, x: f64, y: f64, button: i16) -> bool {
        if !self
            .rects
            .iter()
            .any(|r| x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3])
        {
            return false;
        }
        if let Connection::Running(link) = &self.connection {
            link.tx
                .send(Msg::Pointer {
                    action,
                    x: x as f32,
                    y: y as f32,
                    button,
                })
                .is_ok()
        } else {
            false
        }
    }
    pub fn draw(&self, encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView) {
        if let Connection::Running(link) = &self.connection
            && let Some(slot) = link.current.and_then(|(i, _)| link.slots.get(i))
        {
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
            pass.set_bind_group(0, &slot.bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
    }
    pub fn signal(&self, frame: u64) -> Result<()> {
        unsafe {
            self.d3d.queue.Signal(&self.d3d.done, frame)?;
        }
        Ok(())
    }
}
impl Drop for Ui {
    fn drop(&mut self) {
        if let Connection::Running(link) =
            std::mem::replace(&mut self.connection, Connection::Backoff(Instant::now()))
        {
            retire(link, false);
        }
    }
}

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
@fragment fn fs_main(v: VO) -> @location(0) vec4f {
    return textureSample(hud, samp, v.uv);
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;

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
}
