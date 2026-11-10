// Compares the native host with Edge on uncapped presented frames per second and on CPU time per
// frame, summed over every process involved: host.exe natively, and every msedge process (browser,
// GPU, renderer, utility) in Edge. Runs alternate Edge and native. Run it under the GPU lease.
// A PresentMon capture through --presentmon spans each run and counts the presents of that run's
// processes inside the measured window. A run counts only when its warm-up lasts at least 3 s, its
// measured frames at least 10 s, the GPU stays at P0 in every nvidia-smi sample of the measured
// window, the rest of the machine averages at most one core over its baseline, and its capture
// spans the window with no gap between presents over 100 ms, because PresentMon can lose events
// without saying so. The baseline is 5 s of the machine's load before the run, with nothing
// measured running, and the tool waits while it is over 3 cores. The tool runs Edge and native pairs until each side has --runs counted runs, or
// --max-runs pairs have run, or a capture is unavailable, and the rule's verdict uses counted runs
// only.
// Edge runs in a window by default, so both sides present to the desktop compositor; --edge
// headless measures headless Edge, which presents nothing, so its runs never count.
// Usage, from the repository root:
//   node tools/perf/frame-cost.mjs [--scene instancing] [--runs 3] [--max-runs 6] [--warmup 12000] [--frames 36000]
//     [--width 1920] [--height 1080] [--edge headed] [--host C:/3jsc/target/release/host.exe] [--out target/perf]
//     [--capture-seconds 50] [--presentmon C:/3jsc/tools/presentmon/capture.py]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { busyBaselineCores, load, loadRejection, quietBaseline } from './load.mjs';
import { countPresents, qpcNow, startCapture } from './presentmon.mjs';

const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

const options = { scene: 'instancing', runs: 3, maxRuns: 6, warmup: 12000, frames: 36000, width: 1920, height: 1080, edge: 'headed', host: 'C:/3jsc/target/release/host.exe', out: 'target/perf', captureSeconds: 50, presentmon: 'C:/3jsc/tools/presentmon/capture.py' };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '').replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
  if (!(key in options) || args[i + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  options[key] = typeof options[key] === 'number' ? Number(args[i + 1]) : args[i + 1];
}
const minimum = { warmupMs: 3000, windowMs: 10000, presentGapMs: 100 };
if (!(options.frames >= 1 && options.warmup >= 1 && options.runs >= 1 && options.maxRuns >= options.runs)) throw new Error('--frames, --warmup and --runs must be positive, and --max-runs at least --runs');
if (!(Number.isInteger(options.captureSeconds) && options.captureSeconds >= 1 && options.captureSeconds <= 120)) throw new Error('--capture-seconds is a whole number from 1 to 120');
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
// The busy CPU milliseconds of every processor, which counts every process, including elevated and short-lived ones,
// and the DPC and interrupt milliseconds inside them.
async function machine() {
  const [busyMs, dpcMs, interruptMs] = (await ask('machine')).split(',').map(Number);
  return { busyMs, dpcMs, interruptMs };
}

// GPU state every 250 ms, stamped on arrival.
const gpuSamples = [];
const gpu = spawn('nvidia-smi', ['--query-gpu=pstate,clocks.gr', '--format=csv,noheader,nounits', '-lms', '250'], { stdio: ['ignore', 'pipe', 'ignore'] });
gpu.on('error', () => {});
createInterface({ input: gpu.stdout }).on('line', line => {
  const [pstate, clock] = line.split(',').map(part => part.trim());
  gpuSamples.push({ at: Date.now(), pstate, clock: Number(clock) });
});

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
// The other load is the machine's busy time over the window less its DPC and interrupt time and the
// measured processes' CPU time, and it counts against `baseline`, the load before the run.
async function measure(mark, ids, more, baseline) {
  const startMark = await mark.wait('start');
  const startedAt = Date.now();
  const qpcStart = qpcNow();
  const before = await cpu(ids);
  const machineBefore = await machine();
  const end = await mark.wait('end');
  const endedAt = Date.now();
  const qpcEnd = qpcNow();
  const after = await cpu(ids);
  const machineAfter = await machine();
  const late = (await more()).filter(id => !ids.includes(id));
  const cpuMs = after - before + await cpu(late);
  const window = gpuSamples.filter(sample => sample.at >= startedAt && sample.at <= endedAt);
  const clocks = window.map(sample => sample.clock).toSorted((a, b) => a - b);
  const run = {
    drawingBuffer: startMark.drawingBuffer,
    processes: ids.length + late.length,
    fps: options.frames / (end.elapsedMs / 1000),
    cpuMsPerFrame: cpuMs / options.frames,
    callbackP50: end.callbackP50,
    callbackP95: end.callbackP95,
    warmupMs: startMark.warmupMs,
    windowMs: end.elapsedMs,
    qpcStart,
    qpcEnd,
    baselineCores: baseline.otherCores,
    ...load(machineBefore, machineAfter, endedAt - startedAt, cpuMs),
    gpu: { samples: window.length, pstates: [...new Set(window.map(sample => sample.pstate))], clockMin: clocks[0], clockMedian: median(clocks), clockMax: clocks.at(-1) },
  };
  const rejected = [
    run.warmupMs < minimum.warmupMs && `warm-up ${run.warmupMs.toFixed(0)} ms is under ${minimum.warmupMs} ms`,
    run.windowMs < minimum.windowMs && `measured window ${run.windowMs.toFixed(0)} ms is under ${minimum.windowMs} ms`,
    (window.length === 0 || window.some(sample => sample.pstate !== 'P0')) && `GPU not at P0 in every sample (${run.gpu.pstates.join('/') || 'no samples'})`,
    loadRejection(run),
  ].filter(Boolean);
  return { ...run, counted: rejected.length === 0, rejected };
}

// Waits for the run's capture and counts the presents of `ids` between the start and end marks, and for Edge in
// `idle`, a second after the page stopped drawing. A capture that fails leaves `presents` null and the run
// uncounted, and a capture that may not span the window leaves the run uncounted.
async function withPresents(result, capture, ids, idle) {
  let presents = null;
  const rejected = [];
  try {
    const text = await capture.collect();
    const window = countPresents(text, ids, result.qpcStart, result.qpcEnd);
    const seconds = (result.qpcEnd - result.qpcStart) / 1000;
    presents = { presentedFps: window.presented / seconds, displayedFps: window.displayed / seconds, ...window };
    if (idle) presents.idlePresentsPerSecond = countPresents(text, ids, idle.from, idle.to).presented / ((idle.to - idle.from) / 1000);
    if (window.largestGapMs > minimum.presentGapMs) rejected.push(`the capture has ${window.largestGapMs.toFixed(0)} ms without a present inside the window, so it may have lost presents`);
    if (window.before === 0) rejected.push('the capture has no present of the run before its window, so it may have started late');
    if (Math.max(result.qpcEnd, idle?.to ?? 0) > capture.capturedUntil) rejected.push(`the capture may end before the window; raise --capture-seconds above ${options.captureSeconds}`);
  } catch (error) {
    rejected.push(`PresentMon capture unavailable: ${error.message.trim()}`);
  }
  rejected.unshift(...result.rejected);
  return { ...result, presents, counted: rejected.length === 0, rejected };
}

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

// After the window, the page stops drawing, and the presents in the second that follows show whether Edge's
// presents track the page's canvas or come from something else, such as the browser's own frame.
async function edge(run, capture, baseline) {
  const profile = await mkdtemp(resolve(tmpdir(), 'threejsc-perf-edge-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: options.edge === 'headless', viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--disable-gpu-vsync', '--disable-frame-rate-limit',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion', '--window-position=0,0', `--window-size=${options.width},${options.height + 200}`],
  });
  let measured;
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
    const result = await measure(mark, ids, () => discover(profile), baseline).catch(async error => {
      const state = await tab.evaluate(() => ({ probe: globalThis.__perfProbe, count: globalThis.__perfCount, ready: globalThis.__sceneReady })).catch(String);
      throw new Error(`${error.message}; page state ${JSON.stringify(state)}; console ${JSON.stringify(consoleLines.slice(-5))}`);
    });
    await tab.evaluate(() => { globalThis.__perfProbe.stop = true; });
    const stoppedAt = qpcNow();
    await sleep(1500);
    if (errors.length) throw new Error(`Edge page errors: ${errors.join('; ')}`);
    const every = new Set([...ids, ...await discover(profile)]);
    const gpuProcesses = (await discover('--type=gpu-process')).filter(id => every.has(id));
    measured = { result, every, idle: { from: stoppedAt + 500, to: stoppedAt + 1500 }, userAgent: await tab.evaluate(() => navigator.userAgent), gpuProcesses };
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  const { result, every, idle, ...about } = measured;
  return { side: 'edge', run, ...about, ...await withPresents(result, capture, every, idle) };
}

async function native(run, capture, baseline) {
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
  const result = await measure(mark, [child.pid], async () => [], baseline);
  const code = await exit;
  if (code !== 0) throw new Error(`Host exited with code ${code}; see ${dir}/host.log`);
  const [header, ...lines] = (await readFile(resolve(dir, 'frames.csv'), 'utf8')).trim().split(/\r?\n/);
  const columns = header.split(',');
  const rows = lines.slice(options.warmup, options.warmup + options.frames).map(row => row.split(',').map(Number));
  const p50 = name => median(rows.map(row => row[columns.indexOf(name)]));
  return { side: 'native', run, ...await withPresents(result, capture, new Set([child.pid])), hostCpuMsP50: p50('cpu_ms'), renderCpuMsP50: p50('render_cpu_ms'), hostIntervalMsP50: p50('interval_ms') };
}

const results = [];
const counted = side => results.filter(result => result.side === side && result.counted);
let unavailable = null;
const sides = [[edge, 'msedge.exe'], [native, basename(options.host)]];
try {
  runs: for (let run = 1; run <= options.maxRuns && (counted('edge').length < options.runs || counted('native').length < options.runs); run++) {
    for (const [side, executable] of sides) {
      const baseline = await quietBaseline(machine);
      if (!baseline.quiet) {
        unavailable = `the machine stayed over ${busyBaselineCores} cores with nothing measured running (${baseline.otherCores.toFixed(2)} at the last try)`;
        break runs;
      }
      const capture = await startCapture(options.presentmon, [executable], options.captureSeconds, resolve(out, `${side.name}-${run}-presentmon.csv`)).catch(error => error);
      if (capture instanceof Error) {
        unavailable = `PresentMon capture unavailable: ${capture.message.trim()}`;
        break runs;
      }
      const result = await side(run, capture, baseline);
      results.push(result);
      console.log(`${result.side} run ${run}: ${result.fps.toFixed(0)} fps, ${result.cpuMsPerFrame.toFixed(3)} CPU ms per frame over ${result.processes} processes, callback p50 ${result.callbackP50.toFixed(3)} ms, drawing buffer ${result.drawingBuffer}${result.side === 'native' ? `, game thread CPU p50 ${result.hostCpuMsP50.toFixed(3)} ms, render thread CPU p50 ${result.renderCpuMsP50.toFixed(3)} ms, interval p50 ${result.hostIntervalMsP50.toFixed(3)} ms` : ''}`);
      const presents = result.presents;
      if (presents) {
        const processes = Object.entries(presents.processes).map(([id, count]) => `${id}${result.gpuProcesses?.includes(Number(id)) ? ' (GPU process)' : ''} ${count}`);
        const modes = Object.entries(presents.presentModes).map(([mode, count]) => `${mode} ${count}`);
        console.log(`  PresentMon: ${presents.presentedFps.toFixed(0)} presented fps, ${presents.displayedFps.toFixed(0)} displayed fps, largest gap ${presents.largestGapMs.toFixed(1)} ms; presents by process ${processes.join(', ') || 'none'}; ${Object.keys(presents.swapChains).length} swap chains; ${modes.join(', ')}${result.side === 'edge' ? `; ${presents.idlePresentsPerSecond.toFixed(0)} presents per second after the page stopped drawing` : ''}`);
      }
      console.log(`  warm-up ${(result.warmupMs / 1000).toFixed(1)} s, window ${(result.windowMs / 1000).toFixed(1)} s, GPU ${result.gpu.pstates.join('/') || 'unknown'} at ${result.gpu.clockMin}-${result.gpu.clockMax} MHz over ${result.gpu.samples} samples, rest of the machine ${result.otherCores.toFixed(2)} cores over a ${result.baselineCores.toFixed(2)}-core baseline, DPC and interrupts ${result.dpcInterruptCores.toFixed(2)} cores: ${result.counted ? 'counted' : `not counted (${result.rejected.join('; ')})`}`);
      if (!presents) {
        unavailable = result.rejected.find(reason => reason.startsWith('PresentMon'));
        break runs;
      }
    }
  }
} finally {
  sampler.stdin.end();
  gpu.kill();
  await new Promise(resolveClose => server.close(resolveClose));
}
const summary = Object.fromEntries(['edge', 'native'].map(side => {
  const runs = counted(side);
  return [side, {
    runs: runs.length,
    presentedFps: median(runs.map(result => result.presents.presentedFps)),
    displayedFps: median(runs.map(result => result.presents.displayedFps)),
    fps: median(runs.map(result => result.fps)),
    cpuMsPerFrame: median(runs.map(result => result.cpuMsPerFrame)),
    callbackP50: median(runs.map(result => result.callbackP50)),
  }];
}));
const enough = summary.edge.runs >= options.runs && summary.native.runs >= options.runs;
const shortfall = key => enough ? 1 - summary.native[key] / summary.edge[key] : null;
const presentedWorse = shortfall('presentedFps');
const cpuWorse = enough ? summary.native.cpuMsPerFrame / summary.edge.cpuMsPerFrame - 1 : null;
const verdict = !enough ? 'INCONCLUSIVE' : presentedWorse > 0.1 || cpuWorse > 0.1 ? 'FAIL' : 'PASS';
const report = { options, results, summary, nativePresentedFpsShortfall: presentedWorse, nativeDisplayedFpsShortfall: shortfall('displayedFps'), nativeFrameFpsShortfall: shortfall('fps'), nativeCpuExcess: cpuWorse, unavailable, verdict };
await writeFile(resolve(out, 'frame-cost.json'), JSON.stringify(report, null, 2));
if (!enough) {
  if (unavailable) console.log(unavailable);
  console.log(`counted runs: Edge ${summary.edge.runs}, native ${summary.native.runs}; the rule needs ${options.runs} each`);
  console.log('E3 perf rule: INCONCLUSIVE');
  process.exit(2);
}
const line = (name, key, digits) => `median ${name}: Edge ${summary.edge[key].toFixed(digits)}, native ${summary.native[key].toFixed(digits)}`;
console.log(`${line('presented fps', 'presentedFps', 0)} (native ${(presentedWorse * 100).toFixed(1)}% lower)`);
console.log(`${line('displayed fps (information only)', 'displayedFps', 0)} (native ${(shortfall('displayedFps') * 100).toFixed(1)}% lower)`);
console.log(`${line('frame fps from the probe (information only)', 'fps', 0)} (native ${(shortfall('fps') * 100).toFixed(1)}% lower)`);
console.log(`${line('CPU ms per frame', 'cpuMsPerFrame', 3)} (native ${(cpuWorse * 100).toFixed(1)}% higher)`);
console.log(`${line('JavaScript frame callback p50 in ms (information only)', 'callbackP50', 3)}`);
console.log(`E3 perf rule (fail when native presents more than 10% fewer frames per second than Edge, or spends more than 10% more CPU per frame): ${verdict}`);
