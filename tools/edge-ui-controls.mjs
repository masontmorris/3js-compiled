// Drives headless Edge through tools/ui-repro/controls.html with the sequences in
// tools/ui-repro/controls-cases.json, the browser reference for check-ui-controls.py. Prints the
// Edge version, then per case and repeat the page's click events and every event. Each run uses
// a new profile folder in %TEMP%, which it deletes. A DevTools call that takes over 60 s, or a run
// over 5 minutes, stops Edge and exits 1 naming the step.
// Usage: node tools/edge-ui-controls.mjs [reps] > <reference.txt>
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [repsArg] = process.argv.slice(2);
const profile = mkdtempSync(join(tmpdir(), 'threejsc-edge-'));
const page = new URL('ui-repro/controls.html', import.meta.url);
const cases = JSON.parse(readFileSync(new URL('ui-repro/controls-cases.json', import.meta.url), 'utf8'));
const reps = Number(repsArg ?? 2);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9349;
const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--window-size=1280,720', page.href], { stdio: 'ignore' });
let step = 'starting Edge';
let stopping = false;
const stop = (code, why) => {
  if (stopping) return;
  stopping = true;
  proc.kill();
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' });
  } catch {}
  setTimeout(() => {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    if (why) console.error(why);
    process.exit(code);
  }, 2000);
};
process.on('uncaughtException', error => stop(1, `session failed at ${step}: ${error.stack}`));
process.on('unhandledRejection', error => stop(1, `session failed at ${step}: ${error}`));
setTimeout(() => stop(1, `run over 5 minutes at: ${step}`), 5 * 60 * 1000).unref();

const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(100);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
}
if (!target) throw new Error('Edge showed no page in 10 s');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); });
const cdp = (method, params = {}) => new Promise(r => {
  const n = ++id;
  const late = setTimeout(() => stop(1, `DevTools call ${method} over 60 s at: ${step}`), 60 * 1000);
  pending.set(n, d => { clearTimeout(late); r(d); });
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async expr => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
const frames = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
const resize = async width => { await cdp('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false }); await frames(); };
const NAMES = ['left', 'middle', 'right'];
const BITS = [1, 4, 2];
let buttons = 0;
const mouse = async (type, x, y, button) => {
  if (type === 'mousePressed') buttons |= BITS[button];
  if (type === 'mouseReleased') buttons &= ~BITS[button];
  await cdp('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : NAMES[button], buttons,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
};
const tick = async () => JSON.parse(await evaluate('window.__bridge.tick({})')).events;
const CLICKS = ['click', 'auxclick', 'contextmenu', 'dblclick'];
const fmt = e => `${e.type}:${e.id}${e.path0 !== e.id ? `/${e.path0}` : ''}:b${e.button}`;
const onDisabled = events => [...new Set(events.filter(e => e.id === 'dis').map(e => e.type))].sort().join(',') || '-';

console.log((await cdp('Browser.getVersion')).result.product);
for (let rep = 0; rep < reps; rep++) {
  for (const [name, ops] of Object.entries(cases)) {
    step = `case ${name} repeat ${rep}`;
    await resize(1280);
    await tick();
    await frames();
    const events = [];
    for (const op of ops) {
      if (op.op === 'move') await mouse('mouseMoved', op.x, op.y, 0);
      else if (op.op === 'down') await mouse('mousePressed', op.x, op.y, op.button);
      else if (op.op === 'up') await mouse('mouseReleased', op.x, op.y, op.button);
      else if (op.op === 'hold') { events.push(...await tick()); await frames(); }
      else if (op.op === 'resize') await resize(op.width);
    }
    await frames();
    events.push(...await tick());
    const clicks = events.filter(e => CLICKS.includes(e.type)).map(fmt).join(' ') || '-';
    console.log(`CASE ${name} ${rep} clicks: ${clicks} on dis: ${onDisabled(events)}`);
    console.log(`  all: ${events.map(e => `${fmt(e)}@${e.x}/${e.w}`).join(' ')}`);
  }
}
ws.close();
stop(0);
