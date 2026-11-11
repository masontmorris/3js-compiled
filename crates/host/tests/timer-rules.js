// Timers in headless Edge and in the host, from the round-14 verification's lane T. No renderer; the host's clear colour
// turns green once the page reports. Modes (scene):
//   default  frame 5's rAF sets 0/1/4/16 ms timers, equal deadlines, args, a string handler, a throwing callback, a
//            cleared timer, a promise-set timer, a 0 ms interval cleared on its third run and a rAF; frame 10 clears
//            a fired id, an unknown id, undefined, null, a pending timer by its id as a string, and crosses
//            clearInterval/clearTimeout; frame 15 starts a 12-deep 0 ms chain; frame 20 measures never-early for
//            1/4/16/30/100 ms and a 10 ms interval; frame 25 sets odd delays (Infinity, 2^31, 2^32+5, -5, '7', NaN).
//            From frame 120 and 900 ms after frame 25 it logs `R <name>: <value>` lines.
//   busy     from frame 5 a timer re-arms itself for 8 ms at its start, then works 12 ms, for 1500 ms; logs the frames
//            that ran inside that window. A browser keeps rendering between such timer tasks.
//   busy2    the same with two 4 ms intervals that each work 6 ms.
const native = typeof submitGpuCommands === 'function';
const mode = native ? (globalThis.__sceneName ?? 'default') : (new URLSearchParams(location.search).get('scene') ?? 'default');
const events = [];
const log = name => events.push(name);
globalThis.__log = log;
const R = {};
const result = (name, value) => { R[name] = value; };
const early = [];
let frames = 0;
let errorEvents = 0;
globalThis.addEventListener?.('error', () => { errorEvents++; });
const timer = (name, delay, ...args) => {
  const set = performance.now();
  return setTimeout((...got) => {
    const waited = performance.now() - set;
    const want = Math.max(0, Number(delay) || 0);
    if (Number.isFinite(want) && want < 2 ** 31 && waited < want) early.push(`${name}:${waited.toFixed(2)}<${want}`);
    log(args.length ? `${name}(${got.map(String).join(',')})` : name);
  }, delay, ...args);
};
const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };

const timing = [];
const chain = [];
const intervalGaps = [];
const odd = [];
let ids = {};
let reportAt = Infinity;
let reported = false;

function frameFive() {
  requestAnimationFrame(() => {
    log('rafA');
    Promise.resolve().then(() => { log('rafA.promise'); timer('fromPromise', 0); });
    queueMicrotask(() => log('rafA.microtask'));
    for (const delay of [16, 4, 1]) {
      const set = performance.now();
      setTimeout(() => timing.push(`d${delay}`), delay);
    }
    ids.d0 = timer('d0', 0);
    timer('e1', 0); timer('e2', 0); timer('e3', 0);
    timer('args', 0, 1, 'x', null, undefined);
    clearTimeout(timer('cleared', 0));
    setTimeout('globalThis.__log("string-handler")', 0);
    setTimeout(() => { log('throws'); throw new Error('lane-t timer callback throws'); }, 0);
    let runs = 0;
    const interval = setInterval(arg => {
      runs++;
      log(`iv${runs}(${arg})`);
      if (runs === 3) clearInterval(interval);
    }, 0, 'p');
    ids.pendingString = timer('stringIdCleared', 60);
    ids.crossTimeout = timer('crossClearedByClearInterval', 60);
    let crossRuns = 0;
    ids.crossInterval = setInterval(() => { crossRuns++; log(`crossInterval${crossRuns}`); }, 20);
    requestAnimationFrame(() => log('raf-from-rafA'));
    result('setTimeout returns', typeof ids.d0);
  });
  requestAnimationFrame(() => {
    log('rafB');
    Promise.resolve().then(() => log('rafB.promise'));
    timer('fromRafB', 0);
  });
}

function frameTen() {
  log('frame10');
  clearTimeout(ids.d0);
  clearTimeout(987654);
  clearTimeout(undefined);
  clearTimeout(null);
  clearTimeout();
  clearTimeout(String(ids.pendingString));
  clearInterval(ids.crossTimeout);
  clearTimeout(ids.crossInterval);
}

function frameFifteen() {
  let last = performance.now();
  const step = level => {
    const now = performance.now();
    chain.push([level, now - last]);
    last = now;
    if (level < 12) setTimeout(() => step(level + 1), 0);
  };
  setTimeout(() => step(1), 0);
}

function frameTwenty() {
  for (const delay of [1, 4, 16, 30, 100]) timer(`never-early-${delay}`, delay);
  let last = performance.now();
  let runs = 0;
  const interval = setInterval(() => {
    const now = performance.now();
    intervalGaps.push(now - last);
    last = now;
    if (++runs === 5) clearInterval(interval);
  }, 10);
}

function frameTwentyFive() {
  const started = performance.now();
  for (const [name, delay] of [['Infinity', Infinity], ['2^31', 2 ** 31], ['2^32+5', 2 ** 32 + 5], ['-5', -5], ["'7'", '7'], ['NaN', NaN], ['4.9', 4.9]]) {
    setTimeout(() => odd.push(`${name}@${Math.round(performance.now() - started)}`), delay);
  }
  reportAt = started + 900;
}

function report() {
  reported = true;
  result('order', events.join(' '));
  result('timing order', timing.join(' '));
  result('early', early.join(' ') || 'none');
  result('chain gaps', chain.map(([level, gap]) => `${level}:${gap.toFixed(1)}`).join(' '));
  result('chain first level with gap >= 3.5 ms', chain.find(([, gap]) => gap >= 3.5)?.[0] ?? 'none');
  result('10 ms interval gaps', intervalGaps.map(gap => gap.toFixed(1)).join(' '));
  result('10 ms interval early', intervalGaps.some(gap => gap < 10));
  result('odd delays that ran within 900 ms', odd.join(' ') || 'none');
  result('window error events', errorEvents);
  for (const [name, value] of Object.entries(R)) console.log(`R ${name}: ${value}`);
}

let busyStart = Infinity;
let busyEnd = Infinity;
let framesInBusy = 0;
let ticks = 0;
function startBusy() {
  busyStart = performance.now();
  busyEnd = busyStart + 1500;
  if (mode === 'busy') {
    const tick = () => {
      if (performance.now() >= busyEnd) return;
      setTimeout(tick, 8);
      ticks++;
      busy(12);
    };
    setTimeout(tick, 8);
  } else {
    for (let i = 0; i < 2; i++) {
      const interval = setInterval(() => {
        if (performance.now() >= busyEnd) { clearInterval(interval); return; }
        ticks++;
        busy(6);
      }, 4);
    }
  }
}

function frame(now) {
  if (mode === 'default') {
    if (frames === 4) frameFive();
    if (frames === 9) frameTen();
    if (frames === 14) frameFifteen();
    if (frames === 19) frameTwenty();
    if (frames === 24) frameTwentyFive();
    if (frames >= 120 && !reported && performance.now() >= reportAt) report();
  } else {
    if (frames === 4) startBusy();
    const t = performance.now();
    if (t > busyStart && t < busyEnd) framesInBusy++;
    if (!reported && t > busyEnd + 200 && frames >= 120) {
      reported = true;
      console.log(`R ${mode} timer ticks in 1500 ms: ${ticks}`);
      console.log(`R ${mode} frames inside the 1500 ms window: ${framesInBusy}`);
    }
  }
  if (native) setClearColor(0, reported ? 1 : 0, 0, 1);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
