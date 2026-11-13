#![cfg(not(feature = "output"))]

use std::sync::{Arc, Mutex, mpsc};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use threejsc_audio::web_audio_api::context::{AudioContext, AudioContextOptions, AudioContextState, BaseAudioContext};
use threejsc_audio::web_audio_api::{RenderObserver, RenderReport, test_control};

static SERIAL: Mutex<()> = Mutex::new(());

struct Callback(mpsc::Sender<()>);
impl RenderObserver for Callback {
    fn rendered(&self, _: &RenderReport<'_>) { let _ = self.0.send(()); }
}

#[test]
fn stalled_before_slot_returns_and_preserves_graph() { check_stalled_recycle(0); }

#[test]
fn stalled_after_slot_preserves_paused_graph() { check_stalled_recycle(1); }

#[test]
fn delivered_graph_does_not_wait_for_notification() { check_stalled_recycle(2); }

#[test]
fn moving_a_running_graph_does_not_change_its_state() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let context = AudioContext::new(AudioContextOptions { sink_id: "none".into(), ..Default::default() });
    let deadline = Instant::now() + Duration::from_secs(10);
    while context.state() != AudioContextState::Running {
        assert!(Instant::now() < deadline, "context did not start");
        std::thread::yield_now();
    }
    let (initial_send, initial_recv) = mpsc::channel();
    context.set_onsinkchange(move |_| { let _ = initial_send.send(()); });
    context.test_event_marker();
    initial_recv.recv_timeout(Duration::from_secs(10)).expect("initial event barrier");
    let events = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&events);
    context.set_onstatechange(move |_| { observed.fetch_add(1, Ordering::AcqRel); });
    assert!(context.set_sink_id_sync(String::new()).is_err());
    let (callback_send, callback_recv) = mpsc::channel();
    context.set_render_observer(Some(Box::new(Callback(callback_send))));
    callback_recv.recv_timeout(Duration::from_secs(10)).expect("replacement callback");
    let (marker_send, marker_recv) = mpsc::channel();
    context.set_onsinkchange(move |_| { let _ = marker_send.send(()); });
    context.test_event_marker();
    marker_recv.recv_timeout(Duration::from_secs(10)).expect("event queue barrier");
    assert_eq!(context.state(), AudioContextState::Running);
    assert_eq!(events.load(Ordering::Acquire), 0);
    context.close_sync();
}

fn check_stalled_recycle(stage: u8) {
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
        let before = context.current_time();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(context.current_time(), before, "the cancelled move stays paused");
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
