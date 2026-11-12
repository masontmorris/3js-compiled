//! Web Audio for the native host, on web-audio-api-rs.

pub mod decode;
#[cfg(feature = "output")]
pub mod device;
pub mod graph;
pub mod record;
mod resample;

pub use web_audio_api;

/// Chromium's composite IRCAM responses, the HRTF set Edge uses. Replacing `hrir/chromium/Composite.flac` swaps the
/// set, with no code change. `hrir/chromium/NOTICE` gives its source, acknowledgement and terms.
pub static HRTF_RESPONSES: &[u8] = include_bytes!("../hrir/chromium/Composite.flac");

/// Hands the engine Chromium's HRTF responses, so every HRTF panner renders as Edge's does. Call it before the first
/// context.
pub fn init() {
    web_audio_api::node::set_hrtf_responses(hrtf_responses);
}

/// The 240 composite responses, each converted from 44.1 kHz to `sample_rate` on its own with Chromium's
/// resampler, as Chromium's HRTFElevation loads them.
fn hrtf_responses(sample_rate: f32) -> Option<web_audio_api::node::HrtfResponses> {
    const RESPONSES: usize = 240;
    let decoded = decode::decode(HRTF_RESPONSES.to_vec()).ok()?;
    let [left, right] = decoded.channels.as_slice() else {
        return None;
    };
    let length = left.len() / RESPONSES;
    let convert = |samples: &[f32]| -> Vec<f32> {
        samples
            .chunks_exact(length)
            .flat_map(|response| {
                resample::resample(
                    &[response.to_vec()],
                    f64::from(decoded.sample_rate),
                    f64::from(sample_rate),
                )
                .remove(0)
            })
            .collect()
    };
    let left = convert(left);
    let right = convert(right);
    Some(web_audio_api::node::HrtfResponses {
        response_length: left.len() / RESPONSES,
        left,
        right,
    })
}
