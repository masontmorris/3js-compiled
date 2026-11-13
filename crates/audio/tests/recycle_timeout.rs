#![cfg(not(feature = "output"))]

use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use threejsc_audio::web_audio_api::context::{AudioContext, AudioContextOptions, AudioContextState, BaseAudioContext};
use threejsc_audio::web_audio_api::test_control;

#[test]
fn stalled_recycle_returns_and_preserves_graph() {
    let context = Arc::new(AudioContext::new(AudioContextOptions {
        sink_id: "none".into(),
        ..Default::default()
    }));
    let deadline = Instant::now() + Duration::from_secs(10);
    while context.state() != AudioContextState::Running {
        assert!(Instant::now() < deadline, "context did not start");
        std::thread::yield_now();
    }
    let (entered, release) = test_control::hold_next_recycle();
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
