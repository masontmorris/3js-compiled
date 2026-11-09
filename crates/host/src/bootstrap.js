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
globalThis.cancelAnimationFrame = id => callbacks.delete(id);
globalThis.setClearColor = (r, g, b, a = 1) => ops.op_clear(r, g, b, a);
globalThis.submitGpuCommands = bytes => {
  if (!ops.op_gpu_submit(bytes)) throw new Error("Only one GPU command stream is allowed per frame");
};
const gamepads = [];
globalThis.navigator = { getGamepads: () => gamepads };
function report(error) { console.error(error?.stack ?? String(error)); }
globalThis.__hostDispatch = event => {
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
globalThis.__hostFrame = () => {
  const current = [...callbacks.values()];
  callbacks.clear();
  const now = performance.now();
  for (const callback of current) {
    try { callback(now); } catch (error) { report(error); }
  }
};
