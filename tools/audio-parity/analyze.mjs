// Turns lanes.mjs's raw data into each lane's verdict, the values behind it, and its plot.
// `node tools/audio-parity/analyze.mjs <lanes out dir> <edge render dir>` writes verdicts.json and the e7-*.png plots
// into the lanes out dir.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { plot } from './compare.mjs';
import { readWav } from './wav.mjs';

const [dir, edgeDir] = process.argv.slice(2);
const at = (...parts) => join(dir, ...parts);
const read = path => readFileSync(path, 'utf8');
const lines = (text, tag) => text.split(/\r?\n/).filter(l => l.startsWith(tag)).map(l => l.slice(tag.length));
const verdicts = {};
const db = x => 20 * Math.log10(Math.max(x, 1e-12));

function csv(path) {
  const [header, ...rows] = read(path).trim().split(/\r?\n/);
  const keys = header.split(',');
  return rows.map(row => Object.fromEntries(row.split(',').map((v, i) => [keys[i], Number(v)])));
}

// The WAV frame where context frame `frame` of `context` landed. A callback's row gives the context's frame count when
// it began, and its first samples can come from a quantum the callback before rendered, so the first sample's frame is
// 0 to 127 frames earlier. Over the running callbacks near `frame`, context frame minus WAV frame is one constant, and
// each callback bounds it to a 128-frame range; their intersection pins it.
function wavFrame(rows, frame, context = rows[0]?.context) {
  const starts = rows.filter(r => r.quantum === 0 && r.context === context);
  const running = starts.filter((r, i) => i + 1 < starts.length && starts[i + 1].context_frame > r.context_frame);
  const near = running.filter(r => Math.abs(r.context_frame - frame) < 48000);
  let lo = -Infinity;
  let hi = Infinity;
  for (const r of near) {
    lo = Math.max(lo, r.context_frame - r.wav_frame - 127);
    hi = Math.min(hi, r.context_frame - r.wav_frame);
  }
  if (!(lo <= hi)) return null;
  return frame - hi;
}

function underruns(rows) { return rows.filter(r => r.quantum === 0 && r.underrun === 1).length; }

function pngPixels(path) { return PNG.sync.read(readFileSync(path)); }

function lane1() {
  const names = readdirSync(at('lane1', 'head'));
  const rows = names.map(name => {
    const a = pngPixels(at('lane1', 'base', name, `${name}.png`));
    const b = pngPixels(at('lane1', 'head', name, `${name}.png`));
    let differ = 0;
    for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) differ++;
    const log = read(at('lane1', 'head', name, 'host.log'));
    return { name, size: [a.width, a.height, b.width, b.height], pixelsDiffer: differ, audioCsv: existsSync(at('lane1', 'head', name, 'audio.csv')), audioLog: log.includes('audio: output') };
  });
  // A strip of the head captures, each scaled to 320 wide.
  const tiles = names.map(name => pngPixels(at('lane1', 'head', name, `${name}.png`)));
  const tile = 320;
  const height = Math.round((tile * tiles[0].height) / tiles[0].width);
  const strip = new PNG({ width: tile * tiles.length, height });
  tiles.forEach((img, t) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < tile; x++) {
      const sx = Math.floor((x * img.width) / tile);
      const sy = Math.floor((y * img.height) / height);
      const from = (sy * img.width + sx) * 4;
      strip.data.set(img.data.subarray(from, from + 4), (y * strip.width + t * tile + x) * 4);
    }
  });
  writeFileSync(at('e7-regression.png'), PNG.sync.write(strip));
  verdicts.lane1 = { pass: rows.every(r => r.pixelsDiffer === 0 && !r.audioCsv && !r.audioLog), rows };
}

function graphLanes() {
  const report = JSON.parse(read(at('graphs', 'report.json')));
  const rule = row => {
    if (row.error) return 'fail';
    const shape = row.sampleRate[0] === row.sampleRate[1] && row.channels[0] === row.channels[1] && row.length[0] === row.length[1];
    if (row.lane === 'hrtf') return shape && row.levelsDb.every(l => Math.abs(l) <= 1) ? 'pass' : shape ? 'pending' : 'fail';
    return shape && row.diffDb <= -60 ? 'pass' : 'fail';
  };
  const byLane = {};
  for (const row of report) (byLane[row.lane] ??= []).push({ ...row, verdict: rule(row) });
  const count = rows => rows.reduce((c, r) => ({ ...c, [r.verdict]: (c[r.verdict] ?? 0) + 1 }), {});
  const worst = rows => Math.max(...rows.filter(r => r.diffDb !== undefined && r.lane !== 'hrtf').map(r => r.diffDb));
  verdicts.lane2 = { pass: byLane.decode.every(r => r.verdict === 'pass'), counts: count(byLane.decode), worstDiffDb: worst(byLane.decode), failing: byLane.decode.filter(r => r.verdict !== 'pass') };
  verdicts.lane3 = { pass: byLane.graph.every(r => r.verdict === 'pass'), counts: count(byLane.graph), worstDiffDb: worst(byLane.graph), failing: byLane.graph.filter(r => r.verdict !== 'pass') };
  verdicts.lane4 = {
    pass: byLane.pan.every(r => r.verdict === 'pass'),
    hrtf: byLane.hrtf.every(r => r.verdict === 'pass') ? 'pass' : 'pending: the HRIR set is not Edge\'s until the operator rules on its terms',
    counts: count(byLane.pan), worstDiffDb: worst(byLane.pan), hrtfLevelsDb: byLane.hrtf.map(r => [r.name, r.levelsDb.map(l => Number(l.toFixed(2)))]),
    failing: byLane.pan.filter(r => r.verdict !== 'pass'),
  };
  for (const [file, name] of [['e7-decode.png', 'decode-mp3-2ch-44100-to-48000'], ['e7-graph.png', 'gain-value-curve-fractional'], ['e7-pan.png', 'equalpower-cone']]) {
    const host = readWav(at('graphs', `${name}.wav`));
    const edge = readWav(join(edgeDir, `${name}.wav`));
    plot(at(file), edge, host, 0);
  }
}

function lane5() {
  const log = read(at('lane5', 'host.log'));
  const records = lines(log, 'REALTIME ').map(l => JSON.parse(l));
  const rows = csv(at('lane5', 'audio.csv'));
  const capture = readWav(at('lane5', 'out.wav'));
  const results = records.filter(r => r.name).map(r => {
    const start = wavFrame(rows, r.startFrame);
    const offline = readWav(at('graphs', `${r.name}.wav`)).channels[0];
    let sum = 0;
    for (let i = 0; i < r.length; i++) sum += (capture.channels[0][start + i] - offline[i]) ** 2;
    return { name: r.name, wavStart: start, diffDb: db(Math.sqrt(sum / r.length)) };
  });
  // The capture has no gap when every running callback continues the WAV where the one before left it.
  const ctx = rows.filter(r => r.quantum === 0);
  const breaks = ctx.slice(1).filter((r, i) => r.context_frame > ctx[i].context_frame && r.wav_frame - ctx[i].wav_frame !== ctx[1].wav_frame - ctx[0].wav_frame && r.gap_us > 2 * r.callback_budget_us);
  const first = records[0];
  const last = records.at(-1);
  const latency = first.baseLatency + last.outputLatency;
  const worst = results.reduce((w, r) => (r.diffDb > w.diffDb ? r : w), results[0]);
  const blocked = records.find(r => r.name === worst.name);
  plot(at('e7-realtime.png'), readWav(at('graphs', `${worst.name}.wav`)), { sampleRate: capture.sampleRate, channels: [capture.channels[0].subarray(worst.wavStart, worst.wavStart + blocked.length)] }, 0);
  verdicts.lane5 = {
    pass: results.every(r => r.diffDb <= -60) && underruns(rows) === 0 && breaks.length === 0 && latency <= 0.05,
    underruns: underruns(rows), lateCallbacks: breaks.length, baseLatency: first.baseLatency, outputLatency: last.outputLatency, latency,
    worst, failing: results.filter(r => r.diffDb > -60),
    quantumRenderUs: percentile(rows.map(r => r.quantum_us), [0.5, 0.99, 1]),
  };
}

function percentile(values, ps) {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries(ps.map(p => [`p${p * 100}`, sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]]));
}

function lane6() {
  const host = lines(read(at('lane6', 'host.log')), 'H ');
  const edge = lines(read(at('lane6', 'edge.log')), 'H ');
  const order = list => list.map(l => l.replace(/^(play-call #\d+) [\d.]+$/, '$1'));
  const rows = csv(at('lane6', 'audio.csv'));
  // Howler closes its first context on unlock and plays every sound on the next one, which has its own capture file.
  const context = Math.max(...rows.map(r => r.context));
  const capture = readWav(at('lane6', context === 1 ? 'out.wav' : `out-${context}.wav`));
  const rate = capture.sampleRate;
  const loud = i => capture.channels.some(c => Math.abs(c[i]) > 0.01);
  const onsets = host.filter(l => l.startsWith('play-call')).map(l => {
    const [, id, time] = l.split(' ');
    const expected = wavFrame(rows, Math.round(Number(time) * rate), context);
    let i = Math.max(0, expected - Math.round(0.05 * rate));
    while (i < capture.channels[0].length && !loud(i)) i++;
    return { id, time: Number(time), expectedWav: expected, onsetWav: i, deltaMs: ((i - expected) / rate) * 1000 };
  });
  plotMarkers(at('e7-howler.png'), capture, onsets.map(o => o.expectedWav));
  verdicts.lane6 = {
    pass: JSON.stringify(order(host)) === JSON.stringify(order(edge)) && !host.some(l => l.startsWith('loaderror')) && onsets.every(o => Math.abs(o.deltaMs) <= 10),
    sameOrder: JSON.stringify(order(host)) === JSON.stringify(order(edge)), host: order(host), edge: order(edge), onsets,
  };
}

function plotMarkers(path, capture, markers, { width = 1600, height = 240 } = {}) {
  const png = new PNG({ width, height });
  png.data.fill(255);
  const data = capture.channels[0];
  const n = data.length;
  for (let x = 0; x < width; x++) {
    let lo = 0;
    let hi = 0;
    for (let i = Math.floor((x * n) / width); i < Math.floor(((x + 1) * n) / width); i++) { lo = Math.min(lo, data[i]); hi = Math.max(hi, data[i]); }
    const y = v => Math.max(0, Math.min(height - 1, Math.round(height / 2 - (v * height) / 2)));
    for (let yy = y(hi); yy <= y(lo); yy++) png.data.set([40, 90, 200, 255], (yy * width + x) * 4);
  }
  for (const m of markers) {
    const x = Math.round((m / n) * width);
    for (let yy = 0; yy < height; yy++) if (x >= 0 && x < width) png.data.set([220, 30, 30, 255], (yy * width + x) * 4);
  }
  writeFileSync(path, PNG.sync.write(png));
}

function lane7() {
  const parse = text => lines(text, 'A ').map(l => Object.fromEntries(l.split(' ').map(kv => kv.split('=')).map(([k, v]) => [k, Number(v)])));
  const host = parse(read(at('lane7', 'host', 'host.log')));
  const edge = parse(read(at('lane7', 'edge', 'console.log')));
  // The panner reads the position three ramps to each frame, so it trails the cube by a frame or so. The lag that
  // fits best and the error left over describe how closely it follows.
  const follow = rows => {
    let best = { lag: 0, error: Infinity };
    for (let lag = 0; lag <= 4; lag++) {
      const pairs = rows.slice(30 + lag).map((r, i) => Math.abs(r.px - rows[30 + i].x));
      const error = pairs.reduce((s, v) => s + v, 0) / pairs.length;
      if (error < best.error) best = { lag, error };
    }
    return best;
  };
  const mode = rows => {
    const counts = {};
    for (const r of rows.slice(30)) counts[r.peak] = (counts[r.peak] ?? 0) + 1;
    return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  };
  const h = follow(host);
  const e = follow(edge);
  const png = new PNG({ width: 1200, height: 400 });
  png.data.fill(255);
  const draw = (rows, key, color, top) => rows.forEach((r, i) => {
    const x = Math.round((i / rows.length) * 1200);
    const y = top + Math.round(100 - (r[key] / 4.5) * 90);
    if (y >= 0 && y < 400) png.data.set([...color, 255], (y * 1200 + x) * 4);
  });
  draw(edge, 'x', [150, 150, 150], 0); draw(edge, 'px', [40, 90, 200], 0);
  draw(host, 'x', [150, 150, 150], 200); draw(host, 'px', [220, 110, 30], 200);
  writeFileSync(at('e7-three.png'), PNG.sync.write(png));
  verdicts.lane7 = { pass: h.lag <= e.lag + 1 && h.error <= Math.max(2 * e.error, 0.05) && mode(host) === mode(edge), hostFollow: h, edgeFollow: e, hostPeakBin: mode(host), edgePeakBin: mode(edge), frames: [host.length, edge.length] };
}

function scenarioLanes() {
  const host = JSON.parse(read(at('scenarios', 'scenarios.host.json')));
  const edge = JSON.parse(read('tools/audio-parity/scenarios.edge.json')).scenarios;
  const same = name => JSON.stringify(host[name]) === JSON.stringify(edge[name]);
  const loopback = readWav(at('scenarios', 'loopback.wav'));
  const rate = loopback.sampleRate;
  // Runs of 10 ms blocks above -50 dBFS on the first two channels.
  const block = Math.round(rate / 100);
  const active = [];
  for (let i = 0; i + block <= loopback.channels[0].length; i += block) {
    let sum = 0;
    for (let c = 0; c < 2; c++) for (let j = i; j < i + block; j++) sum += loopback.channels[c][j] ** 2;
    active.push(db(Math.sqrt(sum / (2 * block))) > -50);
  }
  const runs = [];
  active.forEach((on, i) => {
    if (on && (i === 0 || !active[i - 1])) runs.push({ start: i * 10, end: i * 10 + 10 });
    else if (on) runs.at(-1).end = i * 10 + 10;
  });
  plotMarkers(at('e7-lifecycle.png'), loopback, runs.map(r => Math.round((r.start / 1000) * rate)));
  writeFileSync(at('e7-unsupported.png'), readFileSync(at('e7-lifecycle.png')));
  const gaps = runs.slice(1).map((r, i) => ({ before: runs[i], after: r, silentMs: r.start - runs[i].end }));
  const suspended = gaps.find(g => g.silentMs >= 350 && g.silentMs <= 600);
  const lifecycle = ['context-start', 'suspend-resume-close', 'statechange-timing', 'statechange-races', 'suspend-mid-sound', 'offline-render'];
  verdicts.lane8 = { pass: lifecycle.every(same) && !!suspended, scenarios: Object.fromEntries(lifecycle.map(n => [n, same(n) ? 'same' : { host: host[n], edge: edge[n] }])), silentWhileSuspended: suspended ?? null, soundRuns: runs };
  const unsupported = host['unsupported-methods'];
  const throws = ['createMediaElementSource', 'createMediaStreamSource', 'createScriptProcessor', 'audioWorklet.addModule', 'Audio.play'].map(method => {
    const entry = unsupported.find(e => e[0] === method);
    return { method, entry, names: !!entry && entry.slice(1).some(v => typeof v === 'string' && v.includes(method.split('.').at(-1)) && v.includes('not supported')) };
  });
  const still = unsupported.find(e => e[0] === 'still playing');
  const longest = runs.reduce((m, r) => Math.max(m, r.end - r.start), 0);
  verdicts.lane10 = { pass: throws.every(t => t.names) && still?.[1] === 'running' && still?.[2] === true, throws, stillPlaying: still, longestSoundRunMs: longest };
  verdicts.other = Object.fromEntries(['param-errors', 'node-errors', 'decode-callbacks', 'audio-element', 'xhr'].map(n => [n, same(n) ? 'same' : { host: host[n], edge: edge[n] }]));
}

const inputs = { lane1: 'lane1', graphLanes: 'graphs', lane5: 'lane5', lane6: 'lane6', lane7: 'lane7', scenarioLanes: 'scenarios' };
for (const [name, run] of Object.entries({ lane1, graphLanes, lane5, lane6, lane7, scenarioLanes })) {
  if (!existsSync(at(inputs[name]))) continue;
  try { run(); } catch (error) { verdicts[name] = { error: String(error.stack ?? error) }; }
}
writeFileSync(at('verdicts.json'), `${JSON.stringify(verdicts, null, 1)}\n`);
for (const [lane, v] of Object.entries(verdicts)) console.log(`${lane}: ${v.error ? `ERROR ${v.error.split('\n')[0]}` : v.pass === undefined ? 'see verdicts.json' : v.pass ? 'pass' : 'FAIL'}${v.hrtf ? ` (HRTF ${v.hrtf.split(':')[0]})` : ''}`);
