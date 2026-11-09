use std::{
    collections::HashMap,
    sync::{Arc, Mutex, mpsc},
};

use crate::decode;

struct Buffer {
    raw: wgpu::Buffer,
    size: u64,
    usage: wgpu::BufferUsages,
}

struct Texture {
    raw: wgpu::Texture,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    layers: u32,
    mips: u32,
    samples: u32,
    usage: wgpu::TextureUsages,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Response {
    Validation {
        request: u32,
    },
    Readback {
        request: u32,
        bytes: Vec<u8>,
    },
    Error {
        frame: u32,
        command: usize,
        request: Option<u32>,
        label: Option<String>,
        message: String,
    },
}

pub struct Executor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    buffers: HashMap<u32, Buffer>,
    shaders: HashMap<u32, Option<wgpu::ShaderModule>>,
    textures: HashMap<u32, Texture>,
    views: HashMap<u32, (u32, wgpu::TextureView)>,
    samplers: HashMap<u32, wgpu::Sampler>,
    bind_group_layouts: HashMap<u32, wgpu::BindGroupLayout>,
    bind_groups: HashMap<u32, wgpu::BindGroup>,
    pipeline_layouts: HashMap<u32, wgpu::PipelineLayout>,
    render_pipelines: HashMap<u32, Option<wgpu::RenderPipeline>>,
    labels: HashMap<u32, String>,
    frame: u32,
    pipeline: Option<u32>,
    pass_view: Option<u32>,
    encoder: Option<wgpu::CommandEncoder>,
    render_pass: Option<wgpu::RenderPass<'static>>,
    render_pass_scope: Option<wgpu::ErrorScopeGuard>,
    valid_pipeline: Option<bool>,
    surface: Option<wgpu::Texture>,
    surface_handles: Vec<u32>,
    surface_used: bool,
    uncaptured: Arc<Mutex<Vec<String>>>,
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}
fn size(bytes: &[u8], expected: usize) -> Result<(), String> {
    if bytes.len() != expected {
        return Err(format!(
            "expected {expected} payload bytes, got {}",
            bytes.len()
        ));
    }
    Ok(())
}

fn buffer_slice(
    buffer: &Buffer,
    offset: u64,
    size: u64,
    usage: wgpu::BufferUsages,
) -> Result<wgpu::BufferSlice<'_>, String> {
    if !buffer.usage.contains(usage) || offset >= buffer.size {
        return Err("invalid render buffer range".into());
    }
    let end = if size == 0 {
        buffer.size
    } else {
        offset
            .checked_add(size)
            .ok_or("invalid render buffer range")?
    };
    if end > buffer.size || end <= offset {
        return Err("invalid render buffer range".into());
    }
    Ok(buffer.raw.slice(offset..end))
}

impl Executor {
    /// Replaces the device's uncaptured-error handler, whose default panics, so that a stream
    /// can only produce error responses.
    pub fn new(device: wgpu::Device, queue: wgpu::Queue) -> Self {
        let uncaptured = Arc::new(Mutex::new(Vec::new()));
        let errors = uncaptured.clone();
        device.on_uncaptured_error(Arc::new(move |error| {
            errors.lock().unwrap().push(error.to_string());
        }));
        Self {
            device,
            queue,
            buffers: HashMap::new(),
            shaders: HashMap::new(),
            textures: HashMap::new(),
            views: HashMap::new(),
            samplers: HashMap::new(),
            bind_group_layouts: HashMap::new(),
            bind_groups: HashMap::new(),
            pipeline_layouts: HashMap::new(),
            render_pipelines: HashMap::new(),
            labels: HashMap::new(),
            frame: 0,
            pipeline: None,
            pass_view: None,
            encoder: None,
            render_pass: None,
            render_pass_scope: None,
            valid_pipeline: None,
            surface: None,
            surface_handles: Vec::new(),
            surface_used: false,
            uncaptured,
        }
    }

    fn handle_used(&self, handle: u32) -> bool {
        handle == 0
            || self.buffers.contains_key(&handle)
            || self.shaders.contains_key(&handle)
            || self.textures.contains_key(&handle)
            || self.views.contains_key(&handle)
            || self.samplers.contains_key(&handle)
            || self.bind_group_layouts.contains_key(&handle)
            || self.bind_groups.contains_key(&handle)
            || self.pipeline_layouts.contains_key(&handle)
            || self.render_pipelines.contains_key(&handle)
    }

    /// The handle whose label names the resource a command creates, uses, or draws with.
    fn subject(&self, opcode: u16, payload: &[u8]) -> Option<u32> {
        let at = |offset: usize| (payload.len() >= offset + 4).then(|| u32_at(payload, offset));
        match opcode {
            16 | 17 | 18 | 27 | 28 => at(4),
            14 if at(0) == Some(0) => payload.len().checked_sub(32).and_then(at),
            14 => at(8),
            23 | 24 => self.pipeline,
            25 | 26 => self.pass_view,
            _ => at(0),
        }
    }

    fn label(&self, handle: Option<u32>) -> Option<String> {
        handle.and_then(|handle| self.labels.get(&handle).cloned())
    }

    fn set_label(&mut self, handle: u32, label: &str) {
        if label.is_empty() {
            self.labels.remove(&handle);
        } else {
            self.labels.insert(handle, label.to_owned());
        }
    }

    /// Replays one frame. `surface` is the texture that `ACQUIRE_SURFACE` binds for this frame only.
    pub fn replay(
        &mut self,
        frame: &[u8],
        surface: Option<&wgpu::Texture>,
    ) -> Result<Vec<Response>, crate::DecodeError> {
        let stream = decode(frame)?;
        let records = stream.records;
        self.frame = stream.frame;
        self.surface = surface.cloned();
        self.surface_used = false;
        let mut responses = Vec::new();
        for (command, record) in records.iter().enumerate() {
            let subject = self.subject(record.opcode, record.payload);
            let before = self.label(subject);
            let mut result = self.execute(record.opcode, record.payload);
            let uncaptured = std::mem::take(&mut *self.uncaptured.lock().unwrap());
            if !uncaptured.is_empty() {
                let first = result.err().into_iter();
                result = Err(first.chain(uncaptured).collect::<Vec<_>>().join("\n"));
            }
            match result {
                Ok(Some(response)) => responses.push(response),
                Ok(None) => {}
                Err(message) => responses.push(Response::Error {
                    frame: self.frame,
                    command,
                    label: self.label(subject).or(before),
                    request: if (record.opcode == 27 || record.opcode == 28)
                        && record.payload.len() >= 4
                    {
                        Some(u32_at(record.payload, 0))
                    } else if record.opcode == 9
                        && record.payload.len() >= 16
                        && u32_at(record.payload, 12) != 0
                    {
                        Some(u32_at(record.payload, 12))
                    } else if record.opcode == 13
                        && record.payload.len() >= 8
                        && u32_at(record.payload, 4) != 0
                    {
                        Some(u32_at(record.payload, 4))
                    } else {
                        None
                    },
                    message,
                }),
            }
        }
        if self.render_pass.is_some() || self.encoder.is_some() {
            self.render_pass = None;
            self.render_pass_scope = None;
            self.encoder = None;
            responses.push(Response::Error {
                frame: self.frame,
                command: records.len(),
                request: None,
                label: None,
                message: "incomplete command submission".into(),
            });
        }
        for handle in std::mem::take(&mut self.surface_handles) {
            self.textures.remove(&handle);
            self.views.retain(|_, (parent, _)| *parent != handle);
        }
        self.pipeline = None;
        self.pass_view = None;
        self.surface = None;
        Ok(responses)
    }

    /// Whether the last replay bound the host's surface, at its current size, with `ACQUIRE_SURFACE`.
    pub fn surface_used(&self) -> bool {
        self.surface_used
    }

    fn execute(&mut self, opcode: u16, payload: &[u8]) -> Result<Option<Response>, String> {
        match opcode {
            1 => {
                if payload.len() < 20 {
                    return Err("truncated buffer descriptor".into());
                }
                let handle = u32_at(payload, 0);
                let len = u64_at(payload, 4);
                let usage = wgpu::BufferUsages::from_bits(u32_at(payload, 12))
                    .ok_or("invalid buffer usage")?;
                if 20usize.checked_add(u32_at(payload, 16) as usize) != Some(payload.len()) {
                    return Err("invalid buffer label length".into());
                }
                if self.handle_used(handle) {
                    return Err("invalid or duplicate buffer handle".into());
                }
                let label =
                    std::str::from_utf8(&payload[20..]).map_err(|_| "invalid buffer label")?;
                self.set_label(handle, label);
                if len == 0 || len > self.device.limits().max_buffer_size {
                    return Err("invalid buffer size".into());
                }
                let supported = wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::INDEX
                    | wgpu::BufferUsages::VERTEX
                    | wgpu::BufferUsages::UNIFORM
                    | wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::INDIRECT
                    | wgpu::BufferUsages::QUERY_RESOLVE;
                if usage.is_empty() || !supported.contains(usage) {
                    return Err("unsupported buffer usage".into());
                }
                let raw = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(label),
                    size: len,
                    usage,
                    mapped_at_creation: false,
                });
                self.buffers.insert(
                    handle,
                    Buffer {
                        raw,
                        size: len,
                        usage,
                    },
                );
                Ok(None)
            }
            2 => {
                if payload.len() < 12 {
                    return Err("truncated buffer write".into());
                }
                let handle = u32_at(payload, 0);
                let offset = u64_at(payload, 4);
                let bytes = &payload[12..];
                let buffer = self.buffers.get(&handle).ok_or("unknown buffer handle")?;
                if !buffer.usage.contains(wgpu::BufferUsages::COPY_DST)
                    || !offset.is_multiple_of(4)
                    || !bytes.len().is_multiple_of(4)
                    || offset
                        .checked_add(bytes.len() as u64)
                        .is_none_or(|end| end > buffer.size)
                {
                    return Err("invalid buffer write".into());
                }
                self.queue.write_buffer(&buffer.raw, offset, bytes);
                Ok(None)
            }
            3 => {
                size(payload, 4)?;
                let buffer = self
                    .buffers
                    .remove(&u32_at(payload, 0))
                    .ok_or("unknown buffer handle")?;
                buffer.raw.destroy();
                self.labels.remove(&u32_at(payload, 0));
                Ok(None)
            }
            27 => {
                size(payload, 24)?;
                let request = u32_at(payload, 0);
                let offset = u64_at(payload, 8);
                let len = u64_at(payload, 16);
                let buffer = self
                    .buffers
                    .get(&u32_at(payload, 4))
                    .ok_or("unknown buffer handle")?;
                if request == 0
                    || !buffer.usage.contains(wgpu::BufferUsages::COPY_SRC)
                    || len == 0
                    || !offset.is_multiple_of(4)
                    || !len.is_multiple_of(4)
                    || offset.checked_add(len).is_none_or(|end| end > buffer.size)
                {
                    return Err("invalid buffer readback".into());
                }
                let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: len,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                });
                let mut encoder = self.device.create_command_encoder(&Default::default());
                encoder.copy_buffer_to_buffer(&buffer.raw, offset, &staging, 0, len);
                self.queue.submit([encoder.finish()]);
                let slice = staging.slice(..);
                let (tx, rx) = mpsc::channel();
                slice.map_async(wgpu::MapMode::Read, move |result| {
                    let _ = tx.send(result);
                });
                self.device
                    .poll(wgpu::PollType::wait_indefinitely())
                    .map_err(|e| e.to_string())?;
                rx.recv()
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())?;
                let data = slice
                    .get_mapped_range()
                    .map_err(|e| e.to_string())?
                    .to_vec();
                staging.unmap();
                Ok(Some(Response::Readback {
                    request,
                    bytes: data,
                }))
            }
            4 => {
                if payload.len() < 36 {
                    return Err("truncated texture descriptor".into());
                }
                let handle = u32_at(payload, 0);
                let width = u32_at(payload, 4);
                let height = u32_at(payload, 8);
                let layers = u32_at(payload, 12);
                let mips = u32_at(payload, 16);
                let samples = u32_at(payload, 20);
                let usage = wgpu::TextureUsages::from_bits(u32_at(payload, 24))
                    .ok_or("invalid texture usage")?;
                let format_end = 36usize
                    .checked_add(u32_at(payload, 28) as usize)
                    .ok_or("invalid texture format length")?;
                if format_end.checked_add(u32_at(payload, 32) as usize) != Some(payload.len()) {
                    return Err("invalid texture format or label length".into());
                }
                if self.handle_used(handle) {
                    return Err("invalid or duplicate texture handle".into());
                }
                let label = std::str::from_utf8(&payload[format_end..])
                    .map_err(|_| "invalid texture label")?;
                self.set_label(handle, label);
                let name = std::str::from_utf8(&payload[36..format_end])
                    .map_err(|_| "invalid texture format")?;
                let format: wgpu::TextureFormat =
                    serde_json::from_value(serde_json::Value::from(name))
                        .map_err(|_| format!("unsupported texture format {name}"))?;
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let raw = self.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: layers,
                    },
                    mip_level_count: mips,
                    sample_count: samples,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage,
                    view_formats: &[],
                });
                if let Some(error) = pollster::block_on(scope.pop()) {
                    return Err(error.to_string());
                }
                self.textures.insert(
                    handle,
                    Texture {
                        raw,
                        format,
                        width,
                        height,
                        layers,
                        mips,
                        samples,
                        usage,
                    },
                );
                Ok(None)
            }
            5 => {
                if payload.len() < 40 {
                    return Err("truncated texture write".into());
                }
                let texture = self
                    .textures
                    .get(&u32_at(payload, 0))
                    .ok_or("unknown texture handle")?;
                let mip_level = u32_at(payload, 4);
                let origin = wgpu::Origin3d {
                    x: u32_at(payload, 8),
                    y: u32_at(payload, 12),
                    z: u32_at(payload, 16),
                };
                let bytes_per_row = u32_at(payload, 20);
                let rows_per_image = u32_at(payload, 24);
                let extent = wgpu::Extent3d {
                    width: u32_at(payload, 28),
                    height: u32_at(payload, 32),
                    depth_or_array_layers: u32_at(payload, 36),
                };
                if !texture.usage.contains(wgpu::TextureUsages::COPY_DST) {
                    return Err("texture is not writable".into());
                }
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &texture.raw,
                        mip_level,
                        origin,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &payload[40..],
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: (bytes_per_row != 0).then_some(bytes_per_row),
                        rows_per_image: (rows_per_image != 0).then_some(rows_per_image),
                    },
                    extent,
                );
                if let Some(error) = pollster::block_on(scope.pop()) {
                    return Err(error.to_string());
                }
                Ok(None)
            }
            6 => {
                size(payload, 4)?;
                if self.surface_handles.contains(&u32_at(payload, 0)) {
                    return Err(
                        "the surface texture belongs to the host and cannot be destroyed".into(),
                    );
                }
                let texture = self
                    .textures
                    .remove(&u32_at(payload, 0))
                    .ok_or("unknown texture handle")?;
                texture.raw.destroy();
                let handle = u32_at(payload, 0);
                let labels = &mut self.labels;
                self.views.retain(|view, (parent, _)| {
                    if *parent == handle {
                        labels.remove(view);
                    }
                    *parent != handle
                });
                self.labels.remove(&handle);
                Ok(None)
            }
            7 => {
                size(payload, 36)?;
                let handle = u32_at(payload, 0);
                let parent = u32_at(payload, 4);
                if self.handle_used(handle) {
                    return Err("invalid or duplicate view handle".into());
                }
                let texture = self.textures.get(&parent).ok_or("unknown texture handle")?;
                let dimension = match u32_at(payload, 24) {
                    0 => None,
                    1 => Some(wgpu::TextureViewDimension::D2),
                    2 => Some(wgpu::TextureViewDimension::D2Array),
                    3 => Some(wgpu::TextureViewDimension::Cube),
                    4 => Some(wgpu::TextureViewDimension::CubeArray),
                    _ => return Err("unsupported texture view dimension".into()),
                };
                let aspect = match u32_at(payload, 28) {
                    0 => wgpu::TextureAspect::All,
                    1 => wgpu::TextureAspect::DepthOnly,
                    2 => wgpu::TextureAspect::StencilOnly,
                    _ => return Err("unsupported texture view aspect".into()),
                };
                let usage_bits = u32_at(payload, 32);
                let usage = if usage_bits == 0 {
                    None
                } else {
                    Some(
                        wgpu::TextureUsages::from_bits(usage_bits)
                            .ok_or("invalid texture view usage")?,
                    )
                };
                let mips = u32_at(payload, 12);
                let layers = u32_at(payload, 20);
                let label = self.labels.get(&parent).cloned();
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let view = texture.raw.create_view(&wgpu::TextureViewDescriptor {
                    label: label.as_deref(),
                    format: None,
                    dimension,
                    usage,
                    aspect,
                    base_mip_level: u32_at(payload, 8),
                    mip_level_count: (mips != 0).then_some(mips),
                    base_array_layer: u32_at(payload, 16),
                    array_layer_count: (layers != 0).then_some(layers),
                });
                if let Some(error) = pollster::block_on(scope.pop()) {
                    return Err(error.to_string());
                }
                self.views.insert(handle, (parent, view));
                if let Some(label) = label {
                    self.labels.insert(handle, label);
                }
                Ok(None)
            }
            28 => {
                size(payload, 32)?;
                let request = u32_at(payload, 0);
                let texture = self
                    .textures
                    .get(&u32_at(payload, 4))
                    .ok_or("unknown texture handle")?;
                let mip = u32_at(payload, 8);
                let x = u32_at(payload, 12);
                let y = u32_at(payload, 16);
                let layer = u32_at(payload, 20);
                let width = u32_at(payload, 24);
                let height = u32_at(payload, 28);
                if request == 0
                    || mip >= texture.mips
                    || layer >= texture.layers
                    || width == 0
                    || height == 0
                    || texture.samples != 1
                    || !texture.usage.contains(wgpu::TextureUsages::COPY_SRC)
                {
                    return Err("invalid texture readback".into());
                }
                let mip_width = texture.width.checked_shr(mip).unwrap_or(0).max(1);
                let mip_height = texture.height.checked_shr(mip).unwrap_or(0).max(1);
                if x.checked_add(width).is_none_or(|end| end > mip_width)
                    || y.checked_add(height).is_none_or(|end| end > mip_height)
                {
                    return Err("texture readback exceeds bounds".into());
                }
                if !matches!(
                    texture.format,
                    wgpu::TextureFormat::Rgba8Unorm
                        | wgpu::TextureFormat::Rgba8UnormSrgb
                        | wgpu::TextureFormat::Bgra8Unorm
                        | wgpu::TextureFormat::Bgra8UnormSrgb
                ) {
                    return Err("unsupported texture readback format".into());
                }
                let row_bytes = width.checked_mul(4).ok_or("texture row is too large")?;
                let stride = row_bytes
                    .checked_add(255)
                    .ok_or("texture row is too large")?
                    / 256
                    * 256;
                let len = u64::from(stride) * u64::from(height);
                if len > self.device.limits().max_buffer_size {
                    return Err("texture readback is too large".into());
                }
                let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: None,
                    size: len,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                });
                let mut encoder = self.device.create_command_encoder(&Default::default());
                encoder.copy_texture_to_buffer(
                    wgpu::TexelCopyTextureInfo {
                        texture: &texture.raw,
                        mip_level: mip,
                        origin: wgpu::Origin3d { x, y, z: layer },
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyBufferInfo {
                        buffer: &staging,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(stride),
                            rows_per_image: Some(height),
                        },
                    },
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );
                self.queue.submit([encoder.finish()]);
                let slice = staging.slice(..);
                let (tx, rx) = mpsc::channel();
                slice.map_async(wgpu::MapMode::Read, move |result| {
                    let _ = tx.send(result);
                });
                self.device
                    .poll(wgpu::PollType::wait_indefinitely())
                    .map_err(|e| e.to_string())?;
                rx.recv()
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())?;
                let data = slice.get_mapped_range().map_err(|e| e.to_string())?;
                let mut bytes = Vec::with_capacity(row_bytes as usize * height as usize);
                for row in data.chunks(stride as usize) {
                    bytes.extend_from_slice(&row[..row_bytes as usize]);
                }
                drop(data);
                staging.unmap();
                Ok(Some(Response::Readback { request, bytes }))
            }
            8 => {
                size(payload, 44)?;
                let handle = u32_at(payload, 0);
                if self.handle_used(handle) {
                    return Err("invalid or duplicate sampler handle".into());
                }
                let address = |value| match value {
                    0 => Ok(wgpu::AddressMode::ClampToEdge),
                    1 => Ok(wgpu::AddressMode::Repeat),
                    2 => Ok(wgpu::AddressMode::MirrorRepeat),
                    _ => Err("unsupported sampler address mode"),
                };
                let filter = |value| match value {
                    0 => Ok(wgpu::FilterMode::Nearest),
                    1 => Ok(wgpu::FilterMode::Linear),
                    _ => Err("unsupported sampler filter"),
                };
                let mipmap_filter = match u32_at(payload, 24) {
                    0 => wgpu::MipmapFilterMode::Nearest,
                    1 => wgpu::MipmapFilterMode::Linear,
                    _ => return Err("unsupported sampler mipmap filter".into()),
                };
                let compare = match u32_at(payload, 36) {
                    0 => None,
                    1 => Some(wgpu::CompareFunction::Never),
                    2 => Some(wgpu::CompareFunction::Less),
                    3 => Some(wgpu::CompareFunction::Equal),
                    4 => Some(wgpu::CompareFunction::LessEqual),
                    5 => Some(wgpu::CompareFunction::Greater),
                    6 => Some(wgpu::CompareFunction::NotEqual),
                    7 => Some(wgpu::CompareFunction::GreaterEqual),
                    8 => Some(wgpu::CompareFunction::Always),
                    _ => return Err("unsupported sampler comparison".into()),
                };
                let anisotropy_clamp =
                    u16::try_from(u32_at(payload, 40)).map_err(|_| "invalid sampler anisotropy")?;
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
                    label: None,
                    address_mode_u: address(u32_at(payload, 4))?,
                    address_mode_v: address(u32_at(payload, 8))?,
                    address_mode_w: address(u32_at(payload, 12))?,
                    mag_filter: filter(u32_at(payload, 16))?,
                    min_filter: filter(u32_at(payload, 20))?,
                    mipmap_filter,
                    lod_min_clamp: f32::from_bits(u32_at(payload, 28)),
                    lod_max_clamp: f32::from_bits(u32_at(payload, 32)),
                    compare,
                    anisotropy_clamp,
                    border_color: None,
                });
                if let Some(error) = pollster::block_on(scope.pop()) {
                    return Err(error.to_string());
                }
                self.samplers.insert(handle, sampler);
                Ok(None)
            }
            9 => {
                if payload.len() < 16 {
                    return Err("truncated shader".into());
                }
                let handle = u32_at(payload, 0);
                let label_len = u32_at(payload, 4) as usize;
                let code_len = u32_at(payload, 8) as usize;
                let request = u32_at(payload, 12);
                let label_end = 16usize
                    .checked_add(label_len)
                    .ok_or("invalid shader length")?;
                let code_end = label_end
                    .checked_add(code_len)
                    .ok_or("invalid shader length")?;
                if code_end != payload.len() {
                    return Err("invalid shader length".into());
                }
                if self.handle_used(handle) {
                    return Err("invalid or duplicate shader handle".into());
                }
                let label = std::str::from_utf8(&payload[16..label_end])
                    .map_err(|_| "invalid shader label")?;
                let code = std::str::from_utf8(&payload[label_end..code_end])
                    .map_err(|_| "invalid shader source")?;
                self.set_label(handle, label);
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let shader = self
                    .device
                    .create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: Some(label),
                        source: wgpu::ShaderSource::Wgsl(code.into()),
                    });
                if let Some(error) = pollster::block_on(scope.pop()) {
                    self.shaders.insert(handle, None);
                    return Err(format!("shader {label}: {error}"));
                }
                self.shaders.insert(handle, Some(shader));
                Ok((request != 0).then_some(Response::Validation { request }))
            }
            10 => {
                if payload.len() < 8 || !(payload.len() - 8).is_multiple_of(32) {
                    return Err("invalid bind group layout length".into());
                }
                let handle = u32_at(payload, 0);
                if self.handle_used(handle) {
                    return Err("invalid or duplicate bind group layout handle".into());
                }
                if u32_at(payload, 4) as usize != (payload.len() - 8) / 32 {
                    return Err("invalid bind group layout count".into());
                }
                let mut entries = Vec::new();
                for entry in payload[8..].as_chunks::<32>().0 {
                    let visibility = wgpu::ShaderStages::from_bits(u32_at(entry, 4))
                        .ok_or("invalid shader visibility")?;
                    let kind = u32_at(entry, 8);
                    let option = u32_at(entry, 12);
                    let dimension = u32_at(entry, 16);
                    let flags = u32_at(entry, 20);
                    let min_size = u64_at(entry, 24);
                    let ty = match kind {
                        1 if dimension == 0 && flags <= 1 => wgpu::BindingType::Buffer {
                            ty: match option {
                                0 => wgpu::BufferBindingType::Uniform,
                                1 => wgpu::BufferBindingType::Storage { read_only: false },
                                2 => wgpu::BufferBindingType::Storage { read_only: true },
                                _ => return Err("invalid buffer binding type".into()),
                            },
                            has_dynamic_offset: flags != 0,
                            min_binding_size: std::num::NonZeroU64::new(min_size),
                        },
                        2 if dimension == 0 && flags == 0 && min_size == 0 => {
                            wgpu::BindingType::Sampler(match option {
                                0 => wgpu::SamplerBindingType::Filtering,
                                1 => wgpu::SamplerBindingType::NonFiltering,
                                2 => wgpu::SamplerBindingType::Comparison,
                                _ => return Err("invalid sampler binding type".into()),
                            })
                        }
                        3 if flags <= 1 && min_size == 0 => wgpu::BindingType::Texture {
                            sample_type: match option {
                                0 => wgpu::TextureSampleType::Float { filterable: true },
                                1 => wgpu::TextureSampleType::Float { filterable: false },
                                2 => wgpu::TextureSampleType::Depth,
                                3 => wgpu::TextureSampleType::Sint,
                                4 => wgpu::TextureSampleType::Uint,
                                _ => return Err("invalid texture sample type".into()),
                            },
                            view_dimension: match dimension {
                                0 => wgpu::TextureViewDimension::D1,
                                1 => wgpu::TextureViewDimension::D2,
                                2 => wgpu::TextureViewDimension::D2Array,
                                3 => wgpu::TextureViewDimension::Cube,
                                4 => wgpu::TextureViewDimension::CubeArray,
                                5 => wgpu::TextureViewDimension::D3,
                                _ => return Err("invalid binding view dimension".into()),
                            },
                            multisampled: flags != 0,
                        },
                        _ => return Err("invalid bind group layout entry".into()),
                    };
                    entries.push(wgpu::BindGroupLayoutEntry {
                        binding: u32_at(entry, 0),
                        visibility,
                        ty,
                        count: None,
                    });
                }
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let layout =
                    self.device
                        .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                            label: None,
                            entries: &entries,
                        });
                if let Some(error) = pollster::block_on(scope.pop()) {
                    return Err(error.to_string());
                }
                self.bind_group_layouts.insert(handle, layout);
                Ok(None)
            }
            11 => {
                if payload.len() < 12 || !(payload.len() - 12).is_multiple_of(28) {
                    return Err("invalid bind group length".into());
                }
                let handle = u32_at(payload, 0);
                if self.handle_used(handle) {
                    return Err("invalid or duplicate bind group handle".into());
                }
                let layout = self
                    .bind_group_layouts
                    .get(&u32_at(payload, 4))
                    .ok_or("unknown bind group layout handle")?;
                if u32_at(payload, 8) as usize != (payload.len() - 12) / 28 {
                    return Err("invalid bind group count".into());
                }
                let mut entries = Vec::new();
                for entry in payload[12..].as_chunks::<28>().0 {
                    let resource_handle = u32_at(entry, 8);
                    let offset = u64_at(entry, 12);
                    let size = u64_at(entry, 20);
                    let resource = match u32_at(entry, 4) {
                        1 => {
                            let buffer = self
                                .buffers
                                .get(&resource_handle)
                                .ok_or("unknown buffer handle")?;
                            wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: &buffer.raw,
                                offset,
                                size: std::num::NonZeroU64::new(size),
                            })
                        }
                        2 if offset == 0 && size == 0 => wgpu::BindingResource::Sampler(
                            self.samplers
                                .get(&resource_handle)
                                .ok_or("unknown sampler handle")?,
                        ),
                        3 if offset == 0 && size == 0 => wgpu::BindingResource::TextureView(
                            &self
                                .views
                                .get(&resource_handle)
                                .ok_or("unknown texture view handle")?
                                .1,
                        ),
                        _ => return Err("invalid bind group resource".into()),
                    };
                    entries.push(wgpu::BindGroupEntry {
                        binding: u32_at(entry, 0),
                        resource,
                    });
                }
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout,
                    entries: &entries,
                });
                if let Some(error) = pollster::block_on(scope.pop()) {
                    return Err(error.to_string());
                }
                self.bind_groups.insert(handle, group);
                Ok(None)
            }
            12 => {
                if payload.len() < 8 || !(payload.len() - 8).is_multiple_of(4) {
                    return Err("invalid pipeline layout length".into());
                }
                let handle = u32_at(payload, 0);
                if self.handle_used(handle) {
                    return Err("invalid or duplicate pipeline layout handle".into());
                }
                if u32_at(payload, 4) as usize != (payload.len() - 8) / 4 {
                    return Err("invalid pipeline layout count".into());
                }
                let layouts = payload[8..]
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|bytes| {
                        self.bind_group_layouts
                            .get(&u32::from_le_bytes(*bytes))
                            .map(Some)
                            .ok_or("unknown bind group layout handle")
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let layout = self
                    .device
                    .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                        label: None,
                        bind_group_layouts: &layouts,
                        immediate_size: 0,
                    });
                if let Some(error) = pollster::block_on(scope.pop()) {
                    return Err(error.to_string());
                }
                self.pipeline_layouts.insert(handle, layout);
                Ok(None)
            }
            13 => {
                if payload.len() < 9 {
                    return Err("invalid render pipeline length".into());
                }
                let handle = u32_at(payload, 0);
                if self.handle_used(handle) {
                    return Err("invalid or duplicate render pipeline handle".into());
                }
                let request = u32_at(payload, 4);
                let spec: crate::pipeline::Pipeline = serde_json::from_slice(&payload[8..])
                    .map_err(|error| format!("invalid render pipeline descriptor: {error}"))?;
                self.set_label(handle, &spec.label);
                let layout = match spec.layout {
                    0 => None,
                    handle => Some(
                        self.pipeline_layouts
                            .get(&handle)
                            .ok_or("unknown pipeline layout handle")?,
                    ),
                };
                let vertex = self
                    .shaders
                    .get(&spec.vertex.module)
                    .ok_or("unknown vertex shader handle")?;
                let fragment = match &spec.fragment {
                    Some(stage) => Some(
                        self.shaders
                            .get(&stage.module)
                            .ok_or("unknown fragment shader handle")?,
                    ),
                    None => None,
                };
                if vertex.is_none() || fragment.is_some_and(Option::is_none) {
                    self.render_pipelines.insert(handle, None);
                    return Err(format!("pipeline {} uses an invalid shader", spec.label));
                }
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let result = spec.create(
                    &self.device,
                    layout,
                    vertex.as_ref().unwrap(),
                    fragment.and_then(Option::as_ref),
                );
                let validation_error = pollster::block_on(scope.pop());
                let pipeline = match (result, validation_error) {
                    (Ok(pipeline), None) => pipeline,
                    (Err(error), _) => {
                        self.render_pipelines.insert(handle, None);
                        return Err(format!("pipeline {}: {error}", spec.label));
                    }
                    (_, Some(error)) => {
                        self.render_pipelines.insert(handle, None);
                        return Err(format!("pipeline {}: {error}", spec.label));
                    }
                };
                self.render_pipelines.insert(handle, Some(pipeline));
                Ok((request != 0).then_some(Response::Validation { request }))
            }
            14 => {
                if self.render_pass.is_some() {
                    return Err("render pass already active".into());
                }
                if payload.len() < 36 || !(payload.len() - 36).is_multiple_of(52) {
                    return Err("invalid render pass length".into());
                }
                if u32_at(payload, 0) as usize != (payload.len() - 36) / 52 {
                    return Err("invalid color attachment count".into());
                }
                let mut colors = Vec::new();
                for entry in payload[4..payload.len() - 32].as_chunks::<52>().0 {
                    let flags = u32_at(entry, 0);
                    if flags == 0 {
                        colors.push(None);
                        continue;
                    }
                    if flags != 1 && flags != 3 {
                        return Err("invalid color attachment flags".into());
                    }
                    let view = &self
                        .views
                        .get(&u32_at(entry, 4))
                        .ok_or("unknown color view handle")?
                        .1;
                    let resolve_target = if flags & 2 != 0 {
                        Some(
                            &self
                                .views
                                .get(&u32_at(entry, 8))
                                .ok_or("unknown resolve view handle")?
                                .1,
                        )
                    } else {
                        None
                    };
                    let component = |offset| f64::from_bits(u64_at(entry, offset));
                    let clear = wgpu::Color {
                        r: component(20),
                        g: component(28),
                        b: component(36),
                        a: component(44),
                    };
                    if ![clear.r, clear.g, clear.b, clear.a]
                        .iter()
                        .all(|value| value.is_finite())
                    {
                        return Err("invalid clear color".into());
                    }
                    let load = match u32_at(entry, 12) {
                        0 => wgpu::LoadOp::Load,
                        1 => wgpu::LoadOp::Clear(clear),
                        _ => return Err("invalid color load operation".into()),
                    };
                    let store = match u32_at(entry, 16) {
                        0 => wgpu::StoreOp::Discard,
                        1 => wgpu::StoreOp::Store,
                        _ => return Err("invalid color store operation".into()),
                    };
                    colors.push(Some(wgpu::RenderPassColorAttachment {
                        view,
                        depth_slice: None,
                        resolve_target,
                        ops: wgpu::Operations { load, store },
                    }));
                }
                let depth_entry = &payload[payload.len() - 32..];
                let depth_view = u32_at(depth_entry, 0);
                let depth = if depth_view == 0 {
                    None
                } else {
                    let view = &self
                        .views
                        .get(&depth_view)
                        .ok_or("unknown depth view handle")?
                        .1;
                    let flags = u32_at(depth_entry, 4);
                    if flags > 3 {
                        return Err("invalid depth attachment flags".into());
                    }
                    let depth_clear = f32::from_bits(u32_at(depth_entry, 16));
                    if !depth_clear.is_finite() {
                        return Err("invalid depth clear value".into());
                    }
                    let load = |value, clear| match value {
                        0 => Ok(wgpu::LoadOp::Load),
                        1 => Ok(wgpu::LoadOp::Clear(clear)),
                        _ => Err("invalid attachment load operation"),
                    };
                    let store = |value| match value {
                        0 => Ok(wgpu::StoreOp::Discard),
                        1 => Ok(wgpu::StoreOp::Store),
                        _ => Err("invalid attachment store operation"),
                    };
                    let depth_ops = if flags & 1 != 0 {
                        Some(wgpu::Operations {
                            load: load(u32_at(depth_entry, 8), depth_clear)?,
                            store: store(u32_at(depth_entry, 12))?,
                        })
                    } else {
                        None
                    };
                    let stencil_ops = if flags & 2 != 0 {
                        let stencil_load = match u32_at(depth_entry, 20) {
                            0 => wgpu::LoadOp::Load,
                            1 => wgpu::LoadOp::Clear(u32_at(depth_entry, 28)),
                            _ => return Err("invalid stencil load operation".into()),
                        };
                        Some(wgpu::Operations {
                            load: stencil_load,
                            store: store(u32_at(depth_entry, 24))?,
                        })
                    } else {
                        None
                    };
                    Some(wgpu::RenderPassDepthStencilAttachment {
                        view,
                        depth_ops,
                        stencil_ops,
                    })
                };
                let encoder = self
                    .encoder
                    .get_or_insert_with(|| self.device.create_command_encoder(&Default::default()));
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let pass = encoder
                    .begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: None,
                        color_attachments: &colors,
                        depth_stencil_attachment: depth,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                        multiview_mask: None,
                    })
                    .forget_lifetime();
                self.render_pass_scope = Some(scope);
                self.valid_pipeline = None;
                self.pipeline = None;
                self.pass_view = self.subject(14, payload);
                self.render_pass = Some(pass);
                Ok(None)
            }
            15 => {
                size(payload, 4)?;
                let pipeline = self
                    .render_pipelines
                    .get(&u32_at(payload, 0))
                    .ok_or("unknown render pipeline handle")?;
                let pass = self.render_pass.as_mut().ok_or("no active render pass")?;
                self.valid_pipeline = Some(pipeline.is_some());
                self.pipeline = Some(u32_at(payload, 0));
                if let Some(pipeline) = pipeline {
                    pass.set_pipeline(pipeline);
                }
                Ok(None)
            }
            16 => {
                if payload.len() < 12
                    || !(payload.len() - 12).is_multiple_of(4)
                    || u32_at(payload, 8) as usize != (payload.len() - 12) / 4
                {
                    return Err("invalid bind group command".into());
                }
                let group = self
                    .bind_groups
                    .get(&u32_at(payload, 4))
                    .ok_or("unknown bind group handle")?;
                let offsets: Vec<_> = payload[12..]
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|value| u32::from_le_bytes(*value))
                    .collect();
                self.render_pass
                    .as_mut()
                    .ok_or("no active render pass")?
                    .set_bind_group(u32_at(payload, 0), group, &offsets);
                Ok(None)
            }
            17 | 18 => {
                size(payload, 24)?;
                let buffer = self
                    .buffers
                    .get(&u32_at(payload, 4))
                    .ok_or("unknown render buffer handle")?;
                let usage = if opcode == 17 {
                    wgpu::BufferUsages::VERTEX
                } else {
                    wgpu::BufferUsages::INDEX
                };
                let slice = buffer_slice(buffer, u64_at(payload, 8), u64_at(payload, 16), usage)?;
                let pass = self.render_pass.as_mut().ok_or("no active render pass")?;
                if opcode == 17 {
                    pass.set_vertex_buffer(u32_at(payload, 0), slice);
                } else {
                    let format = match u32_at(payload, 0) {
                        0 => wgpu::IndexFormat::Uint16,
                        1 => wgpu::IndexFormat::Uint32,
                        _ => return Err("invalid index format".into()),
                    };
                    pass.set_index_buffer(slice, format);
                }
                Ok(None)
            }
            19 => {
                size(payload, 24)?;
                let values =
                    [0, 4, 8, 12, 16, 20].map(|offset| f32::from_bits(u32_at(payload, offset)));
                if !values.iter().all(|value| value.is_finite()) {
                    return Err("invalid viewport".into());
                }
                self.render_pass
                    .as_mut()
                    .ok_or("no active render pass")?
                    .set_viewport(
                        values[0], values[1], values[2], values[3], values[4], values[5],
                    );
                Ok(None)
            }
            20 => {
                size(payload, 16)?;
                self.render_pass
                    .as_mut()
                    .ok_or("no active render pass")?
                    .set_scissor_rect(
                        u32_at(payload, 0),
                        u32_at(payload, 4),
                        u32_at(payload, 8),
                        u32_at(payload, 12),
                    );
                Ok(None)
            }
            21 => {
                size(payload, 32)?;
                let values = [0, 8, 16, 24].map(|offset| f64::from_bits(u64_at(payload, offset)));
                if !values.iter().all(|value| value.is_finite()) {
                    return Err("invalid blend constant".into());
                }
                self.render_pass
                    .as_mut()
                    .ok_or("no active render pass")?
                    .set_blend_constant(wgpu::Color {
                        r: values[0],
                        g: values[1],
                        b: values[2],
                        a: values[3],
                    });
                Ok(None)
            }
            22 => {
                size(payload, 4)?;
                self.render_pass
                    .as_mut()
                    .ok_or("no active render pass")?
                    .set_stencil_reference(u32_at(payload, 0));
                Ok(None)
            }
            23 | 24 => {
                size(payload, if opcode == 23 { 16 } else { 20 })?;
                let pass = self.render_pass.as_mut().ok_or("no active render pass")?;
                let valid = self.valid_pipeline.ok_or("no render pipeline set")?;
                let first = u32_at(payload, 8);
                let end = first
                    .checked_add(u32_at(payload, 0))
                    .ok_or("draw range overflow")?;
                let first_instance = u32_at(payload, if opcode == 23 { 12 } else { 16 });
                let end_instance = first_instance
                    .checked_add(u32_at(payload, 4))
                    .ok_or("instance range overflow")?;
                if valid {
                    if opcode == 23 {
                        pass.draw(first..end, first_instance..end_instance);
                    } else {
                        pass.draw_indexed(
                            first..end,
                            u32_at(payload, 12) as i32,
                            first_instance..end_instance,
                        );
                    }
                }
                Ok(None)
            }
            25 => {
                size(payload, 0)?;
                drop(self.render_pass.take().ok_or("no active render pass")?);
                let scope = self
                    .render_pass_scope
                    .take()
                    .expect("active pass has an error scope");
                if let Some(error) = pollster::block_on(scope.pop()) {
                    self.encoder = None;
                    return Err(error.to_string());
                }
                Ok(None)
            }
            30 => {
                size(payload, 12)?;
                let handle = u32_at(payload, 0);
                if self.handle_used(handle) {
                    return Err("invalid or duplicate surface handle".into());
                }
                let surface = self.surface.clone().ok_or("no surface for this frame")?;
                let (width, height) = (u32_at(payload, 4), u32_at(payload, 8));
                let current = (surface.width(), surface.height()) == (width, height);
                // A canvas texture acquired before a resize renders offscreen, as a browser
                // discards it, so the frame's later draws still reach the resized surface.
                let raw = if current {
                    surface
                } else {
                    let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                    let stale = self.device.create_texture(&wgpu::TextureDescriptor {
                        label: Some("stale surface"),
                        size: wgpu::Extent3d {
                            width,
                            height,
                            depth_or_array_layers: 1,
                        },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: surface.format(),
                        usage: surface.usage(),
                        view_formats: &[],
                    });
                    if let Some(error) = pollster::block_on(scope.pop()) {
                        return Err(error.to_string());
                    }
                    stale
                };
                self.textures.insert(
                    handle,
                    Texture {
                        format: raw.format(),
                        width: raw.width(),
                        height: raw.height(),
                        layers: 1,
                        mips: 1,
                        samples: 1,
                        usage: raw.usage(),
                        raw,
                    },
                );
                self.surface_handles.push(handle);
                self.surface_used |= current;
                Ok(None)
            }
            31 => {
                size(payload, 12)?;
                let handle = u32_at(payload, 0);
                if self.handle_used(handle) {
                    return Err("invalid or duplicate bind group layout handle".into());
                }
                let pipeline = self
                    .render_pipelines
                    .get(&u32_at(payload, 4))
                    .ok_or("unknown render pipeline handle")?
                    .as_ref()
                    .ok_or("render pipeline is invalid")?;
                let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                let layout = pipeline.get_bind_group_layout(u32_at(payload, 8));
                if let Some(error) = pollster::block_on(scope.pop()) {
                    return Err(error.to_string());
                }
                self.bind_group_layouts.insert(handle, layout);
                Ok(None)
            }
            29 => {
                size(payload, 4)?;
                let handle = u32_at(payload, 0);
                if self.shaders.remove(&handle).is_none()
                    && self.views.remove(&handle).is_none()
                    && self.samplers.remove(&handle).is_none()
                    && self.bind_groups.remove(&handle).is_none()
                    && self.render_pipelines.remove(&handle).is_none()
                    && self.pipeline_layouts.remove(&handle).is_none()
                    && self.bind_group_layouts.remove(&handle).is_none()
                {
                    return Err("unknown resource handle".into());
                }
                self.labels.remove(&handle);
                Ok(None)
            }
            26 => {
                size(payload, 0)?;
                if self.render_pass.is_some() {
                    return Err("cannot submit an active render pass".into());
                }
                if let Some(encoder) = self.encoder.take() {
                    let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
                    let commands = encoder.finish();
                    self.queue.submit([commands]);
                    if let Some(error) = pollster::block_on(scope.pop()) {
                        return Err(error.to_string());
                    }
                } else {
                    self.queue.submit([]);
                }
                Ok(None)
            }
            _ => Err(format!("GPU opcode {opcode} is not implemented")),
        }
    }
}
