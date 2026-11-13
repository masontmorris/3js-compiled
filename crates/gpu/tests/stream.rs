use threejsc_gpu::{DecodeError, Record, decode, join};

#[test]
fn javascript_frame_decodes_in_order() {
    let frame = include_bytes!("fixtures/frame.bin");
    assert_eq!(
        decode(frame).unwrap().records,
        vec![
            Record {
                opcode: 1,
                payload: &[0, 1, 2, 255]
            },
            Record {
                opcode: 23,
                payload: &[42]
            },
            Record {
                opcode: 26,
                payload: &[]
            },
        ]
    );
}

#[test]
fn damaged_or_truncated_frames_are_rejected() {
    let frame = include_bytes!("fixtures/frame.bin");
    for length in 0..frame.len() {
        assert!(decode(&frame[..length]).is_err());
    }
    let mut damaged = frame.to_vec();
    damaged[20] = 255;
    assert_eq!(decode(&damaged), Err(DecodeError::Opcode));
    damaged = frame.to_vec();
    damaged[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(decode(&damaged), Err(DecodeError::Truncated));
}

#[test]
fn a_stream_of_an_earlier_version_is_rejected_by_version() {
    let mut old = include_bytes!("fixtures/frame.bin").to_vec();
    old[4..6].copy_from_slice(&2u16.to_le_bytes());
    let message = decode(&old).unwrap_err().to_string();
    assert!(
        message.contains("version 2")
            && message.contains(&format!("version {}", threejsc_gpu::VERSION)),
        "{message}"
    );
}

#[test]
fn map_buffer_is_the_last_opcode() {
    let mut frame = include_bytes!("fixtures/frame.bin").to_vec();
    let last = frame.len() - 8;
    frame[last..last + 2].copy_from_slice(&56u16.to_le_bytes());
    assert_eq!(decode(&frame).unwrap().records[2].opcode, 56);
    frame[last..last + 2].copy_from_slice(&57u16.to_le_bytes());
    assert_eq!(decode(&frame), Err(DecodeError::Opcode));
}

// F1's G8: a device request names WebGPU features, and the executor grants exactly the ones it can parse and the
// adapter has. The adapter therefore reports only those, so texture-formats-tier1 and tier2, which wgpu 30 has no
// name for, and a feature the adapter lacks, such as clip-distances on D3D12 here, are never offered.
#[test]
fn the_adapter_offers_only_the_webgpu_features_a_device_can_be_given() {
    let adapter = wgpu::Features::TIMESTAMP_QUERY
        | wgpu::Features::SHADER_F16
        | wgpu::Features::DEPTH_CLIP_CONTROL;
    assert_eq!(
        threejsc_gpu::webgpu_features(adapter),
        vec![
            "core-features-and-limits",
            "depth-clip-control",
            "timestamp-query",
            "shader-f16"
        ]
    );
    let everything = threejsc_gpu::webgpu_features(wgpu::Features::all());
    assert!(!everything.contains(&"texture-formats-tier1"));
    assert!(!everything.contains(&"texture-formats-tier2"));
    for name in everything
        .iter()
        .filter(|name| **name != "core-features-and-limits")
    {
        assert!(name.parse::<wgpu::Features>().is_ok(), "{name} parses");
    }
    assert!(
        !threejsc_gpu::webgpu_features(wgpu::Features::empty()).contains(&"clip-distances"),
        "an adapter without a feature does not offer it"
    );
}

#[test]
fn a_joined_stream_holds_both_streams_records_in_order_under_the_second_frame() {
    let first = include_bytes!("fixtures/frame.bin").to_vec();
    let mut second = first.clone();
    second[12..16].copy_from_slice(&9u32.to_le_bytes());
    let last = second.len() - 9;
    second[last] = 7;
    let joined = join(&first, &second);
    let stream = decode(&joined).unwrap();
    assert_eq!(stream.frame, 9);
    let records = decode(&first).unwrap().records;
    let mut expected = records.clone();
    expected.extend(decode(&second).unwrap().records);
    assert_eq!(stream.records, expected);
    assert_eq!(join(&first[..10], &second), &first[..10]);
    assert_eq!(join(&first, &second[..10]), &second[..10]);
}
