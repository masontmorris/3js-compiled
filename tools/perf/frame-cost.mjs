// Compares the native host with Edge on uncapped frame rate and on CPU time per frame, summed over
// every process involved: host.exe natively, and every msedge process (browser, GPU, renderer,
// utility) in Edge. Runs alternate Edge and native. Run it under the GPU lease.
// Edge runs in a window by default, so both sides present every frame to the desktop compositor;
// --edge headless measures headless Edge, which renders without presenting.
// Usage, from the repository root:
//   node tools/perf/frame-cost.mjs [--scene instancing] [--runs 3] [--warmup 300] [--frames 1500]
//     [--width 1920] [--height 1080] [--edge headed] [--host C:/3jsc/target/release/host.exe] [--out target/perf]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const options = { scene: 'instancing', runs: 3, warmup: 300, frames: 1500, width: 1920, height: 1080, edge: 'headed', host: 'C:/3jsc/target/release/host.exe', out: 'target/perf' };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  if (!(key in options) || args[i + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  options[key] = typeof options[key] === 'number' ? Number(args[i + 1]) : args[i + 1];
}
if (options.frames < 1500 || options.warmup < 300) throw new Error('The E3 rule needs at least 1,500 frames after a 300-frame warm-up');
if (!['headed', 'headless'].includes(options.edge)) throw new Error('--edge is headed or headless');
const root = resolve('.');
const out = resolve(options.out);
await mkdir(out, { recursive: true });
const probe = await readFile(resolve(root, 'tools/perf/probe.js'), 'utf8');
const probeConfig = go => `globalThis.__perfProbe = ${JSON.stringify({ warmup: options.warmup, frames: options.frames, go })};`;

const sampler = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'tools/perf/sampler.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
const samplerLines = createInterface({ input: sampler.stdout })[Symbol.asyncIterator]();
async function ask(line) {
  sampler.stdin.write(line + '\n');
  const { value } = await samplerLines.next();
  if (value === undefined || value.startsWith('error')) throw new Error(`CPU sampler failed on "${line}": ${value}`);
  return value;
}
const cpu = async ids => ids.length ? Number(await ask(`cpu ${ids.join(',')}`)) : 0;
const discover = async text => (await ask(`discover ${text}`)).split(',').filter(Boolean).map(Number);

// Resolves each "perf <name> <json>" line once, in order of arrival.
function marks() {
  const waiting = new Map();
  const arrived = new Map();
  return {
    line(text) {
      const match = /^perf (\w+) (.*)$/.exec(text);
      if (!match) return;
      const value = JSON.parse(match[2]);
      if (waiting.has(match[1])) waiting.get(match[1])(value);
      else arrived.set(match[1], value);
    },
    wait(name, timeout = 120000) {
      if (arrived.has(name)) return Promise.resolve(arrived.get(name));
      return new Promise((resolveMark, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for perf ${name}`)), timeout);
        waiting.set(name, value => { clearTimeout(timer); resolveMark(value); });
      });
    },
  };
}

// Samples CPU at the start and end marks. Processes that appear during the window count in full.
async function measure(mark, ids, more) {
  const startMark = await mark.wait('start');
  const before = await cpu(ids);
  const end = await mark.wait('end');
  const after = await cpu(ids);
  const late = (await more()).filter(id => !ids.includes(id));
  const cpuMs = after - before + await cpu(late);
  return {
    drawingBuffer: startMark.drawingBuffer,
    processes: ids.length + late.length,
    fps: options.frames / (end.elapsedMs / 1000),
    cpuMsPerFrame: cpuMs / options.frames,
    callbackP50: end.callbackP50,
    callbackP95: end.callbackP95,
  };
}

const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const page = `<!doctype html><html><head><meta charset="utf-8"><title>frame cost</title></head><body style="margin:0"><canvas width="${options.width}" height="${options.height}"></canvas><script type="module" src="/examples/scenes/index.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  const headers = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' };
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/perf.html') {
      response.writeHead(200, { ...headers, 'content-type': 'text/html' });
      response.end(page);
      return;
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    const rel = relative(root, path);
    if (rel.startsWith('..' + sep) || rel === '..') throw new Error('Invalid path');
    const bytes = await readFile(path);
    response.writeHead(200, { ...headers, 'content-type': mime[extname(path)] ?? 'application/octet-stream' });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));

async function edge(run) {
  const profile = await mkdtemp(resolve(tmpdir(), 'threejsc-perf-edge-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: options.edge === 'headless', viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--disable-gpu-vsync', '--disable-frame-rate-limit',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion', '--window-position=0,0', `--window-size=${options.width},${options.height + 200}`],
  });
  try {
    const mark = marks();
    const tab = context.pages()[0] ?? await context.newPage();
    const errors = [];
    const consoleLines = [];
    tab.on('console', message => { consoleLines.push(message.text()); mark.line(message.text()); });
    tab.on('pageerror', error => errors.push(String(error)));
    await tab.addInitScript(`${probeConfig(false)}\n${probe}`);
    await tab.goto(`http://127.0.0.1:${server.address().port}/perf.html?scene=${options.scene}`);
    await tab.waitForFunction(() => globalThis.__scene || globalThis.__sceneError, null, { timeout: 60000 });
    const sceneError = await tab.evaluate(() => globalThis.__sceneError ?? null);
    if (sceneError || errors.length) throw new Error(`Edge scene failed: ${sceneError ?? errors.join('; ')}`);
    const ids = await discover(profile);
    await tab.evaluate(() => { globalThis.__perfProbe.go = true; });
    const result = await measure(mark, ids, () => discover(profile)).catch(async error => {
      const state = await tab.evaluate(() => ({ probe: globalThis.__perfProbe, count: globalThis.__perfCount, ready: globalThis.__sceneReady })).catch(String);
      throw new Error(`${error.message}; page state ${JSON.stringify(state)}; console ${JSON.stringify(consoleLines.slice(-5))}`);
    });
    if (errors.length) throw new Error(`Edge page errors: ${errors.join('; ')}`);
    return { side: 'edge', run, userAgent: await tab.evaluate(() => navigator.userAgent), ...result };
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function native(run) {
  const dir = resolve(out, `native-${run}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'probe.js'), probe);
  await writeFile(resolve(dir, 'entry.js'), `${probeConfig(true)}\nawait import(${JSON.stringify(pathToFileURL(resolve(dir, 'probe.js')).href)});\nawait import(${JSON.stringify(pathToFileURL(resolve(root, 'examples/scenes/index.js')).href)});\n`);
  await writeFile(resolve(dir, 'steps.json'), JSON.stringify([
    { type: 'resize', width: options.width, height: options.height },
    { type: 'wait', frames: options.warmup + options.frames + 30 },
    { type: 'close' },
  ]));
  const child = spawn(options.host, ['--entry', resolve(dir, 'entry.js'), '--scene', options.scene, '--script', 'steps.json', '--vsync', 'off'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const mark = marks();
  child.stdout.resume();
  createInterface({ input: child.stderr }).on('line', line => mark.line(line));
  const exit = new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('exit', code => resolveExit(code));
  });
  const result = await measure(mark, [child.pid], async () => []);
  const code = await exit;
  if (code !== 0) throw new Error(`Host exited with code ${code}; see ${dir}/host.log`);
  const [header, ...lines] = (await readFile(resolve(dir, 'frames.csv'), 'utf8')).trim().split(/\r?\n/);
  const columns = header.split(',');
  const rows = lines.slice(options.warmup, options.warmup + options.frames).map(row => row.split(',').map(Number));
  const p50 = name => median(rows.map(row => row[columns.indexOf(name)]));
  return { side: 'native', run, ...result, hostCpuMsP50: p50('cpu_ms'), renderCpuMsP50: p50('render_cpu_ms'), hostIntervalMsP50: p50('interval_ms') };
}

const results = [];
try {
  for (let run = 1; run <= options.runs; run++) {
    for (const side of [edge, native]) {
      const result = await side(run);
      results.push(result);
      console.log(`${result.side} run ${run}: ${result.fps.toFixed(0)} fps, ${result.cpuMsPerFrame.toFixed(3)} CPU ms per frame over ${result.processes} processes, callback p50 ${result.callbackP50.toFixed(3)} ms, drawing buffer ${result.drawingBuffer}${result.side === 'native' ? `, game thread CPU p50 ${result.hostCpuMsP50.toFixed(3)} ms, render thread CPU p50 ${result.renderCpuMsP50.toFixed(3)} ms, interval p50 ${result.hostIntervalMsP50.toFixed(3)} ms` : ''}`);
    }
  }
} finally {
  sampler.stdin.end();
  await new Promise(resolveClose => server.close(resolveClose));
}
const summary = Object.fromEntries(['edge', 'native'].map(side => {
  const runs = results.filter(result => result.side === side);
  return [side, {
    fps: median(runs.map(result => result.fps)),
    cpuMsPerFrame: median(runs.map(result => result.cpuMsPerFrame)),
    callbackP50: median(runs.map(result => result.callbackP50)),
  }];
}));
const fpsWorse = 1 - summary.native.fps / summary.edge.fps;
const cpuWorse = summary.native.cpuMsPerFrame / summary.edge.cpuMsPerFrame - 1;
const verdict = fpsWorse > 0.1 || cpuWorse > 0.1 ? 'FAIL' : 'PASS';
const report = { options, results, summary, nativeFpsShortfall: fpsWorse, nativeCpuExcess: cpuWorse, verdict };
await writeFile(resolve(out, 'frame-cost.json'), JSON.stringify(report, null, 2));
console.log(`median fps: Edge ${summary.edge.fps.toFixed(0)}, native ${summary.native.fps.toFixed(0)} (native ${(fpsWorse * 100).toFixed(1)}% lower)`);
console.log(`median CPU ms per frame: Edge ${summary.edge.cpuMsPerFrame.toFixed(3)}, native ${summary.native.cpuMsPerFrame.toFixed(3)} (native ${(cpuWorse * 100).toFixed(1)}% higher)`);
console.log(`median JavaScript frame callback p50 (information only): Edge ${summary.edge.callbackP50.toFixed(3)} ms, native ${summary.native.callbackP50.toFixed(3)} ms`);
console.log(`E3 perf rule (fail when native is more than 10% worse on either number): ${verdict}`);
