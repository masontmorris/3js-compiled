//! Output devices: `--audio-device <name>`, and following the system's default device as it changes.

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use web_audio_api::context::AudioContext;
use web_audio_api::media_devices::{MediaDeviceInfoKind, enumerate_devices_sync};

/// The engine's sink id for the output device named `name`, or `"none"`, which renders with no device at all. The name
/// is the one Windows shows, such as `Speakers (Steam Streaming Speakers)`, or the engine's whole label, which adds
/// the device type and interface. A name that matches no output, or several, is an error.
pub fn sink_for(name: &str) -> Result<String, String> {
    if name == "none" {
        return Ok("none".into());
    }
    let outputs: Vec<_> = enumerate_devices_sync()
        .into_iter()
        .filter(|d| d.kind() == MediaDeviceInfoKind::AudioOutput)
        .collect();
    let names = |label: &str| {
        label == name
            || label
                .strip_prefix(name)
                .is_some_and(|rest| rest.starts_with(" [") || rest.starts_with(" via "))
    };
    let matches: Vec<_> = outputs.iter().filter(|d| names(d.label())).collect();
    match matches.as_slice() {
        [device] => Ok(device.device_id().to_owned()),
        _ => {
            let labels: Vec<_> = outputs.iter().map(|d| format!("{:?}", d.label())).collect();
            Err(format!(
                "{} audio outputs match {name:?}, not one; the outputs are {}",
                matches.len(),
                labels.join(", ")
            ))
        }
    }
}

fn default_output() -> Option<String> {
    cpal::default_host()
        .default_output_device()?
        .description()
        .ok()
        .map(|d| d.to_string())
}

/// The online contexts that play through the default device, which a follower moves when the default changes.
pub type Followed = Arc<Mutex<Vec<Weak<AudioContext>>>>;

/// Polls the default output device every `period` and moves every followed context to a new default. `log` gets one
/// line per move, and one per failure until the default changes again. A default whose move failed for any context is
/// retried each poll for the contexts not yet on it.
pub fn follow_default(period: Duration, log: impl Fn(String) + Send + 'static) -> Followed {
    let followed: Followed = Arc::default();
    let contexts = Arc::downgrade(&followed);
    std::thread::Builder::new()
        .name("audio-default-device".into())
        .spawn(move || {
            let mut applied = default_output();
            let mut reported = None;
            loop {
                std::thread::sleep(period);
                let Some(contexts) = contexts.upgrade() else {
                    return;
                };
                let next = default_output();
                if next == applied || next.is_none() {
                    continue;
                }
                let report = reported != next;
                reported.clone_from(&next);
                let label = next.clone().unwrap_or_default();
                let Ok(sink) = sink_for(&label) else {
                    if report {
                        log(format!(
                            "audio: the default output changed to {label:?}, which has no sink id"
                        ));
                    }
                    continue;
                };
                // A move can wait seconds on a stopped stream, so the list is not held while contexts register.
                let targets: Vec<_> = {
                    let mut contexts = contexts.lock().unwrap();
                    contexts.retain(|c| c.strong_count() > 0);
                    contexts.iter().filter_map(Weak::upgrade).collect()
                };
                let mut moved = true;
                for context in targets.iter().filter(|c| c.sink_id() != sink) {
                    match context.set_sink_id_sync(sink.clone()) {
                        Ok(()) => log(format!(
                            "audio: moved a context to the new default output {label:?}"
                        )),
                        Err(e) => {
                            moved = false;
                            if report {
                                log(format!(
                                    "audio: could not move a context to the new default output {label:?}: {e}"
                                ));
                            }
                        }
                    }
                }
                if moved {
                    applied = next;
                }
            }
        })
        .expect("spawn the default device thread");
    followed
}
