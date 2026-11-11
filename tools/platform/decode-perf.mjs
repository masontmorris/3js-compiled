// E5's perf rule: total decode time of a set of images, in headless Edge and in the host, interleaved. Each run
// reads every file first, then decodes the whole set with createImageBitmap, as three's ImageBitmapLoader does,
// three times, and reports each pass's total in ms. It drives the GPU, so run it under the lease:
//   node tools/platform/decode-perf.mjs --images <dir> --out <dir> [--host <host.exe>] [--runs 3]
import { createServer } from 'node:http';
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
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
const passes = [];
let pixels = 0;
for (let pass = 0; pass < 3; pass++) {
  const start = performance.now();
  const bitmaps = await Promise.all(blobs.map(blob => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })));
  passes.push(performance.now() - start);
  pixels = bitmaps.reduce((sum, bitmap) => sum + bitmap.width * bitmap.height, 0);
  for (const bitmap of bitmaps) bitmap.close();
}
console.log('DECODE ' + JSON.stringify({ files: files.length, bytes: blobs.reduce((sum, blob) => sum + blob.size, 0), pixels, passes }));
globalThis.__done = true;
`);
await writeFile(join(page, 'decode.html'), '<!doctype html><script type="module" src="decode.js"></script>');

const withTimeout = (promise, step) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after 60 s: ${step}`)), 60_000))]);
async function edge() {
  const server = createServer(async (request, response) => {
    try {
      const path = join(page, decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/\.\./g, ''));
      response.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' }[extname(path)] ?? 'application/octet-stream' });
      response.end(await readFile(path));
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

const results = { edge: [], native: [] };
for (let run = 0; run < runs; run++) {
  results.edge.push(await edge());
  console.log(`edge ${run}: ${results.edge.at(-1).passes.map(ms => ms.toFixed(1)).join(' ')} ms`);
  results.native.push(await native(run));
  console.log(`native ${run}: ${results.native.at(-1).passes.map(ms => ms.toFixed(1)).join(' ')} ms`);
}
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const summary = side => median(results[side].map(result => median(result.passes)));
const edgeMs = summary('edge');
const nativeMs = summary('native');
const verdict = nativeMs <= edgeMs * 1.25 ? 'PASS' : 'FAIL';
const report = { files: results.edge[0].files, bytes: results.edge[0].bytes, pixels: results.edge[0].pixels, edgeMs, nativeMs, ratio: nativeMs / edgeMs, verdict, results };
await writeFile(join(out, 'decode-perf.json'), JSON.stringify(report, null, 1));
console.log(`${report.files} files, ${(report.bytes / 1e6).toFixed(1)} MB, ${(report.pixels / 1e6).toFixed(1)} Mpx: Edge ${edgeMs.toFixed(1)} ms, native ${nativeMs.toFixed(1)} ms, ${report.ratio.toFixed(2)}x: ${verdict}`);
