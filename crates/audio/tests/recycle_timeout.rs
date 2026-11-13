#![cfg(not(feature = "output"))]

use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use threejsc_audio::web_audio_api::context::{AudioContext, AudioContextOptions, AudioContextState, BaseAudioContext};
use threejsc_audio::web_audio_api::test_control;

#[test]
fn stalled_before_slot_returns_and_preserves_graph() { check_stalled_recycle(0); }

#[test]
fn stalled_after_slot_preserves_paused_graph() { check_stalled_recycle(1); }

#[test]
fn delivered_graph_does_not_wait_for_notification() { check_stalled_recycle(2); }

fn check_stalled_recycle(stage: u8) {
    static SERIAL: Mutex<()> = Mutex::new(());
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let context = Arc::new(AudioContext::new(AudioContextOptions {
        sink_id: "none".into(),
        ..Default::default()
    }));
    let deadline = Instant::now() + Duration::from_secs(10);
    while context.state() != AudioContextState::Running {
        assert!(Instant::now() < deadline, "context did not start");
        std::thread::yield_now();
    }
    if stage == 1 {
        context.suspend_sync();
    }
    let (entered, release) = test_control::hold_next_recycle(stage);
    let (done, result) = mpsc::channel();
    let moving = Arc::clone(&context);
    let worker = std::thread::spawn(move || {
        let _ = done.send(moving.set_sink_id_sync(String::new()).is_err());
    });
    entered.recv_timeout(Duration::from_secs(10)).expect("recycle was not taken");
    let returned = result.recv_timeout(Duration::from_secs(5));
    release.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(returned, Ok(true), "a stalled recycle must return an error");
    if stage == 1 {
        assert_eq!(context.state(), AudioContextState::Suspended);
        context.resume_sync();
    }
    let before = context.current_time();
    let deadline = Instant::now() + Duration::from_secs(10);
    while context.current_time() <= before + 0.05 {
        assert!(Instant::now() < deadline, "the graph did not resume");
        std::thread::sleep(Duration::from_millis(1));
    }
    context.suspend_sync();
    context.resume_sync();
    context.close_sync();
}
