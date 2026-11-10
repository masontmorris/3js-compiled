use std::{
    ops::{Deref, DerefMut},
    sync::{Mutex, MutexGuard, PoisonError},
};

use threejsc_gpu::{Executor, Response};

// Each bound sits just above the scene's difference from Edge on llvmpipe and WARP, so a replay
// that drops or changes a draw fails. docs/testing.md lists the measured values.
const BASIC_CUBE_BOUND: f64 = 0.00001;
const SHADOW_BOUND: f64 = 0.0001;
const SHADOW_REGION_BOUND: f64 = 0.00015;
const INVALID_WGSL_BOUND: f64 = 0.00001;

/// A value that uses the software adapter while no other test in this process does. WARP's shader
/// JIT can fault when several devices in one process compile and destroy shaders at once, so a test
/// keeps its turn until its device is dropped. docs/testing.md has the crash evidence.
struct Exclusive<T> {
    value: T,
    _turn: MutexGuard<'static, ()>,
}

impl<T> Deref for Exclusive<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.value
    }
}

impl<T> DerefMut for Exclusive<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.value
    }
}

fn device() -> Exclusive<(wgpu::Device, wgpu::Queue)> {
    static ADAPTER: Mutex<()> = Mutex::new(());
    let turn = ADAPTER.lock().unwrap_or_else(PoisonError::into_inner);
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::from_env().unwrap_or(wgpu::Backends::VULKAN),
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    Exclusive {
        value: pollster::block_on(adapter.request_device(&Default::default())).unwrap(),
        _turn: turn,
    }
}

fn executor() -> Exclusive<Executor> {
    let Exclusive {
        value: (device, queue),
        _turn,
    } = device();
    Exclusive {
        value: Executor::new(device.clone(), queue.clone()),
        _turn,
    }
}

fn error(command: usize, request: Option<u32>, message: &str) -> Response {
    Response::Error {
        frame: 0,
        command,
        request,
        label: None,
        message: message.into(),
    }
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn recorded_buffers_round_trip_on_vulkan() {
    let mut executor = executor();
    let responses = executor
        .replay(include_bytes!("fixtures/buffers.bin"), None)
        .unwrap();
    assert_eq!(
        responses,
        vec![
            Response::Readback {
                request: 2,
                bytes: vec![0, 0, 0, 0, 11, 22, 33, 44, 0, 0, 0, 0, 0, 0, 0, 0]
            },
            error(4, Some(3), "unknown buffer handle"),
        ]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn invalid_shader_reports_its_label_and_other_commands_continue() {
    let mut executor = executor();
    let responses = executor
        .replay(include_bytes!("fixtures/shaders.bin"), None)
        .unwrap();
    assert_eq!(responses.len(), 2);
    match &responses[0] {
        Response::Error {
            command, message, ..
        } => {
            assert_eq!(*command, 0);
            assert!(message.contains("broken-material"), "{message}");
            assert!(message.contains(":2:"), "{message}");
        }
        response => panic!("expected shader error, got {response:?}"),
    }
    assert_eq!(
        responses[1],
        Response::Readback {
            request: 7,
            bytes: vec![8, 7, 6, 5]
        }
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn texture_upload_and_readback_preserve_rows() {
    let mut executor = executor();
    let responses = executor
        .replay(include_bytes!("fixtures/textures.bin"), None)
        .unwrap();
    assert_eq!(
        responses,
        vec![
            Response::Readback {
                request: 11,
                bytes: vec![
                    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255
                ]
            },
            Response::Readback {
                request: 13,
                bytes: vec![4, 3, 2, 1, 8, 7, 6, 5],
            },
            error(7, Some(12), "unknown texture handle"),
            error(8, None, "unknown resource handle"),
        ]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn errors_name_their_frame_and_resource_label() {
    let mut executor = executor();
    let frames: [&[u8]; 4] = [
        include_bytes!("fixtures/labels-0.bin"),
        include_bytes!("fixtures/labels-1.bin"),
        include_bytes!("fixtures/labels-2.bin"),
        include_bytes!("fixtures/labels-3.bin"),
    ];
    let errors: Vec<_> = frames
        .iter()
        .flat_map(|frame| executor.replay(frame, None).unwrap())
        .map(|response| match response {
            Response::Error {
                frame,
                command,
                label,
                message,
                ..
            } => (frame, command, label, message),
            response => panic!("expected an error, got {response:?}"),
        })
        .collect();
    let write = |frame| {
        (
            frame,
            0,
            Some("particles".to_string()),
            "invalid buffer write".to_string(),
        )
    };
    assert_eq!(errors.len(), 4, "{errors:?}");
    assert_eq!(errors[0], write(1));
    assert_eq!(errors[3], write(3));
    assert_eq!(
        (errors[1].0, errors[1].2.as_deref()),
        (2, Some("shadow-map"))
    );
    assert_eq!(errors[2].0, 2);
    assert!(errors[2].3.contains("'particles'"), "{}", errors[2].3);
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn float_and_depth_textures_read_back_their_texels() {
    let halves: Vec<u8> = [0x3c00u16, 0x3800, 0x3400, 0x3c00, 0, 0x3c00, 0, 0x3c00]
        .iter()
        .flat_map(|half| half.to_le_bytes())
        .collect();
    assert_eq!(
        executor()
            .replay(include_bytes!("fixtures/readback-formats.bin"), None)
            .unwrap(),
        vec![
            Response::Readback {
                request: 10,
                bytes: halves
            },
            Response::Readback {
                request: 11,
                bytes: 0.25f32.to_le_bytes().to_vec()
            },
            Response::Readback {
                request: 12,
                bytes: 0.5f32.to_le_bytes().repeat(4)
            },
            error(13, Some(13), "Depth24Plus textures cannot be read back"),
        ]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn anisotropic_comparison_sampler_is_created_and_released() {
    let mut executor = executor();
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/samplers.bin"), None)
            .unwrap(),
        vec![error(2, None, "unknown resource handle"),]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn bind_group_layouts_validate_and_share_the_handle_namespace() {
    let mut executor = executor();
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/layouts.bin"), None)
            .unwrap(),
        vec![
            error(1, None, "invalid or duplicate buffer handle"),
            error(3, None, "unknown resource handle"),
        ]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn recorded_bind_group_accepts_buffers_samplers_and_views() {
    let mut executor = executor();
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/bindings.bin"), None)
            .unwrap(),
        vec![Response::Readback {
            request: 100,
            bytes: vec![1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        }]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn pipeline_layout_keeps_its_bind_group_layout_and_handle() {
    let mut executor = executor();
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/pipeline-layouts.bin"), None)
            .unwrap(),
        vec![error(3, None, "invalid or duplicate buffer handle")]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn recorded_render_pass_clears_and_reads_back_pixels() {
    let mut executor = executor();
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/clear-pass.bin"), None)
            .unwrap(),
        vec![Response::Readback {
            request: 100,
            bytes: vec![
                255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255
            ],
        }]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn recorded_multisample_pass_resolves_with_depth() {
    let mut executor = executor();
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/msaa-pass.bin"), None)
            .unwrap(),
        vec![Response::Readback {
            request: 100,
            bytes: vec![
                0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255
            ],
        }]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn recorded_render_pipeline_validates_with_vertex_and_depth_state() {
    let mut executor = executor();
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/pipeline.bin"), None)
            .unwrap(),
        vec![
            Response::Validation { request: 3 },
            Response::Validation { request: 5 },
            Response::Validation { request: 7 },
            Response::Readback {
                request: 100,
                bytes: vec![4, 3, 2, 1]
            },
        ]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn invalid_shader_and_pipeline_report_requests_and_leave_other_work_usable() {
    let mut executor = executor();
    let responses = executor
        .replay(include_bytes!("fixtures/pipeline-errors.bin"), None)
        .unwrap();
    assert_eq!(responses.len(), 6);
    match &responses[0] {
        Response::Error {
            request, message, ..
        } => {
            assert_eq!(*request, Some(3));
            assert!(message.contains("broken material"), "{message}");
            assert!(message.contains(":2:"), "{message}");
        }
        response => panic!("expected shader diagnostic, got {response:?}"),
    }
    assert_eq!(responses[1], Response::Validation { request: 5 });
    assert_eq!(responses[2], Response::Validation { request: 7 });
    match &responses[3] {
        Response::Error {
            request, message, ..
        } => {
            assert_eq!(*request, Some(9));
            assert!(message.contains("broken material pipeline"), "{message}");
        }
        response => panic!("expected pipeline error, got {response:?}"),
    }
    assert_eq!(responses[4], Response::Validation { request: 11 });
    assert_eq!(
        responses[5],
        Response::Readback {
            request: 100,
            bytes: vec![9, 8, 7, 6]
        }
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn recorded_draws_fill_targets_with_bound_uniform_color() {
    let red = [255, 0, 0, 255].repeat(16);
    assert_eq!(
        executor()
            .replay(include_bytes!("fixtures/draw.bin"), None)
            .unwrap(),
        vec![
            Response::Validation { request: 4 },
            Response::Validation { request: 6 },
            Response::Readback {
                request: 100,
                bytes: red.clone()
            },
            Response::Readback {
                request: 101,
                bytes: red
            },
        ]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn surface_is_bound_for_one_frame_and_bundles_draw_with_an_automatic_layout() {
    let gpu = device();
    let (device, queue) = &*gpu;
    let mut surface = surface_texture(device, 4, 4);
    let mut executor = Executor::new(device.clone(), queue.clone());
    let frame = include_bytes!("fixtures/surface.bin");
    let drawn = vec![
        Response::Validation { request: 2 },
        Response::Readback {
            request: 100,
            bytes: [255, 0, 0, 255].repeat(16),
        },
    ];
    assert_eq!(executor.replay(frame, Some(&mut surface)).unwrap(), drawn);
    assert_eq!(
        executor
            .replay(
                include_bytes!("fixtures/surface-resize.bin"),
                Some(&mut surface)
            )
            .unwrap(),
        vec![Response::Readback {
            request: 100,
            bytes: [0, 255, 0, 255].repeat(16)
        }],
        "a texture acquired before a resize no longer reaches the canvas"
    );
    assert!(executor.surface_used());
    assert_eq!((surface.width(), surface.height()), (4, 4));
    let mut larger = surface_texture(device, 8, 8);
    let mut executor = Executor::new(device.clone(), queue.clone());
    assert_eq!(
        executor.replay(frame, Some(&mut larger)).unwrap(),
        drawn,
        "a canvas acquired at another size reads back at its own size"
    );
    assert_eq!((larger.width(), larger.height()), (4, 4));
    let missing = executor.replay(frame, None).unwrap();
    assert!(
        missing.iter().any(|response| matches!(response, Response::Error { message, .. } if message == "no surface for this frame")),
        "{missing:?}"
    );
}

fn surface_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: None,
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
    })
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn a_stream_cannot_destroy_the_host_surface() {
    let gpu = device();
    let (device, queue) = &*gpu;
    let mut surface = surface_texture(device, 4, 4);
    let mut executor = Executor::new(device.clone(), queue.clone());
    assert_eq!(
        executor
            .replay(
                include_bytes!("fixtures/surface-destroy.bin"),
                Some(&mut surface)
            )
            .unwrap(),
        vec![
            error(
                1,
                None,
                "the surface texture belongs to the host and cannot be destroyed"
            ),
            Response::Readback {
                request: 100,
                bytes: [0, 255, 0, 255].repeat(16)
            },
        ]
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn each_frame_that_acquires_the_surface_starts_transparent() {
    let gpu = device();
    let (device, queue) = &*gpu;
    let mut surface = surface_texture(device, 4, 4);
    let mut executor = Executor::new(device.clone(), queue.clone());
    let acquire = |texture: u32, view: u32| {
        [
            (30, words(&[texture, 4, 4])),
            (7, words(&[view, texture, 0, 0, 0, 0, 0, 0, 0])),
        ]
    };
    let pass = |view: u32, load: u32| {
        let mut payload = words(&[1, 1, view, 0, load, 1]);
        for component in [0.0f64, 0.0, 1.0, 1.0] {
            payload.extend_from_slice(&component.to_bits().to_le_bytes());
        }
        payload.extend_from_slice(&[0; 32]);
        [(14, payload), (25, vec![]), (26, vec![])]
    };
    let read = |texture: u32| (28, words(&[100, texture, 0, 0, 0, 0, 4, 4]));
    let readback = |bytes: [u8; 4]| Response::Readback {
        request: 100,
        bytes: bytes.repeat(16),
    };
    let blue = [255, 0, 0, 255];
    let mut cleared = acquire(1, 2).to_vec();
    cleared.extend(pass(2, 1));
    cleared.push(read(1));
    assert_eq!(
        executor
            .replay(&stream(&cleared), Some(&mut surface))
            .unwrap(),
        vec![readback(blue)]
    );
    let mut loaded = acquire(3, 4).to_vec();
    loaded.extend(pass(4, 0));
    loaded.push(read(3));
    assert_eq!(
        executor
            .replay(&stream(&loaded), Some(&mut surface))
            .unwrap(),
        vec![readback([0; 4])],
        "a pass that loads a newly acquired surface sees transparent black, as in a browser"
    );
    let mut redrawn = acquire(5, 6).to_vec();
    redrawn.extend(pass(6, 1));
    redrawn.extend(pass(6, 0));
    redrawn.push(read(5));
    assert_eq!(
        executor
            .replay(&stream(&redrawn), Some(&mut surface))
            .unwrap(),
        vec![readback(blue)],
        "later passes in the same frame load what the frame drew"
    );
    let mut unused = acquire(7, 8).to_vec();
    unused.push(read(7));
    assert_eq!(
        executor
            .replay(&stream(&unused), Some(&mut surface))
            .unwrap(),
        vec![readback([0; 4])],
        "an acquired surface that nothing draws reads as transparent black"
    );
}

fn read_surface(device: &wgpu::Device, queue: &wgpu::Queue, surface: &wgpu::Texture) -> Vec<u8> {
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 256 * 4,
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
                bytes_per_row: Some(256),
                rows_per_image: Some(4),
            },
        },
        wgpu::Extent3d {
            width: 4,
            height: 4,
            depth_or_array_layers: 1,
        },
    );
    queue.submit([encoder.finish()]);
    buffer.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    let data = buffer.slice(..).get_mapped_range().unwrap();
    data.chunks(256)
        .flat_map(|row| row[..16].to_vec())
        .collect()
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn a_surface_pass_that_never_reaches_the_queue_leaves_it_transparent() {
    let gpu = device();
    let (device, queue) = &*gpu;
    let mut surface = surface_texture(device, 4, 4);
    let mut executor = Executor::new(device.clone(), queue.clone());
    let acquire = |texture: u32, view: u32| {
        vec![
            (30, words(&[texture, 4, 4])),
            (7, words(&[view, texture, 0, 0, 0, 0, 0, 0, 0])),
        ]
    };
    let begin = |view: u32, load: u32| {
        let mut payload = words(&[1, 1, view, 0, load, 1]);
        for component in [0.0f64, 0.0, 1.0, 1.0] {
            payload.extend_from_slice(&component.to_bits().to_le_bytes());
        }
        payload.extend_from_slice(&[0; 32]);
        (14, payload)
    };
    let read = |texture: u32| (28, words(&[100, texture, 0, 0, 0, 0, 4, 4]));
    let readback = |bytes: [u8; 4]| Response::Readback {
        request: 100,
        bytes: bytes.repeat(16),
    };
    let mut next = 1;
    let mut draw_blue = |executor: &mut Executor, surface: &mut wgpu::Texture| {
        let mut records = acquire(next, next + 1);
        records.extend([begin(next + 1, 1), (25, vec![]), (26, vec![])]);
        next += 2;
        assert_eq!(
            executor.replay(&stream(&records), Some(surface)).unwrap(),
            vec![]
        );
    };

    draw_blue(&mut executor, &mut surface);
    let mut invalid = acquire(101, 102);
    invalid.extend([
        begin(102, 0),
        (20, words(&[0, 0, 100, 100])),
        (25, vec![]),
        (26, vec![]),
        read(101),
    ]);
    let responses = executor
        .replay(&stream(&invalid), Some(&mut surface))
        .unwrap();
    assert!(
        responses.last() == Some(&readback([0; 4])),
        "a first pass that fails validation leaves the surface transparent: {responses:?}"
    );

    draw_blue(&mut executor, &mut surface);
    let mut early = acquire(201, 202);
    early.extend([begin(202, 0), (25, vec![]), read(201), (26, vec![])]);
    assert_eq!(
        executor
            .replay(&stream(&early), Some(&mut surface))
            .unwrap(),
        vec![readback([0; 4])],
        "a readback before the first pass submits sees transparent black"
    );

    draw_blue(&mut executor, &mut surface);
    let mut unsubmitted = acquire(301, 302);
    unsubmitted.extend([begin(302, 0), (25, vec![])]);
    executor
        .replay(&stream(&unsubmitted), Some(&mut surface))
        .unwrap();
    assert_eq!(
        read_surface(device, queue, &surface),
        [0; 4].repeat(16),
        "a frame whose first pass never submits shows transparent black"
    );

    let mut one_encoder = acquire(401, 402);
    one_encoder.extend([
        begin(402, 1),
        (25, vec![]),
        begin(402, 0),
        (25, vec![]),
        (26, vec![]),
        read(401),
    ]);
    assert_eq!(
        executor
            .replay(&stream(&one_encoder), Some(&mut surface))
            .unwrap(),
        vec![readback([255, 0, 0, 255])],
        "a later pass in the first pass's encoder loads what that pass drew"
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn errors_outside_error_scopes_become_responses() {
    let gpu = device();
    let (device, queue) = &*gpu;
    let mut surface = surface_texture(device, 4, 4);
    let mut executor = Executor::new(device.clone(), queue.clone());
    let replaced = surface.clone();
    executor
        .replay(include_bytes!("fixtures/surface.bin"), Some(&mut surface))
        .unwrap();
    // The next frame draws into the canvas texture that the first frame replaced.
    replaced.destroy();
    let responses = executor
        .replay(include_bytes!("fixtures/surface.bin"), Some(&mut surface))
        .unwrap();
    assert!(
        responses.iter().any(|response| matches!(
            response,
            Response::Error { request: Some(100), message, .. } if message.contains("destroyed")
        )),
        "{responses:?}"
    );
}

struct Parity {
    mean: f64,
    region: f64,
}

/// Replays two recorded frames onto a 1280x720 surface and returns the mean RGB difference from
/// the Edge capture over the frame and over `region` (inclusive pixel bounds), as fractions of
/// full scale. Every error must name `expected_error`.
fn parity(
    scene: &str,
    frames: [&[u8]; 2],
    edge: &[u8],
    region: [u32; 4],
    expected_error: Option<&str>,
) -> Parity {
    let gpu = device();
    let (device, queue) = &*gpu;
    let mut surface = surface_texture(device, 1280, 720);
    let mut executor = Executor::new(device.clone(), queue.clone());
    let mut responses = executor.replay(frames[0], Some(&mut surface)).unwrap();
    responses.extend(executor.replay(frames[1], Some(&mut surface)).unwrap());
    let unexpected: Vec<_> = responses
        .iter()
        .filter(|response| match response {
            Response::Error { message, .. } => {
                expected_error.is_none_or(|expected| !message.contains(expected))
            }
            _ => false,
        })
        .collect();
    assert!(unexpected.is_empty(), "{scene}: {unexpected:?}");
    let native = responses
        .iter()
        .find_map(|response| match response {
            Response::Readback {
                request: u32::MAX,
                bytes,
            } => Some(bytes),
            _ => None,
        })
        .expect("surface readback");
    let edge = image::load_from_memory(edge).unwrap().to_rgba8();
    let [left, top, right, bottom] = region;
    let (mut total, mut inside) = (0u64, 0u64);
    for ((index, bgra), (x, y, rgba)) in native.chunks(4).enumerate().zip(edge.enumerate_pixels()) {
        assert_eq!(index, (y * 1280 + x) as usize);
        let delta: u64 = (0..3)
            .map(|c| u64::from(bgra[2 - c].abs_diff(rgba[c])))
            .sum();
        total += delta;
        if (left..=right).contains(&x) && (top..=bottom).contains(&y) {
            inside += delta;
        }
    }
    let area = f64::from((right - left + 1) * (bottom - top + 1));
    let parity = Parity {
        mean: total as f64 / (1280.0 * 720.0 * 3.0 * 255.0),
        region: inside as f64 / (area * 3.0 * 255.0),
    };
    println!(
        "{scene}: mean {:.7}, region {:.7}",
        parity.mean, parity.region
    );
    parity
}

const FULL_FRAME: [u32; 4] = [0, 0, 1279, 719];
/// The cube's shadow on the floor in the Edge capture, from lane 4 of the E3 verification.
const SHADOW: [u32; 4] = [557, 384, 830, 465];

fn standard_shadow(frames: [&[u8]; 2]) -> Parity {
    parity(
        "standard-shadow",
        frames,
        include_bytes!("fixtures/standard-shadow-edge.png"),
        SHADOW,
        None,
    )
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn recorded_three_scenes_match_edge_captures() {
    let basic = parity(
        "basic-cube",
        [
            include_bytes!("fixtures/basic-cube-0.bin"),
            include_bytes!("fixtures/basic-cube-1.bin"),
        ],
        include_bytes!("fixtures/basic-cube-edge.png"),
        FULL_FRAME,
        None,
    );
    assert!(basic.mean < BASIC_CUBE_BOUND, "basic-cube: {}", basic.mean);
    let shadow = standard_shadow([
        include_bytes!("fixtures/standard-shadow-0.bin"),
        include_bytes!("fixtures/standard-shadow-1.bin"),
    ]);
    assert!(
        shadow.mean < SHADOW_BOUND,
        "standard-shadow: {}",
        shadow.mean
    );
    assert!(
        shadow.region < SHADOW_REGION_BOUND,
        "standard-shadow region: {}",
        shadow.region
    );
    let invalid = parity(
        "invalid-wgsl",
        [
            include_bytes!("fixtures/invalid-wgsl-0.bin"),
            include_bytes!("fixtures/invalid-wgsl-1.bin"),
        ],
        include_bytes!("fixtures/invalid-wgsl-edge.png"),
        FULL_FRAME,
        Some("invalid-wgsl-material"),
    );
    assert!(
        invalid.mean < INVALID_WGSL_BOUND,
        "invalid-wgsl: {}",
        invalid.mean
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn the_parity_gate_rejects_a_render_without_its_shadow() {
    let shadowless = standard_shadow([
        include_bytes!("fixtures/standard-shadow-off-0.bin"),
        include_bytes!("fixtures/standard-shadow-off-1.bin"),
    ]);
    assert!(
        shadowless.mean >= SHADOW_BOUND && shadowless.region >= SHADOW_REGION_BOUND,
        "a shadowless render passed: mean {}, region {}",
        shadowless.mean,
        shadowless.region
    );
}

fn stream(records: &[(u16, Vec<u8>)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (opcode, payload) in records {
        body.extend_from_slice(&opcode.to_le_bytes());
        body.extend_from_slice(&0u16.to_le_bytes());
        body.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        body.extend_from_slice(payload);
    }
    let mut bytes = b"3JSC".to_vec();
    bytes.extend_from_slice(&threejsc_gpu::VERSION.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&(20 + body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&(records.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&body);
    bytes
}

fn records(stream: &[u8]) -> Vec<(u16, Vec<u8>)> {
    threejsc_gpu::decode(stream)
        .unwrap()
        .records
        .iter()
        .map(|record| (record.opcode, record.payload.to_vec()))
        .collect()
}

fn words(values: &[u32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn a_vertex_attribute_offset_past_u64_is_an_error_in_every_build() {
    let mut records = records(include_bytes!("fixtures/pipeline.bin"));
    let (_, payload) = records
        .iter_mut()
        .find(|(opcode, _)| *opcode == 13)
        .unwrap();
    let json = String::from_utf8(payload[8..].to_vec()).unwrap();
    let crafted = json.replacen("\"offset\":0", "\"offset\":18446744073709551612", 1);
    assert_ne!(crafted, json);
    payload.truncate(8);
    payload.extend_from_slice(crafted.as_bytes());
    let responses = executor().replay(&stream(&records), None).unwrap();
    assert!(
        responses.iter().any(|response| matches!(
            response,
            Response::Error { message, .. } if message.contains("vertex attribute")
        )),
        "{responses:?}"
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn a_partial_depth_readback_reports_its_error_once() {
    let format = "depth32float";
    let mut texture = words(&[1, 5, 3, 1, 1, 1, 17, format.len() as u32, 0]);
    texture.extend_from_slice(format.as_bytes());
    let responses = executor()
        .replay(
            &stream(&[(4, texture), (28, words(&[10, 1, 0, 2, 1, 0, 3, 2]))]),
            None,
        )
        .unwrap();
    let [
        Response::Error {
            request, message, ..
        },
    ] = responses.as_slice()
    else {
        panic!("expected one error, got {responses:?}");
    };
    assert_eq!(*request, Some(10));
    let first = message.lines().next().unwrap();
    assert_eq!(message.matches(first).count(), 1, "{message}");
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const WORDS: [u32; 16] = [
    0,
    1,
    2,
    3,
    4,
    5,
    7,
    8,
    16,
    255,
    256,
    16384,
    65535,
    0x7fff_ffff,
    0x8000_0000,
    0xffff_ffff,
];
const NUMBERS: [&str; 8] = [
    "0",
    "4294967295",
    "4294967296",
    "9007199254740993",
    "18446744073709551612",
    "18446744073709551615",
    "-1",
    "1e40",
];

/// The largest texture a mutation may create: width, height, layers, and samples times 16 bytes
/// per texel and twice that for mips. WARP commits system memory for every texture it creates.
const TEXTURE_BUDGET: u64 = 256 << 20;

fn texture_bytes(payload: &[u8]) -> u64 {
    [4, 8, 12, 20]
        .iter()
        .map(|at| u64::from(u32::from_le_bytes(payload[*at..at + 4].try_into().unwrap())))
        .fold(32, u64::saturating_mul)
}

/// Changes one to three records: duplicates, removes, or swaps a record, replaces one `u32` word
/// of its payload, or replaces one number in the JSON of one of the stream's render pipelines. It
/// never changes a draw, whose instance count alone can keep WARP allocating for minutes, and it
/// keeps each texture within `TEXTURE_BUDGET`.
fn mutate(rng: &mut Rng, base: &[(u16, Vec<u8>)]) -> Vec<(u16, Vec<u8>)> {
    let mut records = base.to_vec();
    for _ in 0..1 + rng.below(3) {
        let index = rng.below(records.len());
        match rng.below(10) {
            0 => {
                let record = records[index].clone();
                records.insert(rng.below(records.len() + 1), record);
            }
            1 if records.len() > 1 => {
                records.remove(index);
            }
            2 => {
                let other = rng.below(records.len());
                records.swap(index, other);
            }
            3 | 4 => {
                let pipelines: Vec<_> = (0..records.len())
                    .filter(|at| records[*at].0 == 13)
                    .collect();
                if pipelines.is_empty() {
                    continue;
                }
                let payload = &mut records[pipelines[rng.below(pipelines.len())]].1;
                let Ok(json) = String::from_utf8(payload[8..].to_vec()) else {
                    continue;
                };
                let digits: Vec<_> = json
                    .match_indices(|c: char| c.is_ascii_digit())
                    .map(|(at, _)| at)
                    .filter(|at| *at == 0 || !json.as_bytes()[at - 1].is_ascii_digit())
                    .collect();
                if digits.is_empty() {
                    continue;
                }
                let start = digits[rng.below(digits.len())];
                let end = start
                    + json[start..]
                        .find(|c: char| !c.is_ascii_digit())
                        .unwrap_or(json.len() - start);
                let mutated = format!(
                    "{}{}{}",
                    &json[..start],
                    NUMBERS[rng.below(NUMBERS.len())],
                    &json[end..]
                );
                payload.truncate(8);
                payload.extend_from_slice(mutated.as_bytes());
            }
            _ => {
                let (opcode, payload) = &mut records[index];
                if payload.len() < 4 || matches!(*opcode, 23 | 24) {
                    continue;
                }
                let original = payload.clone();
                let at = rng.below(payload.len() / 4) * 4;
                let value = match rng.below(3) {
                    0 => WORDS[rng.below(WORDS.len())],
                    1 => {
                        u32::from_le_bytes(payload[at..at + 4].try_into().unwrap())
                            ^ (1 << rng.below(32))
                    }
                    _ => [f32::NAN, f32::INFINITY, -1.0, 1e30, -0.0][rng.below(5)].to_bits(),
                };
                payload[at..at + 4].copy_from_slice(&value.to_le_bytes());
                if *opcode == 4 && payload.len() >= 24 && texture_bytes(payload) > TEXTURE_BUDGET {
                    *payload = original;
                }
            }
        }
    }
    records
}

/// `FUZZ_ITERATIONS` and `FUZZ_SEED` override the run length and seed. A panic fails the test,
/// so debug builds also check wgpu's arithmetic.
#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn mutated_streams_return_errors_and_never_panic() {
    let fixtures: [(&[u8], Option<&[u8]>); 9] = [
        (
            include_bytes!("fixtures/basic-cube-1.bin"),
            Some(include_bytes!("fixtures/basic-cube-0.bin")),
        ),
        (
            include_bytes!("fixtures/standard-shadow-1.bin"),
            Some(include_bytes!("fixtures/standard-shadow-0.bin")),
        ),
        (include_bytes!("fixtures/draw.bin"), None),
        (include_bytes!("fixtures/msaa-pass.bin"), None),
        (include_bytes!("fixtures/bindings.bin"), None),
        (include_bytes!("fixtures/textures.bin"), None),
        (include_bytes!("fixtures/pipeline.bin"), None),
        (include_bytes!("fixtures/readback-formats.bin"), None),
        (include_bytes!("fixtures/surface.bin"), None),
    ];
    let setting = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let iterations = setting("FUZZ_ITERATIONS", 270);
    let mut rng = Rng(setting("FUZZ_SEED", 0x9e37_79b9_7f4a_7c15));
    let gpu = device();
    let (device, queue) = &*gpu;
    let mut surface = surface_texture(device, 1280, 720);
    for iteration in 0..iterations {
        let (target, setup) = fixtures[iteration as usize % fixtures.len()];
        let mut executor = Executor::new(device.clone(), queue.clone());
        if let Some(setup) = setup {
            executor.replay(setup, Some(&mut surface)).unwrap();
        }
        let mutated = stream(&mutate(&mut rng, &records(target)));
        executor.replay(&mutated, Some(&mut surface)).unwrap();
    }
}
