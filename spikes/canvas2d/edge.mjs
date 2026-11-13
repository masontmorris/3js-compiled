// Draws folio's canvases in headless Edge and saves each one's PNG and recorded calls for the Rust replay.
//   node spikes/canvas2d/edge.mjs <out dir> [--no-gpu]
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';

const out = resolve(process.argv[2] ?? 'target/canvas2d-spike');
const root = resolve('.');
await mkdir(join(out, 'edge'), { recursive: true });
const withTimeout = async (promise, step) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`DevTools call timed out after 60 s: ${step}`)), 60_000); })]); }
  finally { clearTimeout(timer); }
};
const deadline = setTimeout(() => { console.error('Edge run exceeded 5 minutes'); process.exit(1); }, 300_000);

const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    const rel = relative(root, path);
    if (rel.startsWith('..' + sep) || rel === '..') throw new Error('Invalid path');
    const bytes = await readFile(path);
    response.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript' }[extname(path)] ?? 'application/octet-stream' });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const profile = await mkdtemp(join(tmpdir(), 'threejsc-edge-'));
let context;
try {
  context = await withTimeout(chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, args: process.argv.includes('--no-gpu') ? ['--disable-gpu'] : ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11'] }), 'launch');
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', error => console.error(`page error: ${error}`));
  await withTimeout(page.goto(`http://127.0.0.1:${server.address().port}/spikes/canvas2d/edge.html`), 'goto');
  await withTimeout(page.waitForFunction(() => globalThis.__ready), 'wait for the cases');
  const cases = await withTimeout(page.evaluate(() => globalThis.__cases), 'read the cases');
  const version = await withTimeout(page.evaluate(() => navigator.userAgent), 'user agent');
  for (const drawn of cases) {
    await writeFile(join(out, 'edge', `${drawn.name}.png`), Buffer.from(drawn.png.split(',')[1], 'base64'));
    delete drawn.png;
  }
  await writeFile(join(out, 'cases.json'), JSON.stringify({ edge: version, cases }, null, 1));
  console.log(`${cases.length} cases from ${version}`);
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
  server.close();
  clearTimeout(deadline);
}
