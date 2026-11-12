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
// HTML's timers. Each frame begins with a turn of timer tasks, as a browser runs its tasks between renderings: each due
// timer in order of deadline and then of setting, each with its promise jobs after it, until the frame is due. The game
// thread starts a frame while the render thread still renders the one before, so the frame is due once the render
// thread has caught up and the turn has had its share: 3.3 ms of timers a frame on average, or a display refresh if
// that is shorter, about what Edge gives its tasks whatever the frame's own work costs. The frame is due no sooner than
// the first display refresh after the frame before began, as a browser begins frames on its display's refresh. A turn
// also ends a display refresh after it began, or at the frame's display refresh if that is later. While nothing is due
// and the frame is not, the turn sleeps until the next timer falls due, so an interval shorter than a frame keeps its
// schedule. The turn checks between timers, so it runs at least one due timer and holds the frame callbacks back by at
// most the callback running when the frame falls due. A timer set from a timer task or its promise jobs is nested one
// deeper, and one nested more than 5 deep waits at least 4 ms, as in HTML. Delays and ids convert as WebIDL's long
// does. The pending timers are a binary heap, so a turn takes O(log n) to find each next timer.
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
// The deadline of the earliest live timer, or Infinity.
function nextDeadline() {
  while (heap.length) {
    const [deadline, order, id] = heap[0];
    if (timers.get(id)?.order === order) return deadline;
    popEarliest();
  }
  return Infinity;
}
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
// Runs due timers until `cap`, or once `shared` has passed and the frame is due, which is when the render thread has
// caught up and `pacedAt`, the frame's display refresh, has come. With vsync off a turn does not wait for the render
// thread, so the frame records while the render thread draws the one before; the idle wait before the handover still
// does. A turn runs at least one due timer, and an idle wait
// (`turn` false) none once the frame is due. While nothing is due and the frame is not, it sleeps until the next timer
// falls due, the frame does, or `cap` comes, so a timer that falls due while the host waits for the frame runs then, as
// a browser runs its tasks between renderings.
function runTimers(cap, shared, pacedAt, turn) {
  for (let ran = !turn; ;) {
    const now = performance.now();
    const rendered = ops.op_frame_due();
    const frameDue = (rendered || (turn && !globalThis.__vsync)) && now >= pacedAt;
    if (ran && (now >= cap || (now >= shared && frameDue))) return;
    const due = takeDue(now);
    if (!due) {
      if (frameDue || now >= cap) return;
      // A host with no render thread, as in the unit tests, does not wait.
      if (!ops.op_wait(Math.min(nextDeadline(), cap, rendered ? pacedAt : Infinity), !rendered)) return;
      continue;
    }
    ran = true;
    const [id, timer] = due;
    if (!timer.repeat) timers.delete(id);
    nesting = timer.nesting;
    const began = performance.now();
    try { timer.handler(...timer.args); } catch (error) { report(error); }
    // An interval that its callback did not clear runs again at the next point of its schedule after this run began,
    // nested one level deeper, as Chrome does: its deadlines stay a timeout apart however late each run is, and a
    // run so late that it misses whole periods skips them rather than running them back to back.
    if (timer.repeat && timers.get(id) === timer) {
      timer.timeout = Math.max(timer.nesting > 5 ? 4 : 0, timer.timeout);
      const next = timer.timeout > 0 ? began + timer.timeout - ((began - timer.deadline) % timer.timeout) : performance.now();
      Object.assign(timer, { deadline: next, order: timerOrder++, nesting: timer.nesting + 1 });
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
// A frame interval in ms that the host forces for testing, as at 60 Hz on a faster display, or null: a frame is then
// due no sooner than this long after the frame before began its callbacks.
globalThis.__framePacing = null;
// Whether the display paces frames, as with vsync on; the host sets it.
globalThis.__vsync = true;
let framesBegan = -Infinity;
// When the next frame may begin: with a forced frame rate, that interval after the frame before began. Otherwise a
// frame begins no sooner than the first display refresh after the frame before began, as a browser begins frames on its
// display's refresh: after a late frame the next begins at once and the one after waits for its refresh, rather than
// both running ahead while the render thread has room. The refreshes are the latest one the render thread waited for
// and every display interval from it; with none, as with vsync off, a frame is due once the render thread has caught
// up.
function frameDueAt(interval) {
  if (globalThis.__framePacing !== null) return framesBegan + globalThis.__framePacing;
  const refreshed = ops.op_refreshed();
  if (Number.isNaN(refreshed) || framesBegan === -Infinity) return -Infinity;
  return refreshed + Math.ceil((framesBegan + 0.25 - refreshed) / interval) * interval;
}
let shareLeft = 3.3;
// Runs timers while the host waits for the render thread to catch up before it hands over the next frame: each timer as
// it falls due, until the render thread has caught up, as a browser runs its tasks while it waits to render.
globalThis.__hostIdle = () => runTimers(Infinity, -Infinity, -Infinity, false);
// Runs the due timers and then the frame's callbacks, each with its promise jobs after it, as HTML does. At the end
// of a frame in which the page submits no command stream, NativeBackend hands the host the recorded work that the
// page awaits a response to.
globalThis.__hostFrame = () => {
  const start = performance.now();
  const interval = globalThis.__displayInterval;
  const share = Math.min(3.3, interval);
  const paced = frameDueAt(interval);
  runTimers(Math.max(start + interval, paced), start + shareLeft, paced, true);
  // A turn that ran past its share takes the overrun out of the next one's, so timers average the share of each frame
  // rather than the share plus the timer running when it ends.
  shareLeft = Math.max(0, Math.min(share, shareLeft + share - (performance.now() - start)));
  framesBegan = performance.now();
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
