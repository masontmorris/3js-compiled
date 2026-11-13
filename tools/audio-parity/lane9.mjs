// Lane 9: change the default playback device in the middle of a steady sound and check that the host follows it.
// The caller sets the starting default (a virtual device) and restores the original default afterwards; this script
// switches to --switch-id mid-run, captures --capture with WASAPI loopback, and restores --restore-id in a finally.
//   node tools/audio-parity/lane9.mjs <out dir> --switch-id <id> --restore-id <id> --capture "<device name>"
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readWav } from './wav.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args.splice(i, 2)[1]; };
const out = resolve(args[0]);
const switchId = option('switch-id');
const restoreId = option('restore-id');
const captureName = option('capture');
const frames = Number(option('frames', '900'));
const switchAfterMs = Number(option('switch-after', '2500'));
const captureSeconds = Number(option('capture-seconds', '9'));
const hostExe = resolve(option('host', 'C:/3jsc/swarm/e7/owner/bin/head/host.exe'));
const loopbackExe = resolve(option('loopback', 'C:/3jsc/swarm/e7/owner/bin/head/loopback.exe'));
const powershell = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

mkdirSync(out, { recursive: true });
const clock = () => Date.now() / 1000;
const wait = ms => new Promise(done => setTimeout(done, ms));
const audioDevice = command => execFileSync(powershell, ['-NoProfile', '-Command', `Import-Module AudioDeviceCmdlets; ${command}`], { encoding: 'utf8' }).trim();
const setDefault = id => audioDevice(`Set-AudioDevice -ID '${id}' -DefaultOnly`);

writeFileSync(join(out, 'steps.json'), JSON.stringify([{ type: 'wait', frames }, { type: 'close' }]));
const loopback = spawn(loopbackExe, [captureName, String(captureSeconds), join(out, 'loopback.wav')], { stdio: ['ignore', 'pipe', 'inherit'] });
const loopbackDone = new Promise(done => loopback.on('exit', code => done({ code, at: clock() })));
const log = createWriteStream(join(out, 'host.log'));
const errors = createWriteStream(join(out, 'host.err.log'));
const host = spawn(hostExe, ['--entry', resolve('examples/audio/lane9.js'), '--script', join(out, 'steps.json'), '--audio-out', join(out, 'out.wav')], { cwd: out, stdio: ['ignore', 'pipe', 'pipe'] });
host.stdout.pipe(log);
host.stderr.pipe(errors);
const hostDone = new Promise(done => host.on('exit', code => done({ code, at: clock() })));
let switched = null;
let switchBefore = null;
let switchAfter = null;
let defaultAfterSwitch = null;
let hostExit = null;
let loopbackExit = null;
let timer;
try {
  await wait(switchAfterMs);
  switchBefore = clock();
  setDefault(switchId);
  switchAfter = clock();
  defaultAfterSwitch = audioDevice('(Get-AudioDevice -Playback).ID');
  switched = switchAfter;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Child process timeout')), Math.max(captureSeconds * 1000, switchAfterMs) + 30000); });
  [hostExit, loopbackExit] = await Promise.race([Promise.all([hostDone, loopbackDone]), timeout]);
} finally {
  clearTimeout(timer);
  if (host.exitCode === null) host.kill();
  if (loopback.exitCode === null) loopback.kill();
  setDefault(restoreId);
}

const verdict = { capture: captureName, switchBefore, switchAfter, defaultAfterSwitch, switchAt: switched, hostExit, loopbackExit };
try {
  const [header, ...lines] = readFileSync(join(out, 'frames.csv'), 'utf8').trim().split(/\r?\n/);
  const keys = header.split(',');
  const rows = lines.map(line => Object.fromEntries(line.split(',').map((value, i) => [keys[i], Number(value)])));
  const intervals = rows.map(row => row.interval_ms).filter(value => Number.isFinite(value));
  verdict.frames = rows.length;
  verdict.maxFrameIntervalMs = Math.max(...intervals.slice(1));
  const wav = readWav(join(out, 'loopback.wav'));
  const rate = wav.sampleRate;
  const duration = wav.channels[0].length / rate;
  const captureStart = loopbackExit.at - duration;
  const block = Math.round(rate / 100);
  const db = value => 20 * Math.log10(Math.max(value, 1e-12));
  const levels = [];
  for (let i = 0; i + block <= wav.channels[0].length; i += block) {
    let sum = 0;
    for (let c = 0; c < Math.min(2, wav.channels.length); c++) for (let j = i; j < i + block; j++) sum += wav.channels[c][j] ** 2;
    levels.push({ at: captureStart + i / rate, db: db(Math.sqrt(sum / (2 * block))) });
  }
  const onset = levels.find(entry => entry.db > -50) ?? null;
  verdict.soundAt = onset?.at ?? null;
  verdict.captureDelayMs = onset ? (onset.at - switched) * 1000 : null;
  verdict.preSwitchPeakDb = levels.filter(entry => entry.at < switched).reduce((peak, entry) => Math.max(peak, entry.db), null);
  verdict.loopbackSeconds = duration;
  const moveLine = readFileSync(join(out, 'host.err.log'), 'utf8').split(/\r?\n/).find(line => /audio: moved a context to the new default output "[^"]+"\s*$/.test(line));
  const movedAtMs = moveLine?.match(/^\[(\d+)\]/)?.[1];
  verdict.moveLine = moveLine ?? null;
  verdict.moveAt = movedAtMs ? Number(movedAtMs) / 1000 : null;
  verdict.moveDelayMs = verdict.moveAt === null ? null : (verdict.moveAt - switchBefore) * 1000;
  const engine = readWav(join(out, 'out.wav'));
  verdict.engineSilentBlocks = [];
  for (let i = 0; i + block <= engine.channels[0].length; i += block) {
    let sum = 0;
    for (let c = 0; c < Math.min(2, engine.channels.length); c++) for (let j = i; j < i + block; j++) sum += engine.channels[c][j] ** 2;
    if (db(Math.sqrt(sum / (2 * block))) <= -50) verdict.engineSilentBlocks.push(i / engine.sampleRate);
  }
  // The lane's rule: the follower logs a successful move within 1 s, the capture's first sound comes within 1 s of
  // the switch, and no frame interval is over 50 ms. An idle endpoint's WAV has no samples for the silent time before
  // the move, so the capture's onset bounds the sound, and the log line times the move.
  verdict.pass = onset !== null && onset.at >= switchBefore && onset.at - switchBefore <= 1 && verdict.moveLine !== null
    && verdict.moveDelayMs !== null && verdict.moveDelayMs >= 0 && verdict.moveDelayMs <= 1000
    && verdict.maxFrameIntervalMs <= 50 && defaultAfterSwitch === switchId;
} catch (error) {
  verdict.pass = false;
  verdict.error = String(error);
}
writeFileSync(join(out, 'lane9.json'), `${JSON.stringify(verdict, null, 1)}\n`);
console.log(JSON.stringify(verdict));
process.exitCode = verdict.pass ? 0 : 1;
