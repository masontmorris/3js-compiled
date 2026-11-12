// Renders every reference graph and decode case in headless Edge with OfflineAudioContext and writes each result as
// a 32-bit float WAV, plus index.json with every render's rate and length. Offline renders make no sound, and Edge
// runs muted anyway. `node tools/audio-parity/edge.mjs <out dir> [name filter]`
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { decodeCases, referenceGraphs } from './graphs.mjs';
import { writeWav } from './wav.mjs';

const [out, filter = ''] = process.argv.slice(2);
if (!out) throw new Error('usage: edge.mjs <out dir> [name filter]');
mkdirSync(out, { recursive: true });
const origin = 'https://reference.test';
let step = 'launch';
const profile = await mkdtemp(join(tmpdir(), 'threejsc-edge-audio-'));
const timeout = setTimeout(() => { console.error(`edge.mjs: no finish within 5 minutes, at ${step}`); process.exit(1); }, 300_000);
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, timeout: 60_000, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.route(`${origin}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
    if (path === '/run-graph.mjs') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('./run-graph.mjs', import.meta.url)) });
    if (path.startsWith('/clips/')) return route.fulfill({ contentType: 'application/octet-stream', body: readFileSync(join('examples/audio/clips', path.slice(7))) });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${origin}/`);
  const index = { userAgent: await page.evaluate(() => navigator.userAgent), renders: {} };
  const save = (name, sampleRate, channels) => {
    const data = channels.map(base64 => new Float32Array(Uint8Array.from(Buffer.from(base64, 'base64')).buffer));
    writeWav(join(out, `${name}.wav`), data, sampleRate, { float: true });
    index.renders[name] = { sampleRate, channels: data.length, length: data[0].length };
  };
  // page.evaluate takes no timeout of its own.
  const evaluate = (fn, arg) => Promise.race([page.evaluate(fn, arg), new Promise((_, reject) => setTimeout(() => reject(new Error(`edge.mjs: ${step} took over 60 s`)), 60_000).unref())]);
  const encode = `const encode = a => { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(s); };`;
  for (const spec of referenceGraphs().filter(g => g.name.includes(filter))) {
    step = spec.name;
    const channels = await evaluate(new Function('spec', `${encode} return import('/run-graph.mjs').then(m => m.renderGraph(spec)).then(cs => cs.map(encode));`), spec);
    save(spec.name, spec.sampleRate, channels);
  }
  for (const c of decodeCases().filter(g => g.name.includes(filter))) {
    step = c.name;
    const result = await evaluate(new Function('c', `${encode} return fetch('/clips/' + c.file).then(r => r.arrayBuffer()).then(b => import('/run-graph.mjs').then(m => m.decodeClip(b, c.sampleRate))).then(d => ({ sampleRate: d.sampleRate, channels: d.channels.map(encode) }));`), c);
    save(c.name, result.sampleRate, result.channels);
  }
  writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  console.log(`${index.userAgent}: ${Object.keys(index.renders).length} renders in ${out}`);
} finally {
  clearTimeout(timeout);
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
