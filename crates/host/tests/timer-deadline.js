// Attacks on the timer turn's deadline, from the round-15 verification's lane V, in headless Edge and in the
// host. No renderer; the host's clear colour turns green once the page reports. Each mode starts at frame 5 and runs
// for 1500 ms; it logs the frames whose callbacks ran inside the window, the longest gap between frame callbacks in
// the window, the mean frame interval, and the timer ticks.
//   loaders     8 async loops that each yield with `await new Promise(r => setTimeout(r, 0))` and then work 1 ms, as
//               a game streaming assets in chunks does, while each frame callback works 3 ms
//   loaders2    2 such loops that each work 3 ms a tick, while each frame callback works 3 ms
//   raf3        the frame callbacks' 3 ms of work alone (the control for loaders)
//   loaders0    the 8 loops alone, with no frame-callback work
//   slowraf     a zero-delay chain that re-arms itself and works 0.5 ms a tick, while each frame callback works 20 ms
//   many10k     10,000 zero-delay timers set at once, each only counting a tick
//   many100k    100,000 of them (and manyNk, N thousand)
//   pending100k 100,000 timers that never fall due (1e8 ms), and nothing else
const native = typeof submitGpuCommands === 'function';
const mode = native ? (globalThis.__sceneName ?? 'loaders') : (new URLSearchParams(location.search).get('scene') ?? 'loaders');
const R = {};
const result = (name, value) => { R[name] = value; };
const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };
let frames = 0;
let reported = false;
let reportAt = Infinity;
let windowStart = Infinity;
let windowEnd = Infinity;
let framesInWindow = 0;
let firstInWindow = null;
let lastInWindow = null;
let lastFrame = null;
let maxGap = 0;
let ticks = 0;
let ticksInWindow = 0;
let allDoneAt = null;
let rafWork = 0;
const live = () => performance.now() < windowEnd;
const tick = () => { ticks++; if (live()) ticksInWindow++; };

function startWindow() {
  windowStart = performance.now();
  windowEnd = windowStart + 1500;
  reportAt = windowEnd + 300;
  if (mode === 'loaders' || mode === 'loaders0') {
    if (mode === 'loaders') rafWork = 3;
    for (let i = 0; i < 8; i++) (async () => { while (live()) { await new Promise(r => setTimeout(r, 0)); tick(); busy(1); } })();
  }
  if (mode === 'loaders2') {
    rafWork = 3;
    for (let i = 0; i < 2; i++) (async () => { while (live()) { await new Promise(r => setTimeout(r, 0)); tick(); busy(3); } })();
  }
  if (mode === 'raf3') rafWork = 3;
  if (mode === 'slowraf') {
    rafWork = 20;
    const f = () => { if (!live()) return; tick(); busy(0.5); setTimeout(f, 0); };
    setTimeout(f, 0);
  }
  if (/^many\d+k$/.test(mode)) {
    const n = Number(mode.slice(4, -1)) * 1000;
    let left = n;
    for (let i = 0; i < n; i++) setTimeout(() => { tick(); if (--left === 0) allDoneAt = performance.now(); }, 0);
    reportAt = Math.max(reportAt, windowStart + 20000);
  }
  if (mode === 'pending100k') {
    const ids = [];
    for (let i = 0; i < 100000; i++) ids.push(setTimeout(() => tick(), 1e8));
    setTimeout(() => ids.forEach(clearTimeout), 1600);
  }
}

function report() {
  reported = true;
  result(`${mode} frames inside the 1500 ms window`, framesInWindow);
  result(`${mode} mean frame interval ms`, framesInWindow > 1 ? ((lastInWindow - firstInWindow) / (framesInWindow - 1)).toFixed(2) : 'n/a');
  result(`${mode} longest frame gap ms`, Math.round(maxGap));
  result(`${mode} ticks in 1500 ms`, ticksInWindow);
  if (mode.startsWith('many')) result(`${mode} ms until every timer ran`, allDoneAt === null ? `not by report (${ticks} ran)` : Math.round(allDoneAt - windowStart));
  for (const [name, value] of Object.entries(R)) console.log(`R ${name}: ${value}`);
}

function frame() {
  const t = performance.now();
  if (t > windowStart && t < windowEnd) {
    framesInWindow++;
    firstInWindow ??= t;
    lastInWindow = t;
    if (lastFrame !== null) maxGap = Math.max(maxGap, t - lastFrame);
    if (rafWork) busy(rafWork);
  }
  lastFrame = t;
  if (frames === 4) startWindow();
  if (!reported && frames >= 30 && performance.now() >= reportAt) report();
  if (!reported && mode.startsWith('many') && allDoneAt !== null && performance.now() >= windowEnd + 300) report();
  if (native) setClearColor(0, reported ? 1 : 0, 0, 1);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
