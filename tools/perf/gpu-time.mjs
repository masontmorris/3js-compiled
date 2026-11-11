// Compares the GPU time of a scene's frames in Edge and in the native host, from three's timestamp queries. Runs
// alternate Edge and native. Each run draws --warmup frames and then --frames measured frames at --width x --height,
// uncapped on both sides (Edge in a window with vsync and its frame rate limit off, the host with --vsync off), so the
// GPU runs at the same load. A frame's GPU time is the sum of its render passes' timestamp spans, which
// renderer.resolveTimestampsAsync() reports for the last frame each resolution covers, so each side samples the
// measured frames its resolutions reach. Edge runs with --enable-webgpu-developer-features, which turns off its
// 100-microsecond timestamp quantization. nvidia-smi records the GPU's performance state through every run.
// typeperf records the machine's total CPU load each second, and a run whose mean load is over 40 percent is void,
// because other work on the machine can skew it. The rule uses the runs that are not void, and it fails when the
// native median exceeds Edge's by more than --margin (default 0.1).
// Usage, from the repository root, under the GPU lease:
//   node tools/perf/gpu-time.mjs [--scene post] [--runs 3] [--warmup 120] [--frames 600] [--width 1920] [--height 1080]
//     [--host C:/3jsc/target/release/host.exe] [--out target/gpu-time] [--margin 0.1]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const options = { scene: 'post', runs: 3, warmup: 120, frames: 600, width: 1920, height: 1080, host: 'C:/3jsc/target/release/host.exe', out: 'target/gpu-time', margin: 0.1 };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  if (!(key in options) || args[i + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  options[key] = typeof options[key] === 'number' ? Number(args[i + 1]) : args[i + 1];
}
const root = resolve('.');
const out = resolve(options.out);
await mkdir(out, { recursive: true });
const sorted = values => values.toSorted((a, b) => a - b);
const quantile = (values, share) => sorted(values)[Math.min(values.length - 1, Math.floor(values.length * share))];
const callTimeout = 60000;
// Rejects when `promise` takes longer than a DevTools call may, naming the step.
const call = (step, promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${step} passed 60 s`)), callTimeout).unref())]);

// The page script: it keeps the GPU time of each measured frame, numbered as three numbers frames, and prints them
// once a resolution reaches past the measured frames.
const script = native => `globalThis.__gpuTime = {
  first: ${options.warmup}, last: ${options.warmup + options.frames}, samples: new Map(), done: false,
  record(ms, frame) {
    if (this.done || frame === undefined || frame <= this.first) return;
    if (frame > this.last) {
      this.done = true;
      console.log('gpu-time ' + JSON.stringify([...this.samples]));
      ${native ? '' : 'globalThis.__gpuTimeDone = true;'}
      return;
    }
    this.samples.set(frame, ms);
  },
};`;

const gpuSamples = [];
const smi = spawn('nvidia-smi', ['--query-gpu=pstate,clocks.gr', '--format=csv,noheader,nounits', '-lms', '250'], { stdio: ['ignore', 'pipe', 'ignore'] });
smi.on('error', () => {});
createInterface({ input: smi.stdout }).on('line', line => {
  const [pstate, clock] = line.split(',').map(part => part.trim());
  gpuSamples.push({ at: Date.now(), pstate, clock: Number(clock) });
});
const cpuSamples = [];
const cpu = spawn('typeperf', ['\\Processor(_Total)\\% Processor Time', '-si', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
cpu.on('error', () => {});
createInterface({ input: cpu.stdout }).on('line', line => {
  const value = Number(/^"[^"]*","([\d.]+)"/.exec(line)?.[1]);
  if (Number.isFinite(value)) cpuSamples.push({ at: Date.now(), value });
});
const cpuDuring = (from, to) => {
  const window = cpuSamples.filter(sample => sample.at >= from && sample.at <= to).map(sample => sample.value);
  return window.length ? window.reduce((a, b) => a + b, 0) / window.length : null;
};
const gpuDuring = (from, to) => {
  const window = gpuSamples.filter(sample => sample.at >= from && sample.at <= to);
  return { samples: window.length, p0: window.filter(sample => sample.pstate === 'P0').length, clockMedian: window.length ? quantile(window.map(sample => sample.clock), 0.5) : null };
};

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const page = `<!doctype html><html><head><meta charset="utf-8"><title>gpu time</title></head>
<body style="margin:0"><canvas width="${options.width}" height="${options.height}"></canvas><script type="module" src="/examples/scenes/index.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/gpu-time.html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(page);
      return;
    }
    const file = resolve(root, '.' + decodeURIComponent(path));
    const rel = relative(root, file);
    if (rel.startsWith('..' + sep) || rel === '..') throw new Error('Invalid path');
    const bytes = await readFile(file);
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));

const summary = (side, run, samples, from, to, extra = {}) => {
  const times = samples.map(([, ms]) => ms);
  const cpuLoad = cpuDuring(from, to);
  return { side, run, samples: times.length, p50: quantile(times, 0.5), p95: quantile(times, 0.95), min: Math.min(...times), max: Math.max(...times), gpu: gpuDuring(from, to), cpuLoad, void: cpuLoad === null || cpuLoad > 40, ...extra };
};

async function edge(run) {
  const profile = await mkdtemp(resolve(tmpdir(), 'threejsc-gpu-time-edge-'));
  let step = 'launch';
  const deadline = setTimeout(() => {
    console.log(`TIMEOUT: Edge run ${run} passed 5 minutes at ${step}`);
    process.exit(2);
  }, 300000);
  try {
    const context = await call(step, chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: false, viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1,
      args: ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11',
        '--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion', '--window-position=0,0',
        `--window-size=${options.width},${options.height + 200}`],
    }));
    try {
      const tab = context.pages()[0] ?? await call('newPage', context.newPage());
      const errors = [];
      tab.on('pageerror', error => errors.push(String(error)));
      await tab.addInitScript(script(false));
      step = 'goto';
      await call(step, tab.goto(`http://127.0.0.1:${server.address().port}/gpu-time.html?scene=${options.scene}`));
      const from = Date.now();
      step = 'measured frames';
      await call(step, tab.waitForFunction(() => globalThis.__gpuTimeDone || globalThis.__sceneError, null, { timeout: callTimeout, polling: 250 }));
      const to = Date.now();
      step = 'read samples';
      const { samples, error, size } = await call(step, tab.evaluate(() => ({
        samples: [...(globalThis.__gpuTime.samples ?? [])], error: globalThis.__sceneError ?? null,
        size: `${globalThis.__scene?.renderer.domElement.width}x${globalThis.__scene?.renderer.domElement.height}`,
      })));
      if (error || errors.length) throw new Error(`Edge scene failed: ${error ?? errors.join('; ')}`);
      return summary('edge', run, samples, from, to, { drawingBuffer: size, userAgent: await call('userAgent', tab.evaluate(() => navigator.userAgent)) });
    } finally {
      await Promise.race([context.close(), new Promise(ok => setTimeout(ok, 20000))]);
    }
  } catch (error) {
    throw new Error(`Edge run ${run} failed at ${step}: ${error.message}`);
  } finally {
    clearTimeout(deadline);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function native(run) {
  const dir = resolve(out, `native-${run}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'entry.js'), `${script(true)}\nglobalThis.__sceneName = ${JSON.stringify(options.scene)};\nawait import(${JSON.stringify(pathToFileURL(resolve(root, 'examples/scenes/index.js')).href)});\n`);
  await writeFile(resolve(dir, 'steps.json'), JSON.stringify([
    { type: 'resize', width: options.width, height: options.height },
    { type: 'wait', frames: options.warmup + options.frames + 120 },
    { type: 'close' },
  ]));
  const from = Date.now();
  const child = spawn(options.host, ['--entry', resolve(dir, 'entry.js'), '--scene', options.scene, '--script', 'steps.json', '--vsync', 'off'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let samples = null;
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', line => {
      const match = /gpu-time (\[.*\])$/.exec(line);
      if (match) samples = JSON.parse(match[1]);
    });
  }
  const timer = setTimeout(() => child.kill(), 300000);
  const code = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('exit', resolveExit);
  });
  clearTimeout(timer);
  const to = Date.now();
  if (code !== 0) throw new Error(`Host exited with code ${code}; see ${dir}/host.log`);
  if (!samples) {
    const log = await readFile(resolve(dir, 'host.log'), 'utf8').catch(() => '');
    samples = JSON.parse(/gpu-time (\[.*\])/.exec(log)?.[1] ?? 'null');
  }
  if (!samples) throw new Error(`Native run ${run} printed no GPU times; see ${dir}/host.log`);
  return summary('native', run, samples, from, to);
}

const results = [];
try {
  for (let run = 1; run <= options.runs; run++) {
    for (const side of [edge, native]) {
      const result = await side(run);
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
} finally {
  smi.kill();
  cpu.kill();
  server.close();
}
const counted = side => results.filter(result => result.side === side && !result.void);
const medianOf = side => quantile(counted(side).map(result => result.p50), 0.5);
const verdict = { scene: options.scene, size: `${options.width}x${options.height}`, edgeP50: medianOf('edge'), nativeP50: medianOf('native') };
verdict.limit = verdict.edgeP50 * (1 + options.margin);
verdict.counted = { edge: counted('edge').length, native: counted('native').length };
verdict.pass = verdict.counted.edge > 0 && verdict.counted.native > 0 && verdict.nativeP50 <= verdict.limit;
console.log(`GPU time p50 over ${verdict.counted.edge} Edge and ${verdict.counted.native} native runs under 40% CPU of ${options.runs} each: Edge ${verdict.edgeP50.toFixed(3)} ms, native ${verdict.nativeP50.toFixed(3)} ms, limit ${verdict.limit.toFixed(3)} ms: ${verdict.pass ? 'PASS' : 'FAIL'}`);
await writeFile(resolve(out, 'gpu-time.json'), JSON.stringify({ options, results, verdict }, null, 2));
