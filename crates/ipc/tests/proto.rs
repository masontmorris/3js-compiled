use threejsc_ipc::{MAX_JSON, MAX_PAYLOAD, Msg, place, read_msg, write_msg};

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
        Msg::Pointer(place::Pointer {
            action: 1,
            x: 12.5,
            y: 30.0,
            button: 0,
            at: place::At::Rect {
                rect: 3,
                offset: (100.5, 40.0),
            },
        }),
        Msg::Pointer(place::Pointer {
            action: 2,
            x: 1160.0,
            y: 60.0,
            button: 2,
            at: place::At::Beside {
                rect: 1,
                offset: (-960.0, 40.0),
            },
        }),
        Msg::Resize {
            width: 640,
            height: 480,
        },
        Msg::Shutdown,
        Msg::SlotsImported { generation: 3 },
        Msg::Slots {
            generation: 3,
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
            width: 640,
            height: 480,
            json: "[]".into(),
        },
        Msg::Report {
            text: "done".into(),
        },
        Msg::Ready,
    ];
    for message in messages {
        let mut bytes = Vec::new();
        write_msg(&mut bytes, &message).unwrap();
        assert_eq!(read_msg(&mut bytes.as_slice()).unwrap(), message);
        assert!(read_msg(&mut &bytes[..bytes.len() - 1]).is_err());
    }
}

#[test]
fn writer_refuses_what_the_reader_refuses() {
    for (seq, len) in [(1, MAX_JSON), (2, MAX_JSON + 1)] {
        let message = Msg::Events {
            seq,
            width: 640,
            height: 480,
            json: "x".repeat(len),
        };
        let mut bytes = Vec::new();
        let written = write_msg(&mut bytes, &message);
        if len <= MAX_JSON {
            written.unwrap();
            assert_eq!(read_msg(&mut bytes.as_slice()).unwrap(), message);
        } else {
            assert_eq!(
                written.unwrap_err().kind(),
                std::io::ErrorKind::InvalidInput
            );
            assert!(bytes.is_empty());
        }
    }
}

#[test]
fn rejects_oversized_and_forged_frames() {
    assert!(read_msg(&mut &((MAX_PAYLOAD as u32 + 1).to_le_bytes())[..]).is_err());
    let frame = [5, 0, 0, 0, 10, 255, 255, 255, 255];
    assert!(read_msg(&mut &frame[..]).is_err());
}
