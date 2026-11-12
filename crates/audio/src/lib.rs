//! Web Audio for the native host, on web-audio-api-rs.

pub mod decode;
#[cfg(feature = "output")]
pub mod device;
pub mod graph;
pub mod record;
mod resample;

pub use web_audio_api;

/// The HRIR sphere every HRTF panner uses, in the `hrtf` crate's format. Replacing `hrir/sphere.bin` swaps the set,
/// with no code change. It is IRCAM LISTEN subject 1003, the set web-audio-api-rs bundles.
pub static HRIR_SPHERE: &[u8] = include_bytes!("../hrir/sphere.bin");

/// Points the engine at `HRIR_SPHERE`. Call it before the first context.
pub fn init() {
    web_audio_api::node::set_hrir_sphere(HRIR_SPHERE);
}
