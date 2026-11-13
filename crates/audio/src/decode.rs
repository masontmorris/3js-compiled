//! `decodeAudioData` as Edge does it: decode at the file's rate, trim as Chromium's FFmpeg path does, then resample
//! with Chromium's resampler.

use std::io::Cursor;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::audio::well_known::CODEC_ID_VORBIS;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::resample::resample;

/// Planar samples at one rate.
#[derive(Debug, Clone, PartialEq)]
pub struct Decoded {
    pub sample_rate: f32,
    pub channels: Vec<Vec<f32>>,
}

/// Why a file did not decode. Edge rejects every such file with an `EncodingError`.
#[derive(Debug)]
pub struct DecodeError(pub String);

/// Decodes a whole file at its own rate.
pub fn decode(bytes: Vec<u8>) -> Result<Decoded, DecodeError> {
    let fail = |e: Error| DecodeError(e.to_string());
    let stream = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(
            &Hint::new(),
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(fail)?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| DecodeError("no audio track".into()))?;
    let track_id = track.id;
    let delay = track.delay.unwrap_or(0) as usize;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| DecodeError("no audio track".into()))?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(fail)?;

    let mut sample_rate = params.sample_rate;
    let mut channels: Vec<Vec<f32>> = Vec::new();
    let mut last_packet_frames = 0;
    let mut planes = Vec::new();
    // Like Chromium, keep what decoded before a broken packet or a read error rather than fail the whole file.
    while let Ok(Some(packet)) = format.next_packet() {
        if packet.track_id != track_id {
            continue;
        }
        let Ok(buffer) = decoder.decode(&packet) else {
            continue;
        };
        let rate = buffer.spec().rate();
        if sample_rate.is_some_and(|r| r != rate)
            || (!channels.is_empty() && channels.len() != buffer.spec().channels().count())
        {
            break;
        }
        sample_rate = Some(rate);
        buffer.copy_to_vecs_planar::<f32>(&mut planes);
        if channels.is_empty() {
            channels = vec![Vec::new(); planes.len()];
        }
        for (channel, plane) in channels.iter_mut().zip(&planes) {
            channel.extend_from_slice(plane);
        }
        last_packet_frames = buffer.frames();
    }
    let sample_rate = sample_rate.ok_or_else(|| DecodeError("no sample rate".into()))?;
    if channels.first().is_none_or(Vec::is_empty) {
        return Err(DecodeError("no audio frames".into()));
    }
    if params.codec == CODEC_ID_VORBIS {
        // FFmpeg's Ogg demuxer adds the decoder delay to the end skip it reports for the last packet, and Chromium
        // trims that from the last decoded buffer, or drops the buffer when the skip is longer. So Edge ends a
        // Vorbis file min(delay, last packet's frames) early.
        let cut = delay.min(last_packet_frames);
        for channel in &mut channels {
            channel.truncate(channel.len() - cut);
        }
    }
    Ok(Decoded {
        sample_rate: sample_rate as f32,
        channels,
    })
}

/// Decodes a file into a context running at `context_rate`, as `BaseAudioContext.decodeAudioData` does.
pub fn decode_audio_data(bytes: Vec<u8>, context_rate: f32) -> Result<Decoded, DecodeError> {
    let decoded = decode(bytes)?;
    Ok(Decoded {
        sample_rate: context_rate,
        channels: resample(
            &decoded.channels,
            f64::from(decoded.sample_rate),
            f64::from(context_rate),
        ),
    })
}
