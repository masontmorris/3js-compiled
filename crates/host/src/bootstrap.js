const ops = Deno.core.ops;
const callbacks = new Map();
let nextFrame = 1;
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.devicePixelRatio = 1;
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
    const ran = performance.now();
    try { timer.handler(...timer.args); } catch (error) { report(error); }
    // An interval that its callback did not clear runs again at the next point of its schedule after this run began,
    // nested one level deeper, as Chrome does: its deadlines stay a timeout apart however late each run is, and a
    // run so late that it misses whole periods skips them rather than running them back to back.
    if (timer.repeat && timers.get(id) === timer) {
      timer.timeout = Math.max(timer.nesting > 5 ? 4 : 0, timer.timeout);
      const next = timer.timeout > 0 ? ran + timer.timeout - ((ran - timer.deadline) % timer.timeout) : performance.now();
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
// HTML's "report an exception": a cancelable error event at the window, whose message has Edge's "Uncaught " prefix,
// and the console unless a listener cancels the event or onerror returns true. An exception thrown while reporting
// goes to the console only. The platform shims make the window an EventTarget and define ErrorEvent.
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
    globalThis.dispatchEvent(event);
    reporting = false;
    canceled = event.defaultPrevented;
  }
  if (!canceled) console.error(error?.stack ?? String(error));
}
globalThis.reportError = report;
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
