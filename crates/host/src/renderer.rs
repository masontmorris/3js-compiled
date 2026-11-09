use anyhow::{Context, Result, bail};
use sdl3::video::Window;
use std::{path::Path, sync::mpsc};

pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    executor: threejsc_gpu::Executor,
}
impl Renderer {
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
        let executor = threejsc_gpu::Executor::new(device.clone(), queue.clone());
        Ok((
            Self {
                surface,
                device,
                queue,
                config,
                executor,
            },
            format!(
                "adapter: {} ({:?}, {:?})",
                info.name, info.backend, info.device_type
            ),
        ))
    }
    /// Replays JS commands into `frame`. Returns whether they drew to the surface.
    pub fn replay(
        &mut self,
        commands: &[u8],
        frame: &wgpu::SurfaceTexture,
    ) -> Result<(Vec<threejsc_gpu::Response>, bool)> {
        let responses = self.executor.replay(commands, Some(&frame.texture))?;
        Ok((responses, self.executor.surface_used()))
    }
    pub fn resize(&mut self, width: u32, height: u32) -> bool {
        let changed =
            width > 0 && height > 0 && (width != self.config.width || height != self.config.height);
        if changed {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
        }
        changed
    }
    pub fn acquire(&self) -> Result<wgpu::SurfaceTexture> {
        match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => Ok(frame),
            other => bail!("surface texture unavailable: {other:?}"),
        }
    }
    pub fn render(
        &self,
        frame: wgpu::SurfaceTexture,
        clear: Option<[f64; 4]>,
        captures: &[&Path],
    ) -> Result<wgpu::SurfaceTexture> {
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
    pub fn present(&self, frame: wgpu::SurfaceTexture) {
        self.queue.present(frame);
    }
}
