// Compares the GPU time of a scene's post-processing chain in Edge and in the native host, from three's timestamp
// queries. Runs alternate Edge and native and pair up in that order. Each run draws --warmup frames and then --frames
// measured frames at --width x --height, with Edge in a window. --vsync off runs both uncapped, Edge with vsync and its
// frame rate limit off and the host with --vsync off, which keeps the GPU's clocks up; --vsync on (the default) paces
// both to the display, where the driver lowers the lighter side's clocks.
// renderer.resolveTimestampsAsync() reports the passes of the last frame each resolution covers. A frame's chain time
// sums its render passes from render call --chain-from (2) on, which leaves out the scene pass that RenderPipeline's
// pass() draws first, and its whole time sums every render pass; the rule uses the chain. three resolves again only
// once its last map of the result buffer resolves. Uncapped, Edge's map took about 350 ms (lane P: 5 resolutions 111
// frames apart over 1.4 s), while the host answers a map two frames after it, so a 600-frame run has about 5 Edge
// samples and 300 native ones. Edge runs with
// --enable-webgpu-developer-features, which turns off its 100-microsecond timestamp quantization.
// nvidia-smi records the graphics and memory clocks every 50 ms. tools/perf/gpu-time-rule.mjs judges each pair: it
// is void when the two sides' median graphics clocks differ by more than 5 percent either way or a side has under 10
// clock samples. The verdict needs at least 3 counted pairs, and the rule fails when the native chain median of the
// counted runs exceeds Edge's by more than --margin (0.1). CPU load does not drive a GPU duration, so each run's background load, the machine's total less the run's own
// processes, is only recorded.
// Usage, from the repository root, under the GPU lease and C:\3jsc\tools\quiet_run.py:
//   node tools/perf/gpu-time.mjs [--scene post] [--runs 3] [--warmup 120] [--frames 600] [--width 1920] [--height 1080]
//     [--host C:/3jsc/target/release/host.exe] [--out target/gpu-time] [--margin 0.1] [--vsync on] [--chain-from 2]
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { extname, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { frameTimes, judge } from './gpu-time-rule.mjs';

const options = { scene: 'post', runs: 3, warmup: 120, frames: 600, width: 1920, height: 1080, host: 'C:/3jsc/target/release/host.exe', out: 'target/gpu-time', margin: 0.1, vsync: 'on', chainFrom: 2 };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '').replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
  if (!(key in options) || args[i + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  options[key] = typeof options[key] === 'number' ? Number(args[i + 1]) : args[i + 1];
}
if (!['on', 'off'].includes(options.vsync)) throw new Error('--vsync is on or off');
const root = resolve('.');
const out = resolve(options.out);
await mkdir(out, { recursive: true });
const sorted = values => values.toSorted((a, b) => a - b);
const quantile = (values, share) => sorted(values)[Math.min(values.length - 1, Math.floor(values.length * share))];
const callTimeout = 60000;
// Rejects when `promise` takes longer than a DevTools call may, naming the step.
const call = (step, promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${step} passed 60 s`)), callTimeout).unref())]);

// The page script: it keeps the timestamp entries of each measured frame, numbered as three numbers frames, and the
// wall-clock window from the first measured sample to the end, and prints them once a resolution reaches past the
// measured frames. The CPU load and the GPU's clocks count over that window, which leaves out the page's load and warm-up.
const script = native => `globalThis.__gpuTime = {
  first: ${options.warmup}, last: ${options.warmup + options.frames}, samples: new Map(), done: false,
  record(ms, frame) {
    if (this.done || frame === undefined || frame <= this.first) return;
    if (frame > this.last) {
      this.done = true;
      this.to = Date.now();
      console.log('gpu-time ' + JSON.stringify({ from: this.from, to: this.to, samples: [...this.samples] }));
      ${native ? '' : 'globalThis.__gpuTimeDone = true;'}
      return;
    }
    this.from ??= Date.now();
    const pool = globalThis.__scene?.renderer.backend.timestampQueryPool?.render;
    const suffix = ':f' + frame;
    this.samples.set(frame, [...(pool?.timestamps ?? [])].filter(([uid]) => uid.endsWith(suffix)));
  },
};`;

// GPU graphics and memory clocks every 50 ms, stamped on arrival.
const gpuSamples = [];
const smi = spawn('nvidia-smi', ['--query-gpu=clocks.gr,clocks.mem', '--format=csv', '-lms', '50'], { stdio: ['ignore', 'pipe', 'ignore'] });
smi.on('error', () => {});
createInterface({ input: smi.stdout }).on('line', line => {
  const [graphics, memory] = [...line.matchAll(/(\d+) MHz/g)].map(match => Number(match[1]));
  if (memory !== undefined) gpuSamples.push({ at: Date.now(), graphics, memory });
});
const gpuDuring = (from, to) => {
  const window = gpuSamples.filter(sample => sample.at >= from && sample.at <= to);
  const median = key => window.length ? quantile(window.map(sample => sample[key]), 0.5) : null;
  return { samples: window.length, graphicsMedian: median('graphics'), memoryMedian: median('memory') };
};
// The machine's total CPU load each second, and the CPU seconds of every host and msedge process each second, so a
// run's background load is the total less its own processes' share.
const cpuSamples = [];
const cpu = spawn('typeperf', ['\\Processor(_Total)\\% Processor Time', '-si', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
cpu.on('error', () => {});
createInterface({ input: cpu.stdout }).on('line', line => {
  const value = Number(/^"[^"]*","([\d.]+)"/.exec(line)?.[1]);
  if (Number.isFinite(value)) cpuSamples.push({ at: Date.now(), value });
});
const processSamples = [];
const processes = spawn('powershell', ['-NoProfile', '-Command', 'while ($true) { $t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); Get-Process host, msedge -ErrorAction SilentlyContinue | ForEach-Object { "$t $($_.Id) $($_.CPU)" }; Start-Sleep -Milliseconds 1000 }'], { stdio: ['ignore', 'pipe', 'ignore'] });
processes.on('error', () => {});
createInterface({ input: processes.stdout }).on('line', line => {
  const [at, pid, seconds] = line.trim().split(' ').map(Number);
  if (Number.isFinite(seconds)) processSamples.push({ at, pid, seconds });
});
const cores = availableParallelism();
const cpuDuring = (from, to, pids) => {
  const total = cpuSamples.filter(sample => sample.at >= from && sample.at <= to).map(sample => sample.value);
  if (!total.length) return { total: null, own: null, background: null };
  let ownSeconds = 0;
  for (const pid of pids) {
    const mine = processSamples.filter(sample => sample.pid === pid);
    const first = mine.findLast(sample => sample.at <= from) ?? mine.find(sample => sample.at >= from);
    const last = mine.find(sample => sample.at >= to) ?? mine.findLast(sample => sample.at <= to);
    if (first && last) ownSeconds += last.seconds - first.seconds;
  }
  const totalMean = total.reduce((a, b) => a + b, 0) / total.length;
  const own = ownSeconds / ((to - from) / 1000) / cores * 100;
  return { total: totalMean, own, background: Math.max(0, totalMean - own) };
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

const summary = (side, run, samples, from, to, pids, extra = {}) => {
  const frames = samples.map(([, entries]) => frameTimes(entries, options.chainFrom));
  const chain = frames.map(frame => frame.chain);
  const whole = frames.map(frame => frame.whole);
  return {
    side, run, samples: frames.length, passesPerFrame: [...new Set(frames.map(frame => frame.passes))],
    chainP50: quantile(chain, 0.5), chainP95: quantile(chain, 0.95), wholeP50: quantile(whole, 0.5), wholeP95: quantile(whole, 0.95),
    gpu: gpuDuring(from, to), cpu: cpuDuring(from, to, pids), ...extra,
  };
};
// The PIDs of the Edge that uses `profile`.
const edgePids = profile => {
  const name = profile.split(/[\\/]/).pop();
  const found = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${name}*' } | ForEach-Object ProcessId`], { encoding: 'utf8' });
  return found.stdout.split(/\s+/).filter(Boolean).map(Number);
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
        ...(options.vsync === 'off' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
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
      step = 'measured frames';
      await call(step, tab.waitForFunction(() => globalThis.__gpuTimeDone || globalThis.__sceneError, null, { timeout: callTimeout, polling: 250 }));
      step = 'read samples';
      const { samples, from, to, error, size } = await call(step, tab.evaluate(() => ({
        samples: [...(globalThis.__gpuTime.samples ?? [])], from: globalThis.__gpuTime.from, to: globalThis.__gpuTime.to, error: globalThis.__sceneError ?? null,
        size: `${globalThis.__scene?.renderer.domElement.width}x${globalThis.__scene?.renderer.domElement.height}`,
      })));
      if (error || errors.length) throw new Error(`Edge scene failed: ${error ?? errors.join('; ')}`);
      return summary('edge', run, samples, from, to, edgePids(profile), { drawingBuffer: size, userAgent: await call('userAgent', tab.evaluate(() => navigator.userAgent)) });
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
  const child = spawn(options.host, ['--entry', resolve(dir, 'entry.js'), '--scene', options.scene, '--script', 'steps.json', '--vsync', options.vsync], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let measured = null;
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', line => {
      const match = /gpu-time (\{.*\})$/.exec(line);
      if (match) measured = JSON.parse(match[1]);
    });
  }
  const timer = setTimeout(() => child.kill(), 300000);
  const code = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('exit', resolveExit);
  });
  clearTimeout(timer);
  if (code !== 0) throw new Error(`Host exited with code ${code}; see ${dir}/host.log`);
  if (!measured) {
    const log = await readFile(resolve(dir, 'host.log'), 'utf8').catch(() => '');
    measured = JSON.parse(/gpu-time (\{.*\})/.exec(log)?.[1] ?? 'null');
  }
  if (!measured) throw new Error(`Native run ${run} printed no GPU times; see ${dir}/host.log`);
  return summary('native', run, measured.samples, measured.from, measured.to, [child.pid]);
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
  processes.kill();
  server.close();
}
const verdict = { scene: options.scene, size: `${options.width}x${options.height}`, vsync: options.vsync, ...judge(results, options.margin) };
for (const pair of verdict.pairs) console.log(`pair ${pair.run}: ${pair.counted ? 'counted' : `not counted, ${pair.reason}`}`);
const ms = value => value === null ? 'none' : `${value.toFixed(4)} ms`;
console.log(`Chain GPU time p50 over ${verdict.counted} counted pairs: Edge ${ms(verdict.edge.chainP50)}, native ${ms(verdict.native.chainP50)}, limit ${ms(verdict.limit)}: ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ''}; whole frame Edge ${ms(verdict.edge.wholeP50)}, native ${ms(verdict.native.wholeP50)}`);
await writeFile(resolve(out, 'gpu-time.json'), JSON.stringify({ options, results, verdict }, null, 2));
