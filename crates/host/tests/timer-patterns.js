// Game-shaped timer patterns the round-17 scenario table does not cover, from the round-17 verification's lane V, in
// headless Edge and in the host. Same frame and window bookkeeping as game.js. Random choices are seeded.
//   fixed20   a setInterval(tick, 16) fixed-step loop whose tick works 1.5 ms, but every fifth tick (seeded, about
//             a fifth) works 20 ms, longer than the interval; frame callbacks work 3 ms. 3 s window.
//   awaitload a loader that awaits timers: 4 asset loops, each step works 1 ms and awaits setTimeout(0), and every
//             tenth step awaits setTimeout(8) as a fetch would; each frame callback works a seeded 2 to 14 ms. 3 s.
//   debounce  a UI whose input events (time-scheduled, delivered in the frame callback as the browser delivers them
//             before rAF) clear and re-set three debounced setTimeouts of 100, 150 and 500 ms, in bursts of typing
//             8 to 40 ms apart with pauses of 50 to 700 ms. 5 s window.
//   step5     a 200 Hz fixed physics step, setInterval(step, 5), whose step works 0.3 ms; frame callbacks work 3 ms,
//             so the interval is shorter than a 169 Hz frame. 3 s window. stepN steps every N ms the same way.
const native = typeof submitGpuCommands === 'function';
const mode = native ? (globalThis.__sceneName ?? 'fixed20') : (new URLSearchParams(location.search).get('scene') ?? 'fixed20');
const R = {};
const result = (name, value) => { R[name] = value; };
const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };
let seed = 0x2545f491;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const windows = { fixed20: 3000, awaitload: 3000, debounce: 5000 };
let rafWork = () => 3;
const span = windows[mode] ?? 3000;
let frames = 0, reported = false, reportAt = Infinity, windowStart = Infinity, windowEnd = Infinity;
let framesInWindow = 0, firstInWindow = null, lastInWindow = null, lastFrame = null, maxGap = 0, longFrames = 0;
const live = () => performance.now() < windowEnd;
const stats = xs => { const s = [...xs].sort((a, b) => a - b); const at = q => s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; return s.length ? `n=${s.length} mean=${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1)} p50=${at(0.5).toFixed(1)} p99=${at(0.99).toFixed(1)} min=${s[0].toFixed(1)} max=${s[s.length - 1].toFixed(1)}` : 'n=0'; };
let onFrame = () => {};
let finish = () => {};
// Per-frame records for the host's checks that a stalled PC does not move: each frame's gap from the frame before, the
// frame work before it, and the interval ticks or loader steps that ran between the two.
const frameLog = [];
let between = 0, lastWork = 0;
const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];

function fixed20() {
  const t0 = performance.now();
  let ticks = 0, longTicks = 0, sinceFrame = 0, x = 0, lastRun = null;
  const gaps = [], perFrame = [0, 0, 0, 0];
  const id = setInterval(() => {
    if (!live()) { clearInterval(id); return; }
    const now = performance.now();
    if (lastRun !== null) gaps.push(now - lastRun);
    lastRun = now;
    ticks++;
    sinceFrame++;
    x += 1.6;
    if (rand() < 0.2) { longTicks++; busy(20); } else busy(1.5);
  }, 16);
  onFrame = () => { perFrame[Math.min(3, sinceFrame)]++; sinceFrame = 0; };
  finish = () => {
    result('fixed20 ticks', ticks);
    result('fixed20 long ticks', longTicks);
    result('fixed20 frames with 0/1/2/3+ ticks', perFrame.join('/'));
    result('fixed20 tick start gaps ms', stats(gaps));
    result('fixed20 behind schedule at the last tick ms', lastRun === null ? 'n/a' : (lastRun - (t0 + 16 * ticks)).toFixed(1));
    result('fixed20 position', x.toFixed(1));
  };
}

function awaitload() {
  rafWork = () => 2 + rand() * 12;
  let steps = 0, fetches = 0, frameSteps = 0;
  const perFrame = [], fetchLate = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 4; i++) (async () => {
    for (let n = 0; live(); n++) {
      busy(1);
      if (n % 10 === 9) { const t = performance.now(); await sleep(8); fetchLate.push(performance.now() - t - 8); if (live()) fetches++; }
      else { await sleep(0); }
      if (live()) { steps++; frameSteps++; between++; }
    }
  })();
  onFrame = () => { if (live()) perFrame.push(frameSteps); frameSteps = 0; };
  finish = () => {
    result('awaitload loader steps', steps);
    result('awaitload 8 ms fetch waits', fetches);
    result('awaitload fetch lateness ms', stats(fetchLate));
    result('awaitload steps per frame', stats(perFrame));
    // Steps in the frames a stall did not stretch: a gap no more than 6 ms past the frame work before it, a turn's
    // 3.3 ms share and a step to spare.
    const calm = frameLog.filter(([gap, work]) => gap - work <= 6);
    result('awaitload steps per unstalled frame', calm.length ? (calm.reduce((sum, [, , n]) => sum + n, 0) / calm.length).toFixed(2) : 'n/a');
  };
}

function debounce() {
  // Input times, relative to the window start: bursts of 4 to 20 keys 8 to 40 ms apart, with 50 to 700 ms pauses.
  const inputs = [];
  for (let t = 20; t < span - 50;) {
    const keys = 4 + Math.floor(rand() * 17);
    for (let k = 0; k < keys && t < span - 50; k++) { inputs.push(t); t += 8 + rand() * 32; }
    t += 50 + rand() * 650;
  }
  const debouncers = [100, 150, 500].map(delay => ({ delay, timer: 0, last: 0, armedAt: 0, fires: 0, early: 0, late: [], seq: [] }));
  let next = 0, delivered = 0, order = [];
  onFrame = now => {
    while (next < inputs.length && windowStart + inputs[next] <= now) {
      next++;
      delivered++;
      for (const d of debouncers) {
        clearTimeout(d.timer);
        const armedAt = performance.now();
        d.timer = setTimeout(() => {
          const fired = performance.now();
          if (fired - armedAt < d.delay - 0.01) d.early++;
          d.late.push(fired - armedAt - d.delay);
          d.fires++;
          order.push(d.delay);
        }, d.delay);
      }
    }
  };
  finish = () => {
    result('debounce inputs scheduled/delivered', `${inputs.length}/${delivered}`);
    for (const d of debouncers) {
      result(`debounce ${d.delay} ms fires`, d.fires);
      result(`debounce ${d.delay} ms early fires`, d.early);
      result(`debounce ${d.delay} ms lateness`, stats(d.late));
    }
    result('debounce fire order', order.join(' '));
  };
}

function step(every) {
  const t0 = performance.now();
  let ticks = 0, sinceFrame = 0, lastRun = null;
  const perFrame = [0, 0, 0, 0];
  const id = setInterval(() => {
    if (!live()) { clearInterval(id); return; }
    lastRun = performance.now();
    ticks++;
    sinceFrame++;
    between++;
    busy(0.3);
  }, every);
  onFrame = () => { perFrame[Math.min(3, sinceFrame)]++; sinceFrame = 0; };
  finish = () => {
    result(`${mode} ticks`, ticks);
    result(`${mode} frames with 0/1/2/3+ ticks`, perFrame.join('/'));
    result(`${mode} behind schedule at the last tick ms`, lastRun === null ? 'n/a' : (lastRun - (t0 + every * ticks)).toFixed(1));
    // Ticks against the schedule's points in the frames a stall did not stretch: a gap up to 1.15 times the median, since
    // a frame stretched by a whole period legitimately skips a tick.
    const m = median(frameLog.map(([gap]) => gap));
    const calm = frameLog.filter(([gap]) => gap <= 1.15 * m);
    const ran = calm.reduce((sum, [, , n]) => sum + n, 0), due = calm.reduce((sum, [gap]) => sum + gap / every, 0);
    result(`${mode} ticks per scheduled tick in unstalled frames`, due ? (ran / due).toFixed(3) : 'n/a');
  };
}

function startWindow() {
  windowStart = performance.now();
  windowEnd = windowStart + span;
  reportAt = windowEnd + 2700;
  if (mode.startsWith('step')) step(Number(mode.slice(4)));
  else ({ fixed20, awaitload, debounce })[mode]();
}

function report() {
  reported = true;
  finish();
  result(`${mode} frames inside the window`, framesInWindow);
  result(`${mode} mean frame interval ms`, framesInWindow > 1 ? ((lastInWindow - firstInWindow) / (framesInWindow - 1)).toFixed(2) : 'n/a');
  result(`${mode} longest frame gap ms`, Math.round(maxGap));
  result(`${mode} frame gaps over 12 ms`, longFrames);
  result(`${mode} median frame interval ms`, frameLog.length ? median(frameLog.map(([gap]) => gap)).toFixed(2) : 'n/a');
  result(`${mode} tenth-percentile frame interval ms`, frameLog.length ? [...frameLog.map(([gap]) => gap)].sort((x, y) => x - y)[Math.floor(frameLog.length / 10)].toFixed(2) : 'n/a');
  for (const [name, value] of Object.entries(R)) console.log(`R ${name}: ${value}`);
}

function frame() {
  const t = performance.now();
  if (t > windowStart && t < windowEnd) {
    framesInWindow++;
    firstInWindow ??= t;
    lastInWindow = t;
    if (lastFrame !== null) { maxGap = Math.max(maxGap, t - lastFrame); if (t - lastFrame > 12) longFrames++; }
    if (lastFrame !== null && lastFrame > windowStart) frameLog.push([t - lastFrame, lastWork, between]);
  }
  between = 0;
  lastFrame = t;
  onFrame(t);
  lastWork = rafWork();
  busy(lastWork);
  if (frames === 4) startWindow();
  if (!reported && frames >= 30 && performance.now() >= reportAt) report();
  if (native) setClearColor(0, reported ? 1 : 0, 0, 1);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
