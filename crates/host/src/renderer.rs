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
}

/// The window surface and its device. The main thread creates it from the window, and the render
/// thread owns it.
pub struct Target {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
}
/// Lives on the render thread, because wgpu error scopes belong to the thread that pushes them.
pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    executor: threejsc_gpu::Executor,
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
        let target = unsafe { wgpu::SurfaceTargetUnsafe::from_display_and_window(window, window)? };
        let surface = unsafe { instance.create_surface_unsafe(target)? };
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
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await?;
        let caps = surface.get_capabilities(&adapter);
        if !caps.usages.contains(wgpu::TextureUsages::COPY_SRC) {
            bail!("surface does not support capture");
        }
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| *f == wgpu::TextureFormat::Bgra8Unorm)
            .context("surface does not support bgra8unorm")?;
        let (width, height) = window.size_in_pixels();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
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
        Ok((
            Self {
                surface,
                device,
                queue,
                config,
            },
            format!(
                "adapter: {} ({:?}, {:?})",
                info.name, info.backend, info.device_type
            ),
        ))
    }
}
impl Renderer {
    pub fn new(target: Target) -> Self {
        Self {
            executor: threejsc_gpu::Executor::new(target.device.clone(), target.queue.clone()),
            surface: target.surface,
            device: target.device,
            queue: target.queue,
            config: target.config,
        }
    }
    /// Draws `frame` into a surface texture at the frame's size and presents it. The surface is
    /// cleared to the frame's color only when no command acquired the surface at its current size.
    pub fn frame(&mut self, frame: Frame) -> Result<Rendered> {
        let started = Instant::now();
        self.resize(frame.size);
        let acquire_started = Instant::now();
        let surface = self.acquire()?;
        let acquire_wait = acquire_started.elapsed();
        let replay = frame
            .commands
            .map(|commands| self.executor.replay(&commands, Some(&surface.texture)));
        let drew = matches!(replay, Some(Ok(_))) && self.executor.surface_used();
        let captures: Vec<_> = frame.captures.iter().map(PathBuf::as_path).collect();
        let surface = self.render(surface, (!drew).then_some(frame.clear), &captures)?;
        self.queue.present(surface);
        Ok(Rendered {
            index: frame.index,
            replay,
            cpu: started.elapsed() - acquire_wait,
            latency: frame.started.elapsed(),
        })
    }
    fn resize(&mut self, (width, height): (u32, u32)) {
        if width != self.config.width || height != self.config.height {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
        }
    }
    fn acquire(&self) -> Result<wgpu::SurfaceTexture> {
        match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => Ok(frame),
            other => bail!("surface texture unavailable: {other:?}"),
        }
    }
    fn render(
        &self,
        frame: wgpu::SurfaceTexture,
        clear: Option<[f64; 4]>,
        captures: &[&Path],
    ) -> Result<wgpu::SurfaceTexture> {
        if clear.is_none() && captures.is_empty() {
            return Ok(frame);
        }
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("frame"),
            });
        if let Some(color) = clear {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("clear"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: color[0],
                            g: color[1],
                            b: color[2],
                            a: color[3],
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
        }
        // Overlays that composite over the game frame, such as E2's UI, draw here so captures
        // include them.
        let stride = (self.config.width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = if captures.is_empty() {
            None
        } else {
            let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("capture"),
                size: u64::from(stride) * u64::from(self.config.height),
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
                        bytes_per_row: Some(stride),
                        rows_per_image: Some(self.config.height),
                    },
                },
                wgpu::Extent3d {
                    width: self.config.width,
                    height: self.config.height,
                    depth_or_array_layers: 1,
                },
            );
            Some(buffer)
        };
        self.queue.submit(Some(encoder.finish()));
        if let Some(error) = pollster::block_on(scope.pop()) {
            bail!("host frame rendering failed: {error}");
        }
        if let Some(buffer) = buffer {
            let slice = buffer.slice(..);
            let (tx, rx) = mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |result| {
                let _ = tx.send(result);
            });
            self.device.poll(wgpu::PollType::wait_indefinitely())?;
            rx.recv()??;
            let data = slice.get_mapped_range()?;
            let mut rgba =
                Vec::with_capacity((self.config.width * self.config.height * 4) as usize);
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
        }
        Ok(frame)
    }
}
