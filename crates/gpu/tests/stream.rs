use threejsc_gpu::{DecodeError, Record, decode};

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
