// Runs examples/audio/graphs.js or examples/audio/scenarios.js in the host and collects what it logs.
//   node tools/audio-parity/host.mjs graphs <edge render dir> <out dir> [--filter x] [--dump x]
//   node tools/audio-parity/host.mjs scenarios <out dir> [--filter x]
// graphs writes report.json with one row per render, and each dumped render as a float WAV. scenarios writes
// scenarios.host.json and prints each scenario that differs from scenarios.edge.json. The host plays to the virtual
// device `--audio-device` names, Steam Streaming Speakers by default, and never to the default output. It needs the
// window, so run it under the GPU lease.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeWav } from './wav.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args.splice(i, 2)[1]; };
// A frozen copy, outside the target directory that cargo_fresh.py cleans before each build.
const hostExe = resolve(option('host', 'C:/3jsc/swarm/e7/owner/bin/head/host.exe'));
const device = option('audio-device', 'Speakers (Steam Streaming Speakers)');
const filter = option('filter', '');
const dump = option('dump', '');
const frames = Number(option('frames', '3000'));
const [mode, ...rest] = args;
const main = import.meta.url === pathToFileURL(process.argv[1]).href;
const repo = resolve('.');

// Runs the host on `entry` in `out` and answers host.log once it exits. `steps` run after `frames` frames, then the
// host closes.
export function runHost(entry, hash, out, { exe = hostExe, frames: count = frames, steps = [], args: extra = [], audio = true, audioOut = true, timeoutMs = 300_000 } = {}) {
  mkdirSync(out, { recursive: true });
  const script = join(out, 'steps.json');
  writeFileSync(script, JSON.stringify([{ type: 'wait', frames: count }, ...steps, { type: 'close' }]));
  // The base host has no audio, so it takes neither audio flag.
  const args = ['--entry', join(repo, entry), '--hash', hash, '--script', script, ...(audio ? ['--audio-device', device] : []), ...(audio && audioOut ? ['--audio-out', join(out, 'out.wav')] : []), ...extra];
  return new Promise((done, fail) => {
    const child = spawn(exe, args, { cwd: out, stdio: ['ignore', 'ignore', 'inherit'] });
    const timer = setTimeout(() => { child.kill(); fail(new Error(`host.mjs: the host did not exit within ${timeoutMs / 1000} s (pid ${child.pid})`)); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); fail(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? done(readFileSync(join(out, 'host.log'), 'utf8')) : fail(new Error(`host exited with ${code}`)); });
  });
}

export const lines = (log, tag) => log.split(/\r?\n/).filter(line => line.startsWith(`${tag} `)).map(line => line.slice(tag.length + 1));

if (!main) {
  // imported by lanes.mjs
} else if (mode === 'graphs') {
  const [edgeDir, out] = rest;
  const hash = new URLSearchParams({ ref: pathToFileURL(resolve(edgeDir)).href, filter, dump }).toString();
  const log = await runHost('examples/audio/graphs.js', hash, resolve(out));
  if (!log.includes('AUDIO-PARITY-DONE')) throw new Error(`host.mjs: graphs.js did not finish within ${frames} frames`);
  const rows = lines(log, 'AUDIO-PARITY').map(line => JSON.parse(line));
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(rows, null, 1)}\n`);
  for (const line of lines(log, 'AUDIO-SAMPLES')) {
    const [name, rate, data] = line.split(' ');
    const channels = data.split(',').map(b64 => new Float32Array(Uint8Array.from(Buffer.from(b64, 'base64')).buffer));
    writeWav(join(out, `${name}.wav`), channels, Number(rate), { float: true });
  }
  console.log(`${rows.length} renders in ${join(out, 'report.json')}`);
} else if (mode === 'scenarios') {
  const [out] = rest;
  const log = await runHost('examples/audio/scenarios.js', new URLSearchParams({ filter }).toString(), resolve(out));
  if (!log.includes('AUDIO-SCENARIO-DONE')) throw new Error(`host.mjs: scenarios.js did not finish within ${frames} frames`);
  const host = Object.fromEntries(lines(log, 'AUDIO-SCENARIO').map(line => JSON.parse(line)).map(({ name, log }) => [name, log]));
  writeFileSync(join(out, 'scenarios.host.json'), `${JSON.stringify(host, null, 1)}\n`);
  const edge = JSON.parse(readFileSync('tools/audio-parity/scenarios.edge.json', 'utf8')).scenarios;
  for (const [name, log] of Object.entries(host)) {
    const same = JSON.stringify(log) === JSON.stringify(edge[name]);
    console.log(`${same ? 'same' : 'DIFFERS'} ${name}`);
  }
} else {
  throw new Error('usage: host.mjs graphs <edge dir> <out dir> | host.mjs scenarios <out dir>');
}
