use std::{collections::HashMap, sync::mpsc};

use crate::decode;

struct Buffer {
    raw: wgpu::Buffer,
    size: u64,
    usage: wgpu::BufferUsages,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Response {
    Readback {
        request: u32,
        bytes: Vec<u8>,
    },
    Error {
        command: usize,
        request: Option<u32>,
        message: String,
    },
}

pub struct Executor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    buffers: HashMap<u32, Buffer>,
    shaders: HashMap<u32, Option<wgpu::ShaderModule>>,
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

impl Executor {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue) -> Self {
        Self {
            device,
            queue,
            buffers: HashMap::new(),
            shaders: HashMap::new(),
        }
    }

    pub fn replay(&mut self, frame: &[u8]) -> Result<Vec<Response>, crate::DecodeError> {
        let records = decode(frame)?;
        let mut responses = Vec::new();
        for (command, record) in records.iter().enumerate() {
            match self.execute(record.opcode, record.payload) {
                Ok(Some(response)) => responses.push(response),
                Ok(None) => {}
                Err(message) => responses.push(Response::Error {
                    command,
                    request: (record.opcode == 27 && record.payload.len() >= 4)
                        .then(|| u32_at(record.payload, 0)),
                    message,
                }),
            }
        }
        Ok(responses)
    }

    fn execute(&mut self, opcode: u16, payload: &[u8]) -> Result<Option<Response>, String> {
        match opcode {
            1 => {
                size(payload, 16)?;
                let handle = u32_at(payload, 0);
                let len = u64_at(payload, 4);
                let usage = wgpu::BufferUsages::from_bits(u32_at(payload, 12))
                    .ok_or("invalid buffer usage")?;
                if handle == 0
                    || self.buffers.contains_key(&handle)
                    || self.shaders.contains_key(&handle)
                {
                    return Err("invalid or duplicate buffer handle".into());
                }
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
                    label: None,
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
            9 => {
                if payload.len() < 12 {
                    return Err("truncated shader".into());
                }
                let handle = u32_at(payload, 0);
                let label_len = u32_at(payload, 4) as usize;
                let code_len = u32_at(payload, 8) as usize;
                let label_end = 12usize
                    .checked_add(label_len)
                    .ok_or("invalid shader length")?;
                let code_end = label_end
                    .checked_add(code_len)
                    .ok_or("invalid shader length")?;
                if code_end != payload.len() {
                    return Err("invalid shader length".into());
                }
                if handle == 0
                    || self.buffers.contains_key(&handle)
                    || self.shaders.contains_key(&handle)
                {
                    return Err("invalid or duplicate shader handle".into());
                }
                let label = std::str::from_utf8(&payload[12..label_end])
                    .map_err(|_| "invalid shader label")?;
                let code = std::str::from_utf8(&payload[label_end..code_end])
                    .map_err(|_| "invalid shader source")?;
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
                Ok(None)
            }
            29 => {
                size(payload, 4)?;
                self.shaders
                    .remove(&u32_at(payload, 0))
                    .ok_or("unknown shader handle")?;
                Ok(None)
            }
            26 => {
                size(payload, 0)?;
                self.queue.submit([]);
                Ok(None)
            }
            _ => Err(format!("GPU opcode {opcode} is not implemented")),
        }
    }
}
