//! Replays recorded frames onto an offscreen surface on a software adapter and saves the last frame.
//! Usage: replay <width> <height> <out.png> <frame.bin>...

use threejsc_gpu::{Executor, Response};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [width, height, out, frames @ ..] = args.as_slice() else {
        panic!("usage: replay <width> <height> <out.png> <frame.bin>...");
    };
    let (width, height): (u32, u32) = (width.parse().unwrap(), height.parse().unwrap());
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::from_env().unwrap_or(wgpu::Backends::VULKAN),
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::from_env_or_default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software adapter is required");
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut surface = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("surface"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let mut executor = Executor::new(device.clone(), queue.clone());
    for (index, path) in frames.iter().enumerate() {
        for response in executor
            .replay(&std::fs::read(path).unwrap(), Some(&mut surface))
            .unwrap()
        {
            if let Response::Error {
                command,
                label,
                message,
                ..
            } = response
            {
                eprintln!("frame {index} command {command} label {label:?}: {message}");
            }
        }
    }
    let stride = (width * 4).div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: u64::from(stride * height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        surface.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: None,
            },
        },
        surface.size(),
    );
    queue.submit([encoder.finish()]);
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, |result| result.unwrap());
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    let data = buffer.slice(..).get_mapped_range().unwrap();
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for row in data.chunks(stride as usize) {
        for pixel in row[..(width * 4) as usize].as_chunks::<4>().0 {
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
    }
    image::save_buffer(out, &rgba, width, height, image::ColorType::Rgba8).unwrap();
}
