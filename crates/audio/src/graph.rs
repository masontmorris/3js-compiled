//! The engine objects behind the page's Web Audio objects, keyed by the ids the JavaScript side holds. The JavaScript
//! side checks every argument and throws Edge's errors first, so a call that reaches here is one the engine accepts,
//! and an unknown id, kind or name is an error rather than a panic.

use std::collections::HashMap;
use std::sync::Arc;

use futures_channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use serde_json::Value;
use web_audio_api::context::{
    AudioContext, AudioContextLatencyCategory, AudioContextOptions, BaseAudioContext,
    OfflineAudioContext,
};
use web_audio_api::node::{
    AnalyserNode, AudioBufferSourceNode, AudioDestinationNode, AudioNode, AudioScheduledSourceNode,
    BiquadFilterNode, BiquadFilterType, ChannelCountMode, ChannelInterpretation,
    ConstantSourceNode, DelayNode, DelayOptions, DistanceModelType, GainNode, OscillatorNode,
    OscillatorType, PannerNode, PanningModelType, StereoPannerNode,
};
use web_audio_api::{AudioBuffer, AudioListener, AudioParam, AutomationRate, RenderObserver};

use crate::decode::Decoded;

pub type Id = u32;

#[derive(Debug)]
pub struct GraphError(pub String);

impl std::fmt::Display for GraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GraphError {}

type Result<T> = std::result::Result<T, GraphError>;

fn err<T>(message: impl Into<String>) -> Result<T> {
    Err(GraphError(message.into()))
}

enum Context {
    Online(Arc<AudioContext>),
    Offline(Box<OfflineAudioContext>),
    /// An offline context while it renders on another thread.
    Rendering,
    Rendered(f32, usize),
}

enum Node {
    Gain(GainNode),
    Source(AudioBufferSourceNode),
    Oscillator(OscillatorNode),
    Constant(ConstantSourceNode),
    Stereo(StereoPannerNode),
    Panner(PannerNode),
    Analyser(AnalyserNode),
    Biquad(BiquadFilterNode),
    Delay(DelayNode),
    Destination(AudioDestinationNode),
    Listener(AudioListener),
}

impl Node {
    fn audio_node(&self) -> Result<&dyn AudioNode> {
        Ok(match self {
            Node::Gain(n) => n,
            Node::Source(n) => n,
            Node::Oscillator(n) => n,
            Node::Constant(n) => n,
            Node::Stereo(n) => n,
            Node::Panner(n) => n,
            Node::Analyser(n) => n,
            Node::Biquad(n) => n,
            Node::Delay(n) => n,
            Node::Destination(n) => n,
            Node::Listener(_) => return err("the listener is not an AudioNode"),
        })
    }

    fn param(&self, name: &str) -> Result<&AudioParam> {
        Ok(match (self, name) {
            (Node::Gain(n), "gain") => n.gain(),
            (Node::Source(n), "playbackRate") => n.playback_rate(),
            (Node::Source(n), "detune") => n.detune(),
            (Node::Oscillator(n), "frequency") => n.frequency(),
            (Node::Oscillator(n), "detune") => n.detune(),
            (Node::Constant(n), "offset") => n.offset(),
            (Node::Stereo(n), "pan") => n.pan(),
            (Node::Panner(n), "positionX") => n.position_x(),
            (Node::Panner(n), "positionY") => n.position_y(),
            (Node::Panner(n), "positionZ") => n.position_z(),
            (Node::Panner(n), "orientationX") => n.orientation_x(),
            (Node::Panner(n), "orientationY") => n.orientation_y(),
            (Node::Panner(n), "orientationZ") => n.orientation_z(),
            (Node::Biquad(n), "frequency") => n.frequency(),
            (Node::Biquad(n), "detune") => n.detune(),
            (Node::Biquad(n), "Q") => n.q(),
            (Node::Biquad(n), "gain") => n.gain(),
            (Node::Delay(n), "delayTime") => n.delay_time(),
            (Node::Listener(n), "positionX") => n.position_x(),
            (Node::Listener(n), "positionY") => n.position_y(),
            (Node::Listener(n), "positionZ") => n.position_z(),
            (Node::Listener(n), "forwardX") => n.forward_x(),
            (Node::Listener(n), "forwardY") => n.forward_y(),
            (Node::Listener(n), "forwardZ") => n.forward_z(),
            (Node::Listener(n), "upX") => n.up_x(),
            (Node::Listener(n), "upY") => n.up_y(),
            (Node::Listener(n), "upZ") => n.up_z(),
            _ => return err(format!("no AudioParam {name}")),
        })
    }

    fn start_at(&mut self, when: f64) -> Result<()> {
        match self {
            Node::Source(n) => n.start_at(when),
            Node::Oscillator(n) => n.start_at(when),
            Node::Constant(n) => n.start_at(when),
            _ => return err("not a scheduled source"),
        }
        Ok(())
    }

    fn stop_at(&mut self, when: f64) -> Result<()> {
        match self {
            Node::Source(n) => n.stop_at(when),
            Node::Oscillator(n) => n.stop_at(when),
            Node::Constant(n) => n.stop_at(when),
            _ => return err("not a scheduled source"),
        }
        Ok(())
    }

    fn on_ended(&self, callback: impl FnOnce() + Send + 'static) {
        match self {
            Node::Source(n) => n.set_onended(move |_| callback()),
            Node::Oscillator(n) => n.set_onended(move |_| callback()),
            Node::Constant(n) => n.set_onended(move |_| callback()),
            _ => {}
        }
    }
}

/// Makes the observer for a new online context from its sample rate and channel count.
pub type ObserverFactory = Box<dyn FnMut(f32, usize) -> Box<dyn RenderObserver>>;

pub type OnlineHook = Box<dyn FnMut(&Arc<AudioContext>)>;

/// How an online context reaches the output: the device, and an observer of what the device receives.
pub struct Output {
    /// The engine's sink id, or empty for the default device.
    pub sink_id: String,
    pub observer: Option<ObserverFactory>,
    /// Sees each new online context, so a default-device follower can move it.
    pub on_online: Option<OnlineHook>,
}

/// What a new online context reports back to the page.
pub struct OnlineInfo {
    pub id: Id,
    pub sample_rate: f32,
    pub base_latency: f64,
}

pub struct Graph {
    next: Id,
    contexts: HashMap<Id, Context>,
    nodes: HashMap<Id, (Id, Node)>,
    buffers: HashMap<Id, AudioBuffer>,
    destinations: HashMap<Id, Id>,
    listeners: HashMap<Id, Id>,
    ended_tx: UnboundedSender<Id>,
}

impl Graph {
    /// An empty graph, and the receiver of every source id that ends.
    pub fn new() -> (Self, UnboundedReceiver<Id>) {
        let (ended_tx, ended_rx) = unbounded();
        let graph = Self {
            next: 1,
            contexts: HashMap::new(),
            nodes: HashMap::new(),
            buffers: HashMap::new(),
            destinations: HashMap::new(),
            listeners: HashMap::new(),
            ended_tx,
        };
        (graph, ended_rx)
    }

    fn id(&mut self) -> Id {
        let id = self.next;
        self.next += 1;
        id
    }

    pub fn online(
        &mut self,
        output: &mut Output,
        sample_rate: Option<f32>,
        latency_hint: &str,
    ) -> Result<OnlineInfo> {
        let latency_hint = match latency_hint {
            "balanced" => AudioContextLatencyCategory::Balanced,
            "playback" => AudioContextLatencyCategory::Playback,
            seconds => seconds.parse().map_or(
                AudioContextLatencyCategory::Interactive,
                AudioContextLatencyCategory::Custom,
            ),
        };
        let options = AudioContextOptions {
            latency_hint,
            sample_rate,
            sink_id: output.sink_id.clone(),
            ..AudioContextOptions::default()
        };
        let context = AudioContext::try_new(options).map_err(|e| GraphError(e.to_string()))?;
        if let Some(observer) = &mut output.observer {
            context.set_render_observer(Some(observer(
                context.sample_rate(),
                context.destination().max_channel_count(),
            )));
        }
        let id = self.id();
        let info = OnlineInfo {
            id,
            sample_rate: context.sample_rate(),
            base_latency: context.base_latency(),
        };
        let context = Arc::new(context);
        if let Some(on_online) = &mut output.on_online {
            on_online(&context);
        }
        self.contexts.insert(id, Context::Online(context));
        Ok(info)
    }

    pub fn offline(&mut self, channels: usize, length: usize, sample_rate: f32) -> Id {
        let id = self.id();
        self.contexts.insert(
            id,
            Context::Offline(Box::new(OfflineAudioContext::new(
                channels,
                length,
                sample_rate,
            ))),
        );
        id
    }

    /// The online context, for suspend, resume and close, which the host awaits off this object.
    pub fn online_context(&self, id: Id) -> Result<Arc<AudioContext>> {
        match self.contexts.get(&id) {
            Some(Context::Online(context)) => Ok(Arc::clone(context)),
            _ => err(format!("no online context {id}")),
        }
    }

    pub fn current_time(&self, id: Id) -> f64 {
        match self.contexts.get(&id) {
            Some(Context::Online(c)) => c.current_time(),
            Some(Context::Offline(c)) => c.current_time(),
            Some(Context::Rendered(rate, length)) => *length as f64 / f64::from(*rate),
            Some(Context::Rendering) | None => 0.,
        }
    }

    pub fn output_latency(&self, id: Id) -> f64 {
        match self.contexts.get(&id) {
            Some(Context::Online(c)) => c.output_latency(),
            _ => 0.,
        }
    }

    pub fn max_channel_count(&self, id: Id) -> Result<usize> {
        Ok(match self.contexts.get(&id) {
            Some(Context::Online(c)) => c.destination().max_channel_count(),
            Some(Context::Offline(c)) => c.destination().max_channel_count(),
            _ => return err(format!("no context {id} to read")),
        })
    }

    /// Takes an offline context out to render it on another thread. Give the result back with `rendered`.
    pub fn take_offline(&mut self, id: Id) -> Result<OfflineAudioContext> {
        match self.contexts.remove(&id) {
            Some(Context::Offline(context)) => {
                self.contexts.insert(id, Context::Rendering);
                Ok(*context)
            }
            other => {
                if let Some(other) = other {
                    self.contexts.insert(id, other);
                }
                err(format!("context {id} cannot render"))
            }
        }
    }

    pub fn rendered(&mut self, id: Id, sample_rate: f32, length: usize) {
        self.contexts
            .insert(id, Context::Rendered(sample_rate, length));
    }

    fn with_context<T>(
        &self,
        id: Id,
        online: impl FnOnce(&AudioContext) -> T,
        offline: impl FnOnce(&OfflineAudioContext) -> T,
    ) -> Result<T> {
        match self.contexts.get(&id) {
            Some(Context::Online(c)) => Ok(online(c)),
            Some(Context::Offline(c)) => Ok(offline(c)),
            _ => err(format!(
                "context {id} is rendering or gone, so it cannot take new nodes"
            )),
        }
    }

    pub fn destination(&mut self, context: Id) -> Result<Id> {
        if let Some(id) = self.destinations.get(&context) {
            return Ok(*id);
        }
        let node = self.with_context(context, |c| c.destination(), |c| c.destination())?;
        let id = self.id();
        self.nodes.insert(id, (context, Node::Destination(node)));
        self.destinations.insert(context, id);
        Ok(id)
    }

    pub fn listener(&mut self, context: Id) -> Result<Id> {
        if let Some(id) = self.listeners.get(&context) {
            return Ok(*id);
        }
        let listener = self.with_context(context, |c| c.listener(), |c| c.listener())?;
        let id = self.id();
        self.nodes.insert(id, (context, Node::Listener(listener)));
        self.listeners.insert(context, id);
        Ok(id)
    }

    /// Creates a node with the engine's defaults. The page's options arrive as `set` and param calls after this.
    pub fn node(&mut self, context: Id, kind: &str, options: &Value) -> Result<Id> {
        let node = match kind {
            "Gain" => self.with_context(
                context,
                |c| Node::Gain(c.create_gain()),
                |c| Node::Gain(c.create_gain()),
            )?,
            "AudioBufferSource" => self.with_context(
                context,
                |c| Node::Source(c.create_buffer_source()),
                |c| Node::Source(c.create_buffer_source()),
            )?,
            "Oscillator" => self.with_context(
                context,
                |c| Node::Oscillator(c.create_oscillator()),
                |c| Node::Oscillator(c.create_oscillator()),
            )?,
            "ConstantSource" => self.with_context(
                context,
                |c| Node::Constant(c.create_constant_source()),
                |c| Node::Constant(c.create_constant_source()),
            )?,
            "StereoPanner" => self.with_context(
                context,
                |c| Node::Stereo(c.create_stereo_panner()),
                |c| Node::Stereo(c.create_stereo_panner()),
            )?,
            "Panner" => self.with_context(
                context,
                |c| Node::Panner(c.create_panner()),
                |c| Node::Panner(c.create_panner()),
            )?,
            "Analyser" => self.with_context(
                context,
                |c| Node::Analyser(c.create_analyser()),
                |c| Node::Analyser(c.create_analyser()),
            )?,
            "BiquadFilter" => self.with_context(
                context,
                |c| Node::Biquad(c.create_biquad_filter()),
                |c| Node::Biquad(c.create_biquad_filter()),
            )?,
            "Delay" => {
                let options = DelayOptions {
                    max_delay_time: options
                        .get("maxDelayTime")
                        .and_then(Value::as_f64)
                        .unwrap_or(1.),
                    ..DelayOptions::default()
                };
                self.with_context(
                    context,
                    |c| Node::Delay(DelayNode::new(c, options.clone())),
                    |c| Node::Delay(DelayNode::new(c, options.clone())),
                )?
            }
            other => return err(format!("no node kind {other}")),
        };
        let id = self.id();
        let tx = self.ended_tx.clone();
        node.on_ended(move || {
            let _ = tx.unbounded_send(id);
        });
        self.nodes.insert(id, (context, node));
        Ok(id)
    }

    fn node_mut(&mut self, id: Id) -> Result<&mut Node> {
        self.nodes
            .get_mut(&id)
            .map(|(_, n)| n)
            .ok_or_else(|| GraphError(format!("no node {id}")))
    }

    fn get(&self, id: Id) -> Result<&Node> {
        self.nodes
            .get(&id)
            .map(|(_, n)| n)
            .ok_or_else(|| GraphError(format!("no node {id}")))
    }

    /// Sets a node attribute, or an AudioParam's automation rate as `<param>.automationRate`.
    pub fn set(&mut self, id: Id, prop: &str, value: &Value) -> Result<()> {
        let text = || value.as_str().unwrap_or_default();
        let number = || value.as_f64().unwrap_or_default();
        if let Some(name) = prop.strip_suffix(".automationRate") {
            let rate = if text() == "k-rate" {
                AutomationRate::K
            } else {
                AutomationRate::A
            };
            self.get(id)?.param(name)?.set_automation_rate(rate);
            return Ok(());
        }
        let node = self.node_mut(id)?;
        match (prop, node) {
            ("channelCount", node) => node.audio_node()?.set_channel_count(number() as usize),
            ("channelCountMode", node) => node.audio_node()?.set_channel_count_mode(match text() {
                "clamped-max" => ChannelCountMode::ClampedMax,
                "explicit" => ChannelCountMode::Explicit,
                _ => ChannelCountMode::Max,
            }),
            ("channelInterpretation", node) => {
                node.audio_node()?
                    .set_channel_interpretation(if text() == "discrete" {
                        ChannelInterpretation::Discrete
                    } else {
                        ChannelInterpretation::Speakers
                    })
            }
            ("type", Node::Oscillator(n)) => n.set_type(match text() {
                "square" => OscillatorType::Square,
                "sawtooth" => OscillatorType::Sawtooth,
                "triangle" => OscillatorType::Triangle,
                _ => OscillatorType::Sine,
            }),
            ("type", Node::Biquad(n)) => n.set_type(match text() {
                "highpass" => BiquadFilterType::Highpass,
                "bandpass" => BiquadFilterType::Bandpass,
                "lowshelf" => BiquadFilterType::Lowshelf,
                "highshelf" => BiquadFilterType::Highshelf,
                "peaking" => BiquadFilterType::Peaking,
                "notch" => BiquadFilterType::Notch,
                "allpass" => BiquadFilterType::Allpass,
                _ => BiquadFilterType::Lowpass,
            }),
            ("loop", Node::Source(n)) => n.set_loop(value.as_bool().unwrap_or_default()),
            ("loopStart", Node::Source(n)) => n.set_loop_start(number()),
            ("loopEnd", Node::Source(n)) => n.set_loop_end(number()),
            ("panningModel", Node::Panner(n)) => n.set_panning_model(if text() == "HRTF" {
                PanningModelType::HRTF
            } else {
                PanningModelType::EqualPower
            }),
            ("distanceModel", Node::Panner(n)) => n.set_distance_model(match text() {
                "linear" => DistanceModelType::Linear,
                "exponential" => DistanceModelType::Exponential,
                _ => DistanceModelType::Inverse,
            }),
            ("refDistance", Node::Panner(n)) => n.set_ref_distance(number()),
            ("maxDistance", Node::Panner(n)) => n.set_max_distance(number()),
            ("rolloffFactor", Node::Panner(n)) => n.set_rolloff_factor(number()),
            ("coneInnerAngle", Node::Panner(n)) => n.set_cone_inner_angle(number()),
            ("coneOuterAngle", Node::Panner(n)) => n.set_cone_outer_angle(number()),
            ("coneOuterGain", Node::Panner(n)) => n.set_cone_outer_gain(number()),
            ("fftSize", Node::Analyser(n)) => n.set_fft_size(number() as usize),
            ("minDecibels", Node::Analyser(n)) => n.set_min_decibels(number()),
            ("maxDecibels", Node::Analyser(n)) => n.set_max_decibels(number()),
            ("smoothingTimeConstant", Node::Analyser(n)) => n.set_smoothing_time_constant(number()),
            (prop, _) => return err(format!("no attribute {prop} on node {id}")),
        }
        Ok(())
    }

    /// Runs one AudioParam method: `value`, `setValueAtTime`, the two ramps, `setTargetAtTime`, or the two cancels.
    pub fn param(&self, id: Id, name: &str, method: &str, a: f64, b: f64, c: f64) -> Result<()> {
        let param = self.get(id)?.param(name)?;
        match method {
            "value" => {
                param.set_value(a as f32);
            }
            "setValueAtTime" => {
                param.set_value_at_time(a as f32, b);
            }
            "linearRampToValueAtTime" => {
                param.linear_ramp_to_value_at_time(a as f32, b);
            }
            "exponentialRampToValueAtTime" => {
                param.exponential_ramp_to_value_at_time(a as f32, b);
            }
            "setTargetAtTime" => {
                param.set_target_at_time(a as f32, b, c);
            }
            "cancelScheduledValues" => {
                param.cancel_scheduled_values(a);
            }
            "cancelAndHoldAtTime" => {
                param.cancel_and_hold_at_time(a);
            }
            other => return err(format!("no AudioParam method {other}")),
        }
        Ok(())
    }

    pub fn curve(
        &self,
        id: Id,
        name: &str,
        values: &[f32],
        start: f64,
        duration: f64,
    ) -> Result<()> {
        self.get(id)?
            .param(name)?
            .set_value_curve_at_time(values, start, duration);
        Ok(())
    }

    pub fn param_value(&self, id: Id, name: &str) -> Result<f32> {
        Ok(self.get(id)?.param(name)?.value())
    }

    pub fn connect(&self, from: Id, to: Id, output: usize, input: usize) -> Result<()> {
        let source = self.get(from)?.audio_node()?;
        source.connect_from_output_to_input(self.get(to)?.audio_node()?, output, input);
        Ok(())
    }

    pub fn connect_param(&self, from: Id, to: Id, name: &str, output: usize) -> Result<()> {
        let source = self.get(from)?.audio_node()?;
        source.connect_from_output_to_input(self.get(to)?.param(name)?, output, 0);
        Ok(())
    }

    pub fn disconnect(&self, from: Id, to: Id, output: usize, input: usize) -> Result<()> {
        let source = self.get(from)?.audio_node()?;
        source.disconnect_dest_from_output_to_input(self.get(to)?.audio_node()?, output, input);
        Ok(())
    }

    pub fn disconnect_param(&self, from: Id, to: Id, name: &str, output: usize) -> Result<()> {
        let source = self.get(from)?.audio_node()?;
        source.disconnect_dest_from_output(self.get(to)?.param(name)?, output);
        Ok(())
    }

    /// Starts a source. A negative `duration` means none was given.
    pub fn start(&mut self, id: Id, when: f64, offset: f64, duration: f64) -> Result<()> {
        match self.node_mut(id)? {
            Node::Source(n) if duration >= 0. => {
                n.start_at_with_offset_and_duration(when, offset, duration)
            }
            Node::Source(n) => n.start_at_with_offset(when, offset),
            node => node.start_at(when)?,
        }
        Ok(())
    }

    pub fn stop(&mut self, id: Id, when: f64) -> Result<()> {
        self.node_mut(id)?.stop_at(when)
    }

    pub fn buffer(&mut self, channels: Vec<Vec<f32>>, sample_rate: f32) -> Id {
        let id = self.id();
        self.buffers
            .insert(id, AudioBuffer::from(channels, sample_rate));
        id
    }

    pub fn decoded(&mut self, decoded: Decoded) -> (Id, usize, usize) {
        let channels = decoded.channels.len();
        let length = decoded.channels.first().map_or(0, Vec::len);
        (
            self.buffer(decoded.channels, decoded.sample_rate),
            channels,
            length,
        )
    }

    pub fn buffer_data(&self, id: Id, channel: usize) -> Result<Vec<f32>> {
        let buffer = self
            .buffers
            .get(&id)
            .ok_or_else(|| GraphError(format!("no buffer {id}")))?;
        Ok(buffer.get_channel_data(channel).to_vec())
    }

    pub fn source_buffer(&mut self, node: Id, buffer: Id) -> Result<()> {
        let buffer = self
            .buffers
            .get(&buffer)
            .ok_or_else(|| GraphError(format!("no buffer {buffer}")))?
            .clone();
        match self.node_mut(node)? {
            Node::Source(n) => n.set_buffer(buffer),
            _ => return err(format!("node {node} takes no buffer")),
        }
        Ok(())
    }

    /// Fills `floats` or `bytes` from an AnalyserNode, by `kind`: floatFrequency, byteFrequency, floatTime or byteTime.
    pub fn analyser(
        &mut self,
        id: Id,
        kind: &str,
        floats: &mut [f32],
        bytes: &mut [u8],
    ) -> Result<()> {
        let Node::Analyser(n) = self.node_mut(id)? else {
            return err(format!("node {id} is not an analyser"));
        };
        match kind {
            "floatFrequency" => n.get_float_frequency_data(floats),
            "byteFrequency" => n.get_byte_frequency_data(bytes),
            "floatTime" => n.get_float_time_domain_data(floats),
            "byteTime" => n.get_byte_time_domain_data(bytes),
            other => return err(format!("no analyser read {other}")),
        }
        Ok(())
    }

    /// Drops a closed context and its nodes.
    pub fn forget(&mut self, context: Id) {
        self.contexts.remove(&context);
        self.nodes.retain(|_, (owner, _)| *owner != context);
        self.destinations.remove(&context);
        self.listeners.remove(&context);
    }
}
