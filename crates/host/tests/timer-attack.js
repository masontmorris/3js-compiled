// Attacks on the host's timer turn, from the round-14 verification's lane V, in headless Edge and in the host. No
// renderer; the host's clear colour turns green once the page reports. Each busy mode starts at frame 5 and runs for
// 1500 ms; it logs ticks, the frames whose callbacks ran inside the window, the longest gap before a frame callback
// in the window, and the gaps between the first 16 ticks (the 4 ms clamp shows as a gap of 4 ms or more).
//   rearm0      a zero-delay setTimeout that re-arms itself, 0.5 ms of work a tick
//   iv0heavy    a 0 ms setInterval that works 10 ms a tick
//   promise0    an async loop that yields with `await new Promise(r => setTimeout(r, 0))`, 0.5 ms of work a tick
//   promisethen a zero-delay setTimeout re-armed from a .then() inside its callback, 0.5 ms of work a tick
//   microtask   the same re-armed from queueMicrotask
//   fanout      each tick sets two zero-delay timers until level 6, 63 timers that each work 1 ms
//   deep        a plain zero-delay chain of 20 levels from a timer, then one from a frame callback, then a 0 ms
//               interval's first 20 runs, then a chain re-armed from .then(); logs each one's gaps
//   order       timers set from promise jobs inside a turn, against timers already due and a rAF
//   cancel      a throwing timer with an error listener that cancels the event, a throwing frame callback, a throw
//               with onerror returning true, and a listener that throws; logs each event's fields
//   domex       DOMException's name, code and string tag
const native = typeof submitGpuCommands === 'function';
const mode = native ? (globalThis.__sceneName ?? 'rearm0') : (new URLSearchParams(location.search).get('scene') ?? 'rearm0');
const R = {};
const result = (name, value) => { R[name] = value; };
const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };
let frames = 0;
let reported = false;
let reportAt = Infinity;
let windowStart = Infinity;
let windowEnd = Infinity;
let framesInWindow = 0;
let lastFrame = null;
let maxGap = 0;
let ticks = 0;
const tickTimes = [];
const tick = () => { ticks++; if (tickTimes.length < 17) tickTimes.push(performance.now()); };
const gaps = times => times.slice(1).map((t, i) => (t - times[i]).toFixed(1)).join(' ');
const firstClamped = times => { const i = times.slice(1).findIndex((t, k) => t - times[k] >= 3.5); return i < 0 ? 'none' : i + 2; };

function startWindow() {
  windowStart = performance.now();
  windowEnd = windowStart + 1500;
  reportAt = windowEnd + 300;
  const live = () => performance.now() < windowEnd;
  if (mode === 'rearm0') {
    const f = () => { if (!live()) return; tick(); busy(0.5); setTimeout(f, 0); };
    setTimeout(f, 0);
  }
  if (mode === 'iv0heavy') {
    const id = setInterval(() => { if (!live()) { clearInterval(id); return; } tick(); busy(10); }, 0);
  }
  if (mode === 'promise0') {
    (async () => { while (live()) { await new Promise(r => setTimeout(r, 0)); tick(); busy(0.5); } })();
  }
  if (mode === 'promisethen') {
    const f = () => { if (!live()) return; tick(); busy(0.5); Promise.resolve().then(() => setTimeout(f, 0)); };
    setTimeout(f, 0);
  }
  if (mode === 'fanout') {
    const f = level => { if (!live()) return; tick(); busy(1); if (level < 6) { setTimeout(f, 0, level + 1); setTimeout(f, 0, level + 1); } };
    setTimeout(f, 0, 1);
  }
  if (mode === 'microtask') {
    const f = () => { if (!live()) return; tick(); busy(0.5); queueMicrotask(() => setTimeout(f, 0)); };
    setTimeout(f, 0);
  }
}

// deep: four chains one after another, each logging its 20 levels' times.
const chains = {};
function chain(name, kind, done) {
  const times = [];
  chains[name] = times;
  const step = () => {
    times.push(performance.now());
    if (times.length >= 21) { done(); return; }
    if (kind === 'then') Promise.resolve().then(() => setTimeout(step, 0));
    else setTimeout(step, 0);
  };
  if (kind === 'interval') {
    const id = setInterval(() => { times.push(performance.now()); if (times.length >= 21) { clearInterval(id); done(); } }, 0);
  } else if (kind === 'raf') {
    requestAnimationFrame(() => { times.push(performance.now()); setTimeout(step, 0); });
  } else setTimeout(step, 0);
}
function startDeep() {
  chain('timer', 'plain', () => chain('raf', 'raf', () => chain('interval', 'interval', () => chain('then', 'then', () => { reportAt = performance.now() + 200; }))));
}

// order: timers set from promise jobs inside a turn.
const events = [];
const log = name => events.push(name);
function startOrder() {
  setTimeout(() => {
    log('A');
    Promise.resolve().then(() => { log('A.then'); setTimeout(() => log('fromAthen'), 0); });
    setTimeout(() => log('fromA'), 0);
  }, 0);
  setTimeout(() => {
    log('B');
    queueMicrotask(() => { log('B.micro'); setTimeout(() => log('fromBmicro'), 0); });
  }, 0);
  requestAnimationFrame(() => { log('raf'); setTimeout(() => log('fromRaf'), 0); });
  (async () => { await new Promise(r => setTimeout(r, 0)); log('awaited1'); await new Promise(r => setTimeout(r, 0)); log('awaited2'); })();
  reportAt = performance.now() + 500;
}

// cancel: HTML's report-an-exception.
const errorEvents = [];
let phase = '';
const describeEvent = e => `${phase}: ${e.constructor?.name} type=${e.type} message=${JSON.stringify(e.message)} errorIsThrown=${e.error === globalThis.__thrown} cancelable=${e.cancelable} filename=${typeof e.filename} lineno=${typeof e.lineno}`;
function cancelPhase(n) {
  if (n === 5) {
    phase = 'timer, listener cancels';
    const listener = e => { errorEvents.push(describeEvent(e)); e.preventDefault(); };
    addEventListener('error', listener);
    globalThis.__cancelListener = listener;
    setTimeout(() => { throw (globalThis.__thrown = new Error('lane-v timer throws, canceled')); }, 0);
  }
  if (n === 10) {
    phase = 'rAF, listener cancels';
    requestAnimationFrame(() => { throw (globalThis.__thrown = new Error('lane-v rAF throws, canceled')); });
  }
  if (n === 15) {
    removeEventListener('error', globalThis.__cancelListener);
    phase = 'timer, onerror returns true';
    globalThis.onerror = (message, source, line, col, error) => { errorEvents.push(`${phase}: onerror args=${typeof message},${typeof source},${typeof line},${typeof col},${error === globalThis.__thrown}`); return true; };
    setTimeout(() => { throw (globalThis.__thrown = new Error('lane-v timer throws, onerror true')); }, 0);
  }
  if (n === 20) {
    globalThis.onerror = null;
    phase = 'timer, listener throws';
    addEventListener('error', e => { errorEvents.push(describeEvent(e)); if (phase === 'timer, listener throws') { phase = 'done'; throw new Error('lane-v listener throws'); } });
    setTimeout(() => { throw (globalThis.__thrown = new Error('lane-v timer throws, not canceled')); }, 0);
  }
  if (n === 25) reportAt = performance.now();
}

function report() {
  reported = true;
  if (['rearm0', 'iv0heavy', 'promise0', 'promisethen', 'microtask', 'fanout'].includes(mode)) {
    result(`${mode} ticks in 1500 ms`, ticks);
    result(`${mode} frames inside the 1500 ms window`, framesInWindow);
    result(`${mode} longest frame gap ms`, Math.round(maxGap));
    result(`${mode} first tick gaps`, gaps(tickTimes));
    result(`${mode} first tick whose gap >= 3.5 ms`, firstClamped(tickTimes));
  }
  if (mode === 'deep') {
    for (const [name, times] of Object.entries(chains)) {
      result(`${name} chain gaps`, gaps(times));
      result(`${name} chain first level whose gap >= 3.5 ms`, firstClamped(times));
    }
  }
  if (mode === 'order') result('order', events.join(' '));
  if (mode === 'domex') {
    const e = new DOMException('m', 'OperationError');
    result('domex', `name=${e.name} ownName=${Object.prototype.hasOwnProperty.call(e, 'name')} code=${e.code} abort=${new DOMException('m', 'AbortError').code} default=${new DOMException().name}/${new DOMException().code} tag=${Object.prototype.toString.call(e)} string=${String(e)} instanceofError=${e instanceof Error}`);
  }
  if (mode === 'cancel') for (const [i, line] of errorEvents.entries()) result(`event ${i}`, line);
  for (const [name, value] of Object.entries(R)) console.log(`R ${name}: ${value}`);
}

function frame() {
  const t = performance.now();
  if (t > windowStart && t < windowEnd) {
    framesInWindow++;
    if (lastFrame !== null) maxGap = Math.max(maxGap, t - lastFrame);
  }
  lastFrame = t;
  if (frames === 4) {
    if (mode === 'deep') startDeep();
    else if (mode === 'order') startOrder();
    else if (mode === 'domex') reportAt = 0;
    else if (mode !== 'cancel') startWindow();
  }
  if (mode === 'cancel') cancelPhase(frames);
  if (!reported && frames >= 30 && performance.now() >= reportAt) report();
  if (native) setClearColor(0, reported ? 1 : 0, 0, 1);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
