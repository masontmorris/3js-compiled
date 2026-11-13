// Compares two captures: aligns the second to the first by cross-correlation, reports the lag and the RMS difference
// over their overlap in dBFS, and plots both waveforms and their difference as a PNG.
// `node tools/audio-parity/compare.mjs <reference.wav> <capture.wav> [--plot out.png] [--max-lag seconds] [--json]`
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { readWav } from './wav.mjs';

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const mono = ({ channels }) => Float64Array.from(channels[0], (_, i) => channels.reduce((s, c) => s + c[i], 0) / channels.length);

/** The lag, in frames, that best aligns `b` to `a`: b[i + lag] ≈ a[i]. */
export function align(a, b, maxLag) {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n); const ai = new Float64Array(n);
  const br = new Float64Array(n); const bi = new Float64Array(n);
  ar.set(a); br.set(b);
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < n; i++) {
    const r = br[i] * ar[i] + bi[i] * ai[i];
    const im = bi[i] * ar[i] - br[i] * ai[i];
    br[i] = r; bi[i] = im;
  }
  fft(br, bi, true);
  let best = 0;
  let bestValue = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const value = br[(lag + n) % n];
    if (value > bestValue) { bestValue = value; best = lag; }
  }
  return best;
}

export function compare(reference, capture, { maxLagSeconds = 1 } = {}) {
  // The loudest channel aligns, since a mix of opposite channels such as [x, -x] is silence.
  const energy = c => c.reduce((sum, v) => sum + v * v, 0);
  const channel = reference.channels.reduce((best, c, i) => (energy(c) > energy(reference.channels[best]) ? i : best), 0);
  const lag = align(reference.channels[channel], capture.channels[Math.min(channel, capture.channels.length - 1)], Math.round(maxLagSeconds * reference.sampleRate));
  let sum = 0;
  let count = 0;
  for (let c = 0; c < reference.channels.length; c++) {
    const ref = reference.channels[c];
    const cap = capture.channels[Math.min(c, capture.channels.length - 1)];
    for (let i = Math.max(0, -lag); i < ref.length && i + lag < cap.length; i++) {
      const d = ref[i] - cap[i + lag];
      sum += d * d;
      count++;
    }
  }
  if (!count) throw new Error('No overlapping samples');
  const rms = Math.sqrt(sum / count);
  return { lag, lagMs: (lag / reference.sampleRate) * 1000, overlapFrames: count / reference.channels.length, diffDb: 20 * Math.log10(Math.max(rms, 1e-12)) };
}

// Two waveform rows and a difference row, each the min to max of the samples a column covers.
export function plot(path, reference, capture, lag, { width = 1200, row = 160 } = {}) {
  const png = new PNG({ width, height: row * 3 });
  png.data.fill(255);
  const a = mono(reference);
  const b = mono(capture);
  const n = a.length;
  const sample = [i => a[i], i => b[i + lag] ?? 0, i => a[i] - (b[i + lag] ?? 0)];
  const colors = [[40, 90, 200], [220, 110, 30], [180, 30, 60]];
  sample.forEach((value, r) => {
    for (let x = 0; x < width; x++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = Math.floor((x * n) / width); i < Math.floor(((x + 1) * n) / width); i++) {
        lo = Math.min(lo, value(i));
        hi = Math.max(hi, value(i));
      }
      if (lo === Infinity) continue;
      const y = v => Math.max(0, Math.min(row - 1, Math.round(row / 2 - (v * row) / 2)));
      for (let yy = y(hi); yy <= y(lo); yy++) {
        const at = ((r * row + yy) * width + x) * 4;
        png.data.set([...colors[r], 255], at);
      }
    }
    for (let x = 0; x < width; x++) png.data.set([200, 200, 200, 255], ((r * row + row / 2) * width + x) * 4);
  });
  writeFileSync(path, PNG.sync.write(png));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/').replace(/^\//, '')}`) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const plotPath = option('plot');
  const maxLag = Number(option('max-lag') ?? 1);
  const json = args.includes('--json');
  const [refPath, capPath] = args.filter(a => !a.startsWith('--'));
  const reference = readWav(refPath);
  const capture = readWav(capPath);
  const result = compare(reference, capture, { maxLagSeconds: maxLag });
  if (plotPath) plot(plotPath, reference, capture, result.lag);
  console.log(json ? JSON.stringify(result) : `lag ${result.lag} frames (${result.lagMs.toFixed(2)} ms), diff ${result.diffDb.toFixed(1)} dBFS over ${result.overlapFrames} frames`);
}
