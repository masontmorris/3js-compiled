use threejsc_gpu::{Executor, Response};

// Each bound sits just above the scene's difference from Edge on llvmpipe and WARP, so a replay
// that drops or changes a draw fails. docs/testing.md lists the measured values.
const BASIC_CUBE_BOUND: f64 = 0.00001;
const SHADOW_BOUND: f64 = 0.0001;
const SHADOW_REGION_BOUND: f64 = 0.00015;
const INVALID_WGSL_BOUND: f64 = 0.00001;

fn device() -> (wgpu::Device, wgpu::Queue) {
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
    pollster::block_on(adapter.request_device(&Default::default())).unwrap()
}

fn executor() -> Executor {
    let (device, queue) = device();
    Executor::new(device, queue)
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
    let (device, queue) = device();
    let surface = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: 4,
            height: 4,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let mut executor = Executor::new(device, queue);
    let frame = include_bytes!("fixtures/surface.bin");
    assert_eq!(
        executor.replay(frame, Some(&surface)).unwrap(),
        vec![
            Response::Validation { request: 2 },
            Response::Readback {
                request: 100,
                bytes: [255, 0, 0, 255].repeat(16)
            },
        ]
    );
    assert_eq!(
        executor
            .replay(
                include_bytes!("fixtures/surface-resize.bin"),
                Some(&surface)
            )
            .unwrap(),
        vec![Response::Readback {
            request: 100,
            bytes: [0, 255, 0, 255].repeat(16)
        }],
        "a texture acquired before a resize renders offscreen and later draws reach the surface"
    );
    assert!(executor.surface_used());
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
    let (device, queue) = device();
    let surface = surface_texture(&device, 4, 4);
    let mut executor = Executor::new(device, queue);
    assert_eq!(
        executor
            .replay(
                include_bytes!("fixtures/surface-destroy.bin"),
                Some(&surface)
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
fn errors_outside_error_scopes_become_responses() {
    let (device, queue) = device();
    let surface = surface_texture(&device, 4, 4);
    let mut executor = Executor::new(device, queue);
    surface.destroy();
    let responses = executor
        .replay(include_bytes!("fixtures/surface.bin"), Some(&surface))
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
    let (device, queue) = device();
    let surface = surface_texture(&device, 1280, 720);
    let mut executor = Executor::new(device, queue);
    let mut responses = executor.replay(frames[0], Some(&surface)).unwrap();
    responses.extend(executor.replay(frames[1], Some(&surface)).unwrap());
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
