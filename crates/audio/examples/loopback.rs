//! Records what an output device plays, through WASAPI loopback, as a 32-bit float WAV. It never plays anything.
//! `cargo run -p threejsc-audio --features output --example loopback -- "<device name>" <seconds> <out.wav>`
//! A `stop` line on stdin ends the recording early.

use std::io::BufRead;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [name, seconds, out] = args.as_slice() else {
        return Err("usage: loopback <device name> <seconds> <out.wav>".into());
    };
    let host = cpal::default_host();
    let names: Vec<String> = host
        .output_devices()?
        .filter_map(|d| d.description().ok().map(|n| n.name().to_owned()))
        .collect();
    let device = host
        .output_devices()?
        .find(|d| d.description().is_ok_and(|n| n.name() == name))
        .ok_or_else(|| format!("no output device named {name:?}; the outputs are {names:?}"))?;
    let config = device.default_output_config()?;
    let channels = config.channels();
    let rate = config.sample_rate();
    let spec = hound::WavSpec {
        channels,
        sample_rate: rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let writer = Arc::new(Mutex::new(Some(hound::WavWriter::create(out, spec)?)));
    let sink = Arc::clone(&writer);
    let stream = device.build_input_stream(
        config.into(),
        move |data: &[f32], _| {
            if let Some(writer) = sink.lock().unwrap().as_mut() {
                for &sample in data {
                    let _ = writer.write_sample(sample);
                }
            }
        },
        |error| eprintln!("loopback: {error}"),
        None,
    )?;
    stream.play()?;
    let duration = Duration::from_secs_f64(seconds.parse()?);
    let deadline = Instant::now() + duration;
    let (stop, stopped) = mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            if line.is_ok_and(|line| line.trim() == "stop") {
                stop.send(()).ok();
                return;
            }
        }
    });
    // Stdin closing without a stop line, as an ignored stdin does at once, leaves the full duration.
    if stopped.recv_timeout(duration) == Err(RecvTimeoutError::Disconnected) {
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
    }
    drop(stream);
    if let Some(writer) = writer.lock().unwrap().take() {
        writer.finalize()?;
    }
    println!(
        "loopback: recorded {seconds} s of {name:?} at {rate} Hz, {channels} channels, to {out}"
    );
    Ok(())
}
