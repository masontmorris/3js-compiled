//! Web Audio ops over `threejsc_audio`, and the host's audio options: `--audio-device <name>` plays through the
//! named output, and `--audio-out <file.wav>` records what the output receives. The page's `platform/audio.js` checks
//! every argument before it calls these ops.
//!
//! Nothing opens an audio device until a page creates an `AudioContext`. The first online context starts the
//! recorder, which writes `audio.csv` in the working directory with one row per render quantum, and resolves the
//! device name. A device name that matches no output is an error; the host never falls back to another device.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use deno_core::{JsBuffer, OpState, ToJsBuffer, op2, v8};
use deno_error::JsErrorBox;
use futures_channel::mpsc::UnboundedReceiver;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use threejsc_audio::decode::decode_audio_data;
use threejsc_audio::graph::{
    FrameSink, Graph, Id, ObserverFactory, OnlineHook, OnlineInfo, Output,
};
use threejsc_audio::record::Recorder;
use threejsc_audio::web_audio_api::context::BaseAudioContext;

/// The audio options from the command line.
#[derive(Clone, Default)]
pub struct Options {
    pub device: Option<String>,
    pub out: Option<PathBuf>,
    /// Where `audio.csv` goes.
    pub csv: PathBuf,
    /// Writes a line to the host log.
    pub log: Option<Rc<dyn Fn(String)>>,
}

/// The page's audio graph. Making it opens no device; the first online context resolves the output.
pub struct Audio {
    options: Options,
    graph: Graph,
    ended: Option<UnboundedReceiver<Id>>,
    output: Option<Output>,
    recorder: Option<Rc<RefCell<Recorder>>>,
    // Keeps the default-device follower thread alive.
    followed: Option<threejsc_audio::device::Followed>,
    // The batches op_audio_batch has run, and the commands in them.
    batched: (u64, u64),
}

impl Audio {
    pub fn new(options: Options) -> Self {
        threejsc_audio::init();
        let (graph, ended) = Graph::new();
        Self {
            options,
            graph,
            ended: Some(ended),
            output: None,
            recorder: None,
            followed: None,
            batched: (0, 0),
        }
    }

    /// The batches of graph changes the page has sent, and the commands in them.
    pub fn batched(&self) -> (u64, u64) {
        self.batched
    }

    /// An online context's currentTime as the engine reads it.
    pub fn current_time(&self, context: Id) -> f64 {
        self.graph.current_time(context)
    }

    fn log(&self, message: String) {
        if let Some(log) = &self.options.log {
            log(message);
        }
    }

    // Resolves the device, starts the recorder and, on the default device, the follower.
    fn ensure_output(&mut self) -> Result<(), JsErrorBox> {
        if self.output.is_some() {
            return Ok(());
        }
        let sink_id = match &self.options.device {
            Some(name) => threejsc_audio::device::sink_for(name).map_err(JsErrorBox::generic)?,
            None => String::new(),
        };
        let recorder = Recorder::start(self.options.out.clone(), &self.options.csv)
            .map_err(|e| JsErrorBox::generic(format!("audio.csv: {e}")))?;
        let recorder = Rc::new(RefCell::new(recorder));
        let observer: ObserverFactory = {
            let recorder = Rc::clone(&recorder);
            Box::new(move |rate, channels| recorder.borrow_mut().observer(rate, channels))
        };
        let on_online: Option<OnlineHook> = if sink_id.is_empty() {
            let log = self.options.log.clone();
            let lines = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&lines);
            let followed =
                threejsc_audio::device::follow_default(Duration::from_millis(200), move |line| {
                    sink.lock().unwrap().push(line)
                });
            let contexts = Arc::downgrade(&followed);
            self.followed = Some(followed);
            Some(Box::new(move |context| {
                if let Some(contexts) = contexts.upgrade() {
                    contexts.lock().unwrap().push(Arc::downgrade(context));
                }
                if let Some(log) = &log {
                    for line in lines.lock().unwrap().drain(..) {
                        log(line);
                    }
                }
            }))
        } else {
            None
        };
        self.log(format!(
            "audio: output {}",
            self.options
                .device
                .as_deref()
                .unwrap_or("the default device, followed as it changes")
        ));
        self.recorder = Some(recorder);
        self.output = Some(Output {
            sink_id,
            observer: Some(observer),
            on_online,
        });
        Ok(())
    }

    fn online(
        &mut self,
        sample_rate: Option<f32>,
        hint: &str,
        frames: Option<FrameSink>,
    ) -> Result<OnlineInfo, JsErrorBox> {
        self.ensure_output()?;
        let output = self.output.as_mut().expect("ensure_output set the output");
        self.graph
            .online(output, sample_rate, hint, frames)
            .map_err(fail)
    }

    fn get(&mut self) -> Result<&mut Graph, JsErrorBox> {
        Ok(&mut self.graph)
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        let (graph, _) = Graph::new();
        drop(std::mem::replace(&mut self.graph, graph));
        if let Some(recorder) = self.recorder.take() {
            let summary = recorder.borrow_mut().finish();
            self.log(format!("audio: recorder finished: {summary:?}"));
        }
    }
}

fn audio(state: &mut OpState) -> &mut Audio {
    state.borrow_mut::<Audio>()
}

fn fail(error: impl std::fmt::Display) -> JsErrorBox {
    JsErrorBox::generic(error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextSpec {
    kind: String,
    sample_rate: Option<f32>,
    latency_hint: Option<Value>,
    channels: Option<usize>,
    length: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextInfo {
    id: Id,
    sample_rate: f32,
}

// Publishes an online context's frame count, in render quanta, to the first 4 bytes of the page's SharedArrayBuffer,
// which `currentTime` reads with `Atomics.load`, so a read is no call into the engine. The render thread writes it as
// each render quantum begins, so it advances by render quantum, as Chrome's does.
fn publisher(slot: v8::Local<v8::Value>) -> Option<FrameSink> {
    let slot = v8::Local::<v8::SharedArrayBuffer>::try_from(slot).ok()?;
    let store = slot.get_backing_store();
    if store.byte_length() < 4 {
        return None;
    }
    Some(Box::new(move |frames| {
        if let Some(data) = store.data() {
            // SAFETY: `store` keeps the SharedArrayBuffer's memory alive for as long as this closure, a
            // SharedArrayBuffer's memory is aligned for its typed arrays, and the page only reads it atomically.
            let quanta = unsafe { AtomicU32::from_ptr(data.as_ptr().cast()) };
            quanta.store((frames / 128) as u32, Ordering::Relaxed);
        }
    }))
}

#[op2]
#[serde]
fn op_audio_context(
    state: &mut OpState,
    #[serde] spec: ContextSpec,
    slot: v8::Local<v8::Value>,
) -> Result<ContextInfo, JsErrorBox> {
    if spec.kind == "offline" {
        let rate = spec.sample_rate.unwrap_or(44100.);
        let id =
            audio(state)
                .graph
                .offline(spec.channels.unwrap_or(1), spec.length.unwrap_or(1), rate);
        return Ok(ContextInfo {
            id,
            sample_rate: rate,
        });
    }
    let hint = match spec.latency_hint {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s,
        _ => "interactive".into(),
    };
    let OnlineInfo { id, sample_rate } =
        audio(state).online(spec.sample_rate, &hint, publisher(slot))?;
    Ok(ContextInfo { id, sample_rate })
}

#[op2(fast)]
fn op_audio_current_time(state: &mut OpState, id: u32) -> f64 {
    audio(state).graph.current_time(id)
}

#[op2(fast)]
fn op_audio_base_latency(state: &mut OpState, id: u32) -> f64 {
    audio(state).graph.base_latency(id)
}

#[op2(fast)]
fn op_audio_output_latency(state: &mut OpState, id: u32) -> f64 {
    audio(state).graph.output_latency(id)
}

#[op2(fast)]
fn op_audio_destination(state: &mut OpState, context: u32) -> Result<u32, JsErrorBox> {
    audio(state).get()?.destination(context).map_err(fail)
}

#[op2(fast)]
fn op_audio_listener(state: &mut OpState, context: u32) -> Result<u32, JsErrorBox> {
    audio(state).get()?.listener(context).map_err(fail)
}

#[op2(fast)]
fn op_audio_max_channel_count(state: &mut OpState, context: u32) -> Result<u32, JsErrorBox> {
    Ok(audio(state)
        .get()?
        .max_channel_count(context)
        .map_err(fail)? as u32)
}

/// Suspends, resumes or closes an online context, and settles once the audio thread has done it.
#[op2]
async fn op_audio_lifecycle(
    state: Rc<RefCell<OpState>>,
    id: u32,
    #[string] action: String,
) -> Result<(), JsErrorBox> {
    let context = audio(&mut state.borrow_mut())
        .get()?
        .online_context(id)
        .map_err(fail)?;
    match action.as_str() {
        "suspend" => context.suspend().await,
        "resume" => context.resume().await,
        "close" => {
            context.close().await;
            audio(&mut state.borrow_mut()).get()?.forget(id);
        }
        other => return Err(fail(format!("no lifecycle action {other}"))),
    }
    Ok(())
}

/// Renders an offline context on the blocking pool and answers each channel's samples.
#[op2]
#[serde]
async fn op_audio_render(
    state: Rc<RefCell<OpState>>,
    id: u32,
) -> Result<Vec<ToJsBuffer>, JsErrorBox> {
    let mut context = audio(&mut state.borrow_mut())
        .get()?
        .take_offline(id)
        .map_err(fail)?;
    let (rate, length) = (context.sample_rate(), context.length());
    let rendered = tokio::task::spawn_blocking(move || context.start_rendering_sync())
        .await
        .map_err(fail)?;
    audio(&mut state.borrow_mut())
        .get()?
        .rendered(id, rate, length);
    Ok((0..rendered.number_of_channels())
        .map(|c| floats_to_bytes(rendered.get_channel_data(c)).into())
        .collect())
}

#[op2]
fn op_audio_node(
    state: &mut OpState,
    context: u32,
    #[string] kind: &str,
    #[serde] options: serde_json::Value,
) -> Result<u32, JsErrorBox> {
    audio(state)
        .get()?
        .node(context, kind, &options)
        .map_err(fail)
}

#[op2]
fn op_audio_set(
    state: &mut OpState,
    node: u32,
    #[string] prop: &str,
    #[serde] value: serde_json::Value,
) -> Result<(), JsErrorBox> {
    audio(state).get()?.set(node, prop, &value).map_err(fail)
}

#[op2(fast)]
fn op_audio_param(
    state: &mut OpState,
    node: u32,
    #[string] name: &str,
    #[string] method: &str,
    a: f64,
    b: f64,
    c: f64,
) -> Result<(), JsErrorBox> {
    audio(state)
        .get()?
        .param(node, name, method, a, b, c)
        .map_err(fail)
}

/// Runs the graph changes a page made in one task turn, in order. `platform/index.js` queues AudioParam automation,
/// property sets, connections and source starts and stops, and sends them in one call at the end of the turn, or
/// before any other audio call. Each command is a little-endian f64 code and its arguments; names index `strings`
/// and set values index `values`.
#[op2]
fn op_audio_batch(
    state: &mut OpState,
    #[buffer] commands: &[u8],
    #[serde] strings: Vec<String>,
    #[serde] values: Vec<Value>,
) -> Result<(), JsErrorBox> {
    let words: Vec<f64> = commands
        .as_chunks::<8>()
        .0
        .iter()
        .map(|w| f64::from_le_bytes(*w))
        .collect();
    let audio = audio(state);
    audio.batched.0 += 1;
    let graph = &mut audio.graph;
    let string = |i: f64| {
        strings
            .get(i as usize)
            .map(String::as_str)
            .ok_or_else(|| fail(format!("no batched string {i}")))
    };
    let mut at = 0;
    while at < words.len() {
        let w = &words[at..];
        let arg = |i: usize| w.get(i).copied().unwrap_or(0.);
        let id = arg(1) as u32;
        let length = match arg(0) as u32 {
            0 => {
                graph
                    .param(id, string(arg(2))?, string(arg(3))?, arg(4), arg(5), arg(6))
                    .map_err(fail)?;
                7
            }
            1 => {
                let value = values
                    .get(arg(3) as usize)
                    .ok_or_else(|| fail("no batched value"))?;
                graph.set(id, string(arg(2))?, value).map_err(fail)?;
                4
            }
            2 => {
                graph
                    .connect(id, arg(2) as u32, arg(3) as usize, arg(4) as usize)
                    .map_err(fail)?;
                5
            }
            3 => {
                graph
                    .connect_param(id, arg(2) as u32, string(arg(3))?, arg(4) as usize)
                    .map_err(fail)?;
                5
            }
            4 => {
                graph
                    .disconnect(id, arg(2) as u32, arg(3) as usize, arg(4) as usize)
                    .map_err(fail)?;
                5
            }
            5 => {
                graph
                    .disconnect_param(id, arg(2) as u32, string(arg(3))?, arg(4) as usize)
                    .map_err(fail)?;
                5
            }
            6 => {
                graph.start(id, arg(2), arg(3), arg(4)).map_err(fail)?;
                5
            }
            7 => {
                graph.stop(id, arg(2)).map_err(fail)?;
                3
            }
            code => return Err(fail(format!("no batched command {code}"))),
        };
        at += length;
        audio.batched.1 += 1;
    }
    Ok(())
}

#[op2(fast)]
fn op_audio_curve(
    state: &mut OpState,
    node: u32,
    #[string] name: &str,
    #[buffer] values: &[u8],
    start: f64,
    duration: f64,
) -> Result<(), JsErrorBox> {
    audio(state)
        .get()?
        .curve(node, name, &bytes_to_floats(values), start, duration)
        .map_err(fail)
}

#[op2(fast)]
fn op_audio_param_value(
    state: &mut OpState,
    node: u32,
    #[string] name: &str,
) -> Result<f32, JsErrorBox> {
    audio(state).get()?.param_value(node, name).map_err(fail)
}

#[op2(fast)]
fn op_audio_connect(
    state: &mut OpState,
    from: u32,
    to: u32,
    output: u32,
    input: u32,
) -> Result<(), JsErrorBox> {
    audio(state)
        .get()?
        .connect(from, to, output as usize, input as usize)
        .map_err(fail)
}

#[op2(fast)]
fn op_audio_connect_param(
    state: &mut OpState,
    from: u32,
    to: u32,
    #[string] name: &str,
    output: u32,
) -> Result<(), JsErrorBox> {
    audio(state)
        .get()?
        .connect_param(from, to, name, output as usize)
        .map_err(fail)
}

#[op2(fast)]
fn op_audio_disconnect(
    state: &mut OpState,
    from: u32,
    to: u32,
    output: u32,
    input: u32,
) -> Result<(), JsErrorBox> {
    audio(state)
        .get()?
        .disconnect(from, to, output as usize, input as usize)
        .map_err(fail)
}

#[op2(fast)]
fn op_audio_disconnect_param(
    state: &mut OpState,
    from: u32,
    to: u32,
    #[string] name: &str,
    output: u32,
) -> Result<(), JsErrorBox> {
    audio(state)
        .get()?
        .disconnect_param(from, to, name, output as usize)
        .map_err(fail)
}

#[op2(fast)]
fn op_audio_start(
    state: &mut OpState,
    node: u32,
    when: f64,
    offset: f64,
    duration: f64,
) -> Result<(), JsErrorBox> {
    audio(state)
        .get()?
        .start(node, when, offset, duration)
        .map_err(fail)
}

#[op2(fast)]
fn op_audio_stop(state: &mut OpState, node: u32, when: f64) -> Result<(), JsErrorBox> {
    audio(state).get()?.stop(node, when).map_err(fail)
}

/// Copies a page's AudioBuffer channels into an engine buffer.
#[op2]
fn op_audio_buffer(
    state: &mut OpState,
    #[serde] channels: Vec<JsBuffer>,
    sample_rate: f64,
) -> Result<u32, JsErrorBox> {
    let channels = channels.iter().map(|c| bytes_to_floats(c)).collect();
    Ok(audio(state).get()?.buffer(channels, sample_rate as f32))
}

#[op2]
#[buffer]
fn op_audio_buffer_data(
    state: &mut OpState,
    buffer: u32,
    channel: u32,
) -> Result<Vec<u8>, JsErrorBox> {
    Ok(floats_to_bytes(
        &audio(state)
            .get()?
            .buffer_data(buffer, channel as usize)
            .map_err(fail)?,
    ))
}

#[op2(fast)]
fn op_audio_source_buffer(state: &mut OpState, node: u32, buffer: u32) -> Result<(), JsErrorBox> {
    audio(state)
        .get()?
        .source_buffer(node, buffer)
        .map_err(fail)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecodedInfo {
    id: Id,
    number_of_channels: usize,
    length: usize,
    sample_rate: f32,
}

/// Decodes a file on the blocking pool into a context running at `sample_rate`.
#[op2]
#[serde]
async fn op_audio_decode(
    state: Rc<RefCell<OpState>>,
    #[buffer] bytes: JsBuffer,
    sample_rate: f64,
) -> Result<DecodedInfo, JsErrorBox> {
    let bytes = bytes.to_vec();
    let decoded = tokio::task::spawn_blocking(move || decode_audio_data(bytes, sample_rate as f32))
        .await
        .map_err(fail)?
        .map_err(|e| JsErrorBox::generic(e.0))?;
    let (id, number_of_channels, length) = audio(&mut state.borrow_mut()).graph.decoded(decoded);
    Ok(DecodedInfo {
        id,
        number_of_channels,
        length,
        sample_rate: sample_rate as f32,
    })
}

/// Fills a typed array from an AnalyserNode. Float reads take the array's bytes.
#[op2(fast)]
fn op_audio_analyser(
    state: &mut OpState,
    node: u32,
    #[string] kind: &str,
    #[buffer] out: &mut [u8],
) -> Result<(), JsErrorBox> {
    let graph = audio(state).get()?;
    if kind.starts_with("float") {
        let mut floats = vec![0f32; out.len() / 4];
        graph
            .analyser(node, kind, &mut floats, &mut [])
            .map_err(fail)?;
        out.copy_from_slice(&floats_to_bytes(&floats));
    } else {
        graph.analyser(node, kind, &mut [], out).map_err(fail)?;
    }
    Ok(())
}

/// Answers the next source that ended, for the page to fire `ended`. One call waits at a time.
#[op2]
async fn op_audio_ended(state: Rc<RefCell<OpState>>) -> Result<u32, JsErrorBox> {
    let mut receiver = audio(&mut state.borrow_mut())
        .ended
        .take()
        .ok_or_else(|| fail("another call already waits for ended sources"))?;
    let next = receiver.next().await;
    audio(&mut state.borrow_mut()).ended = Some(receiver);
    next.ok_or_else(|| fail("the audio graph closed"))
}

fn floats_to_bytes(floats: &[f32]) -> Vec<u8> {
    floats.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn bytes_to_floats(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}

deno_core::extension!(
    audio_ext,
    ops = [
        op_audio_context,
        op_audio_current_time,
        op_audio_base_latency,
        op_audio_output_latency,
        op_audio_destination,
        op_audio_listener,
        op_audio_max_channel_count,
        op_audio_lifecycle,
        op_audio_render,
        op_audio_node,
        op_audio_set,
        op_audio_param,
        op_audio_batch,
        op_audio_curve,
        op_audio_param_value,
        op_audio_connect,
        op_audio_connect_param,
        op_audio_disconnect,
        op_audio_disconnect_param,
        op_audio_start,
        op_audio_stop,
        op_audio_buffer,
        op_audio_buffer_data,
        op_audio_source_buffer,
        op_audio_decode,
        op_audio_analyser,
        op_audio_ended
    ]
);
pub use audio_ext as extension;

#[cfg(test)]
mod tests {
    use super::*;
    use deno_core::{JsRuntime, RuntimeOptions};

    #[test]
    fn the_publisher_writes_render_quanta_where_the_page_reads_them() {
        let mut runtime = JsRuntime::new(RuntimeOptions::default());
        let slot = runtime
            .execute_script("slot", "globalThis.slot = new SharedArrayBuffer(4); slot")
            .unwrap();
        let sink = {
            deno_core::scope!(scope, runtime);
            let slot = v8::Local::new(scope, slot);
            publisher(slot).expect("a SharedArrayBuffer of 4 bytes")
        };
        sink(128 * 37);
        let read = runtime
            .execute_script("read", "Atomics.load(new Int32Array(slot), 0)")
            .unwrap();
        deno_core::scope!(scope, runtime);
        assert_eq!(v8::Local::new(scope, read).int32_value(scope), Some(37));
    }

    #[test]
    fn a_running_context_publishes_its_frame_count_to_the_page() {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            extensions: vec![extension::init()],
            ..Default::default()
        });
        runtime.op_state().borrow_mut().put(Audio::new(Options {
            device: Some("none".into()),
            csv: std::env::temp_dir().join(format!("threejsc-publish-{}.csv", std::process::id())),
            ..Default::default()
        }));
        runtime
            .execute_script(
                "context",
                "const ops = Deno.core.ops;
                globalThis.slot = new SharedArrayBuffer(4);
                const { id } = ops.op_audio_context({ kind: 'online', sampleRate: null, latencyHint: 'interactive' }, slot);
                const tone = ops.op_audio_node(id, 'Oscillator', {});
                ops.op_audio_connect(tone, ops.op_audio_destination(id), 0, 0);
                ops.op_audio_start(tone, 0, 0, -1);",
            )
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let read = runtime
            .execute_script("read", "Atomics.load(new Int32Array(slot), 0)")
            .unwrap();
        deno_core::scope!(scope, runtime);
        let quanta = v8::Local::new(scope, read).int32_value(scope).unwrap();
        assert!(quanta > 0, "the page's slot holds {quanta} quanta");
    }
}
