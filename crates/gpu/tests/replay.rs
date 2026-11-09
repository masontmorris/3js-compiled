use threejsc_gpu::{Executor, Response};

#[test]
#[ignore = "requires a Vulkan adapter; run in the Modal gpu_replay lane"]
fn recorded_buffers_round_trip_on_vulkan() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    let responses = executor
        .replay(include_bytes!("fixtures/buffers.bin"))
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
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    let responses = executor
        .replay(include_bytes!("fixtures/shaders.bin"))
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
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    let responses = executor
        .replay(include_bytes!("fixtures/textures.bin"))
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
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/samplers.bin"))
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
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/layouts.bin"))
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
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/bindings.bin"))
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
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/pipeline-layouts.bin"))
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
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/clear-pass.bin"))
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
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/msaa-pass.bin"))
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
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    assert_eq!(
        executor
            .replay(include_bytes!("fixtures/pipeline.bin"))
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
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: true,
        ..Default::default()
    }))
    .expect("a software Vulkan adapter is required");
    assert_eq!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let mut executor = Executor::new(device, queue);
    let responses = executor
        .replay(include_bytes!("fixtures/pipeline-errors.bin"))
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
