//! Suspend, resume and close racing each other on an online context with no output device, as the host's async
//! lifecycle ops and its device follower do.

use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use threejsc_audio::web_audio_api::context::{
    AudioContext, AudioContextOptions, AudioContextState, BaseAudioContext,
};

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
    let mut cx = Context::from_waker(Waker::noop());
    let _ = suspend.as_mut().poll(&mut cx);
    let closing = Arc::clone(&context);
    returns("close", move || closing.close_sync());
    assert_eq!(context.state(), AudioContextState::Closed);
    finish(suspend);
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
    let _ = suspend
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()));
    let resuming = Arc::clone(&context);
    returns("resume", move || resuming.resume_sync());
    finish(suspend);
    assert_eq!(context.state(), AudioContextState::Running);
    assert!(advances(&context), "the context renders after the resume");
    context.close_sync();
}
