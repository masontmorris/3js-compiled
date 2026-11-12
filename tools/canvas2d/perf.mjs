// E6's perf rule: the time to draw folio's ten canvases at load, and the per-frame time of one dynamic canvas,
// in Edge and in the host, interleaved, three runs each. Each page logs the rest of the machine's CPU load as a
// share of every processor, from busy time less DPC, interrupt and the page's own processes' time; a page over
// 40 percent is void and the tool says so. Run it under the GPU lease and quiet_run.
//   node tools/canvas2d/perf.mjs --out <dir> [--host <host.exe>] [--runs 3] [--frames 900]
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { withEdge, withTimeout } from './edge.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const out = resolve(option('--out', 'target/canvas2d-perf'));
const host = resolve(option('--host', process.env.THREEJSC_HOST ?? 'target/release/host.exe'));
const runs = Number(option('--runs', '3'));
const frames = Number(option('--frames', '900'));
await mkdir(out, { recursive: true });

const sampler = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('tools/perf/sampler.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
const answers = createInterface({ input: sampler.stdout })[Symbol.asyncIterator]();
async function ask(line) {
  sampler.stdin.write(line + '\n');
  const { value } = await answers.next();
  if (value === undefined || value.startsWith('error')) throw new Error(`CPU sampler failed on "${line}": ${value}`);
  return value;
}
const machine = async () => (await ask('machine')).split(',').map(Number);
const processors = cpus().length;

// Runs `body` while it measures the machine, and returns its result with the other load in percent.
async function measured(body) {
  const [busy0, dpc0, interrupt0] = await machine();
  const started = performance.now();
  const ids = { list: [] };
  const result = await body(ids);
  const [busy1, dpc1, interrupt1] = await machine();
  const own = ids.list.length ? Number(await ask(`cpu ${ids.list.join(',')}`)) : 0;
  const elapsed = performance.now() - started;
  const other = (busy1 - busy0 - (dpc1 - dpc0) - (interrupt1 - interrupt0) - own) / elapsed / processors * 100;
  return { ...result, otherPercent: Number(other.toFixed(1)), ownCores: Number((own / elapsed).toFixed(2)) };
}

function parse(lines) {
  const loads = lines.map(line => /perf load run=(\d+) ms=([\d.]+)/.exec(line)).filter(Boolean).map(m => Number(m[2]));
  const dynamic = lines.map(line => /dynamic frames=(\d+) draw median ms=([\d.]+) p95 ms=([\d.]+) max ms=([\d.]+)/.exec(line)).filter(Boolean).map(m => ({ frames: Number(m[1]), median: Number(m[2]), p95: Number(m[3]), max: Number(m[4]) }));
  return { loads, dynamic };
}

async function edgePage(scene, waitFrames, ids) {
  return withEdge(async (page, origin) => {
    const lines = [];
    page.on('console', message => lines.push(message.text()));
    const marker = `threejsc-edge-`;
    await withTimeout(page.goto(`${origin}/examples/canvas2d/index.html?scene=${scene}`), 'goto');
    ids.list = (await ask(`discover ${marker}`)).split(',').filter(Boolean);
    await withTimeout(page.waitForFunction(() => globalThis.__sceneReady || globalThis.__sceneError), 'scene');
    await withTimeout(page.evaluate(count => new Promise(done => { let left = count; const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), waitFrames), 'frames', 120_000);
    return { lines };
  });
}

async function nativePage(scene, waitFrames, ids, dir) {
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'steps.json');
  await writeFile(script, JSON.stringify([{ type: 'wait', frames: waitFrames }, { type: 'close' }]));
  const child = spawn(host, ['--entry', resolve('examples/canvas2d/index.js'), '--scene', scene, '--script', script], { cwd: dir, stdio: 'ignore' });
  ids.list = [String(child.pid)];
  await ask(`cpu ${child.pid}`);
  const timer = setTimeout(() => child.kill(), 300_000);
  const code = await new Promise(done => child.on('exit', done));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`host exited with ${code} in ${scene}`);
  return { lines: (await readFile(join(dir, 'host.log'), 'utf8')).split(/\r?\n/) };
}

const rows = [];
for (let run = 1; run <= runs; run++) {
  for (const side of ['edge', 'native']) {
    for (const [scene, waitFrames] of [['perf', 10], ['dynamic', frames]]) {
      const result = await measured(ids => (side === 'edge' ? edgePage(scene, waitFrames, ids) : nativePage(scene, waitFrames, ids, join(out, `${side}-${scene}-${run}`))));
      const parsed = parse(result.lines);
      const row = { run, side, scene, ...parsed, otherPercent: result.otherPercent, ownCores: result.ownCores, void: result.otherPercent > 40 };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
}
sampler.stdin.end();
await writeFile(join(out, 'perf.json'), JSON.stringify(rows, null, 1));
const counted = rows.filter(row => !row.void);
for (const side of ['edge', 'native']) {
  const loads = counted.filter(row => row.side === side && row.scene === 'perf').map(row => row.loads[0]);
  const dynamic = counted.filter(row => row.side === side && row.scene === 'dynamic').flatMap(row => row.dynamic.slice(1).map(d => d.median));
  console.log(`${side}: load ms ${loads.join(', ')}; dynamic median ms per 300 frames ${dynamic.join(', ')}`);
}
