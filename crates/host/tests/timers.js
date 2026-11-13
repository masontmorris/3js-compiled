// The order of timers, requestAnimationFrame callbacks and promise jobs, run in headless Edge and in the
// host. It checks only what HTML fixes, not timing that follows the frame rate. Frame 5 runs two rAF callbacks that
// queue promise jobs, microtasks and timers; frame 20 checks that delays are never early, that equal deadlines keep
// the order they were set in, and that an interval stops when cleared. From frame 120, once 400 ms have passed since
// frame 20, the page logs `R <name>: <value>` lines.
const native = typeof submitGpuCommands === 'function';
const events = [];
const log = name => events.push(name);
let frames = 0;
let inFrame = false;
let timerInFrame = false;
const timer = (name, delay = 0, ...args) => setTimeout((...got) => {
  timerInFrame ||= inFrame;
  log(args.length ? `${name}(${got.join(',')})` : name);
}, delay, ...args);
const results = {};
const result = (name, value) => { results[name] = value; };

function frameFive() {
  requestAnimationFrame(() => {
    inFrame = true;
    log('rafA');
    Promise.resolve().then(() => log('rafA.promise'));
    queueMicrotask(() => log('rafA.microtask'));
    timer('t1');
    timer('t2');
    timer('args', 0, 'a', 'b');
    clearTimeout(timer('cleared'));
    setTimeout(() => { log('throws'); throw new Error('a timer callback throws'); }, 0);
    setTimeout(() => {
      log('t3');
      Promise.resolve().then(() => log('t3.promise'));
      setTimeout(() => { log('t3.nested'); setTimeout(() => log('t3.nested.nested'), 0); }, 0);
      requestAnimationFrame(() => log('raf-from-timer'));
    }, 0);
    timer('t4');
    inFrame = false;
  });
  requestAnimationFrame(() => {
    inFrame = true;
    log('rafB');
    Promise.resolve().then(() => log('rafB.promise'));
    inFrame = false;
  });
}

let twentyAt = Infinity;
let reported = false;
function frameTwenty() {
  const started = twentyAt = performance.now();
  setTimeout(() => result('a 30 ms timer runs no sooner than 30 ms', performance.now() - started >= 30), 30);
  const order = [];
  setTimeout(() => order.push('first'), 10);
  setTimeout(() => order.push('second'), 10);
  setTimeout(() => result('equal deadlines run in the order they were set', order.join(',')), 40);
  let count = 0;
  const interval = setInterval(() => {
    count++;
    if (count === 3) clearInterval(interval);
  }, 1);
  setTimeout(() => result('an interval cleared on its third run ran', count), 200);
  result('queueMicrotask is a function', typeof queueMicrotask);
  result('setInterval returns a number', typeof interval);
}

function frame() {
  if (frames === 4) frameFive();
  if (frames === 19) frameTwenty();
  // A fast host reaches frame 120 sooner than Edge, so the report also waits for frame 20's timers.
  if (frames >= 120 && !reported && performance.now() - twentyAt >= 400) {
    reported = true;
    result('order', events.join(' '));
    result('a timer ran inside a frame callback', timerInFrame);
    for (const [name, value] of Object.entries(results)) console.log(`R ${name}: ${value}`);
  }
  if (native) setClearColor(0, reported ? 1 : 0, 0, 1);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
