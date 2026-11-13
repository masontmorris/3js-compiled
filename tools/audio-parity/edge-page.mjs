// Runs one examples/audio page in headless Edge, muted, and writes its console lines to a file.
//   node tools/audio-parity/edge-page.mjs <page.html or .js> <out.log> [--until <line>] [--key-on <line>] [--hash <h>] [--seconds n] [--webgpu]
// It presses a key when a line contains the --key-on text, and stops at the first line that contains --until, or after
// --seconds (default 30).
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const flag = name => { const i = args.indexOf(`--${name}`); return i >= 0 && args.splice(i, 1).length > 0; };
const until = option('until');
const keyOn = option('key-on');
const hash = option('hash') ?? '';
const seconds = Number(option('seconds') ?? 30);
const webgpu = flag('webgpu');
const [page, out] = args;
const origin = 'https://reference.test';
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.mp3': 'audio/mpeg' };
let step = 'launch';
const profile = await mkdtemp(join(tmpdir(), 'threejsc-edge-page-'));
const timeout = setTimeout(() => { console.error(`edge-page.mjs: no finish within 5 minutes, at ${step}`); process.exit(1); }, 300_000);
let context;
const lines = [];
try {
  const flags = ['--mute-audio', '--autoplay-policy=no-user-gesture-required', ...(webgpu ? ['--enable-unsafe-webgpu', '--enable-gpu'] : [])];
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, timeout: 60_000, args: flags, viewport: { width: 1280, height: 720 } });
  const tab = context.pages()[0] ?? await context.newPage();
  tab.setDefaultTimeout(60_000);
  await tab.route(`${origin}/**`, route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = path.startsWith('/tools/') ? path.slice(1) : join('examples/audio', path.slice(1));
    try {
      return route.fulfill({ contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    } catch {
      return route.fulfill({ status: 404, body: '' });
    }
  });
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  tab.on('console', message => {
    const text = message.text();
    lines.push(text);
    if (keyOn && text.includes(keyOn)) tab.keyboard.press('KeyA').catch(() => {});
    if (until && text.includes(until)) done();
  });
  tab.on('pageerror', error => lines.push(`pageerror ${error.message}`));
  const html = page.endsWith('.html') ? page : null;
  step = 'goto';
  if (html) await tab.goto(`${origin}/${html}#${hash}`);
  else {
    await tab.route(`${origin}/page.html`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style><script type="module" src="./${page}"></script>` }));
    await tab.goto(`${origin}/page.html#${hash}`);
  }
  step = 'run';
  await Promise.race([finished, new Promise(resolve => setTimeout(resolve, seconds * 1000))]);
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`${lines.length} lines in ${out}`);
} finally {
  clearTimeout(timeout);
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
