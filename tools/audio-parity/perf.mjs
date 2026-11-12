// E7's perf probe: examples/audio/stress.js with its audio calls on and off, in the order given, each for `--seconds`.
// Per run it reports the game thread's CPU time per frame from frames.csv, and the rest of the machine's load over the
// run, which voids a run above 40 percent. An audio-on run also reports each quantum's render time and the callbacks
// that rendered longer than their budget, from audio.csv; the late callbacks, as information; and the gaps, skips and
// mismatches in a loopback recording of the device against what the engine handed it.
// Run it under the GPU lease and quiet_run.py.
//   node tools/audio-parity/perf.mjs <out dir> [--order on,off,on] [--seconds 300]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { load } from '../perf/load.mjs';
import { findGaps } from './gaps.mjs';
import { runHost } from './host.mjs';
import { readWav } from './wav.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args.splice(i, 2)[1]; };
const order = option('order', 'on,off,on').split(',');
const seconds = Number(option('seconds', '300'));
const out = resolve(args[0]);
const fps = 169;
const loopbackExe = 'C:/3jsc/swarm/e7/owner/bin/head/loopback.exe';
const device = 'Speakers (Steam Streaming Speakers)';

const sampler = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('tools/perf/sampler.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
const answers = createInterface({ input: sampler.stdout })[Symbol.asyncIterator]();
const ask = async line => { sampler.stdin.write(`${line}\n`); return (await answers.next()).value; };
const machine = async () => { const [busyMs, dpcMs, interruptMs] = (await ask('machine')).split(',').map(Number); return { busyMs, dpcMs, interruptMs }; };

const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const table = path => {
  const [header, ...rows] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const keys = header.split(',');
  return rows.map(r => Object.fromEntries(r.split(',').map((v, i) => [keys[i], Number(v)])));
};

// Count, minimum, median and maximum.
const summarize = values => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? { count: s.length, min: s[0], p50: s[Math.floor(s.length / 2)], max: s.at(-1) } : { count: 0 };
};
const count = values => values.reduce((counts, v) => ({ ...counts, [v]: (counts[v] ?? 0) + 1 }), {});

const runs = [];
for (const [i, mode] of order.entries()) {
  const dir = join(out, `${i}-${mode}`);
  const before = await machine();
  const started = performance.now();
  // The host's own CPU time is inside the machine's busy time, so take it out: sample its tree as it runs.
  // The sampler answers one request at a time, so the samples run in sequence.
  let hostMs = 0;
  let running = true;
  const watch = (async () => {
    while (running) {
      const ids = await ask('discover stress.js');
      if (ids) hostMs = Math.max(hostMs, Number(await ask(`cpu ${ids}`)));
      await new Promise(r => setTimeout(r, 1000));
    }
  })();
  // The loopback starts first and runs past the host, so it holds everything the device played.
  mkdirSync(dir, { recursive: true });
  const loopback = mode === 'on' ? spawn(loopbackExe, [device, String(seconds + 20), join(dir, 'loopback.wav')], { stdio: 'inherit' }) : null;
  const recorded = loopback && new Promise(r => loopback.on('exit', r));
  await runHost('examples/audio/stress.js', mode === 'off' ? 'audio=off' : '', dir, { frames: seconds * fps, audioOut: mode === 'on', timeoutMs: (seconds + 120) * 1000 });
  running = false;
  await watch;
  const elapsed = performance.now() - started;
  const after = await machine();
  // The machine's load is read before the loopback's wait, so the wait does not count.
  if (recorded) await recorded;
  const other = load(before, after, elapsed, hostMs);
  const frames = table(join(dir, 'frames.csv')).slice(fps * 10);
  const row = { run: i, mode, frames: frames.length, cpuMsP50: percentile(frames.map(f => f.cpu_ms), 0.5), cpuMsP99: percentile(frames.map(f => f.cpu_ms), 0.99), otherLoadPercent: (100 * other.otherCores) / cpus().length };
  if (mode === 'on') {
    const audio = table(join(dir, 'audio.csv'));
    row.quanta = audio.length;
    row.quantumUsP50 = percentile(audio.map(a => a.quantum_us), 0.5);
    row.quantumUsP99 = percentile(audio.map(a => a.quantum_us), 0.99);
    row.quantumUsMax = audio.reduce((max, a) => Math.max(max, a.quantum_us), 0);
    row.underruns = new Set(audio.filter(a => a.underrun === 1).map(a => a.callback)).size;
    const late = audio.filter(a => a.late === 1);
    row.lateCallbacks = late.length;
    row.lateGapsMs = summarize(late.map(a => a.gap_us / 1000));
    row.callbackBudgetsUs = count(audio.filter(a => a.quantum === 0).map(a => a.callback_budget_us));
    const { events = [], ...gaps } = findGaps(readWav(join(dir, 'out.wav')), readWav(join(dir, 'loopback.wav')));
    row.loopback = { ...gaps, discontinuities: events.length, events: events.slice(0, 20) };
  }
  row.void = row.otherLoadPercent > 40;
  runs.push(row);
  console.log(JSON.stringify(row));
}
sampler.kill();
writeFileSync(join(out, `perf-${order.join('-')}.json`), `${JSON.stringify(runs, null, 1)}\n`);
