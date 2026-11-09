use threejsc_gpu::{Executor, Response};

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
            Response::Error {
                command: 4,
                request: Some(3),
                message: "unknown buffer handle".into()
            },
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
            Response::Error {
                command: 7,
                request: Some(12),
                message: "unknown texture handle".into()
            },
            Response::Error {
                command: 8,
                request: None,
                message: "unknown resource handle".into()
            },
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
        vec![Response::Error {
            command: 2,
            request: None,
            message: "unknown resource handle".into()
        },]
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
            Response::Error {
                command: 1,
                request: None,
                message: "invalid or duplicate buffer handle".into()
            },
            Response::Error {
                command: 3,
                request: None,
                message: "unknown resource handle".into()
            },
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
        vec![Response::Error {
            command: 3,
            request: None,
            message: "invalid or duplicate buffer handle".into(),
        }]
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
    let mismatch = executor
        .replay(
            include_bytes!("fixtures/surface-mismatch.bin"),
            Some(&surface),
        )
        .unwrap();
    assert!(
        matches!(&mismatch[..], [Response::Error { message, .. }] if message == "surface is 4x4, not 8x8"),
        "{mismatch:?}"
    );
    let missing = executor.replay(frame, None).unwrap();
    assert!(
        missing.iter().any(|response| matches!(response, Response::Error { message, .. } if message == "no surface for this frame")),
        "{missing:?}"
    );
}

fn assert_scene_matches_edge(scene: &str, frames: [&[u8]; 2], edge: &[u8]) {
    let (device, queue) = device();
    let surface = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: 1280,
            height: 720,
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
    let mut responses = executor.replay(frames[0], Some(&surface)).unwrap();
    responses.extend(executor.replay(frames[1], Some(&surface)).unwrap());
    let errors: Vec<_> = responses
        .iter()
        .filter(|response| matches!(response, Response::Error { .. }))
        .collect();
    assert!(errors.is_empty(), "{scene}: {errors:?}");
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
    let total: u64 = native
        .chunks(4)
        .zip(edge.pixels())
        .map(|(bgra, rgba)| {
            (0..3)
                .map(|c| u64::from(bgra[2 - c].abs_diff(rgba[c])))
                .sum::<u64>()
        })
        .sum();
    let mean = total as f64 / (1280.0 * 720.0 * 3.0 * 255.0);
    assert!(
        mean < 0.01,
        "{scene}: mean RGB difference from Edge is {mean}"
    );
}

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn recorded_three_scenes_match_edge_captures() {
    assert_scene_matches_edge(
        "basic-cube",
        [
            include_bytes!("fixtures/basic-cube-0.bin"),
            include_bytes!("fixtures/basic-cube-1.bin"),
        ],
        include_bytes!("fixtures/basic-cube-edge.png"),
    );
    assert_scene_matches_edge(
        "standard-shadow",
        [
            include_bytes!("fixtures/standard-shadow-0.bin"),
            include_bytes!("fixtures/standard-shadow-1.bin"),
        ],
        include_bytes!("fixtures/standard-shadow-edge.png"),
    );
}
