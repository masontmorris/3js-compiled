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
