#![cfg(not(feature = "output"))]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;
use threejsc_audio::web_audio_api::context::{AudioContext, AudioContextOptions, AudioContextState, BaseAudioContext};
use threejsc_audio::web_audio_api::{RenderObserver, RenderReport, test_control};

struct Callback(mpsc::Sender<()>);
impl RenderObserver for Callback {
    fn rendered(&self, _: &RenderReport<'_>) { let _ = self.0.send(()); }
}

#[test]
fn moving_unstarted_suspended_graph_does_not_emit_running() {
    test_control::pause_next_none_backend();
    let context = AudioContext::new(AudioContextOptions { sink_id: "none".into(), ..Default::default() });
    let events = Arc::new(AtomicUsize::new(0));
    let observed = events.clone();
    context.set_onstatechange(move |_| { observed.fetch_add(1, Ordering::AcqRel); });
    let (callback_tx, callback_rx) = mpsc::channel();
    context.set_render_observer(Some(Box::new(Callback(callback_tx))));
    context.suspend_sync();
    assert_eq!(context.state(), AudioContextState::Suspended);
    assert!(context.set_sink_id_sync(String::new()).is_err());
    callback_rx.recv_timeout(Duration::from_secs(10)).expect("replacement callback");
    let (marker_tx, marker_rx) = mpsc::channel();
    context.set_onsinkchange(move |_| { let _ = marker_tx.send(()); });
    context.test_event_marker();
    marker_rx.recv_timeout(Duration::from_secs(10)).expect("event queue barrier");
    assert_eq!(context.state(), AudioContextState::Suspended);
    assert_eq!(events.load(Ordering::Acquire), 0, "moving an unstarted suspended graph must not report a state change");
    context.close_sync();
}
