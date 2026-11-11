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
// WebIDL's DOMException, which WebGPU throws its OperationErrors as, with its legacy codes. As in Edge, its name and
// code come from the prototype, and one a script constructs carries no stack.
const domExceptionCodes = {
  IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5, NoModificationAllowedError: 7,
  NotFoundError: 8, NotSupportedError: 9, InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13,
  NamespaceError: 14, InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20,
  URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25,
};
globalThis.DOMException ??= class DOMException extends Error {
  #name;
  constructor(message = "", name = "Error") {
    super(message);
    delete this.stack;
    this.#name = String(name);
  }
  get name() { return this.#name; }
  get code() { return domExceptionCodes[this.#name] ?? 0; }
  get [Symbol.toStringTag]() { return "DOMException"; }
};
// HTML's ErrorEvent, which the host fires at the global object for an uncaught exception.
globalThis.ErrorEvent ??= class ErrorEvent {
  constructor(type, { message = "", filename = "", lineno = 0, colno = 0, error = null, cancelable = false } = {}) {
    Object.assign(this, { type: String(type), message, filename, lineno, colno, error, cancelable, defaultPrevented: false });
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
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
// HTML's timers. Each frame begins with a turn of timer tasks, as a browser runs its tasks until a rendering
// opportunity: each due timer in order of deadline and then of setting, each with its promise jobs after it, until
// the next frame is due. The game thread starts a frame while the render thread still renders the one before, so the
// frame is due once the render thread has caught up and the turn has had its share: it starts timers for 3.5 ms, or a
// display refresh if that is shorter, which with the one running then gives timers about 4 ms of each frame, as Edge
// gives its tasks whatever the frame's own work costs. A turn also ends a display refresh after it began, whatever the
// render thread does. The turn checks between timers, so it runs at
// least one due timer and holds the frame callbacks back by at most the callback running when the frame falls due. A timer set from a timer task or its promise jobs is
// nested one deeper, and one nested more than 5 deep waits at least 4 ms, as in HTML. Delays and ids convert as
// WebIDL's long does. The pending timers are a binary heap, so a turn takes O(log n) to find each next timer.
const timers = new Map();
// The heap of [deadline, order, id], earliest first. A cleared timer's entry, and an interval's entry from before it
// re-armed, stay until they reach the top, where the timer's order no longer matches.
const heap = [];
let nextTimer = 1;
let timerOrder = 0;
let nesting = 0;
const earlier = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
function arm(id, timer) {
  // Rebuilds the heap from the live timers once stale entries outnumber them, so set-and-clear churn cannot grow it.
  if (heap.length > 2 * timers.size + 1024) {
    heap.length = 0;
    for (const [liveId, live] of timers) if (live !== timer) arm(liveId, live);
  }
  const entry = [timer.deadline, timer.order, id];
  let i = heap.push(entry) - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!earlier(entry, heap[parent])) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = entry;
}
function popEarliest() {
  const last = heap.pop();
  if (!heap.length) return;
  let i = 0;
  for (;;) {
    let child = 2 * i + 1;
    if (child >= heap.length) break;
    if (child + 1 < heap.length && earlier(heap[child + 1], heap[child])) child++;
    if (!earlier(heap[child], last)) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = last;
}
// The earliest live timer whose deadline has passed, taken off the heap, or null.
function takeDue(now) {
  while (heap.length) {
    const [deadline, order, id] = heap[0];
    const timer = timers.get(id);
    if (timer?.order !== order) { popEarliest(); continue; }
    if (deadline > now) return null;
    popEarliest();
    return [id, timer];
  }
  return null;
}
function schedule(callback, delay, args, repeat) {
  const id = nextTimer++;
  const handler = typeof callback === "function" ? callback : () => (0, eval)(String(callback));
  const timeout = Math.max(nesting > 5 ? 4 : 0, delay | 0);
  const timer = { handler, args, timeout, repeat, deadline: performance.now() + timeout, order: timerOrder++, nesting: nesting + 1 };
  timers.set(id, timer);
  arm(id, timer);
  return id;
}
globalThis.setTimeout = (callback, delay, ...args) => schedule(callback, delay, args, false);
globalThis.setInterval = (callback, delay, ...args) => schedule(callback, delay, args, true);
globalThis.clearTimeout = globalThis.clearInterval = id => { timers.delete(id | 0); };
function runTimers(frameDue) {
  for (let ran = false; !ran || !frameDue(); ran = true) {
    const due = takeDue(performance.now());
    if (!due) return;
    const [id, timer] = due;
    if (!timer.repeat) timers.delete(id);
    nesting = timer.nesting;
    try { timer.handler(...timer.args); } catch (error) { report(error); }
    // An interval that its callback did not clear runs again after its timeout, nested one level deeper.
    if (timer.repeat && timers.get(id) === timer) {
      timer.timeout = Math.max(timer.nesting > 5 ? 4 : 0, timer.timeout);
      Object.assign(timer, { deadline: performance.now() + timer.timeout, order: timerOrder++, nesting: timer.nesting + 1 });
      arm(id, timer);
    }
    ops.op_run_microtasks();
    nesting = 0;
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
// HTML's "report an exception": a cancelable error event at the window, whose message has Edge's "Uncaught " prefix,
// and the console unless a listener cancels the event or onerror returns true. An exception thrown while reporting
// goes to the console only.
let reporting = false;
function report(error) {
  let canceled = false;
  if (!reporting) {
    reporting = true;
    let message;
    try { message = `Uncaught ${String(error)}`; } catch { message = "Uncaught exception"; }
    const event = new ErrorEvent("error", { message, error, cancelable: true });
    try {
      if (typeof globalThis.onerror === "function" && globalThis.onerror(message, "", 0, 0, error) === true) event.preventDefault();
    } catch (inner) { console.error(inner?.stack ?? String(inner)); }
    for (const callback of listeners.get("error") ?? []) {
      try { callback(event); } catch (inner) { console.error(inner?.stack ?? String(inner)); }
    }
    reporting = false;
    canceled = event.defaultPrevented;
  }
  if (!canceled) console.error(error?.stack ?? String(error));
}
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
// The display's refresh interval in ms, which the host sets from its display mode. Frame starts cannot measure it: the
// game thread starts a frame at once when it catches up, and a turn that overruns stretches the next interval.
globalThis.__displayInterval = 1000 / 60;
// Runs the due timers and then the frame's callbacks, each with its promise jobs after it, as HTML does. At the end
// of a frame in which the page submits no command stream, NativeBackend hands the host the recorded work that the
// page awaits a response to.
globalThis.__hostFrame = () => {
  const start = performance.now();
  const interval = globalThis.__displayInterval;
  const shared = start + Math.min(3.5, interval);
  runTimers(() => {
    const now = performance.now();
    return now >= start + interval || (now >= shared && ops.op_frame_due());
  });
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
