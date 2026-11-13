use anyhow::{Context, Result, bail};
use sdl3::video::Window;
use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    time::{Duration, Instant},
};

/// One frame the game thread recorded, handed to the render thread.
pub struct Frame {
    pub index: u64,
    pub started: Instant,
    pub size: (u32, u32),
    pub clear: [f64; 4],
    pub commands: Option<Vec<u8>>,
    pub captures: Vec<PathBuf>,
}
pub struct Rendered {
    pub index: u64,
    pub replay: Option<Result<Vec<threejsc_gpu::Response>, threejsc_gpu::DecodeError>>,
    /// Render-thread time for the frame, excluding the wait to acquire a surface texture.
    pub cpu: Duration,
    /// From the frame's start on the game thread, where it polls input, to the return of present.
    pub latency: Duration,
    /// When the surface texture was acquired, if acquiring it waited for the display to take a
    /// frame: a display refresh.
    pub refresh: Option<Instant>,
    /// When acquiring the surface texture began and ended.
    pub acquire: (Instant, Instant),
}

/// The window's raw handles, from which the render thread makes a surface for a new device.
#[derive(Clone, Copy)]
struct WindowHandles {
    display: Option<wgpu::rwh::RawDisplayHandle>,
    window: wgpu::rwh::RawWindowHandle,
}
// SAFETY: the SDL window outlives the render thread, and DXGI makes a swap chain for a window on any
// thread, as the surface the main thread hands the render thread already does.
unsafe impl Send for WindowHandles {}

/// The window surface and its device. The main thread creates it from the window, and the render
/// thread owns it.
pub struct Target {
    surface: wgpu::Surface<'static>,
    instance: wgpu::Instance,
    handles: WindowHandles,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
}
/// Lives on the render thread, because wgpu error scopes belong to the thread that pushes them.
pub struct Renderer {
    window: Presenter,
    queue: wgpu::Queue,
    executor: threejsc_gpu::Executor,
    /// The canvas the game draws into, at the size of its drawing buffer. A frame that acquires it
    /// starts from transparent black, and other frames keep the last image, as a browser canvas does.
    game: wgpu::Texture,
    /// Whether the game has drawn since the host started.
    drawn: bool,
}
/// The window's surface and what draws the canvas into it.
struct Presenter {
    surface: wgpu::Surface<'static>,
    instance: wgpu::Instance,
    handles: WindowHandles,
    device: wgpu::Device,
    config: wgpu::SurfaceConfiguration,
    /// Draws `scaled` over the whole window.
    stretch: wgpu::RenderPipeline,
    /// A copy of `game` and its bilinear bind group for `stretch`, kept while `game` keeps its
    /// size. `game` has a canvas's usages, which exclude sampling.
    scaled: Option<(wgpu::Texture, wgpu::BindGroup)>,
}
/// A frame's surface texture, and the buffer that receives a copy of it for the frame's captures.
struct Shown {
    surface: wgpu::SurfaceTexture,
    acquire_wait: Duration,
    acquired: Instant,
    capture: Option<wgpu::Buffer>,
}
impl WindowHandles {
    fn target(self) -> wgpu::SurfaceTargetUnsafe {
        wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: self.display,
            raw_window_handle: self.window,
        }
    }
}
impl Target {
    pub async fn new(window: &Window, vsync: bool) -> Result<(Self, String)> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12,
            flags: wgpu::InstanceFlags::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::default(),
            display: None,
        });
        // The SDL window outlives the renderer and its surface.
        let handles =
            match unsafe { wgpu::SurfaceTargetUnsafe::from_display_and_window(window, window)? } {
                wgpu::SurfaceTargetUnsafe::RawHandle {
                    raw_display_handle,
                    raw_window_handle,
                } => WindowHandles {
                    display: raw_display_handle,
                    window: raw_window_handle,
                },
                _ => bail!("the window has no raw handle"),
            };
        let surface = unsafe { instance.create_surface_unsafe(handles.target())? };
        let mut adapters: Vec<_> = instance
            .enumerate_adapters(wgpu::Backends::DX12)
            .await
            .into_iter()
            .filter(|adapter| {
                let info = adapter.get_info();
                matches!(
                    info.device_type,
                    wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
                ) && !info.name.to_ascii_lowercase().contains("virtual")
                    && adapter.is_surface_supported(&surface)
            })
            .collect();
        adapters.sort_by_key(|adapter| {
            if adapter.get_info().device_type == wgpu::DeviceType::DiscreteGpu {
                0
            } else {
                1
            }
        });
        let adapter = adapters
            .into_iter()
            .next()
            .context("no hardware DX12 adapter supports the window")?;
        let info = adapter.get_info();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("threejsc"),
                // WebGPU's defaults, as a browser's device has until the game asks for more.
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await?;
        let caps = surface.get_capabilities(&adapter);
        if !caps
            .usages
            .contains(wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST)
        {
            bail!("surface does not support copies");
        }
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| *f == wgpu::TextureFormat::Bgra8Unorm)
            .context("surface does not support bgra8unorm")?;
        let (width, height) = window.size_in_pixels();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: if vsync {
                wgpu::PresentMode::Fifo
            } else {
                wgpu::PresentMode::AutoNoVsync
            },
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        surface.configure(&device, &config);
        let description = format!(
            "adapter: {} ({:?}, {:?}), maxTextureDimension2D {}",
            info.name,
            info.backend,
            info.device_type,
            adapter.limits().max_texture_dimension_2d
        );
        Ok((
            Self {
                surface,
                instance,
                handles,
                adapter,
                device,
                queue,
                config,
            },
            description,
        ))
    }
}
impl Target {
    /// The limits a device requested from this adapter can have.
    pub fn adapter_limits(&self) -> wgpu::Limits {
        self.adapter.limits()
    }

    /// The features a device requested from this adapter can have.
    pub fn adapter_features(&self) -> wgpu::Features {
        self.adapter.features()
    }
}
impl Renderer {
    pub fn new(target: Target) -> Self {
        Self {
            executor: threejsc_gpu::Executor::with_adapter(
                target.adapter,
                target.device.clone(),
                target.queue.clone(),
            ),
            game: game_texture(&target.device, &target.config),
            drawn: false,
            window: Presenter {
                stretch: stretch_pipeline(&target.device, target.config.format),
                scaled: None,
                surface: target.surface,
                instance: target.instance,
                handles: target.handles,
                device: target.device,
                config: target.config,
            },
            queue: target.queue,
        }
    }
    /// Replays `frame` into the game texture and presents it in a surface texture at the frame's
    /// size, as a browser shows a canvas whose CSS size fills the window: copied when the sizes
    /// match and scaled with bilinear filtering otherwise. A frame whose commands do not acquire
    /// the surface keeps the last image the game drew. Until the game first draws, the window
    /// shows the frame's clear color. The commands that show the canvas go to the queue with the
    /// frame's last submission when the executor can take them.
    pub fn frame(&mut self, frame: Frame) -> Result<Rendered> {
        let started = Instant::now();
        self.window.resize(frame.size);
        let capture = !frame.captures.is_empty();
        let mut acquired = None;
        let replay = frame.commands.map(|commands| {
            let (window, drawn) = (&mut self.window, self.drawn);
            let mut trailer = |canvas: &wgpu::Texture, used: bool| {
                let shown = acquired.insert(window.acquire()).as_mut().ok()?;
                let (commands, buffer) =
                    window.encode(shown, canvas, drawn || used, frame.clear, capture);
                shown.capture = buffer;
                Some(commands)
            };
            self.executor
                .replay_then(&commands, Some(&mut self.game), Some(&mut trailer))
        });
        if self.executor.took_device() {
            self.window.adopt(self.executor.device())?;
            self.queue = self.executor.queue().clone();
        }
        self.drawn |= matches!(replay, Some(Ok(_))) && self.executor.surface_used();
        let acquired_in_replay = acquired.is_some();
        let mut shown = match acquired {
            Some(shown) => shown?,
            None => self.window.acquire()?,
        };
        if !(acquired_in_replay && self.executor.trailed()) {
            let scope = self
                .window
                .device
                .push_error_scope(wgpu::ErrorFilter::Validation);
            let (commands, buffer) =
                self.window
                    .encode(&shown, &self.game, self.drawn, frame.clear, capture);
            shown.capture = buffer;
            self.queue.submit([commands]);
            if let Some(error) = pollster::block_on(scope.pop()) {
                bail!("host frame rendering failed: {error}");
            }
        }
        if let Some(buffer) = &shown.capture {
            let captures: Vec<_> = frame.captures.iter().map(PathBuf::as_path).collect();
            self.window.save(buffer, &captures)?;
        }
        self.queue.present(shown.surface);
        Ok(Rendered {
            index: frame.index,
            replay,
            cpu: started.elapsed() - shown.acquire_wait,
            latency: frame.started.elapsed(),
            refresh: (shown.acquire_wait >= Duration::from_micros(250)).then_some(shown.acquired),
            acquire: (shown.acquired - shown.acquire_wait, shown.acquired),
        })
    }
}
impl Presenter {
    /// Draws the window with `device` from now on, which the game's `requestDevice()` replaced.
    /// wgpu resizes a configured swap chain in place, and the old one belongs to the old device's
    /// queue, so the new device gets a new surface. DXGI allows one swap chain per window, and the
    /// old surface's lasts while the old device's finished submissions hold its textures, which
    /// only a poll of that device frees, so the old device finishes its work first.
    fn adopt(&mut self, device: &wgpu::Device) -> Result<()> {
        self.surface = unsafe { self.instance.create_surface_unsafe(self.handles.target())? };
        self.device.poll(wgpu::PollType::wait_indefinitely())?;
        self.device = device.clone();
        self.stretch = stretch_pipeline(device, self.config.format);
        self.scaled = None;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        self.surface.configure(device, &self.config);
        if let Some(error) = pollster::block_on(scope.pop()) {
            bail!("the window surface for the new device failed to configure: {error}");
        }
        Ok(())
    }
    fn resize(&mut self, (width, height): (u32, u32)) {
        if width != self.config.width || height != self.config.height {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
        }
    }
    fn acquire(&self) -> Result<Shown> {
        let started = Instant::now();
        match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(surface)
            | wgpu::CurrentSurfaceTexture::Suboptimal(surface) => Ok(Shown {
                surface,
                acquire_wait: started.elapsed(),
                acquired: Instant::now(),
                capture: None,
            }),
            other => bail!("surface texture unavailable: {other:?}"),
        }
    }
    /// Encodes showing `canvas` in the frame's surface texture, or the clear color while the game
    /// has not drawn, and a copy of the result into a new buffer when `capture` is set.
    fn encode(
        &mut self,
        shown: &Shown,
        canvas: &wgpu::Texture,
        drawn: bool,
        clear: [f64; 4],
        capture: bool,
    ) -> (wgpu::CommandBuffer, Option<wgpu::Buffer>) {
        let frame = &shown.surface;
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("frame"),
            });
        let size = wgpu::Extent3d {
            width: self.config.width,
            height: self.config.height,
            depth_or_array_layers: 1,
        };
        if !drawn {
            let [r, g, b, a] = clear;
            let view = frame.texture.create_view(&Default::default());
            window_pass(&mut encoder, &view, wgpu::Color { r, g, b, a });
        } else if canvas.size() == size {
            encoder.copy_texture_to_texture(
                canvas.as_image_copy(),
                frame.texture.as_image_copy(),
                size,
            );
        } else {
            if self
                .scaled
                .as_ref()
                .is_none_or(|(copy, _)| copy.size() != canvas.size())
            {
                self.scaled = Some(scaled(&self.device, &self.stretch, canvas));
            }
            let (copy, group) = self.scaled.as_ref().expect("scaled matches the canvas");
            encoder.copy_texture_to_texture(
                canvas.as_image_copy(),
                copy.as_image_copy(),
                canvas.size(),
            );
            let view = frame.texture.create_view(&Default::default());
            let mut pass = window_pass(&mut encoder, &view, wgpu::Color::TRANSPARENT);
            pass.set_pipeline(&self.stretch);
            pass.set_bind_group(0, group, &[]);
            pass.draw(0..3, 0..1);
        }
        // Overlays that composite over the game frame, such as E2's UI, draw here so captures
        // include them.
        let capture = capture.then(|| {
            let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("capture"),
                size: u64::from(self.stride()) * u64::from(self.config.height),
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: &frame.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(self.stride()),
                        rows_per_image: Some(self.config.height),
                    },
                },
                size,
            );
            buffer
        });
        (encoder.finish(), capture)
    }
    fn stride(&self) -> u32 {
        (self.config.width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
    }
    /// Writes the window copy in `buffer`, which a submission has filled, to each capture path.
    fn save(&self, buffer: &wgpu::Buffer, captures: &[&Path]) -> Result<()> {
        let stride = self.stride();
        let slice = buffer.slice(..);
        let (tx, rx) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        self.device.poll(wgpu::PollType::wait_indefinitely())?;
        rx.recv()??;
        let data = slice.get_mapped_range()?;
        let mut rgba = Vec::with_capacity((self.config.width * self.config.height * 4) as usize);
        for row in data
            .chunks(stride as usize)
            .take(self.config.height as usize)
        {
            for pixel in row[..(self.config.width * 4) as usize].as_chunks::<4>().0 {
                rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
            }
        }
        for path in captures {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent)?;
            }
            image::save_buffer(
                path,
                &rgba,
                self.config.width,
                self.config.height,
                image::ColorType::Rgba8,
            )?;
        }
        drop(data);
        buffer.unmap();
        Ok(())
    }
}

/// A render pass over the window that starts from `clear`.
fn window_pass<'a>(
    encoder: &'a mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    clear: wgpu::Color,
) -> wgpu::RenderPass<'a> {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("window"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(clear),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    })
}

fn stretch_pipeline(device: &wgpu::Device, format: wgpu::TextureFormat) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(wgpu::include_wgsl!("stretch.wgsl"));
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("stretch"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: None,
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: None,
            compilation_options: Default::default(),
            targets: &[Some(format.into())],
        }),
        multiview_mask: None,
        cache: None,
    })
}

/// A texture with `game`'s size and format that `stretch` samples with bilinear filtering, as a
/// browser scales a canvas, and its bind group.
fn scaled(
    device: &wgpu::Device,
    stretch: &wgpu::RenderPipeline,
    game: &wgpu::Texture,
) -> (wgpu::Texture, wgpu::BindGroup) {
    let copy = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("scaled"),
        size: game.size(),
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: game.format(),
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("scaled"),
        layout: &stretch.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(
                    &copy.create_view(&Default::default()),
                ),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
        ],
    });
    (copy, group)
}

/// A texture with the surface's size, format and the usages a stream sees on the surface.
fn game_texture(device: &wgpu::Device, config: &wgpu::SurfaceConfiguration) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("game"),
        size: wgpu::Extent3d {
            width: config.width,
            height: config.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: config.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}
