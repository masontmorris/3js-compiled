//! Chromium's sample-rate conversion for `decodeAudioData`.
//!
//! A port of `media::SincResampler` from `media/base/sinc_resampler.h` and `media/base/sinc_resampler.cc`, and of
//! `blink::AudioBus::TryCreateBySampleRateConverting` from `third_party/blink/renderer/platform/audio/audio_bus.cc`,
//! at chromium/chromium 09931c1f02320a1b1175af4f338c992c02342f89. Only the scalar `Convolve_C` path and the
//! 64-frame request size that `AudioBus` passes, which selects the 32-tap kernel, are ported.
//!
//! Copyright 2012 The Chromium Authors. Used under the BSD-3-Clause license in `LICENSE-CHROMIUM`.

use std::f64::consts::PI;

const KERNEL_SIZE: usize = 32;
const KERNEL_OFFSET_COUNT: usize = 32;
const REQUEST_FRAMES: usize = 64;

/// Converts each channel from `from` Hz to `to` Hz with Chromium's output length, `(int)(length / (from / to))`.
pub fn resample(channels: &[Vec<f32>], from: f64, to: f64) -> Vec<Vec<f32>> {
    #[allow(clippy::float_cmp)]
    if from == to {
        return channels.to_vec();
    }
    let ratio = from / to;
    let length = channels
        .first()
        .map_or(0, |c| (c.len() as f64 / ratio) as usize);
    channels
        .iter()
        .map(|source| {
            let mut out = vec![0.; length];
            SincResampler::new(ratio, source).resample(&mut out);
            out
        })
        .collect()
}

struct SincResampler<'a> {
    ratio: f64,
    kernel: Vec<f32>,
    input: [f32; REQUEST_FRAMES + KERNEL_SIZE],
    virtual_source_idx: f64,
    primed: bool,
    r0: usize,
    r3: usize,
    block_size: usize,
    source: &'a [f32],
}

// r1 starts the input buffer and r2 is half a kernel in, as in Chromium.
const R1: usize = 0;
const R2: usize = KERNEL_SIZE / 2;

impl<'a> SincResampler<'a> {
    fn new(ratio: f64, source: &'a [f32]) -> Self {
        let mut resampler = Self {
            ratio,
            kernel: kernel(ratio),
            input: [0.; REQUEST_FRAMES + KERNEL_SIZE],
            virtual_source_idx: 0.,
            primed: false,
            r0: 0,
            r3: 0,
            block_size: 0,
            source,
        };
        resampler.update_regions(false);
        resampler
    }

    fn update_regions(&mut self, second_load: bool) {
        self.r0 = if second_load {
            KERNEL_SIZE
        } else {
            KERNEL_SIZE / 2
        };
        self.r3 = self.r0 + REQUEST_FRAMES - KERNEL_SIZE;
        let r4 = self.r0 + REQUEST_FRAMES - KERNEL_SIZE / 2;
        self.block_size = r4 - R2;
    }

    // AudioBus's read callback: copy what is left of the source, then zeros.
    fn read(&mut self) {
        let destination = &mut self.input[self.r0..self.r0 + REQUEST_FRAMES];
        let count = self.source.len().min(REQUEST_FRAMES);
        destination[..count].copy_from_slice(&self.source[..count]);
        destination[count..].fill(0.);
        self.source = &self.source[count..];
    }

    fn resample(&mut self, destination: &mut [f32]) {
        let mut remaining = destination.len();
        if !self.primed && remaining > 0 {
            self.read();
            self.primed = true;
        }
        let mut out = destination.iter_mut();
        while remaining > 0 {
            while self.virtual_source_idx < self.block_size as f64 {
                let source_idx = self.virtual_source_idx as usize;
                let virtual_offset_idx =
                    (self.virtual_source_idx - source_idx as f64) * KERNEL_OFFSET_COUNT as f64;
                let offset_idx = virtual_offset_idx as usize;
                let k1 = &self.kernel[offset_idx * KERNEL_SIZE..][..KERNEL_SIZE];
                let k2 = &self.kernel[(offset_idx + 1) * KERNEL_SIZE..][..KERNEL_SIZE];
                let input = &self.input[R1 + source_idx..][..KERNEL_SIZE];
                *out.next().unwrap() =
                    convolve(input, k1, k2, virtual_offset_idx - offset_idx as f64);
                self.virtual_source_idx += self.ratio;
                remaining -= 1;
                if remaining == 0 {
                    return;
                }
            }
            self.virtual_source_idx -= self.block_size as f64;
            self.input.copy_within(self.r3..self.r3 + KERNEL_SIZE, R1);
            if self.r0 == R2 {
                self.update_regions(true);
            }
            self.read();
        }
    }
}

fn convolve(input: &[f32], k1: &[f32], k2: &[f32], factor: f64) -> f32 {
    let mut sum1 = 0f32;
    let mut sum2 = 0f32;
    for i in 0..input.len() {
        sum1 += input[i] * k1[i];
        sum2 += input[i] * k2[i];
    }
    ((1. - factor) * f64::from(sum1) + factor * f64::from(sum2)) as f32
}

// Windowed sinc kernels at KERNEL_OFFSET_COUNT + 1 sub-sample offsets, with Chromium's mix of f32 and f64 steps.
fn kernel(ratio: f64) -> Vec<f32> {
    const ALPHA: f64 = 0.16;
    const A0: f64 = 0.5 * (1. - ALPHA);
    const A1: f64 = 0.5;
    const A2: f64 = 0.5 * ALPHA;
    let scale = (if ratio > 1. { 1. / ratio } else { 1. }) * 0.90;
    let size = KERNEL_SIZE as i32;
    let mut kernel = vec![0f32; KERNEL_SIZE * (KERNEL_OFFSET_COUNT + 1)];
    for offset_idx in 0..=KERNEL_OFFSET_COUNT {
        let subsample_offset = offset_idx as f32 / KERNEL_OFFSET_COUNT as f32;
        for i in 0..size {
            let pre_sinc = std::f32::consts::PI * ((i - size / 2) as f32 - subsample_offset);
            let x = (i as f32 - subsample_offset) / size as f32;
            let window = (A0 - A1 * (2. * PI * f64::from(x)).cos()
                + A2 * (4. * PI * f64::from(x)).cos()) as f32;
            let sinc = if pre_sinc == 0. {
                scale
            } else {
                (scale * f64::from(pre_sinc)).sin() / f64::from(pre_sinc)
            };
            kernel[i as usize + offset_idx * KERNEL_SIZE] = (f64::from(window) * sinc) as f32;
        }
    }
    kernel
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_follows_chromium() {
        let one = |n: usize| vec![vec![0.5f32; n]];
        assert_eq!(resample(&one(24000), 48000., 44100.)[0].len(), 22049);
        assert_eq!(resample(&one(11025), 22050., 48000.)[0].len(), 24000);
        assert_eq!(resample(&one(100), 48000., 48000.)[0].len(), 100);
    }
}
