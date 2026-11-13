//! Suspend, resume and close racing each other on an online context with no output device, as the host's async
//! lifecycle ops and its device follower do.

use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use threejsc_audio::web_audio_api::context::{
    AudioContext, AudioContextOptions, AudioContextState, BaseAudioContext,
};
use threejsc_audio::web_audio_api::{RenderObserver, RenderReport};

const DEADLINE: Duration = Duration::from_secs(10);

fn context() -> Arc<AudioContext> {
    Arc::new(AudioContext::new(AudioContextOptions {
        sink_id: "none".into(),
        ..AudioContextOptions::default()
    }))
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < DEADLINE, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

// Polls until ready on this thread, failing past the deadline instead of hanging the suite.
fn finish(future: impl Future<Output = ()>) {
    let mut future = pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    wait_for("the future", || future.as_mut().poll(&mut cx).is_ready());
}

// Polls once, so the call starts, and answers whether it still waits. A finished future must not be polled again.
fn start(future: std::pin::Pin<&mut impl Future<Output = ()>>) -> bool {
    future
        .poll(&mut Context::from_waker(Waker::noop()))
        .is_pending()
}

// Runs a blocking call on its own thread, failing past the deadline instead of hanging the suite.
fn returns(what: &str, call: impl FnOnce() + Send + 'static) {
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        call();
        done.send(()).ok();
    });
    finished
        .recv_timeout(DEADLINE)
        .unwrap_or_else(|_| panic!("{what} did not return"));
}

// Holds the render thread inside its callback until released, as a stream that stopped after a device error runs no
// callback to answer the control thread.
struct Stall {
    held: Arc<AtomicBool>,
    released: Arc<AtomicBool>,
}

impl RenderObserver for Stall {
    fn rendered(&self, _report: &RenderReport<'_>) {
        while !self.released.load(Ordering::Acquire) {
            self.held.store(true, Ordering::Release);
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

// A running context whose render thread is stuck, and the flag that releases it.
fn stalled() -> (Arc<AudioContext>, Arc<AtomicBool>) {
    let context = context();
    wait_for("running", || context.state() == AudioContextState::Running);
    let held = Arc::new(AtomicBool::new(false));
    let released = Arc::new(AtomicBool::new(false));
    context.set_render_observer(Some(Box::new(Stall {
        held: Arc::clone(&held),
        released: Arc::clone(&released),
    })));
    wait_for("the render thread to stall", || {
        held.load(Ordering::Acquire)
    });
    (context, released)
}

fn advances(context: &AudioContext) -> bool {
    let from = context.current_time();
    let started = Instant::now();
    while started.elapsed() < DEADLINE {
        if context.current_time() > from + 0.05 {
            return true;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    false
}

#[test]
fn close_during_startup_stays_closed() {
    let context = context();
    let closing = Arc::clone(&context);
    returns("close", move || closing.close_sync());
    assert_eq!(context.state(), AudioContextState::Closed);
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(context.state(), AudioContextState::Closed);
}

#[test]
fn close_while_a_suspend_waits_for_the_render_thread_returns() {
    let context = context();
    wait_for("running", || context.state() == AudioContextState::Running);
    let mut suspend = pin!(context.suspend());
    let waits = start(suspend.as_mut());
    let closing = Arc::clone(&context);
    returns("close", move || closing.close_sync());
    assert_eq!(context.state(), AudioContextState::Closed);
    if waits {
        finish(suspend);
    }
}

#[test]
fn a_suspend_a_resume_overtook_leaves_the_stream_running() {
    let context = context();
    wait_for("running", || context.state() == AudioContextState::Running);
    let mut suspend = pin!(context.suspend());
    let mut cx = Context::from_waker(Waker::noop());
    if suspend.as_mut().poll(&mut cx) == Poll::Pending {
        wait_for("suspended", || {
            context.state() == AudioContextState::Suspended
        });
        context.resume_sync();
        finish(suspend);
    }
    assert_eq!(context.state(), AudioContextState::Running);
    assert!(advances(&context), "the context renders after the resume");
    context.close_sync();
}

#[test]
fn resume_after_an_unanswered_suspend_runs() {
    let context = context();
    wait_for("running", || context.state() == AudioContextState::Running);
    let mut suspend = pin!(context.suspend());
    let waits = start(suspend.as_mut());
    let resuming = Arc::clone(&context);
    returns("resume", move || resuming.resume_sync());
    if waits {
        finish(suspend);
    }
    assert_eq!(context.state(), AudioContextState::Running);
    assert!(advances(&context), "the context renders after the resume");
    context.close_sync();
}

#[test]
fn suspend_on_a_stopped_stream_returns_suspended() {
    let (context, released) = stalled();
    finish(context.suspend());
    assert_eq!(context.state(), AudioContextState::Suspended);
    released.store(true, Ordering::Release);
    context.close_sync();
}

#[test]
fn resume_on_a_stopped_stream_returns() {
    let (context, released) = stalled();
    finish(context.suspend());
    finish(context.resume());
    released.store(true, Ordering::Release);
    context.close_sync();
}

#[test]
fn close_on_a_stopped_stream_returns_closed() {
    let (context, released) = stalled();
    finish(context.close());
    assert_eq!(context.state(), AudioContextState::Closed);
    released.store(true, Ordering::Release);
}

#[test]
fn the_blocking_calls_return_on_a_stopped_stream() {
    let (context, released) = stalled();
    let calling = Arc::clone(&context);
    returns("suspend_sync, resume_sync and close_sync", move || {
        calling.suspend_sync();
        calling.resume_sync();
        calling.close_sync();
    });
    assert_eq!(context.state(), AudioContextState::Closed);
    released.store(true, Ordering::Release);
}

#[test]
#[cfg_attr(feature = "output", ignore = "moves a context to the default output device; run under the GPU lease")]
fn a_suspend_answered_before_a_device_change_holds_on_the_new_stream() {
    let context = context();
    wait_for("running", || context.state() == AudioContextState::Running);
    let mut suspend = pin!(context.suspend());
    assert!(
        start(suspend.as_mut()),
        "the suspend waits for the render thread"
    );
    wait_for("suspended", || {
        context.state() == AudioContextState::Suspended
    });
    // The device follower moves the context after the render thread answered and before the suspend's continuation
    // runs. A failed move still hands the graph to a new stream on the previous device.
    let moved = context.set_sink_id_sync(String::new());
    // The host polls the suspend on the page's next turn, which can come a frame or more later.
    let from = context.current_time();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        context.current_time(),
        from,
        "time holds after the move, which answered {moved:?}"
    );
    finish(suspend);
    assert_eq!(context.state(), AudioContextState::Suspended);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(context.current_time(), from, "time holds while suspended");
    context.resume_sync();
    assert_eq!(context.state(), AudioContextState::Running);
    assert!(advances(&context), "the context renders after the resume");
    context.close_sync();
}
