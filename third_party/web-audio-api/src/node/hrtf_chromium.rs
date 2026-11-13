//! HRTF panning as Chromium does it.
//!
//! A port of `hrtf_panner.cc`, `hrtf_database.cc`, `hrtf_elevation.cc`, `hrtf_kernel.cc`, `fft_frame.cc`,
//! `fft_convolver.cc` and `delay.cc` from `third_party/blink/renderer/platform/audio` at chromium/chromium
//! 09931c1f02320a1b1175af4f338c992c02342f89. Copyright 2010 Google Inc. and The Chromium Authors, under the
//! BSD-3-Clause license those files carry.
//!
//! The embedder supplies the 240 composite IRCAM responses through [`set_hrtf_responses`]. Each response becomes a
//! kernel with its average group delay taken out; 7 kernels are interpolated between each pair of the 24 measured
//! azimuths; an elevation picks the measured one at or below it; and a panner convolves with the kernel of its
//! azimuth, delays each ear by the kernel's group delay, and crossfades over 2048 frames when the kernel changes.

use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::{Arc, Mutex, OnceLock};

use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

use crate::RENDER_QUANTUM_SIZE;

/// The composite IRCAM responses at one sample rate: 240 stereo responses of `response_length` frames each, for
/// each azimuth from 0 to 345 degrees in steps of 15, the elevations 0, 15, 30, 45, 60, 75, 90, 315, 330 and 345.
#[derive(Clone, Debug)]
pub struct HrtfResponses {
    pub response_length: usize,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

type Loader = Box<dyn Fn(f32) -> Option<HrtfResponses> + Send + Sync>;
static LOADER: OnceLock<Loader> = OnceLock::new();
static DATABASES: OnceLock<Mutex<HashMap<u32, Arc<Database>>>> = OnceLock::new();

/// Gives every HRTF `PannerNode` created afterwards Chromium's HRTF panning, with the responses `load` returns for a
/// context's sample rate. It returns `false`, and changes nothing, when a loader was already set.
pub fn set_hrtf_responses(
    load: impl Fn(f32) -> Option<HrtfResponses> + Send + Sync + 'static,
) -> bool {
    LOADER.set(Box::new(load)).is_ok()
}

pub(crate) fn database(sample_rate: f32) -> Option<Arc<Database>> {
    let load = LOADER.get()?;
    let cache = DATABASES.get_or_init(Mutex::default);
    let key = sample_rate.to_bits();
    if let Some(database) = cache.lock().unwrap().get(&key) {
        return Some(Arc::clone(database));
    }
    let database = Arc::new(Database::new(&load(sample_rate)?, sample_rate));
    cache.lock().unwrap().insert(key, Arc::clone(&database));
    Some(database)
}

const AZIMUTH_SPACING: usize = 15;
const RAW_AZIMUTHS: usize = 360 / AZIMUTH_SPACING;
const AZIMUTH_INTERPOLATION: usize = 8;
const AZIMUTHS: usize = RAW_AZIMUTHS * AZIMUTH_INTERPOLATION;
const FILE_ELEVATIONS: [i32; 10] = [0, 15, 30, 45, 60, 75, 90, 315, 330, 345];
const MIN_ELEVATION: i32 = -45;
const MAX_ELEVATION: i32 = 90;
const ELEVATION_SPACING: i32 = 15;
const MAX_ELEVATIONS: [i32; RAW_AZIMUTHS] = [
    90, 45, 60, 45, 75, 45, 60, 45, 75, 45, 60, 45, 75, 45, 60, 45, 75, 45, 60, 45, 75, 45, 60, 45,
];
const MAX_DELAY_SECONDS: f64 = 0.002;

/// HRTFPanner::FftSizeForSampleRate: twice the largest power of two in a 256-frame response at the new rate.
pub(crate) fn fft_size_for(sample_rate: f32) -> usize {
    let resampled = 256. * f64::from(sample_rate) / 44100.;
    let analysis = (1usize << (resampled.log2() as u32)).max(32);
    2 * analysis
}

/// A spectrum in FFTFrame's packed layout: `real[0]` holds the DC term, `imag[0]` the Nyquist term.
#[derive(Clone, Debug)]
struct Packed {
    real: Vec<f32>,
    imag: Vec<f32>,
}

fn fft(input: &[f32], size: usize) -> Packed {
    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(size);
    let mut buffer = vec![0f32; size];
    buffer[..input.len().min(size)].copy_from_slice(&input[..input.len().min(size)]);
    let mut spectrum = forward.make_output_vec();
    forward.process(&mut buffer, &mut spectrum).unwrap();
    let half = size / 2;
    let mut real: Vec<f32> = spectrum[..half].iter().map(|c| c.re).collect();
    let mut imag: Vec<f32> = spectrum[..half].iter().map(|c| c.im).collect();
    real[0] = spectrum[0].re;
    imag[0] = spectrum[half].re;
    Packed { real, imag }
}

fn inverse_fft(packed: &Packed) -> Vec<f32> {
    let half = packed.real.len();
    let size = 2 * half;
    let mut planner = RealFftPlanner::<f32>::new();
    let inverse = planner.plan_fft_inverse(size);
    let mut spectrum: Vec<Complex<f32>> = (0..=half)
        .map(|k| match k {
            0 => Complex::new(packed.real[0], 0.),
            k if k == half => Complex::new(packed.imag[0], 0.),
            k => Complex::new(packed.real[k], packed.imag[k]),
        })
        .collect();
    let mut out = inverse.make_output_vec();
    inverse.process(&mut spectrum, &mut out).unwrap();
    out.iter_mut().for_each(|x| *x /= size as f32);
    out
}

/// FFTFrame::ExtractAverageGroupDelay: removes the response's average group delay, less 20 frames of headroom, and
/// answers it.
fn extract_average_group_delay(packed: &mut Packed) -> f64 {
    let size = 2 * packed.real.len();
    let sample_phase_delay = 2. * PI / size as f64;
    let (mut sum, mut weights, mut last) = (0., 0., 0.);
    for i in 0..packed.real.len() {
        let c = Complex::new(f64::from(packed.real[i]), f64::from(packed.imag[i]));
        let (mag, phase) = (c.norm(), c.arg());
        let mut delta = phase - last;
        last = phase;
        if delta < -PI {
            delta += 2. * PI;
        }
        if delta > PI {
            delta -= 2. * PI;
        }
        sum += mag * delta;
        weights += mag;
    }
    let mut delay = -(sum / weights) / sample_phase_delay;
    if delay > 20. {
        delay -= 20.;
    }
    add_constant_group_delay(packed, -delay);
    packed.real[0] = 0.;
    delay
}

fn add_constant_group_delay(packed: &mut Packed, frames: f64) {
    let size = 2 * packed.real.len();
    let adjust = -frames * 2. * PI / size as f64;
    for i in 1..packed.real.len() {
        let c = Complex::new(f64::from(packed.real[i]), f64::from(packed.imag[i]));
        let c = Complex::from_polar(c.norm(), c.arg() + i as f64 * adjust);
        packed.real[i] = c.re as f32;
        packed.imag[i] = c.im as f32;
    }
}

/// FFTFrame::InterpolateFrequencyComponents: magnitudes blended in decibels, group delays blended per bin.
fn interpolate_frames(a: &Packed, b: &Packed, x: f64) -> Packed {
    let n = a.real.len();
    let (s1base, s2base) = (1. - x, x);
    let mut out = Packed {
        real: vec![0.; n],
        imag: vec![0.; n],
    };
    out.real[0] = (s1base * f64::from(a.real[0]) + s2base * f64::from(b.real[0])) as f32;
    out.imag[0] = (s1base * f64::from(a.imag[0]) + s2base * f64::from(b.imag[0])) as f32;
    let (mut accum, mut last1, mut last2) = (0f64, 0f64, 0f64);
    let wrap = |mut v: f64| {
        if v > PI {
            v -= 2. * PI;
        }
        if v < -PI {
            v += 2. * PI;
        }
        v
    };
    for i in 1..n {
        let c1 = Complex::new(f64::from(a.real[i]), f64::from(a.imag[i]));
        let c2 = Complex::new(f64::from(b.real[i]), f64::from(b.imag[i]));
        let db1 = 20. * c1.norm().log10();
        let db2 = 20. * c2.norm().log10();
        let (mut s1, mut s2) = (s1base, s2base);
        let diff = db1 - db2;
        let threshold = if i > 16 { 5. } else { 2. };
        if diff < -threshold && db1 < 0. {
            s1 = s1.powf(0.75);
            s2 = 1. - s1;
        } else if diff > threshold && db2 < 0. {
            s2 = s2.powf(0.75);
            s1 = 1. - s2;
        }
        let mag = 10f64.powf(0.05 * (s1 * db1 + s2 * db2));
        let (phase1, phase2) = (c1.arg(), c2.arg());
        let delta1 = wrap(phase1 - last1);
        let delta2 = wrap(phase2 - last2);
        last1 = phase1;
        last2 = phase2;
        let blend = if delta1 - delta2 > PI {
            s1 * delta1 + s2 * (2. * PI + delta2)
        } else if delta2 - delta1 > PI {
            s1 * (2. * PI + delta1) + s2 * delta2
        } else {
            s1 * delta1 + s2 * delta2
        };
        accum = wrap(accum + blend);
        let c = Complex::from_polar(mag, accum);
        out.real[i] = c.re as f32;
        out.imag[i] = c.im as f32;
    }
    // FFTFrame::CreateInterpolatedFrame: zero the second half in time, to avoid circular aliasing.
    let mut time = inverse_fft(&out);
    let half = time.len() / 2;
    time[half..].fill(0.);
    fft(&time, time.len())
}

#[derive(Clone, Debug)]
pub(crate) struct Kernel {
    spectrum: Packed,
    /// The spectrum's bins from DC to Nyquist, for the convolver.
    bins: Vec<Complex<f32>>,
    delay: f64,
}

fn bins(packed: &Packed) -> Vec<Complex<f32>> {
    let half = packed.real.len();
    (0..=half)
        .map(|k| match k {
            0 => Complex::new(packed.real[0], 0.),
            k if k == half => Complex::new(packed.imag[0], 0.),
            k => Complex::new(packed.real[k], packed.imag[k]),
        })
        .collect()
}

impl Kernel {
    /// HRTFKernel's constructor, from a response at the context's rate.
    fn new(response: &[f32], fft_size: usize, sample_rate: f32) -> Self {
        let mut response = response.to_vec();
        if 2 * response.len() < fft_size {
            response.resize(fft_size / 2, 0.);
        }
        let analysis = fft_size / 2;
        let mut frame = fft(&response[..analysis], analysis);
        let delay = extract_average_group_delay(&mut frame);
        response[..analysis].copy_from_slice(&inverse_fft(&frame));
        let truncated = response.len().min(fft_size / 2);
        let fade = (sample_rate / 4410.) as usize;
        for i in truncated - fade..truncated {
            response[i] *= 1. - (i - (truncated - fade)) as f32 / fade as f32;
        }
        let spectrum = fft(&response[..truncated], fft_size);
        Self {
            bins: bins(&spectrum),
            spectrum,
            delay,
        }
    }

    fn interpolated(a: &Kernel, b: &Kernel, x: f32) -> Self {
        let x = x.clamp(0., 1.);
        let spectrum = interpolate_frames(&a.spectrum, &b.spectrum, f64::from(x));
        Self {
            bins: bins(&spectrum),
            spectrum,
            delay: a.delay + (b.delay - a.delay) * f64::from(x),
        }
    }
}

/// HRTFDatabase with its HRTFElevations: kernels for every elevation from -45 to 90 and 192 azimuths.
#[derive(Debug)]
pub(crate) struct Database {
    fft_size: usize,
    left: Vec<Vec<Kernel>>,
    right: Vec<Vec<Kernel>>,
}

impl Database {
    fn new(responses: &HrtfResponses, sample_rate: f32) -> Self {
        let fft_size = fft_size_for(sample_rate);
        let length = responses.response_length;
        let response = |samples: &[f32], azimuth: usize, elevation: i32| {
            let elevation = elevation.min(MAX_ELEVATIONS[azimuth]).rem_euclid(360);
            let index = FILE_ELEVATIONS
                .iter()
                .position(|&e| e == elevation)
                .unwrap();
            let start = (azimuth * FILE_ELEVATIONS.len() + index) * length;
            Kernel::new(&samples[start..start + length], fft_size, sample_rate)
        };
        let mut left = Vec::new();
        let mut right = Vec::new();
        for elevation in (MIN_ELEVATION..=MAX_ELEVATION).step_by(ELEVATION_SPACING as usize) {
            for (samples, list) in [(&responses.left, &mut left), (&responses.right, &mut right)] {
                let raw: Vec<Kernel> = (0..RAW_AZIMUTHS)
                    .map(|a| response(samples, a, elevation))
                    .collect();
                let mut kernels = Vec::with_capacity(AZIMUTHS);
                for (i, kernel) in raw.iter().enumerate() {
                    let next = &raw[(i + 1) % RAW_AZIMUTHS];
                    kernels.push(kernel.clone());
                    for j in 1..AZIMUTH_INTERPOLATION {
                        kernels.push(Kernel::interpolated(
                            kernel,
                            next,
                            j as f32 / AZIMUTH_INTERPOLATION as f32,
                        ));
                    }
                }
                list.push(kernels);
            }
        }
        Self {
            fft_size,
            left,
            right,
        }
    }

    /// HRTFDatabase::GetKernelsFromAzimuthElevation: the kernels at `azimuth_index`, with delays blended toward the
    /// next azimuth by `blend`.
    fn kernels(
        &self,
        blend: f64,
        azimuth_index: usize,
        elevation: f64,
    ) -> (&Kernel, &Kernel, f64, f64) {
        let elevation = elevation.clamp(f64::from(MIN_ELEVATION), f64::from(MAX_ELEVATION));
        let index = (((elevation - f64::from(MIN_ELEVATION)) / f64::from(ELEVATION_SPACING))
            as usize)
            .min(self.left.len() - 1);
        let (left, right) = (&self.left[index], &self.right[index]);
        let next = (azimuth_index + 1) % AZIMUTHS;
        let lerp = |a: f64, b: f64| a + (b - a) * blend;
        (
            &left[azimuth_index],
            &right[azimuth_index],
            lerp(left[azimuth_index].delay, left[next].delay),
            lerp(right[azimuth_index].delay, right[next].delay),
        )
    }
}

/// FFTConvolver: overlap-add in blocks of half the FFT size. It plans and allocates when made, so processing does
/// neither.
struct Convolver {
    forward: Arc<dyn RealToComplex<f32>>,
    inverse: Arc<dyn ComplexToReal<f32>>,
    input: Vec<f32>,
    time: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    output: Vec<f32>,
    overlap: Vec<f32>,
    index: usize,
}

impl std::fmt::Debug for Convolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Convolver")
            .field("fft_size", &self.input.len())
            .finish_non_exhaustive()
    }
}

impl Convolver {
    fn new(fft_size: usize) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let forward = planner.plan_fft_forward(fft_size);
        let inverse = planner.plan_fft_inverse(fft_size);
        let spectrum = forward.make_output_vec();
        Self {
            forward,
            inverse,
            input: vec![0.; fft_size],
            time: vec![0.; fft_size],
            spectrum,
            output: vec![0.; fft_size],
            overlap: vec![0.; fft_size / 2],
            index: 0,
        }
    }

    fn process(&mut self, kernel: &Kernel, source: &[f32], destination: &mut [f32]) {
        let size = self.input.len();
        let half = size / 2;
        let mut done = 0;
        while done < source.len() {
            let count = (source.len() - done).min(half - self.index);
            self.input[self.index..self.index + count].copy_from_slice(&source[done..done + count]);
            destination[done..done + count]
                .copy_from_slice(&self.output[self.index..self.index + count]);
            self.index += count;
            done += count;
            if self.index == half {
                self.time.copy_from_slice(&self.input);
                self.forward
                    .process(&mut self.time, &mut self.spectrum)
                    .unwrap();
                for (bin, k) in self.spectrum.iter_mut().zip(&kernel.bins) {
                    *bin *= k;
                }
                // A real signal's DC and Nyquist bins are real. A non-finite sample leaves NaN in their imaginary
                // parts, which the inverse rejects with an error.
                let last = self.spectrum.len() - 1;
                self.spectrum[0].im = 0.;
                self.spectrum[last].im = 0.;
                self.inverse
                    .process(&mut self.spectrum, &mut self.output)
                    .unwrap();
                let scale = 1. / size as f32;
                for i in 0..half {
                    self.output[i] = self.output[i] * scale + self.overlap[i];
                }
                for i in half..size {
                    self.output[i] *= scale;
                }
                self.overlap.copy_from_slice(&self.output[half..]);
                self.index = 0;
            }
        }
    }
}

/// Delay's k-rate path: one delay per quantum, read with linear interpolation.
#[derive(Debug)]
struct DelayLine {
    buffer: Vec<f32>,
    write: usize,
    frames: f64,
    max_frames: f64,
}

impl DelayLine {
    fn new(sample_rate: f32) -> Self {
        let max_frames = MAX_DELAY_SECONDS * f64::from(sample_rate);
        Self {
            buffer: vec![0.; RENDER_QUANTUM_SIZE + max_frames.ceil() as usize],
            write: 0,
            frames: 0.,
            max_frames,
        }
    }

    fn process(&mut self, source: &[f32], destination: &mut [f32]) {
        let length = self.buffer.len();
        let frames = self.frames.clamp(0., self.max_frames);
        let mut read = self.write as f64 + length as f64 - frames;
        if read >= length as f64 {
            read -= length as f64;
        }
        let read1 = read as usize;
        let fraction = (read - read1 as f64) as f32;
        for (i, &x) in source.iter().enumerate() {
            self.buffer[(self.write + i) % length] = x;
        }
        self.write = (self.write + source.len()) % length;
        for (i, out) in destination.iter_mut().enumerate() {
            let s1 = self.buffer[(read1 + i) % length];
            let s2 = self.buffer[(read1 + i + 1) % length];
            *out = if fraction == 0. {
                s1
            } else {
                s1 + fraction * (s2 - s1)
            };
        }
    }
}

/// HRTFPanner.
#[derive(Debug)]
pub(crate) struct ChromiumHrtf {
    database: Arc<Database>,
    sample_rate: f32,
    azimuth1: Option<usize>,
    azimuth2: Option<usize>,
    elevation1: f64,
    elevation2: f64,
    second: bool,
    crossfade_x: f32,
    crossfade_incr: f32,
    convolvers: [Convolver; 4],
    delays: [DelayLine; 2],
    delayed: [Vec<f32>; 2],
    temp: [Vec<f32>; 4],
}

impl ChromiumHrtf {
    pub(crate) fn new(database: Arc<Database>, sample_rate: f32) -> Self {
        let fft = database.fft_size;
        Self {
            database,
            sample_rate,
            azimuth1: None,
            azimuth2: None,
            elevation1: 0.,
            elevation2: 0.,
            second: false,
            crossfade_x: 0.,
            crossfade_incr: 0.,
            convolvers: [
                Convolver::new(fft),
                Convolver::new(fft),
                Convolver::new(fft),
                Convolver::new(fft),
            ],
            delays: [DelayLine::new(sample_rate), DelayLine::new(sample_rate)],
            delayed: [vec![0.; RENDER_QUANTUM_SIZE], vec![0.; RENDER_QUANTUM_SIZE]],
            temp: [
                vec![0.; RENDER_QUANTUM_SIZE],
                vec![0.; RENDER_QUANTUM_SIZE],
                vec![0.; RENDER_QUANTUM_SIZE],
                vec![0.; RENDER_QUANTUM_SIZE],
            ],
        }
    }

    /// The tail and the latency of the convolver and the delay line, in frames.
    pub(crate) fn tail_time_samples(&self) -> usize {
        (MAX_DELAY_SECONDS * f64::from(self.sample_rate)).ceil() as usize + self.database.fft_size
    }

    /// HRTFPanner::Pan for one quantum. `azimuth` is the panner's, positive to the right.
    pub(crate) fn pan(
        &mut self,
        desired_azimuth: f64,
        elevation: f64,
        source_l: &[f32],
        source_r: &[f32],
        out_l: &mut [f32],
        out_r: &mut [f32],
    ) {
        let mut azimuth = -desired_azimuth;
        if azimuth < 0. {
            azimuth += 360.;
        }
        let index_float = azimuth / (360. / AZIMUTHS as f64);
        let index = (index_float as usize).min(AZIMUTHS - 1);
        let blend = index_float - index_float.floor();
        if self.azimuth1.is_none() {
            self.azimuth1 = Some(index);
            self.elevation1 = elevation;
        }
        if self.azimuth2.is_none() {
            self.azimuth2 = Some(index);
            self.elevation2 = elevation;
        }
        let fade_frames: f32 = if self.sample_rate <= 48000. {
            2048.
        } else {
            4096.
        };
        if self.crossfade_x == 0.
            && !self.second
            && (Some(index) != self.azimuth1 || elevation != self.elevation1)
        {
            self.crossfade_incr = 1. / fade_frames;
            self.azimuth2 = Some(index);
            self.elevation2 = elevation;
        }
        if self.crossfade_x == 1.
            && self.second
            && (Some(index) != self.azimuth2 || elevation != self.elevation2)
        {
            self.crossfade_incr = -1. / fade_frames;
            self.azimuth1 = Some(index);
            self.elevation1 = elevation;
        }
        let database = Arc::clone(&self.database);
        let (kl1, kr1, dl1, dr1) = database.kernels(blend, self.azimuth1.unwrap(), self.elevation1);
        let (kl2, kr2, dl2, dr2) = database.kernels(blend, self.azimuth2.unwrap(), self.elevation2);
        let x = f64::from(self.crossfade_x);
        self.delays[0].frames = dl1 + (dl2 - dl1) * x;
        self.delays[1].frames = dr1 + (dr2 - dr1) * x;
        let [delayed_l, delayed_r] = &mut self.delayed;
        self.delays[0].process(source_l, delayed_l);
        self.delays[1].process(source_r, delayed_r);
        let crossfading = self.crossfade_incr != 0.;
        let [t1, t2, t3, t4] = &mut self.temp;
        let [c1, c2, c3, c4] = &mut self.convolvers;
        if !self.second || crossfading {
            c1.process(kl1, delayed_l, if crossfading { t1 } else { out_l });
            c2.process(kr1, delayed_r, if crossfading { t2 } else { out_r });
        }
        if self.second || crossfading {
            c3.process(kl2, delayed_l, if crossfading { t3 } else { out_l });
            c4.process(kr2, delayed_r, if crossfading { t4 } else { out_r });
        }
        if crossfading {
            let mut x = self.crossfade_x;
            for i in 0..out_l.len() {
                out_l[i] = (1. - x) * t1[i] + x * t3[i];
                out_r[i] = (1. - x) * t2[i] + x * t4[i];
                x += self.crossfade_incr;
            }
            self.crossfade_x = x;
            if self.crossfade_incr > 0. && (self.crossfade_x - 1.).abs() < self.crossfade_incr {
                self.second = true;
                self.crossfade_x = 1.;
                self.crossfade_incr = 0.;
            } else if self.crossfade_incr < 0. && self.crossfade_x.abs() < -self.crossfade_incr {
                self.second = false;
                self.crossfade_x = 0.;
                self.crossfade_incr = 0.;
            }
        }
    }
}
