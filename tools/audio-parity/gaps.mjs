// Finds where a loopback recording of the device leaves what the engine handed the device: silence the device
// inserted, frames it skipped, or a stretch that matches nothing. A virtual device runs on the engine's clock, so the
// two agree sample for sample apart from one lag and the endpoint's volume. The detector aligns them once over up to
// 20 s, long enough that a page's repeating test signals still align one way, then checks
// each 10 ms block at that lag; a block that misses gets a new lag from the 200 ms that follow it, and a changed lag is
// a gap (the device played later than it should have) or a skip (earlier). The expected signal must not repeat within
// the search range, or the realignment can land on a repeat: the stress page plays seeded noise for this reason.
//   node tools/audio-parity/gaps.mjs <expected.wav> <loopback.wav> [--json]
import { align } from './compare.mjs';
import { readWav } from './wav.mjs';

// The first two channels, summed: the pages here play stereo into the device's front pair.
const front = ({ channels }) => Float64Array.from(channels[0], (v, i) => v + (channels[1]?.[i] ?? 0));
const db = x => 10 * Math.log10(Math.max(x, 1e-30));

export function findGaps(expected, captured, { blockMs = 10, searchMs = 250, windowMs = 200, missDb = -30 } = {}) {
  const rate = expected.sampleRate;
  const e = front(expected);
  const c = front(captured);
  const block = Math.round((rate * blockMs) / 1000);
  const search = Math.round((rate * searchMs) / 1000);
  const window = Math.round((rate * windowMs) / 1000);
  const power = (x, from, n) => { let s = 0; for (let i = from; i < from + n; i++) s += x[i] * x[i]; return s / n; };
  const quiet = (from, n = block) => power(e, from, n) < 1e-8;
  // The residual of `capture` against gain * `expected`, over n frames at `lag`, relative to the expected signal.
  const residual = (from, n, lag, gain) => {
    let diff = 0;
    let ref = 0;
    for (let i = from; i < from + n; i++) {
      const want = gain * e[i];
      const d = (c[i + lag] ?? 0) - want;
      diff += d * d;
      ref += want * want;
    }
    return db(diff / Math.max(ref, 1e-30));
  };
  // The lag that best aligns the window starting at `from` within `range` frames of `around`, and the gain there.
  const fit = (from, n, around, range) => {
    const lo = Math.max(0, from + around - range);
    const hi = Math.min(c.length, from + around + range + n);
    if (hi - lo < n) return null;
    const relative = align(e.subarray(from, from + n), c.subarray(lo, hi), hi - lo);
    const lag = relative + lo - from;
    if (from + lag < 0 || from + lag + n > c.length) return null;
    let xy = 0;
    let xx = 0;
    for (let i = from; i < from + n; i++) { xy += c[i + lag] * e[i]; xx += e[i] * e[i]; }
    const gain = xx > 0 ? xy / xx : 0;
    return { lag, gain, residualDb: residual(from, n, lag, gain) };
  };

  let start = 0;
  while (start + window < e.length && quiet(start)) start += block;
  // The long alignment places the recording; the first 200 ms of sound fix the lag, from there or nearby, so a
  // discontinuity later in the recording cannot move where the walk starts.
  // The recording starts at most 30 s before the engine's output does.
  const span = Math.min(e.length - start, c.length, rate * 20);
  const reach = Math.min(c.length, start + span + rate * 30);
  const coarse = fit(start, span, Math.round(reach / 2) - start, Math.ceil(reach / 2));
  if (!coarse) return { aligned: false, start };
  let first = { ...coarse, residualDb: residual(start, window, coarse.lag, coarse.gain) };
  if (first.residualDb > missDb) first = fit(start, window, coarse.lag, search);
  if (!first || first.residualDb > missDb) return { aligned: false, start, first, coarse };
  let { lag, gain } = first;
  const events = [];
  let checked = 0;
  let skippedQuiet = 0;
  // A run of missed blocks ends in a new lag, a gap or a skip from where the run began, or back at the old lag, a
  // stretch the device played something else in.
  let missed = null;
  const mismatch = end => {
    events.push({ kind: 'mismatch', atSeconds: missed / rate, lengthMs: (1000 * (end - missed)) / rate });
    missed = null;
  };
  let k = start;
  while (k < e.length) {
    const n = Math.min(block, e.length - k);
    if (quiet(k, n)) { skippedQuiet += n / block; k += n; continue; }
    checked += n / block;
    if (residual(k, n, lag, gain) <= missDb) {
      if (missed !== null) mismatch(k);
      k += n;
      continue;
    }
    const next = k + window <= e.length ? fit(k, window, lag, search) : null;
    if (next && next.residualDb <= missDb && next.lag !== lag) {
      const shift = next.lag - lag;
      events.push({ kind: shift > 0 ? 'gap' : 'skip', atSeconds: (missed ?? k) / rate, shiftMs: (1000 * shift) / rate });
      missed = null;
      lag = next.lag;
      continue;
    }
    missed ??= k;
    k += n;
  }
  if (missed !== null) mismatch(k);
  return {
    aligned: true,
    lagMs: (1000 * first.lag) / rate,
    gain: first.gain,
    alignDb: first.residualDb,
    checkedSeconds: (checked * block) / rate,
    quietSeconds: (skippedQuiet * block) / rate,
    events,
  };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const [expectedPath, capturedPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const result = findGaps(readWav(expectedPath), readWav(capturedPath));
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 1));
  else {
    const { events = [], ...rest } = result;
    console.log(JSON.stringify(rest));
    for (const event of events) console.log(JSON.stringify(event));
    console.log(`${events.length} discontinuities`);
  }
}
