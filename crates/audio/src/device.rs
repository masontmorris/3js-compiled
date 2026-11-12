//! Output devices: `--audio-device <name>`, and following the system's default device as it changes.

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use web_audio_api::context::AudioContext;
use web_audio_api::media_devices::{MediaDeviceInfoKind, enumerate_devices_sync};

/// The engine's sink id for the output device named `name`, or `"none"`, which renders with no device at all.
pub fn sink_for(name: &str) -> Result<String, String> {
    if name == "none" {
        return Ok("none".into());
    }
    let outputs: Vec<_> = enumerate_devices_sync()
        .into_iter()
        .filter(|d| d.kind() == MediaDeviceInfoKind::AudioOutput)
        .collect();
    outputs
        .iter()
        .find(|d| d.label() == name)
        .map(|d| d.device_id().to_owned())
        .ok_or_else(|| {
            let labels: Vec<_> = outputs.iter().map(|d| format!("{:?}", d.label())).collect();
            format!(
                "no audio output named {name:?}; the outputs are {}",
                labels.join(", ")
            )
        })
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
/// line per move.
pub fn follow_default(period: Duration, log: impl Fn(String) + Send + 'static) -> Followed {
    let followed: Followed = Arc::default();
    let contexts = Arc::downgrade(&followed);
    std::thread::Builder::new()
        .name("audio-default-device".into())
        .spawn(move || {
            let mut current = default_output();
            loop {
                std::thread::sleep(period);
                let Some(contexts) = contexts.upgrade() else {
                    return;
                };
                let next = default_output();
                if next == current || next.is_none() {
                    continue;
                }
                current = next;
                let label = current.clone().unwrap_or_default();
                let Ok(sink) = sink_for(&label) else {
                    log(format!(
                        "audio: the default output changed to {label:?}, which has no sink id"
                    ));
                    continue;
                };
                let mut contexts = contexts.lock().unwrap();
                contexts.retain(|c| c.strong_count() > 0);
                for context in contexts.iter().filter_map(Weak::upgrade) {
                    let result = context.set_sink_id_sync(sink.clone());
                    log(format!(
                        "audio: moved a context to the new default output {label:?}: {result:?}"
                    ));
                }
            }
        })
        .expect("spawn the default device thread");
    followed
}
