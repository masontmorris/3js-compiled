#![cfg(not(feature = "output"))]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use threejsc_audio::web_audio_api::context::{
    AudioContext, AudioContextOptions, AudioContextState, BaseAudioContext,
};
use threejsc_audio::web_audio_api::{RenderObserver, RenderReport, test_control};

static SERIAL: Mutex<()> = Mutex::new(());

struct Callback(mpsc::Sender<()>);
impl RenderObserver for Callback {
    fn rendered(&self, _: &RenderReport<'_>) {
        let _ = self.0.send(());
    }
}

struct Stall {
    entered: mpsc::Sender<()>,
    released: Arc<AtomicBool>,
}

impl RenderObserver for Stall {
    fn rendered(&self, _: &RenderReport<'_>) {
        let _ = self.entered.send(());
        while !self.released.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

#[test]
fn stalled_before_slot_returns_and_preserves_graph() {
    check_stalled_recycle(0);
}

#[test]
fn stalled_after_slot_preserves_paused_graph() {
    check_stalled_recycle(1);
}

#[test]
fn delivered_graph_does_not_wait_for_notification() {
    check_stalled_recycle(2);
}

#[test]
fn cancelled_recycle_restores_pending_suspend() {
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
    let (callback_send, callback_recv) = mpsc::channel();
    let released = Arc::new(AtomicBool::new(false));
    context.set_render_observer(Some(Box::new(Stall {
        entered: callback_send,
        released: Arc::clone(&released),
    })));
    callback_recv
        .recv_timeout(Duration::from_secs(10))
        .expect("stalled callback");
    context.suspend_sync();
    let drained = test_control::watch_next_recycle_drain();
    let (entered, release_recycle) = test_control::hold_next_recycle(0);
    let (done, result) = mpsc::channel();
    let moving = Arc::clone(&context);
    let worker = std::thread::spawn(move || {
        let _ = done.send(moving.set_sink_id_sync(String::new()).is_err());
    });
    assert!(
        drained
            .recv_timeout(Duration::from_secs(10))
            .expect("drained messages")
            > 0
    );
    released.store(true, Ordering::Release);
    entered
        .recv_timeout(Duration::from_secs(10))
        .expect("recycle was not taken");
    let returned = result.recv_timeout(Duration::from_secs(5));
    release_recycle.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(returned, Ok(true));
    callback_recv
        .recv_timeout(Duration::from_secs(10))
        .expect("restored callback");
    let from = context.current_time();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        context.current_time(),
        from,
        "the saved suspend must still stop the graph"
    );
    context.resume_sync();
    context.close_sync();
}

#[test]
fn moving_a_running_graph_does_not_change_its_state() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let context = AudioContext::new(AudioContextOptions {
        sink_id: "none".into(),
        ..Default::default()
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while context.state() != AudioContextState::Running {
        assert!(Instant::now() < deadline, "context did not start");
        std::thread::yield_now();
    }
    let (startup_send, startup_recv) = mpsc::channel();
    context.set_render_observer(Some(Box::new(Callback(startup_send))));
    startup_recv
        .recv_timeout(Duration::from_secs(10))
        .expect("startup callback");
    context.set_render_observer(None);
    let (initial_send, initial_recv) = mpsc::channel();
    context.set_onsinkchange(move |_| {
        let _ = initial_send.send(());
    });
    context.test_event_marker();
    initial_recv
        .recv_timeout(Duration::from_secs(10))
        .expect("initial event barrier");
    let events = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&events);
    context.set_onstatechange(move |_| {
        observed.fetch_add(1, Ordering::AcqRel);
    });
    assert!(context.set_sink_id_sync(String::new()).is_err());
    let (callback_send, callback_recv) = mpsc::channel();
    context.set_render_observer(Some(Box::new(Callback(callback_send))));
    callback_recv
        .recv_timeout(Duration::from_secs(10))
        .expect("replacement callback");
    let (marker_send, marker_recv) = mpsc::channel();
    context.set_onsinkchange(move |_| {
        let _ = marker_send.send(());
    });
    context.test_event_marker();
    marker_recv
        .recv_timeout(Duration::from_secs(10))
        .expect("event queue barrier");
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
    entered
        .recv_timeout(Duration::from_secs(10))
        .expect("recycle was not taken");
    let returned = result.recv_timeout(Duration::from_secs(5));
    release.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(returned, Ok(true), "a stalled recycle must return an error");
    if stage == 1 {
        assert_eq!(context.state(), AudioContextState::Suspended);
        let before = context.current_time();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            context.current_time(),
            before,
            "the cancelled move stays paused"
        );
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
