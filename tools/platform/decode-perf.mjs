// E5's perf rule: total decode time of a set of images, in headless Edge and in the host, interleaved. Each run
// reads every file first, idles 3 s so the machine's load can be read just before it measures, then decodes the
// whole set with createImageBitmap three times with colorSpaceConversion 'none', as three's ImageBitmapLoader
// passes it, and three times with 'default', which converts embedded color spaces as an image element does, and
// reports each pass's total in ms. It writes each run's idle window to windows.txt. It drives the GPU, so run it under the lease:
//   node tools/platform/decode-perf.mjs --images <dir> --out <dir> [--host <host.exe>] [--runs 3]
import { createServer } from 'node:http';
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const images = resolve(option('--images'));
const out = resolve(option('--out', 'target/decode-perf'));
const host = resolve(option('--host', 'C:/3jsc/target/release/host.exe'));
const runs = Number(option('--runs', 3));
const page = join(out, 'page');
await mkdir(join(page, 'images'), { recursive: true });
const files = (await readdir(images)).filter(name => /\.(png|jpe?g|webp)$/i.test(name)).sort();
for (const file of files) await copyFile(join(images, file), join(page, 'images', file));
await writeFile(join(page, 'manifest.json'), JSON.stringify(files));
await writeFile(join(page, 'decode.js'), `
const files = await (await fetch(new URL('manifest.json', location.href))).json();
const blobs = await Promise.all(files.map(async file => (await fetch(new URL('images/' + file, location.href))).blob()));
const idleStart = new Date().toISOString();
await new Promise(resolve => setTimeout(resolve, 3000));
const idle = [idleStart, new Date().toISOString()];
const passes = { none: [], default: [] };
let pixels = 0;
for (const conversion of ['none', 'default']) {
  for (let pass = 0; pass < 3; pass++) {
    const start = performance.now();
    const bitmaps = await Promise.all(blobs.map(blob => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: conversion })));
    passes[conversion].push(performance.now() - start);
    pixels = bitmaps.reduce((sum, bitmap) => sum + bitmap.width * bitmap.height, 0);
    for (const bitmap of bitmaps) bitmap.close();
  }
}
console.log('DECODE ' + JSON.stringify({ files: files.length, bytes: blobs.reduce((sum, blob) => sum + blob.size, 0), pixels, passes, idle }));
globalThis.__done = true;
`);
await writeFile(join(page, 'decode.html'), '<!doctype html><script type="module" src="decode.js"></script>');

const withTimeout = (promise, step) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after 60 s: ${step}`)), 60_000))]);
async function edge() {
  const server = createServer(async (request, response) => {
    try {
      const path = join(page, decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/\.\./g, ''));
      const bytes = await readFile(path);
      response.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' }[extname(path)] ?? 'application/octet-stream' });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const profile = await mkdtemp(join(tmpdir(), 'threejsc-edge-'));
  let context;
  try {
    context = await withTimeout(chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, args: ['--enable-gpu'] }), 'launch');
    const tab = context.pages()[0] ?? await context.newPage();
    tab.setDefaultTimeout(60_000);
    let line;
    tab.on('console', message => { if (message.text().startsWith('DECODE ')) line = message.text(); });
    await withTimeout(tab.goto(`http://127.0.0.1:${server.address().port}/decode.html`), 'goto');
    await withTimeout(tab.waitForFunction(() => globalThis.__done), 'decode');
    return JSON.parse(line.slice(7));
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    await new Promise(done => server.close(done));
  }
}
async function native(run) {
  const dir = join(out, `native-${run}`);
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'steps.json');
  await writeFile(script, JSON.stringify([{ type: 'wait', frames: 1500 }, { type: 'close' }]));
  const child = spawn(host, ['--entry', join(page, 'decode.js'), '--script', script, '--storage', join(dir, 'storage.json')], { cwd: dir, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill(), 300_000);
  const code = await new Promise(done => child.on('exit', done));
  clearTimeout(timer);
  const line = (await readFile(join(dir, 'host.log'), 'utf8')).split(/\r?\n/).find(text => text.startsWith('DECODE '));
  if (code !== 0 || !line) throw new Error(`host run ${run} exited with ${code} and no result`);
  return JSON.parse(line.slice(7));
}

// The share of all cores busy over the next `ms`.
async function load(ms) {
  const busy = () => cpus().reduce((sum, cpu) => sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq, 0);
  const total = () => cpus().reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
  const [b0, t0] = [busy(), total()];
  await new Promise(resolve => setTimeout(resolve, ms));
  return (busy() - b0) / (total() - t0);
}
// Waits, at most 2 minutes, until the machine is under 35% busy over 3 s, so other work does not skew a run.
async function quiet(name) {
  for (let tries = 0; tries < 40; tries++) {
    const busy = await load(3000);
    if (busy < 0.35) return console.log(`${name}: machine ${(busy * 100).toFixed(1)}% busy before the run`);
  }
  console.log(`${name}: machine stayed over 35% busy for 2 minutes`);
}
// Each run's idle window, so the load just before it measures can be read from a sampler's log.
const windows = [];
const timed = async (name, run) => {
  await quiet(name);
  const result = await run();
  windows.push(`${name} ${result.idle[0]} ${result.idle[1]}`);
  return result;
};
const results = { edge: [], native: [] };
for (let run = 0; run < runs; run++) {
  const show = result => Object.entries(result.passes).map(([conversion, ms]) => `${conversion} ${ms.map(value => value.toFixed(1)).join(' ')}`).join(', ');
  results.edge.push(await timed(`edge-${run}`, edge));
  console.log(`edge ${run}: ${show(results.edge.at(-1))} ms`);
  results.native.push(await timed(`native-${run}`, () => native(run)));
  console.log(`native ${run}: ${show(results.native.at(-1))} ms`);
}
await writeFile(join(out, 'windows.txt'), windows.join('\n') + '\n');
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const report = { files: results.edge[0].files, bytes: results.edge[0].bytes, pixels: results.edge[0].pixels, results, rule: {} };
for (const conversion of ['none', 'default']) {
  const summary = side => median(results[side].map(result => median(result.passes[conversion])));
  const edgeMs = summary('edge');
  const nativeMs = summary('native');
  report.rule[conversion] = { edgeMs, nativeMs, ratio: nativeMs / edgeMs, verdict: nativeMs <= edgeMs * 1.25 ? 'PASS' : 'FAIL' };
  console.log(`${report.files} files, ${(report.bytes / 1e6).toFixed(1)} MB, ${(report.pixels / 1e6).toFixed(1)} Mpx, colorSpaceConversion ${conversion}: Edge ${edgeMs.toFixed(1)} ms, native ${nativeMs.toFixed(1)} ms, ${(nativeMs / edgeMs).toFixed(2)}x: ${report.rule[conversion].verdict}`);
}
await writeFile(join(out, 'decode-perf.json'), JSON.stringify(report, null, 1));
