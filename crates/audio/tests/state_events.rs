use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use threejsc_audio::web_audio_api::context::{
    AudioContext, AudioContextOptions, AudioContextState, BaseAudioContext,
};
use threejsc_audio::web_audio_api::{RenderObserver, RenderReport};

struct Stall {
    held: Arc<AtomicBool>,
    released: Arc<AtomicBool>,
    returned: Arc<AtomicBool>,
}
impl RenderObserver for Stall {
    fn rendered(&self, _: &RenderReport<'_>) {
        self.held.store(true, Ordering::Release);
        while !self.released.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(1));
        }
        self.returned.store(true, Ordering::Release);
    }
}
fn wait(mut condition: impl FnMut() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < Duration::from_secs(15));
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[test]
fn timed_out_suspend_emits_one_state_change() {
    let context = AudioContext::new(AudioContextOptions {
        sink_id: "none".into(),
        ..Default::default()
    });
    wait(|| context.state() == AudioContextState::Running);
    let held = Arc::new(AtomicBool::new(false));
    let released = Arc::new(AtomicBool::new(false));
    let returned = Arc::new(AtomicBool::new(false));
    context.set_render_observer(Some(Box::new(Stall {
        held: held.clone(),
        released: released.clone(),
        returned: returned.clone(),
    })));
    wait(|| held.load(Ordering::Acquire));
    let events = Arc::new(AtomicUsize::new(0));
    let observed = events.clone();
    context.set_onstatechange(move |_| {
        observed.fetch_add(1, Ordering::AcqRel);
    });
    context.suspend_sync();
    wait(|| events.load(Ordering::Acquire) == 1);
    released.store(true, Ordering::Release);
    wait(|| returned.load(Ordering::Acquire));
    context.resume_sync();
    let (marker_tx, marker_rx) = std::sync::mpsc::channel();
    context.set_onsinkchange(move |_| {
        let _ = marker_tx.send(());
    });
    context.test_event_marker();
    marker_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("event queue barrier");
    assert_eq!(
        events.load(Ordering::Acquire),
        2,
        "suspend and resume must each emit one state change"
    );
    context.close_sync();
}
