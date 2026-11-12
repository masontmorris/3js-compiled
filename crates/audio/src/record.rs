//! `--audio-out` and `audio.csv`: what each online context hands the output device, and how long each render quantum
//! took. The render thread pushes into lock-free rings and never blocks or allocates. One writer thread drains every
//! context's rings, in the order the contexts started, into one WAV file and one CSV file.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rtrb::{Consumer, Producer, RingBuffer};
use web_audio_api::{RenderObserver, RenderReport};

/// Seconds of audio a context's ring holds while the writer catches up.
const RING_SECONDS: usize = 10;
const MAX_QUANTA_PER_CALLBACK: usize = 64;

/// One render quantum in `audio.csv`.
#[derive(Clone, Copy, Debug, Default)]
struct Row {
    context: u32,
    callback: u64,
    /// The context frame of the callback's first sample, and the WAV frame it lands on.
    context_frame: u64,
    wav_frame: u64,
    quantum: u32,
    quantum_ns: u64,
    callback_render_ns: u64,
    callback_budget_ns: u64,
    gap_ns: u64,
}

struct Stream {
    context: u32,
    channels: usize,
    sample_rate: f32,
    samples: Consumer<f32>,
    rows: Consumer<Row>,
}

struct Shared {
    streams: Mutex<Vec<Stream>>,
    dropped: AtomicU64,
    stop: AtomicBool,
}

/// The writer's handle. `finish` drains the rings, closes both files and reports what it wrote.
pub struct Recorder {
    shared: Arc<Shared>,
    writer: Option<JoinHandle<std::io::Result<Summary>>>,
    next_context: u32,
}

#[derive(Debug, Default)]
pub struct Summary {
    pub frames: u64,
    pub quanta: u64,
    pub underruns: u64,
    pub dropped: u64,
    pub skipped_contexts: Vec<u32>,
}

impl Recorder {
    /// Writes the mix to `wav` when given, and every quantum's timing to `csv`.
    pub fn start(wav: Option<PathBuf>, csv: &Path) -> std::io::Result<Self> {
        let shared = Arc::new(Shared {
            streams: Mutex::new(Vec::new()),
            dropped: AtomicU64::new(0),
            stop: AtomicBool::new(false),
        });
        let mut csv = BufWriter::new(File::create(csv)?);
        writeln!(
            csv,
            "context,callback,context_frame,wav_frame,quantum,quantum_us,callback_render_us,callback_budget_us,gap_us,underrun"
        )?;
        let writer = {
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("audio-out".into())
                .spawn(move || write_loop(&shared, wav, csv))?
        };
        Ok(Self {
            shared,
            writer: Some(writer),
            next_context: 0,
        })
    }

    /// An observer for the next online context.
    pub fn observer(&mut self, sample_rate: f32, channels: usize) -> Box<dyn RenderObserver> {
        self.next_context += 1;
        let (samples_tx, samples) =
            RingBuffer::new(sample_rate as usize * channels.max(1) * RING_SECONDS);
        let (rows_tx, rows) = RingBuffer::new(MAX_QUANTA_PER_CALLBACK * 1024);
        self.shared.streams.lock().unwrap().push(Stream {
            context: self.next_context,
            channels,
            sample_rate,
            samples,
            rows,
        });
        Box::new(Observer {
            context: self.next_context,
            shared: Arc::clone(&self.shared),
            samples: Mutex::new((samples_tx, rows_tx, 0, 0, None)),
        })
    }

    pub fn finish(&mut self) -> std::io::Result<Summary> {
        self.shared.stop.store(true, Ordering::Release);
        self.writer.take().map_or_else(
            || Ok(Summary::default()),
            |w| {
                w.join()
                    .unwrap_or_else(|_| Err(std::io::Error::other("audio-out writer panicked")))
            },
        )
    }
}

/// The rings, the callback count, the WAV frames written so far and the previous callback's time.
type Rings = (Producer<f32>, Producer<Row>, u64, u64, Option<Instant>);

struct Observer {
    context: u32,
    shared: Arc<Shared>,
    // Only the render thread locks this, so the lock never waits.
    samples: Mutex<Rings>,
}

impl RenderObserver for Observer {
    fn rendered(&self, report: &RenderReport<'_>) {
        let Ok(mut rings) = self.samples.try_lock() else {
            return;
        };
        let (samples, rows, callback, written, last) = &mut *rings;
        let wav_frame = *written;
        *written += (report.samples.len() / report.channels.max(1)) as u64;
        let now = Instant::now();
        let gap_ns = last.map_or(0, |t| now.duration_since(t).as_nanos() as u64);
        *last = Some(now);
        *callback += 1;
        if samples.slots() < report.samples.len() {
            self.shared
                .dropped
                .fetch_add(report.samples.len() as u64, Ordering::Relaxed);
        } else if let Ok(mut chunk) = samples.write_chunk(report.samples.len()) {
            let (first, second) = chunk.as_mut_slices();
            let split = first.len();
            first.copy_from_slice(&report.samples[..split]);
            second.copy_from_slice(&report.samples[split..]);
            chunk.commit_all();
        }
        let quanta: &[u64] = if report.quantum_ns.is_empty() {
            &[0]
        } else {
            report.quantum_ns
        };
        for (quantum, &quantum_ns) in quanta.iter().enumerate() {
            let row = Row {
                context: self.context,
                callback: *callback,
                context_frame: report.frame,
                wav_frame,
                quantum: quantum as u32,
                quantum_ns,
                callback_render_ns: report.render_ns,
                callback_budget_ns: report.budget_ns,
                gap_ns,
            };
            if rows.push(row).is_err() {
                self.shared.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

// A callback underruns when it took longer than the audio it rendered lasts, or when it started more than twice its
// own length after the previous one, so the device ran dry between them.
fn underrun(row: &Row) -> bool {
    row.callback_render_ns > row.callback_budget_ns
        || (row.gap_ns > 0 && row.gap_ns > 2 * row.callback_budget_ns.max(1))
}

fn write_loop(
    shared: &Shared,
    wav_path: Option<PathBuf>,
    mut csv: BufWriter<File>,
) -> std::io::Result<Summary> {
    let mut summary = Summary::default();
    let mut wav: Option<(hound::WavWriter<BufWriter<File>>, usize)> = None;
    let mut wav_path = wav_path;
    loop {
        let stopping = shared.stop.load(Ordering::Acquire);
        let mut streams = shared.streams.lock().unwrap();
        for stream in streams.iter_mut() {
            while let Ok(row) = stream.rows.pop() {
                let bad = underrun(&row);
                if bad && row.quantum == 0 {
                    summary.underruns += 1;
                }
                summary.quanta += 1;
                writeln!(
                    csv,
                    "{},{},{},{},{},{:.3},{:.3},{:.3},{:.3},{}",
                    row.context,
                    row.callback,
                    row.context_frame,
                    row.wav_frame,
                    row.quantum,
                    row.quantum_ns as f64 / 1e3,
                    row.callback_render_ns as f64 / 1e3,
                    row.callback_budget_ns as f64 / 1e3,
                    row.gap_ns as f64 / 1e3,
                    u8::from(bad)
                )?;
            }
            let available = stream.samples.slots();
            if available == 0 {
                continue;
            }
            let Ok(chunk) = stream.samples.read_chunk(available) else {
                continue;
            };
            if wav.is_none()
                && let Some(path) = wav_path.take()
            {
                let spec = hound::WavSpec {
                    channels: stream.channels as u16,
                    sample_rate: stream.sample_rate as u32,
                    bits_per_sample: 32,
                    sample_format: hound::SampleFormat::Float,
                };
                wav = Some((
                    hound::WavWriter::create(path, spec).map_err(std::io::Error::other)?,
                    stream.channels,
                ));
            }
            match &mut wav {
                Some((writer, channels)) if *channels == stream.channels => {
                    let (first, second) = chunk.as_slices();
                    for &sample in first.iter().chain(second) {
                        writer.write_sample(sample).map_err(std::io::Error::other)?;
                    }
                    summary.frames += (available / stream.channels.max(1)) as u64;
                }
                Some(_) if !summary.skipped_contexts.contains(&stream.context) => {
                    summary.skipped_contexts.push(stream.context)
                }
                _ => {}
            }
            chunk.commit_all();
        }
        drop(streams);
        if stopping {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    csv.flush()?;
    if let Some((writer, _)) = wav {
        writer.finalize().map_err(std::io::Error::other)?;
    }
    summary.dropped = shared.dropped.load(Ordering::Relaxed);
    Ok(summary)
}
