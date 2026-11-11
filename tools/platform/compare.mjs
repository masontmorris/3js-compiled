// Runs one host script against the platform example in headless Edge and in the host, and compares the `E` lines
// each logs, field by field, ignoring the frame number. Edge gets the script's steps as DevTools input: keys,
// mouse buttons, moves and wheels, viewport resizes and captures. Gamepad and focus steps have no DevTools input,
// so Edge skips them. Both sides use the GPU, so run it under the lease:
//   node tools/platform/compare.mjs --scene texture --script <steps.json> --out <dir> [--host <host.exe>] [--edge-only] [--native-only]
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { keyCode } from '../../packages/three-native/src/platform/events.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const scene = option('--scene', 'texture');
const out = resolve(option('--out', 'target/platform'));
const host = resolve(option('--host', process.env.THREEJSC_HOST ?? 'C:/3jsc/target/debug/host.exe'));
const scriptPath = resolve(option('--script'));
const extra = (option('--host-args', '') || '').split(' ').filter(Boolean);
const steps = JSON.parse(await readFile(scriptPath, 'utf8'));
await mkdir(out, { recursive: true });
const root = resolve('.');

const SHIFTED = { '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', '`': '~', ',': '<', '.': '>', '/': '?' };
const PUNCTUATION = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/', Space: ' ' };
const MODIFIER_BITS = { AltLeft: 1, AltRight: 1, ControlLeft: 2, ControlRight: 2, MetaLeft: 4, MetaRight: 4, ShiftLeft: 8, ShiftRight: 8 };
// The key a US layout gives `code`, as the host's key table does.
function keyFor(code, shift) {
  if (/^Key[A-Z]$/.test(code)) return shift ? code[3] : code[3].toLowerCase();
  const plain = /^Digit\d$/.test(code) ? code[5] : PUNCTUATION[code];
  if (plain) return shift ? SHIFTED[plain] ?? plain : plain;
  if (/^Numpad\d$/.test(code)) return code[6];
  return { ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta', NumpadEnter: 'Enter' }[code] ?? code;
}
const location = code => /Left$/.test(code) && MODIFIER_BITS[code] ? 1 : /Right$/.test(code) && MODIFIER_BITS[code] ? 2 : code.startsWith('Numpad') ? 3 : 0;
const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];
const BUTTON_BITS = [1, 4, 2, 8, 16];
const withTimeout = (promise, step) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`DevTools call timed out after 60 s: ${step}`)), 60_000))]);

async function runEdge() {
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
      const rel = relative(root, path);
      if (rel.startsWith('..' + sep) || rel === '..') throw new Error('Invalid path');
      const bytes = await readFile(path);
      response.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' }[extname(path)] ?? 'application/octet-stream' });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const profile = await mkdtemp(join(tmpdir(), 'threejsc-edge-'));
  const lines = [];
  let context;
  try {
    context = await withTimeout(chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11'] }), 'launch');
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('console', message => { if (message.text().startsWith('E ')) lines.push(message.text()); else if (message.type() === 'error') lines.push(`ERROR ${message.text()}`); });
    page.on('pageerror', error => lines.push(`ERROR ${error}`));
    await withTimeout(page.goto(`http://127.0.0.1:${server.address().port}/examples/platform/index.html?scene=${scene}`), 'goto');
    await withTimeout(page.waitForFunction(() => globalThis.__sceneReady || globalThis.__sceneError), 'wait for the page');
    const cdp = await context.newCDPSession(page);
    let modifiers = 0;
    let buttons = 0;
    let x = 0;
    let y = 0;
    const frames = n => page.evaluate(count => new Promise(done => { let left = count; const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), n);
    for (const step of steps) {
      const name = `${step.type} ${JSON.stringify(step)}`;
      if (step.type === 'wait') await withTimeout(frames(step.frames), name);
      else if (step.type === 'key') {
        const bit = MODIFIER_BITS[step.code] ?? 0;
        if (step.down) modifiers |= bit; else modifiers &= ~bit;
        const key = keyFor(step.code, (modifiers & 8) !== 0);
        const text = step.down && ([...key].length === 1 || key === 'Enter') && !(modifiers & 6) ? (key === 'Enter' ? '\r' : key) : undefined;
        await withTimeout(cdp.send('Input.dispatchKeyEvent', {
          type: step.down ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp', code: step.code, key, text, unmodifiedText: text,
          windowsVirtualKeyCode: keyCode(step.code), nativeVirtualKeyCode: keyCode(step.code), autoRepeat: !!step.repeat,
          location: location(step.code), modifiers,
        }), name);
      } else if (step.type === 'pointer') {
        x = step.x;
        y = step.y;
        const button = step.button ?? 0;
        if (step.action === 'down') buttons |= BUTTON_BITS[button];
        if (step.action === 'up') buttons &= ~BUTTON_BITS[button];
        await withTimeout(cdp.send('Input.dispatchMouseEvent', {
          type: { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[step.action], x, y, modifiers, buttons,
          button: step.action === 'move' ? 'none' : BUTTONS[button], clickCount: step.action === 'move' ? 0 : 1,
        }), name);
      } else if (step.type === 'wheel') {
        await withTimeout(cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: step.x, deltaY: step.y, modifiers, buttons }), name);
      } else if (step.type === 'resize') {
        await withTimeout(page.setViewportSize({ width: step.width, height: step.height }), name);
      } else if (step.type === 'capture') {
        await withTimeout(frames(2), name);
        await withTimeout(page.screenshot({ path: join(out, `edge-${step.path.split(/[\\/]/).at(-1)}`) }), name);
      } else if (step.type === 'close') break;
      else lines.push(`SKIP ${name}`);
    }
    await withTimeout(frames(3), 'final frames');
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    await new Promise(done => server.close(done));
  }
  return lines;
}

async function runNative() {
  const native = steps.map(step => step.type === 'capture' ? { ...step, path: join(out, `native-${step.path.split(/[\\/]/).at(-1)}`) } : step);
  if (!native.some(step => step.type === 'close')) native.push({ type: 'wait', frames: 3 }, { type: 'close' });
  const nativeScript = join(out, 'native-steps.json');
  await writeFile(nativeScript, JSON.stringify(native));
  const dir = join(out, 'native');
  await mkdir(dir, { recursive: true });
  const child = spawn(host, ['--entry', resolve(root, 'examples/platform/index.js'), '--scene', scene, '--script', nativeScript, ...extra], { cwd: dir, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 300_000);
  const code = await new Promise(done => child.on('exit', done));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`host exited with ${code}`);
  const log = await readFile(join(dir, 'host.log'), 'utf8');
  return log.split(/\r?\n/).filter(line => line.startsWith('E ') || /error/i.test(line) && !line.startsWith('E '));
}

const strip = line => line.replace(/^E f=\d+ /, 'E ');
const edge = args.includes('--native-only') ? null : await runEdge();
if (edge) await writeFile(join(out, 'edge.log'), edge.join('\n') + '\n');
const native = args.includes('--edge-only') ? null : await runNative();
if (native) await writeFile(join(out, 'native.log'), native.join('\n') + '\n');
if (edge && native) {
  const a = edge.filter(line => line.startsWith('E ')).map(strip);
  const b = native.filter(line => line.startsWith('E ')).map(strip);
  const rows = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) rows.push(`#${i}\n  edge:   ${a[i] ?? '(none)'}\n  native: ${b[i] ?? '(none)'}`);
  const summary = `${scene}: ${a.length} Edge lines, ${b.length} native lines, ${rows.length} differ`;
  await writeFile(join(out, 'diff.txt'), [summary, ...rows].join('\n') + '\n');
  console.log(summary);
  for (const row of rows.slice(0, 20)) console.log(row);
  process.exitCode = rows.length ? 1 : 0;
}
