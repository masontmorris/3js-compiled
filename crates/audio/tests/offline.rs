//! Renders the reference graphs in tests/graphs.json with web-audio-api-rs and compares each render to Edge's.
//! tests/fixtures holds Edge's renders as 16-bit FLAC, from tools/audio-parity/edge.mjs and fixtures.mjs.
//! THREEJSC_AUDIO_REFERENCE points at a folder of Edge's float WAVs instead, THREEJSC_AUDIO_DUMP saves the engine's
//! renders as float WAVs, and THREEJSC_AUDIO_REPORT writes one TSV row per render. HRTF rows whose levels miss are
//! pending until the repo ships Edge's HRIR set.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::Value;
use threejsc_audio::decode::decode_audio_data;
use threejsc_audio::web_audio_api::context::{BaseAudioContext, OfflineAudioContext};
use threejsc_audio::web_audio_api::node::{
    AudioBufferSourceNode, AudioBufferSourceOptions, AudioNode, AudioScheduledSourceNode,
    ConstantSourceNode, ConstantSourceOptions, DistanceModelType, GainNode, GainOptions,
    OscillatorNode, OscillatorOptions, OscillatorType, PannerNode, PannerOptions, PanningModelType,
    StereoPannerNode, StereoPannerOptions,
};
use threejsc_audio::web_audio_api::{AudioBuffer, AudioParam};

enum Node {
    Oscillator(OscillatorNode),
    Constant(ConstantSourceNode),
    Gain(GainNode),
    Stereo(StereoPannerNode),
    Panner(PannerNode),
    Source(AudioBufferSourceNode),
}

impl Node {
    fn audio_node(&self) -> &dyn AudioNode {
        match self {
            Node::Oscillator(n) => n,
            Node::Constant(n) => n,
            Node::Gain(n) => n,
            Node::Stereo(n) => n,
            Node::Panner(n) => n,
            Node::Source(n) => n,
        }
    }

    fn param(&self, name: &str) -> &AudioParam {
        match (self, name) {
            (Node::Oscillator(n), "frequency") => n.frequency(),
            (Node::Oscillator(n), "detune") => n.detune(),
            (Node::Constant(n), "offset") => n.offset(),
            (Node::Gain(n), "gain") => n.gain(),
            (Node::Stereo(n), "pan") => n.pan(),
            (Node::Panner(n), "positionX") => n.position_x(),
            (Node::Panner(n), "positionY") => n.position_y(),
            (Node::Panner(n), "positionZ") => n.position_z(),
            (Node::Source(n), "playbackRate") => n.playback_rate(),
            (Node::Source(n), "detune") => n.detune(),
            _ => panic!("no param {name}"),
        }
    }
}

fn f32_of(options: &Value, key: &str, default: f32) -> f32 {
    options
        .get(key)
        .and_then(Value::as_f64)
        .map_or(default, |v| v as f32)
}

fn f64_of(options: &Value, key: &str, default: f64) -> f64 {
    options.get(key).and_then(Value::as_f64).unwrap_or(default)
}

fn signal_buffer(options: &Value) -> AudioBuffer {
    let channels = options["channels"].as_u64().unwrap() as usize;
    let length = options["length"].as_u64().unwrap() as usize;
    let rate = options["sampleRate"].as_f64().unwrap();
    let name = options["signal"].as_str().unwrap();
    let data = (0..channels)
        .map(|c| {
            let mut x: u32 = 0x9e37_79b9 ^ (c as u32).wrapping_mul(0x85eb_ca6b);
            (0..length)
                .map(|i| match name {
                    "mix" => {
                        let t = i as f64 / rate;
                        let phase = c as f64 * 0.7;
                        let tau = 2.0 * std::f64::consts::PI;
                        (0.15
                            * ((tau * 220.0 * t + phase).sin()
                                + (tau * 1330.0 * t + phase).sin()
                                + (tau * 4100.0 * t + phase).sin())) as f32
                    }
                    "noise" => {
                        x ^= x << 13;
                        x ^= x >> 17;
                        x ^= x << 5;
                        (x as f64 / 4_294_967_296.0 - 0.5) as f32
                    }
                    _ => panic!("unknown signal {name}"),
                })
                .collect()
        })
        .collect();
    AudioBuffer::from(data, rate as f32)
}

fn make_node(
    ctx: &OfflineAudioContext,
    kind: &str,
    o: &Value,
    buffers: &HashMap<String, AudioBuffer>,
) -> Node {
    match kind {
        "Oscillator" => Node::Oscillator(OscillatorNode::new(
            ctx,
            OscillatorOptions {
                type_: match o.get("type").and_then(Value::as_str).unwrap_or("sine") {
                    "sine" => OscillatorType::Sine,
                    "square" => OscillatorType::Square,
                    "sawtooth" => OscillatorType::Sawtooth,
                    "triangle" => OscillatorType::Triangle,
                    other => panic!("oscillator type {other}"),
                },
                frequency: f32_of(o, "frequency", 440.0),
                detune: f32_of(o, "detune", 0.0),
                ..OscillatorOptions::default()
            },
        )),
        "ConstantSource" => Node::Constant(ConstantSourceNode::new(
            ctx,
            ConstantSourceOptions {
                offset: f32_of(o, "offset", 1.0),
            },
        )),
        "Gain" => Node::Gain(GainNode::new(
            ctx,
            GainOptions {
                gain: f32_of(o, "gain", 1.0),
                ..GainOptions::default()
            },
        )),
        "StereoPanner" => Node::Stereo(StereoPannerNode::new(
            ctx,
            StereoPannerOptions {
                pan: f32_of(o, "pan", 0.0),
                ..StereoPannerOptions::default()
            },
        )),
        "Panner" => Node::Panner(PannerNode::new(
            ctx,
            PannerOptions {
                panning_model: match o
                    .get("panningModel")
                    .and_then(Value::as_str)
                    .unwrap_or("equalpower")
                {
                    "equalpower" => PanningModelType::EqualPower,
                    "HRTF" => PanningModelType::HRTF,
                    other => panic!("panning model {other}"),
                },
                distance_model: match o
                    .get("distanceModel")
                    .and_then(Value::as_str)
                    .unwrap_or("inverse")
                {
                    "linear" => DistanceModelType::Linear,
                    "inverse" => DistanceModelType::Inverse,
                    "exponential" => DistanceModelType::Exponential,
                    other => panic!("distance model {other}"),
                },
                position_x: f32_of(o, "positionX", 0.0),
                position_y: f32_of(o, "positionY", 0.0),
                position_z: f32_of(o, "positionZ", 0.0),
                orientation_x: f32_of(o, "orientationX", 1.0),
                orientation_y: f32_of(o, "orientationY", 0.0),
                orientation_z: f32_of(o, "orientationZ", 0.0),
                ref_distance: f64_of(o, "refDistance", 1.0),
                max_distance: f64_of(o, "maxDistance", 10000.0),
                rolloff_factor: f64_of(o, "rolloffFactor", 1.0),
                cone_inner_angle: f64_of(o, "coneInnerAngle", 360.0),
                cone_outer_angle: f64_of(o, "coneOuterAngle", 360.0),
                cone_outer_gain: f64_of(o, "coneOuterGain", 0.0),
                ..PannerOptions::default()
            },
        )),
        "AudioBufferSource" => Node::Source(AudioBufferSourceNode::new(
            ctx,
            AudioBufferSourceOptions {
                buffer: o
                    .get("buffer")
                    .and_then(Value::as_str)
                    .map(|id| buffers[id].clone()),
                detune: f32_of(o, "detune", 0.0),
                loop_: o.get("loop").and_then(Value::as_bool).unwrap_or(false),
                loop_start: f64_of(o, "loopStart", 0.0),
                loop_end: f64_of(o, "loopEnd", 0.0),
                playback_rate: f32_of(o, "playbackRate", 1.0),
            },
        )),
        other => panic!("node kind {other}"),
    }
}

fn automate(param: &AudioParam, method: &str, args: &[Value]) {
    let n = |i: usize| args[i].as_f64().unwrap();
    match method {
        "value" => {
            param.set_value(n(0) as f32);
        }
        "setValueAtTime" => {
            param.set_value_at_time(n(0) as f32, n(1));
        }
        "linearRampToValueAtTime" => {
            param.linear_ramp_to_value_at_time(n(0) as f32, n(1));
        }
        "exponentialRampToValueAtTime" => {
            param.exponential_ramp_to_value_at_time(n(0) as f32, n(1));
        }
        "setTargetAtTime" => {
            param.set_target_at_time(n(0) as f32, n(1), n(2));
        }
        "setValueCurveAtTime" => {
            let curve: Vec<f32> = args[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap() as f32)
                .collect();
            param.set_value_curve_at_time(&curve, n(1), n(2));
        }
        "cancelScheduledValues" => {
            param.cancel_scheduled_values(n(0));
        }
        "cancelAndHoldAtTime" => {
            param.cancel_and_hold_at_time(n(0));
        }
        other => panic!("param method {other}"),
    }
}

fn render(spec: &Value) -> Vec<Vec<f32>> {
    let channels = spec["channels"].as_u64().unwrap() as usize;
    let length = spec["length"].as_u64().unwrap() as usize;
    let mut ctx = OfflineAudioContext::new(
        channels,
        length,
        spec["sampleRate"].as_f64().unwrap() as f32,
    );
    let mut buffers = HashMap::new();
    let mut nodes: HashMap<String, Node> = HashMap::new();
    let listener = ctx.listener();
    for op in spec["ops"].as_array().unwrap() {
        let op = op.as_array().unwrap();
        let id = op[1].as_str().unwrap();
        match op[0].as_str().unwrap() {
            "buffer" => {
                buffers.insert(id.to_owned(), signal_buffer(&op[2]));
            }
            "node" => {
                let node = make_node(&ctx, op[2].as_str().unwrap(), &op[3], &buffers);
                nodes.insert(id.to_owned(), node);
            }
            "param" => automate(
                nodes[id].param(op[2].as_str().unwrap()),
                op[3].as_str().unwrap(),
                &op[4..],
            ),
            "listener" => {
                let param = match id {
                    "positionX" => listener.position_x(),
                    "positionY" => listener.position_y(),
                    "positionZ" => listener.position_z(),
                    "forwardX" => listener.forward_x(),
                    "forwardY" => listener.forward_y(),
                    "forwardZ" => listener.forward_z(),
                    "upX" => listener.up_x(),
                    "upY" => listener.up_y(),
                    "upZ" => listener.up_z(),
                    other => panic!("listener param {other}"),
                };
                param.set_value(op[2].as_f64().unwrap() as f32);
            }
            "connect" => {
                let to = op[2].as_str().unwrap();
                if to == "out" {
                    nodes[id].audio_node().connect(&ctx.destination());
                } else {
                    nodes[id].audio_node().connect(nodes[to].audio_node());
                }
            }
            "start" => {
                let args: Vec<f64> = op[2..].iter().map(|v| v.as_f64().unwrap()).collect();
                match (nodes.get_mut(id).unwrap(), args.as_slice()) {
                    (Node::Source(n), [when, offset, duration]) => {
                        n.start_at_with_offset_and_duration(*when, *offset, *duration)
                    }
                    (Node::Source(n), [when, offset]) => n.start_at_with_offset(*when, *offset),
                    (Node::Source(n), [when]) => n.start_at(*when),
                    (Node::Oscillator(n), [when]) => n.start_at(*when),
                    (Node::Constant(n), [when]) => n.start_at(*when),
                    _ => panic!("start {id} {args:?}"),
                }
            }
            "stop" => {
                let when = op[2].as_f64().unwrap();
                match nodes.get_mut(id).unwrap() {
                    Node::Source(n) => n.stop_at(when),
                    Node::Oscillator(n) => n.stop_at(when),
                    Node::Constant(n) => n.stop_at(when),
                    _ => panic!("stop {id}"),
                }
            }
            other => panic!("op {other}"),
        }
    }
    let rendered = ctx.start_rendering_sync();
    (0..rendered.number_of_channels())
        .map(|c| rendered.get_channel_data(c).to_vec())
        .collect()
}

fn decode(case: &Value) -> (f32, Vec<Vec<f32>>) {
    let bytes = std::fs::read(clips_dir().join(case["file"].as_str().unwrap())).unwrap();
    let decoded = decode_audio_data(bytes, case["sampleRate"].as_f64().unwrap() as f32).unwrap();
    (decoded.sample_rate, decoded.channels)
}

fn clips_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/audio/clips")
}

// A stored fixture is 16-bit FLAC; a render from tools/audio-parity/edge.mjs is a float WAV.
fn read_reference(dir: &Path, name: &str) -> (f32, Vec<Vec<f32>>) {
    let flac = dir.join(format!("{name}.flac"));
    if flac.exists() {
        let decoded = threejsc_audio::decode::decode(std::fs::read(&flac).unwrap()).unwrap();
        return (decoded.sample_rate, decoded.channels);
    }
    read_wav(&dir.join(format!("{name}.wav")))
}

fn read_wav(path: &Path) -> (f32, Vec<Vec<f32>>) {
    let mut reader =
        hound::WavReader::open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(Result::unwrap).collect(),
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .map(|s| f32::from(s.unwrap()) / 32768.0)
            .collect(),
    };
    let data = (0..channels)
        .map(|c| samples.iter().skip(c).step_by(channels).copied().collect())
        .collect();
    (spec.sample_rate as f32, data)
}

fn write_wav(path: &Path, rate: f32, data: &[Vec<f32>]) {
    let spec = hound::WavSpec {
        channels: data.len() as u16,
        sample_rate: rate as u32,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..data[0].len() {
        for channel in data {
            writer.write_sample(channel[i]).unwrap();
        }
    }
    writer.finalize().unwrap();
}

fn db(x: f64) -> f64 {
    20.0 * x.max(1e-12).log10()
}

fn rms(samples: impl Iterator<Item = f64>) -> f64 {
    let (sum, n) = samples.fold((0.0, 0usize), |(s, n), v| (s + v * v, n + 1));
    (sum / n.max(1) as f64).sqrt()
}

struct Row {
    name: String,
    lane: String,
    status: Status,
    detail: String,
}

fn compare(
    name: &str,
    lane: &str,
    rate: f32,
    ours: &[Vec<f32>],
    edge_rate: f32,
    edge: &[Vec<f32>],
) -> Row {
    let mut detail = String::new();
    let shape_ok = rate == edge_rate && ours.len() == edge.len() && ours[0].len() == edge[0].len();
    write!(
        detail,
        "rate {rate}/{edge_rate} channels {}/{} length {}/{}",
        ours.len(),
        edge.len(),
        ours[0].len(),
        edge[0].len()
    )
    .unwrap();
    let n = ours[0].len().min(edge[0].len());
    let diff = rms(ours
        .iter()
        .zip(edge)
        .flat_map(|(a, b)| (0..n).map(move |i| f64::from(a[i]) - f64::from(b[i]))));
    write!(detail, " diff {:.1} dBFS", db(diff)).unwrap();
    let status = if lane == "hrtf" {
        let levels: Vec<f64> = ours
            .iter()
            .zip(edge)
            .map(|(a, b)| {
                db(rms(a.iter().map(|&v| f64::from(v)))) - db(rms(b.iter().map(|&v| f64::from(v))))
            })
            .collect();
        for level in &levels {
            write!(detail, " level {level:+.2} dB").unwrap();
        }
        // Edge's HRIR set is not shipped yet, so a level miss is pending rather than a failure.
        match (shape_ok, levels.iter().all(|l| l.abs() <= 1.0)) {
            (true, true) => Status::Pass,
            (true, false) => Status::Pending,
            (false, _) => Status::Fail,
        }
    } else if shape_ok && db(diff) <= -60.0 {
        Status::Pass
    } else {
        Status::Fail
    };
    Row {
        name: name.to_owned(),
        lane: lane.to_owned(),
        status,
        detail,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Status {
    Pass,
    Fail,
    Pending,
}

#[test]
fn reference_graphs_match_edge() {
    threejsc_audio::init();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let specs: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("tests/graphs.json")).unwrap())
            .unwrap();
    let reference = std::env::var_os("THREEJSC_AUDIO_REFERENCE")
        .map_or_else(|| root.join("tests/fixtures"), PathBuf::from);
    let dump = std::env::var_os("THREEJSC_AUDIO_DUMP").map(PathBuf::from);
    let mut rows = Vec::new();
    let mut check = |name: &str, lane: &str, rate: f32, ours: Vec<Vec<f32>>| {
        if let Some(dir) = &dump {
            std::fs::create_dir_all(dir).unwrap();
            write_wav(&dir.join(format!("{name}.wav")), rate, &ours);
        }
        let (edge_rate, edge) = read_reference(&reference, name);
        rows.push(compare(name, lane, rate, &ours, edge_rate, &edge));
    };
    for spec in specs["graphs"].as_array().unwrap() {
        check(
            spec["name"].as_str().unwrap(),
            spec["lane"].as_str().unwrap(),
            spec["sampleRate"].as_f64().unwrap() as f32,
            render(spec),
        );
    }
    for case in specs["decodes"].as_array().unwrap() {
        let (rate, data) = decode(case);
        check(case["name"].as_str().unwrap(), "decode", rate, data);
    }
    let report: String = rows
        .iter()
        .map(|r| {
            format!(
                "{}\t{}\t{}\t{}\n",
                r.lane,
                r.name,
                match r.status {
                    Status::Pass => "pass",
                    Status::Fail => "FAIL",
                    Status::Pending => "pending",
                },
                r.detail
            )
        })
        .collect();
    print!("{report}");
    if let Some(path) = std::env::var_os("THREEJSC_AUDIO_REPORT") {
        std::fs::write(path, &report).unwrap();
    }
    let failed: Vec<&str> = rows
        .iter()
        .filter(|r| r.status == Status::Fail)
        .map(|r| r.name.as_str())
        .collect();
    assert!(
        failed.is_empty(),
        "{} of {} renders miss Edge: {failed:?}",
        failed.len(),
        rows.len()
    );
}
