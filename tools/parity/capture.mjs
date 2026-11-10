import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
let scene = 'basic-cube';
let output = 'target/parity';
let host = process.env.THREEJSC_HOST ?? 'C:/3jsc/target/debug/host.exe';
let browserOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--scene') scene = args[++i];
  else if (args[i] === '--out') output = args[++i];
  else if (args[i] === '--host') host = args[++i];
  else if (args[i] === '--browser-only') browserOnly = true;
  else throw new Error(`Unknown argument: ${args[i]}`);
}
if (!/^[a-z0-9-]+$/.test(scene)) throw new Error('Invalid scene name');
const root = resolve('.');
const out = resolve(output);
await mkdir(out, { recursive: true });
const webPath = resolve(out, `${scene}-web.png`);
const nativePath = resolve(out, `${scene}-native.png`);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    const rel = relative(root, path);
    if (rel.startsWith('..' + sep) || rel === '..') throw new Error('Invalid path');
    const bytes = await readFile(path);
    response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/examples/scenes/index.html?scene=${scene}`);
  await page.waitForFunction(() => globalThis.__sceneReady || globalThis.__sceneError, null, { timeout: 30000 });
  const error = await page.evaluate(() => globalThis.__sceneError ?? null);
  if (error || errors.length) throw new Error(`Browser scene failed: ${error ?? errors.join('; ')}`);
  await page.screenshot({ path: webPath });
  console.log(`Web capture: ${webPath}`);
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}

if (!browserOnly) {
  const temp = await mkdtemp(resolve(tmpdir(), 'threejsc-parity-'));
  const script = resolve(temp, 'steps.json');
  await writeFile(script, JSON.stringify([{ type: 'wait', frames: 5 }, { type: 'capture', path: nativePath }, { type: 'close' }]));
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(host, ['--entry', resolve(root, 'examples/scenes/index.js'), '--scene', scene, '--script', script], { cwd: out, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (status, signal) => signal ? reject(new Error(`Host terminated: ${signal}`)) : resolveExit(status));
  });
  if (code !== 0) throw new Error(`Host exited with code ${code}`);
  const web = PNG.sync.read(await readFile(webPath));
  const native = PNG.sync.read(await readFile(nativePath));
  if (web.width !== native.width || web.height !== native.height) throw new Error('Capture sizes differ');
  const diff = new PNG({ width: web.width, height: web.height });
  let total = 0;
  let changed = 0;
  for (let i = 0; i < web.data.length; i += 4) {
    let different = false;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(web.data[i + channel] - native.data[i + channel]);
      total += delta;
      different ||= delta !== 0;
      diff.data[i + channel] = delta;
    }
    changed += Number(different);
    diff.data[i + 3] = 255;
  }
  const pixels = web.width * web.height;
  const meanPercent = total / (pixels * 3 * 255) * 100;
  const changedPercent = changed / pixels * 100;
  const diffPath = resolve(out, `${scene}-diff.png`);
  await writeFile(diffPath, PNG.sync.write(diff));
  console.log(`Native capture: ${nativePath}`);
  console.log(`Mean RGB difference: ${meanPercent.toFixed(4)}%; pixels with any RGB difference: ${changedPercent.toFixed(2)}%`);
  console.log(`Difference image: ${diffPath}`);
}
