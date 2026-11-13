use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use threejsc_audio::web_audio_api::context::{
    AudioContext, AudioContextOptions, AudioContextState, BaseAudioContext,
};
use threejsc_audio::web_audio_api::node::{AudioNode, AudioScheduledSourceNode};
use threejsc_audio::web_audio_api::{RenderObserver, RenderReport};

struct HeldCallback {
    held: AtomicBool,
    release: AtomicBool,
    complete: AtomicBool,
    audible: AtomicBool,
}

struct Observer(Arc<HeldCallback>);

impl RenderObserver for Observer {
    fn frame(&self, _: u64) {
        self.0.held.store(true, Ordering::Release);
        while !self.0.release.load(Ordering::Acquire) {
            std::thread::yield_now();
        }
    }

    fn rendered(&self, report: &RenderReport<'_>) {
        if report.samples.iter().any(|sample| *sample != 0.0) {
            self.0.audible.store(true, Ordering::Release);
        }
        self.0.complete.store(true, Ordering::Release);
    }
}

fn wait_for(mut condition: impl FnMut() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < Duration::from_secs(15), "timed out");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn timed_out_suspend_silences_the_in_flight_callback() {
    let context = AudioContext::new(AudioContextOptions {
        sink_id: "none".into(),
        ..Default::default()
    });
    wait_for(|| context.state() == AudioContextState::Running);
    let mut source = context.create_constant_source();
    source.connect(&context.destination());
    source.start();
    let start = context.current_time();
    wait_for(|| context.current_time() > start + 0.1);

    let held = Arc::new(HeldCallback {
        held: AtomicBool::new(false),
        release: AtomicBool::new(false),
        complete: AtomicBool::new(false),
        audible: AtomicBool::new(false),
    });
    context.set_render_observer(Some(Box::new(Observer(Arc::clone(&held)))));
    wait_for(|| held.held.load(Ordering::Acquire));
    context.suspend_sync();
    assert_eq!(context.state(), AudioContextState::Suspended);
    held.release.store(true, Ordering::Release);
    wait_for(|| held.complete.load(Ordering::Acquire));
    context.set_render_observer(None);
    context.close_sync();
    assert!(
        !held.audible.load(Ordering::Acquire),
        "callback emitted audio after suspend returned"
    );
}
