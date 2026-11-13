// Game-shaped timer patterns, from the round-16 verification's lane V, in headless Edge and in the host. No renderer;
// the host's clear colour turns green once the page reports. Each mode starts at frame 5, runs for its window, and
// logs R lines: frames whose callbacks ran inside the window, their mean interval and longest gap, and the mode's
// outcome. Every frame callback works 3 ms, as a game's update and render calls do. Random choices are seeded.
//   tween   gsap-style: a rAF ticker with lag smoothing (500, 33) drives 240 tweens of 300-800 ms; tween i starts from
//           setTimeout(start, 12 * i) (a staggered timeline), and each finished tween chains a reverse tween through
//           a promise job and a zero-delay timer, as onComplete callbacks do. 3 s window.
//   tick16  a setInterval(tick, 16) fixed-step game loop whose tick works 1.5 ms, with rAF interpolating. 3 s window.
//   howler  Howler-style: each frame plays 2 sounds of 40-2500 ms, each ending with its own setTimeout; a quarter
//           of them are stopped early with clearTimeout, and a tenth loop by re-arming their end timer. Hundreds
//           are pending. 5 s window.
//   slowload10, slowload16  8 loaders that each yield with `await new Promise(r => setTimeout(r, 0))` and work 1 ms,
//           while each frame callback works 10 or 16 ms instead of 3, as a CPU-heavy game streaming assets does. 3 s.
//   churn   heap churn for 60 s: each frame sets 1,500 timers with delays from 0 to 4,000 ms and clears 1,450 of the
//           pending ones at random, so about 3,000 stay live; checks firing order and lateness throughout.
const native = typeof submitGpuCommands === 'function';
const mode = native ? (globalThis.__sceneName ?? 'tween') : (new URLSearchParams(location.search).get('scene') ?? 'tween');
const R = {};
const result = (name, value) => { R[name] = value; };
const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };
let seed = 0x9e3779b9;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const windows = { tween: 3000, tick16: 3000, howler: 5000, churn: 60000 };
let rafWork = 3;
const span = windows[mode] ?? 3000;
let frames = 0, reported = false, reportAt = Infinity, windowStart = Infinity, windowEnd = Infinity;
let framesInWindow = 0, firstInWindow = null, lastInWindow = null, lastFrame = null, maxGap = 0, longFrames = 0;
const live = () => performance.now() < windowEnd;
const stats = xs => { const s = [...xs].sort((a, b) => a - b); const at = q => s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; return s.length ? `n=${s.length} mean=${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1)} p50=${at(0.5).toFixed(1)} p99=${at(0.99).toFixed(1)} max=${s[s.length - 1].toFixed(1)}` : 'n=0'; };
let onFrame = () => {};
let finish = () => {};

// Streaming checks of firing order and lateness, so the page keeps no per-timer history. `fire(deadline, order,
// zero)` counts a timer that fires after one whose deadline is more than 2 ms later, and a zero-delay timer that
// fires before one set earlier.
class Order {
  constructor() { this.maxDeadline = -Infinity; this.lastZero = -1; this.bad = 0; this.zeroBad = 0; this.n = 0; this.sum = 0; this.max = 0; this.buckets = new Uint32Array(4001); }
  fire(deadline, order, zero) {
    const now = performance.now(), late = now - deadline;
    this.n++; this.sum += late; this.max = Math.max(this.max, late); this.buckets[Math.min(4000, Math.max(0, Math.floor(late * 4)))]++;
    if (deadline < this.maxDeadline - 2) this.bad++;
    this.maxDeadline = Math.max(this.maxDeadline, deadline);
    if (zero) { if (order < this.lastZero) this.zeroBad++; this.lastZero = order; }
  }
  quantile(q) { let left = q * this.n; for (let i = 0; i < this.buckets.length; i++) { left -= this.buckets[i]; if (left <= 0) return i / 4; } return 1000; }
  late() { return this.n ? `n=${this.n} mean=${(this.sum / this.n).toFixed(1)} p50=${this.quantile(0.5).toFixed(1)} p99=${this.quantile(0.99).toFixed(1)} max=${this.max.toFixed(1)}` : 'n=0'; }
  inversions() { return `${this.bad} beyond 2 ms, ${this.zeroBad} zero-delay out of setting order`; }
}

function tween() {
  const active = new Set();
  const startLate = [], doneFrames = [];
  let started = 0, completed = 0, chained = 0, lastTime = performance.now(), time = 0, value = 0;
  const order = [];
  const begin = (id, from, to, duration, chainedFrom) => {
    started++;
    active.add({ id, from, to, duration, t0: time, chainedFrom, onComplete(tw) {
      completed++;
      order.push(id);
      doneFrames.push(frames);
      value += tw.to;
      if (!chainedFrom && live()) Promise.resolve().then(() => setTimeout(() => { chained++; begin(id, to, from, duration, true); }, 0));
    } });
  };
  for (let i = 0; i < 240; i++) {
    const planned = performance.now() + 12 * i;
    const duration = 300 + Math.floor(rand() * 500);
    setTimeout(() => { startLate.push(performance.now() - planned); begin(i, 0, 100 + i, duration, false); }, 12 * i);
  }
  onFrame = now => {
    let elapsed = now - lastTime;
    lastTime = now;
    if (elapsed > 500) elapsed = 33;
    time += elapsed;
    for (const tw of active) {
      const p = Math.min(1, (time - tw.t0) / tw.duration);
      tw.x = tw.from + (tw.to - tw.from) * (1 - (1 - p) ** 3);
      if (p >= 1) { active.delete(tw); tw.onComplete(tw); }
    }
  };
  finish = () => {
    result('tween started', started);
    result('tween completed', completed);
    result('tween chained', chained);
    result('tween start lateness ms', stats(startLate));
    result('tween first 24 completions', order.slice(0, 24).join(' '));
    result('tween frames from window start to the 240th completion', doneFrames.length >= 240 ? doneFrames[239] - 4 : 'n/a');
  };
}

function tick16() {
  const t0 = performance.now();
  let ticks = 0, sinceFrame = 0, x = 0;
  const late = [], perFrame = [0, 0, 0, 0];
  const id = setInterval(() => {
    if (!live()) { clearInterval(id); return; }
    ticks++;
    sinceFrame++;
    late.push(performance.now() - (t0 + 16 * ticks));
    x += 16 * 0.1;
    busy(1.5);
  }, 16);
  onFrame = () => { perFrame[Math.min(3, sinceFrame)]++; sinceFrame = 0; };
  finish = () => {
    result('tick16 ticks', ticks);
    result('tick16 frames with 0/1/2/3+ ticks', perFrame.join('/'));
    result('tick16 drift of the last tick ms', late.length ? late[late.length - 1].toFixed(1) : 'n/a');
    result('tick16 position', x.toFixed(1));
  };
}

function howler() {
  const pending = new Map();
  let played = 0, ended = 0, stopped = 0, looped = 0, maxPending = 0, setOrder = 0;
  const check = new Order();
  const arm = (sound, duration) => {
    const deadline = performance.now() + duration;
    const order = setOrder++;
    sound.timer = setTimeout(() => {
      check.fire(deadline, order, false);
      busy(0.05);
      if (sound.loop && sound.loops-- > 0 && live()) { looped++; arm(sound, sound.duration); return; }
      pending.delete(sound.id);
      ended++;
    }, duration);
  };
  let nextId = 0;
  onFrame = () => {
    if (!live()) return;
    for (let k = 0; k < 2; k++) {
      const sound = { id: nextId++, duration: 40 + Math.floor(rand() * 2460), loop: rand() < 0.1, loops: 2 };
      played++;
      pending.set(sound.id, sound);
      arm(sound, sound.duration);
    }
    if (rand() < 0.5 && pending.size) {
      const ids = [...pending.keys()];
      const id = ids[Math.floor(rand() * ids.length)];
      clearTimeout(pending.get(id).timer);
      pending.delete(id);
      stopped++;
    }
    maxPending = Math.max(maxPending, pending.size);
  };
  finish = () => {
    result('howler played', played);
    result('howler ended', ended);
    result('howler stopped', stopped);
    result('howler looped', looped);
    result('howler most pending', maxPending);
    result('howler end lateness ms', check.late());
    result('howler order inversions', check.inversions());
  };
}

function churn() {
  const pending = [];
  let set = 0, cleared = 0, fired = 0, setOrder = 0;
  const check = new Order(), perTen = [];
  let tenStart = performance.now(), tenCount = 0;
  onFrame = now => {
    if (now - tenStart >= 10000) { perTen.push(tenCount); tenCount = 0; tenStart = now; }
    if (!live()) return;
    for (let k = 0; k < 1500; k++) {
      const delay = k % 10 === 0 ? 0 : Math.floor(rand() * 4000);
      const deadline = performance.now() + delay;
      const order = setOrder++;
      const id = setTimeout(() => { fired++; tenCount++; check.fire(deadline, order, delay === 0); }, delay);
      pending.push(id);
      set++;
    }
    for (let k = 0; k < 1450 && pending.length; k++) {
      const i = Math.floor(rand() * pending.length);
      const id = pending[i];
      pending[i] = pending[pending.length - 1];
      pending.pop();
      clearTimeout(id);
      cleared++;
    }
    if (pending.length > 20000) pending.splice(0, pending.length - 20000);
  };
  finish = () => {
    result('churn set', set);
    result('churn clearTimeout calls', cleared);
    result('churn fired', fired);
    result('churn fired per 10 s', perTen.join(' '));
    result('churn lateness ms', check.late());
    result('churn order inversions', check.inversions());
    if (globalThis.performance?.memory) result('churn edge used JS heap MB', (performance.memory.usedJSHeapSize / 1048576).toFixed(1));
  };
}

function slowload(work) {
  rafWork = work;
  let ticks = 0, frameTicks = 0;
  const perFrame = [];
  for (let i = 0; i < 8; i++) (async () => { while (live()) { await new Promise(r => setTimeout(r, 0)); if (live()) { ticks++; frameTicks++; } busy(1); } })();
  onFrame = () => { if (live()) perFrame.push(frameTicks); frameTicks = 0; };
  finish = () => {
    result(`${mode} loader ticks`, ticks);
    result(`${mode} loader ticks per frame`, stats(perFrame));
  };
}

function startWindow() {
  windowStart = performance.now();
  windowEnd = windowStart + span;
  reportAt = windowEnd + (mode === 'churn' ? 4300 : 2700);
  if (mode.startsWith('slowload')) slowload(Number(mode.slice(8)));
  else ({ tween, tick16, howler, churn })[mode]();
}

function report() {
  reported = true;
  finish();
  result(`${mode} frames inside the window`, framesInWindow);
  result(`${mode} mean frame interval ms`, framesInWindow > 1 ? ((lastInWindow - firstInWindow) / (framesInWindow - 1)).toFixed(2) : 'n/a');
  result(`${mode} longest frame gap ms`, Math.round(maxGap));
  result(`${mode} frame gaps over 12 ms`, longFrames);
  for (const [name, value] of Object.entries(R)) console.log(`R ${name}: ${value}`);
}

function frame() {
  const t = performance.now();
  if (t > windowStart && t < windowEnd) {
    framesInWindow++;
    firstInWindow ??= t;
    lastInWindow = t;
    if (lastFrame !== null) { maxGap = Math.max(maxGap, t - lastFrame); if (t - lastFrame > 12) longFrames++; }
  }
  lastFrame = t;
  onFrame(t);
  busy(rafWork);
  if (frames === 4) startWindow();
  if (!reported && frames >= 30 && performance.now() >= reportAt) report();
  if (native) setClearColor(0, reported ? 1 : 0, 0, 1);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
