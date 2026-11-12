// Runs pages of this repo in headless Edge: a static server over the repo, with /folio/ serving the folio-2025
// checkout that holds Pally, a fresh profile per run, a 60 s limit per DevTools call and 5 minutes per run.
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';

export const FOLIO = resolve(process.env.THREEJSC_FOLIO ?? 'C:/Users/mason/.t3/scratch/2026-11-09-can-threejs-webgl-theoretically-with-e91d77c7/spikes/folio-2025');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };

export const withTimeout = (promise, step, ms = 60_000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`DevTools call timed out after ${ms / 1000} s: ${step}`)), ms))]);

// Calls `body(page, origin)` with a page of headless Edge at 1280x720. `gpu` turns on the flags the lanes use.
export async function withEdge(body, { gpu = true } = {}) {
  const root = resolve('.');
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const [base, rest] = pathname.startsWith('/folio/') ? [FOLIO, pathname.slice('/folio'.length)] : [root, pathname];
      const path = resolve(base, '.' + rest);
      const rel = relative(base, path);
      if (rel.startsWith('..' + sep) || rel === '..') throw new Error('Invalid path');
      const bytes = await readFile(path);
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const profile = await mkdtemp(join(tmpdir(), 'threejsc-edge-'));
  let context;
  const deadline = setTimeout(() => { console.error('Edge run exceeded 5 minutes'); process.exit(1); }, 300_000);
  try {
    context = await withTimeout(chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
      args: gpu ? ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11'] : ['--disable-gpu'],
    }), 'launch');
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(60_000);
    return await body(page, `http://127.0.0.1:${server.address().port}`);
  } finally {
    clearTimeout(deadline);
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    await new Promise(done => server.close(done));
  }
}
