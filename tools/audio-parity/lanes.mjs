// Collects the raw data for E7's live lanes in one GPU job: host runs with --audio-out into the Steam Streaming
// Speakers virtual device, Edge runs muted, and a WASAPI loopback recording of the virtual device during the lifecycle
// scenarios. analyze.mjs turns it into each lane's verdict and plot. Run it under the GPU lease after
// `npm run build:audio`, `npm run build:scenes` and `npm run build:platform`, and after building the host and the
// loopback tool in one cargo call and copying both to C:/3jsc/swarm/e7/owner/bin/head, since cargo_fresh.py cleans the
// workspace's binaries before each build:
// `cargo build --release -p threejsc-host -p threejsc-audio --features threejsc-audio/output --bins --examples`.
//   node tools/audio-parity/lanes.mjs <out dir> [--base-host <exe>] [--only lane1,lane5,...]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runHost } from './host.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const baseHost = option('base-host') ?? 'C:/3jsc/swarm/e7/owner/bin/base/host.exe';
const only = option('only')?.split(',');
const loopbackExe = 'C:/3jsc/swarm/e7/owner/bin/head/loopback.exe';
const device = 'Speakers (Steam Streaming Speakers)';
const out = resolve(args[0]);
const at = (...parts) => join(out, ...parts);
const fps = 170;
const node = (...rest) => execFileSync(process.execPath, rest, { stdio: 'inherit' });

const lanes = {
  // Lane 1: the platform example and the E3 scenes at the base and at head, and no audio device without a context.
  async lane1() {
    const capture = name => [{ type: 'capture', path: `${name}.png` }];
    for (const [side, exe] of [['base', baseHost], ['head', undefined]]) {
      await runHost('examples/platform/index.js', '', at('lane1', side, 'platform'), { exe, frames: 60, steps: capture('platform'), audio: side === 'head', audioOut: false, args: ['--scene', 'texture'] });
      for (const scene of ['basic-cube', 'materials', 'textures', 'standard-shadow', 'instancing', 'gltf', 'msaa', 'alpha']) {
        await runHost('examples/scenes/index.js', '', at('lane1', side, scene), { exe, frames: 60, steps: capture(scene), audio: side === 'head', audioOut: false, args: ['--scene', scene] });
      }
    }
  },
  // Lanes 2 to 4: every reference graph and decode case through the binding, against Edge's renders.
  async graphs() {
    // Every graph name has a hyphen, so --dump - keeps every render for the plots.
    node('tools/audio-parity/host.mjs', 'graphs', 'C:/3jsc/swarm/e7/owner/spike/edge', at('graphs'), '--dump', '-', '--frames', String(60 * fps));
  },
  // Lane 5: lane 3's graphs in real time with a 200 ms game-thread block in each.
  // A loopback recording of the virtual device shows any sound the device dropped. Then Edge's latency on the same
  // device, which sets the latency limit when it is above 50 ms.
  async lane5() {
    mkdirSync(at('lane5'), { recursive: true });
    const loopback = spawn(loopbackExe, [device, '50', at('lane5', 'loopback.wav')], { stdio: 'inherit' });
    const done = new Promise(r => loopback.on('exit', r));
    await runHost('examples/audio/realtime.js', '', at('lane5'), { frames: 45 * fps });
    await done;
    node('tools/audio-parity/edge-latency.mjs', device, at('lane5', 'edge-latency.json'));
  },
  // Lane 6: Howler with folio's calls; a key press at about 1 s runs Howler's unlock.
  async lane6() {
    const key = down => ({ type: 'key', code: 'KeyA', down });
    await runHost('examples/audio/howler.js', '', at('lane6'), { frames: fps, steps: [key(true), key(false), { type: 'wait', frames: 8 * fps }] });
    node('tools/audio-parity/edge-page.mjs', 'howler.js', at('lane6', 'edge.log'), '--until', 'H done', '--key-on', 'H press a key');
  },
  // Lane 7: three.js's AudioListener, PositionalAudio, AudioAnalyser on the moving cube, in the host and in Edge.
  async lane7() {
    await runHost('examples/audio/index.js', 'frames=600', at('lane7', 'host'), { frames: 660, steps: [{ type: 'capture', path: 'e7-three-frame.png' }] });
    mkdirSync(at('lane7', 'edge'), { recursive: true });
    node('tools/audio-parity/edge-page.mjs', 'index.html', at('lane7', 'edge', 'console.log'), '--hash', 'frames=600', '--until', 'A f=599 ', '--webgpu', '--seconds', '60');
  },
  // Lanes 8 and 10: the lifecycle and unsupported-method scenarios, with a loopback recording of the virtual device.
  async scenarios() {
    mkdirSync(at('scenarios'), { recursive: true });
    const loopback = spawn(loopbackExe, [device, '40', at('scenarios', 'loopback.wav')], { stdio: 'inherit' });
    const done = new Promise(r => loopback.on('exit', r));
    node('tools/audio-parity/host.mjs', 'scenarios', at('scenarios'), '--frames', String(30 * fps));
    await done;
    // currentTime again with no device at all, as the host's tests render.
    node('tools/audio-parity/host.mjs', 'scenarios', at('scenarios', 'none'), '--filter', 'current-time', '--audio-device', 'none', '--frames', String(5 * fps));
  },
};

mkdirSync(out, { recursive: true });
// An idle display drops to a 1024-wide fallback monitor and vsync presents at about 4 fps, which stretches every
// frame-counted wait past the host's time limit.
const width = execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width'], { encoding: 'utf8' }).trim();
if (width === '1024') {
  writeFileSync(at('lanes.json'), `${JSON.stringify([{ ok: false, error: 'the display is asleep; vsync runs at about 4 fps' }])}
`);
  console.error('lanes.mjs: the display is asleep, so nothing ran');
  process.exit(3);
}
const log = [];
for (const [name, run] of Object.entries(lanes)) {
  if (only && !only.includes(name)) continue;
  const started = Date.now();
  try {
    await run();
    log.push({ lane: name, ok: true, seconds: (Date.now() - started) / 1000 });
  } catch (error) {
    log.push({ lane: name, ok: false, error: String(error), seconds: (Date.now() - started) / 1000 });
  }
  console.log(JSON.stringify(log.at(-1)));
}
writeFileSync(at('lanes.json'), `${JSON.stringify(log, null, 1)}\n`);
