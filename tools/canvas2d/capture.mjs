// Captures one scene of the canvas 2D example in headless Edge and in the host at 1280x720, after the same number
// of frames, and compares them: the mean RGB difference as a fraction of full scale and the share of pixels where a
// channel differs by more than 2 of 255, over the window and over each `--region x,y,w,h`. It saves both
// captures, a difference image and each side's `R` lines. Both sides use the GPU, so run it under the lease.
//   node tools/canvas2d/capture.mjs --scene <name> --out <dir> [--frames 10] [--host <host.exe>] [--region x,y,w,h]...
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { FOLIO, withEdge, withTimeout } from './edge.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const scene = option('--scene', 'folio');
const out = resolve(option('--out', 'target/canvas2d'));
const frames = Number(option('--frames', '10'));
const host = resolve(option('--host', process.env.THREEJSC_HOST ?? 'target/release/host.exe'));
const regions = args.flatMap((arg, i) => (arg === '--region' ? [args[i + 1].split(',').map(Number)] : []));
await mkdir(out, { recursive: true });
const pallyNative = pathToFileURL(join(FOLIO, 'static/fonts/')).href;

async function runEdge() {
  return withEdge(async (page, origin) => {
    const lines = [];
    page.on('console', message => { if (message.text().startsWith('R ')) lines.push(message.text()); else if (message.type() === 'error') lines.push(`ERROR ${message.text()}`); });
    page.on('pageerror', error => lines.push(`ERROR ${error}`));
    await withTimeout(page.goto(`${origin}/examples/canvas2d/index.html?scene=${scene}#pally=${origin}/folio/static/fonts/`), 'goto');
    await withTimeout(page.waitForFunction(() => globalThis.__sceneReady || globalThis.__sceneError), 'wait for the scene');
    await withTimeout(page.evaluate(count => new Promise(done => { let left = count; const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), frames), 'frames');
    await withTimeout(page.screenshot({ path: join(out, `edge-${scene}.png`) }), 'screenshot');
    lines.push(`R frame at capture ${await page.evaluate(() => globalThis.__frameNumber ?? null)}`);
    return lines;
  });
}

async function runNative() {
  const dir = join(out, `native-${scene}`);
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'steps.json');
  await writeFile(script, JSON.stringify([{ type: 'wait', frames: frames + 3 }, { type: 'capture', path: join(out, `native-${scene}.png`) }, { type: 'wait', frames: 2 }, { type: 'close' }]));
  const child = spawn(host, ['--entry', resolve('examples/canvas2d/index.js'), '--scene', scene, '--hash', `pally=${pallyNative}`, '--script', script], { cwd: dir, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 300_000);
  const code = await new Promise(done => child.on('exit', done));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`host exited with ${code}`);
  const log = await readFile(join(dir, 'host.log'), 'utf8');
  return log.split(/\r?\n/).filter(line => line.startsWith('R ') || /error|not implemented/i.test(line));
}

function compare(a, b, [x0, y0, w, h]) {
  let sum = 0;
  let differing = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * a.width + x) * 4;
      let most = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[i + c] - b.data[i + c]);
        sum += d;
        most = Math.max(most, d);
      }
      if (most > 2) differing++;
    }
  }
  return { region: [x0, y0, w, h], mean: Number((sum / (w * h * 3 * 255)).toFixed(6)), differing: Number((differing / (w * h)).toFixed(6)) };
}

const edgeLines = await runEdge();
await writeFile(join(out, `edge-${scene}.log`), edgeLines.join('\n') + '\n');
const nativeLines = await runNative();
await writeFile(join(out, `native-${scene}.log`), nativeLines.join('\n') + '\n');
const edge = PNG.sync.read(await readFile(join(out, `edge-${scene}.png`)));
const native = PNG.sync.read(await readFile(join(out, `native-${scene}.png`)));
if (edge.width !== native.width || edge.height !== native.height) throw new Error(`capture sizes differ: ${edge.width}x${edge.height} and ${native.width}x${native.height}`);
const diff = new PNG({ width: edge.width, height: edge.height });
for (let i = 0; i < edge.data.length; i += 4) {
  const most = Math.max(...[0, 1, 2].map(c => Math.abs(edge.data[i + c] - native.data[i + c])));
  diff.data.set([Math.min(255, most * 8), 0, 0, 255], i);
}
await writeFile(join(out, `diff-${scene}.png`), PNG.sync.write(diff));
const result = { scene, window: compare(edge, native, [0, 0, edge.width, edge.height]), regions: regions.map(region => compare(edge, native, region)) };
await writeFile(join(out, `result-${scene}.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
const differences = edgeLines.filter(line => !nativeLines.includes(line)).map(line => `edge only: ${line}`).concat(nativeLines.filter(line => !edgeLines.includes(line)).map(line => `native only: ${line}`));
for (const line of differences.slice(0, 40)) console.log(line);
