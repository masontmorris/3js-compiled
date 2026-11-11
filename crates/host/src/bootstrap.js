const ops = Deno.core.ops;
const listeners = new Map();
const callbacks = new Map();
let nextFrame = 1;
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.devicePixelRatio = 1;
globalThis.AbortController ??= class AbortController {
  signal = { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {} };
  abort(reason) {
    this.signal.aborted = true;
    this.signal.reason = reason;
  }
};
globalThis.TextDecoder ??= class TextDecoder {
  constructor(label = "utf-8") {
    if (!/^utf-?8$/i.test(label)) throw new RangeError(`Unsupported encoding: ${label}`);
  }
  get encoding() { return "utf-8"; }
  decode(input = new Uint8Array()) {
    return Deno.core.decode(ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input));
  }
};
globalThis.performance = { now: () => ops.op_now() };
globalThis.console = Object.fromEntries(["log", "info", "warn", "error", "debug"].map(level =>
  [level, (...args) => ops.op_log(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "))]));
globalThis.addEventListener = (type, callback) => {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(callback);
};
globalThis.removeEventListener = (type, callback) => listeners.get(type)?.delete(callback);
globalThis.requestAnimationFrame = callback => { const id = nextFrame++; callbacks.set(id, callback); return id; };
let running = null;
globalThis.cancelAnimationFrame = id => { callbacks.delete(id); running?.delete(id); };
// HTML's timers. The host runs each due timer as its own task before a frame's callbacks, and runs the timers that
// become due meanwhile too, as a browser runs its tasks between frames. A timer nested more than 5 deep waits at
// least 4 ms, as in HTML, so a chain of zero-delay timers cannot hold frames back.
const timers = new Map();
let nextTimer = 1;
let timerOrder = 0;
let nesting = 0;
function schedule(callback, delay, args, repeat) {
  const id = nextTimer++;
  const handler = typeof callback === "function" ? callback : () => (0, eval)(String(callback));
  const timeout = Math.max(nesting > 5 ? 4 : 0, Number(delay) || 0);
  timers.set(id, { handler, args, timeout, repeat, deadline: performance.now() + timeout, order: timerOrder++, nesting: nesting + 1 });
  return id;
}
globalThis.setTimeout = (callback, delay, ...args) => schedule(callback, delay, args, false);
globalThis.setInterval = (callback, delay, ...args) => schedule(callback, delay, args, true);
globalThis.clearTimeout = globalThis.clearInterval = id => { timers.delete(id); };
function runTimers() {
  for (;;) {
    const now = performance.now();
    let due = null;
    for (const entry of timers) {
      const timer = entry[1];
      if (timer.deadline <= now && (!due || timer.deadline < due[1].deadline || (timer.deadline === due[1].deadline && timer.order < due[1].order))) due = entry;
    }
    if (!due) return;
    const [id, timer] = due;
    if (!timer.repeat) timers.delete(id);
    nesting = timer.nesting;
    try { timer.handler(...timer.args); } catch (error) { report(error); }
    nesting = 0;
    // An interval that its callback did not clear runs again after its timeout, nested one level deeper.
    if (timer.repeat && timers.get(id) === timer) {
      timer.timeout = Math.max(timer.nesting > 5 ? 4 : 0, timer.timeout);
      Object.assign(timer, { deadline: performance.now() + timer.timeout, order: timerOrder++, nesting: timer.nesting + 1 });
    }
    ops.op_run_microtasks();
  }
}
// The page keeps frames and timers coming however long its entry module awaits, as a browser does.
ops.op_host_alive();
globalThis.setClearColor = (r, g, b, a = 1) => ops.op_clear(r, g, b, a);
globalThis.submitGpuCommands = bytes => {
  if (!ops.op_gpu_submit(bytes)) throw new Error("Only one GPU command stream is allowed per frame");
};
const gamepads = [];
globalThis.navigator = { getGamepads: () => gamepads };
function report(error) { console.error(error?.stack ?? String(error)); }
globalThis.__hostDispatch = event => {
  if (event.type === "gpu-response") {
    for (const response of event.responses) {
      if (response.type === "readback") response.bytes = ops.op_gpu_readback(response.request);
    }
  }
  if (event.type === "resize") {
    globalThis.innerWidth = event.width;
    globalThis.innerHeight = event.height;
  }
  if (event.type === "gamepadbutton") {
    let pad = gamepads[event.index];
    if (!pad) {
      pad = gamepads[event.index] = { index: event.index, connected: true, buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
      __hostDispatch({ type: "gamepadconnected", gamepad: pad });
    }
    pad.buttons[event.button] = { pressed: event.down, value: event.down ? 1 : 0 };
  }
  for (const callback of listeners.get(event.type) ?? []) {
    try { callback(event); } catch (error) { report(error); }
  }
};
// Runs the due timers and then the frame's callbacks, each with its promise jobs after it, as HTML does. A frame in
// which the page submits no command stream hands the stream's recorded work to the host, as a browser's GPU work
// moves on without the page.
globalThis.__hostFrame = () => {
  runTimers();
  running = new Map(callbacks);
  callbacks.clear();
  const now = performance.now();
  for (const [id, callback] of running) {
    if (!running.has(id)) continue;
    try { callback(now); } catch (error) { report(error); }
    ops.op_run_microtasks();
  }
  running = null;
  if (!ops.op_gpu_submitted()) globalThis.__gpuFrameEnd?.();
};
