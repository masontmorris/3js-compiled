use threejsc_ipc::{Msg, read_msg, write_msg};

#[test]
fn messages_round_trip_and_truncated_frames_fail() {
    let messages = [
        Msg::Hello {
            ready_fence: 1,
            done_fence: 2,
            ready_base: 3,
            width: 1280,
            height: 720,
        },
        Msg::Patch {
            seq: 4,
            json: "{\"hp\":42}".into(),
        },
        Msg::Picked {
            pub_id: 5,
            first_frame: 6,
        },
        Msg::Pointer {
            action: 1,
            x: 12.5,
            y: 30.0,
            button: 0,
        },
        Msg::Resize {
            width: 640,
            height: 480,
        },
        Msg::Shutdown,
        Msg::Slots {
            handles: vec![1, 2, 3, 4],
            width: 640,
            height: 480,
        },
        Msg::FrameReady {
            slot: 2,
            pub_id: 7,
            ready_value: 8,
        },
        Msg::Events {
            seq: 9,
            json: "[]".into(),
        },
        Msg::Report {
            text: "done".into(),
        },
    ];
    for message in messages {
        let mut bytes = Vec::new();
        write_msg(&mut bytes, &message).unwrap();
        assert_eq!(read_msg(&mut bytes.as_slice()).unwrap(), message);
        assert!(read_msg(&mut &bytes[..bytes.len() - 1]).is_err());
    }
}

#[test]
fn rejects_oversized_and_forged_frames() {
    assert!(read_msg(&mut &((1024u32 * 1024 + 1).to_le_bytes())[..]).is_err());
    let frame = [5, 0, 0, 0, 10, 255, 255, 255, 255];
    assert!(read_msg(&mut &frame[..]).is_err());
}
