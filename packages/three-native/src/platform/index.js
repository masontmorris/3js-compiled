// Installs the platform shims on the host's global object before the entry module runs, and turns the host's
// input facts into DOM events. The host serves this module and its siblings as threejsc:/platform/.
import * as events from './events.js';
import { Document, DocumentFragment, Element, HTMLElement, HTMLCanvasElement, HTMLInputElement, HTMLTextAreaElement, Node, Text, DOMTokenList, CSSStyleDeclaration, setLog, logOnce } from './dom.js';
import { Gamepad, GamepadButton, GamepadEvent, GamepadHapticActuator, Gamepads } from './gamepad.js';
import { Storage } from './storage.js';
import { URL, URLSearchParams, Blob, File, Headers, Request, Response, fetch, HTMLImageElement, ImageBitmap, createImageBitmap, imageConstructor, setHost } from './images.js';
import { AbortController, AbortSignal } from './abort.js';
import { CanvasGradient, CanvasRenderingContext2D, FontFace, FontFaceSet, ImageData, TextMetrics, setCanvasHost } from './canvas2d.js';
import { EVENT_HANDLERS } from './dom-methods.js';
import { CookieJar, Crypto, QuotaExceededError, atob, btoa, evaluateMedia as evaluate, openWindow, serializeMedia } from './window.js';
import { DOMMatrix, DOMMatrixReadOnly, DOMPoint, DOMPointReadOnly, DOMRect, DOMRectReadOnly } from './geometry.js';
import { MutationObserver, MutationRecord, NodeList, IntersectionObserver, IntersectionObserverEntry, updateIntersections } from './observers.js';

const ops = Deno.core.ops;
const config = globalThis.__hostConfig;
const window = globalThis;

setLog(message => ops.op_log(message));
events.setCheckpoint(() => ops.op_run_microtasks());
globalThis.TextEncoder ??= class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(text = '') { return Deno.core.encode(String(text)); }
};

window.addEventListener = (type, callback, options) => events.addEventListener.call(window, type, callback, options);
window.removeEventListener = (type, callback, options) => events.removeEventListener.call(window, type, callback, options);
window.dispatchEvent = event => events.dispatchEvent.call(window, event);
// bootstrap.js reads window.onerror itself when it reports an exception, so it stays a plain property.
events.defineHandlers(window, EVENT_HANDLERS.window.filter(type => type !== 'error'));

const document = new Document(window);
const cookies = new CookieJar(config.cookies ?? [], new URL(config.href).pathname, () => Date.now(), saved => ops.op_cookies_save(JSON.stringify(saved)));
Object.defineProperty(document, 'cookie', { get: () => cookies.get(), set: value => cookies.set(value), configurable: true, enumerable: true });
const location = new URL(config.href);
const router = new events.InputRouter(window, document);
const gamepads = new Gamepads(window);
const localStorage = new Storage(config.storage, {
  set: (key, value) => ops.op_storage_set(key, value),
  remove: key => ops.op_storage_remove(key),
  clear: () => ops.op_storage_clear(),
});
setHost({
  readFile: async path => {
    const bytes = await ops.op_read_file(path);
    return bytes ? new Uint8Array(bytes) : null;
  },
  decode: async (bytes, convert) => {
    const decoded = await ops.op_image_decode(bytes, convert);
    return { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data), premultiplied: false };
  },
});
setCanvasHost({
  fontLoad: bytes => ops.op_canvas2d_font_load(bytes),
  fillRect: (pixels, width, height, draw) => ops.op_canvas2d_fill_rect(pixels, width, height, draw),
  clearRect: (pixels, width, height, draw) => ops.op_canvas2d_clear_rect(pixels, width, height, draw),
  drawImage: (pixels, width, height, image, draw) => ops.op_canvas2d_draw_image(pixels, width, height, image, draw),
  text: (pixels, width, height, draw) => ops.op_canvas2d_text(pixels, width, height, draw),
  measure: request => ops.op_canvas2d_measure(request),
  unpremultiply: (from, to) => ops.op_canvas2d_unpremultiply(from, to),
});

// Media queries over the window's size and pixel ratio, with Edge's answers for a desktop with a mouse.
const evaluateMedia = query => evaluate(query, { width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio });
// A list's `matches` reads the window as it is. A list with a change listener is watched, which keeps it alive as a
// listener does in Edge, and gets a change event when its result flips on a resize.
const watched = new Map();
class MediaQueryList extends events.EventTarget {
  constructor(media) {
    super();
    this.media = serializeMedia(media);
  }
  get matches() { return evaluateMedia(this.media); }
  addEventListener(type, callback, options) {
    super.addEventListener(type, callback, options);
    if (String(type) === 'change' && !watched.has(this)) watched.set(this, this.matches);
  }
  addListener(callback) { this.addEventListener('change', callback); }
  removeListener(callback) { this.removeEventListener('change', callback); }
}
events.defineHandlers(MediaQueryList.prototype, ['change']);
const handler = Object.getOwnPropertyDescriptor(MediaQueryList.prototype, 'onchange');
Object.defineProperty(MediaQueryList.prototype, 'onchange', {
  ...handler,
  set(value) {
    handler.set.call(this, value);
    if (!watched.has(this)) watched.set(this, this.matches);
  },
});
class MediaQueryListEvent extends events.Event {
  constructor(type, init = {}) { super(type, init); this.media = init.media ?? ''; this.matches = !!init.matches; }
}
function updateMedia() {
  for (const [list, last] of watched) {
    const matches = list.matches;
    if (matches === last) continue;
    watched.set(list, matches);
    list.dispatchEvent(new MediaQueryListEvent('change', { media: list.media, matches }));
  }
}

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';
const navigator = {
  userAgent,
  appVersion: userAgent.slice(8),
  platform: 'Win32',
  vendor: 'Google Inc.',
  language: 'en-US',
  languages: Object.freeze(['en-US', 'en']),
  hardwareConcurrency: config.cores,
  maxTouchPoints: 0,
  onLine: true,
  cookieEnabled: true,
  webdriver: false,
  getGamepads: () => gamepads.getGamepads(),
};
const screen = {
  get width() { return config.screen[0]; },
  get height() { return config.screen[1]; },
  get availWidth() { return config.screen[0]; },
  get availHeight() { return config.screen[1]; },
  colorDepth: 24,
  pixelDepth: 24,
  orientation: { type: 'landscape-primary', angle: 0 },
};
const locationObject = {
  get href() { return location.href; },
  set href(value) { logOnce('location: navigation is not implemented'); },
  get protocol() { return location.protocol; },
  get host() { return location.host; },
  get hostname() { return location.hostname; },
  get port() { return location.port; },
  get pathname() { return location.pathname; },
  get search() { return location.search; },
  get origin() { return location.origin; },
  get hash() { return location.hash; },
  set hash(value) {
    const old = location.href;
    location.hash = value;
    if (location.href !== old) setTimeout(() => window.dispatchEvent(Object.assign(new events.Event('hashchange'), { oldURL: old, newURL: location.href })), 0);
  },
  assign() { logOnce('location: navigation is not implemented'); },
  replace() { logOnce('location: navigation is not implemented'); },
  reload() { logOnce('location: navigation is not implemented'); },
  toString() { return location.href; },
};

Object.assign(window, {
  ...Object.fromEntries(['Event', 'CustomEvent', 'ErrorEvent', 'PromiseRejectionEvent', 'UIEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'WheelEvent', 'EventTarget'].map(name => [name, events[name]])),
  Node, Element, HTMLElement, HTMLCanvasElement, HTMLInputElement, HTMLTextAreaElement, HTMLImageElement, Text, Document,
  DocumentFragment, DOMTokenList, CSSStyleDeclaration, Gamepad, GamepadButton, GamepadEvent, GamepadHapticActuator,
  MutationObserver, MutationRecord, NodeList, IntersectionObserver, IntersectionObserverEntry,
  Storage, URL, URLSearchParams, Blob, File, Headers, Request, Response, ImageBitmap, MediaQueryList, MediaQueryListEvent,
  AbortController, AbortSignal, CanvasGradient, CanvasRenderingContext2D, FontFace, FontFaceSet, ImageData, TextMetrics,
  DOMMatrix, DOMMatrixReadOnly, DOMPoint, DOMPointReadOnly, DOMRect, DOMRectReadOnly,
  atob, btoa, fetch, createImageBitmap, document, navigator, screen, localStorage, QuotaExceededError, Crypto,
  crypto: new Crypto(bytes => ops.op_random_fill(bytes)),
  sessionStorage: new Storage(),
  location: locationObject,
  Image: imageConstructor(document),
  matchMedia: query => new MediaQueryList(query),
  getComputedStyle: element => element.style,
  devicePixelRatio: config.ratio,
  outerWidth: window.innerWidth,
  outerHeight: window.innerHeight,
  scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0, screenX: 0, screenY: 0, screenLeft: 0, screenTop: 0,
  frames: window, parent: window, top: window, opener: null, closed: false, name: '', length: 0,
  focus() {},
  blur() {},
  scrollTo() {},
  scroll() {},
  scrollBy() {},
  open: url => openWindow(url, href => ops.op_open_url(href), message => ops.op_log(message)),
  alert(message) { ops.op_log(`alert: ${message}`); },
  confirm(message) { ops.op_log(`confirm: ${message}`); return false; },
  prompt(message) { ops.op_log(`prompt: ${message}`); return null; },
});

// HTML's update-the-rendering step: IntersectionObserver checks its targets after each frame's callbacks and delivers
// an entry in a task before the next frame.
const hostFrame = globalThis.__hostFrame;
globalThis.__hostFrame = () => { hostFrame(); updateIntersections(); };

// HTML's unhandled promise rejections: a trusted, cancelable unhandledrejection event at the window, and Edge's
// console line unless a listener cancels it. The handler always reports the rejection as handled, so deno_core never
// turns it into an error that stops the game. rejectionhandled, for a rejection handled later, is not implemented.
Deno.core.setUnhandledPromiseRejectionHandler((promise, reason) => {
  const event = events.trusted(new events.PromiseRejectionEvent('unhandledrejection', { promise, reason, cancelable: true }));
  try { window.dispatchEvent(event); } catch (error) { console.error(error?.stack ?? String(error)); }
  if (!event.defaultPrevented) {
    let text;
    try { text = reason instanceof Error ? reason.stack ?? String(reason) : String(reason); } catch { text = 'exception'; }
    console.error(`Uncaught (in promise) ${text}`);
  }
  return true;
});

// WebAssembly.compileStreaming and instantiateStreaming over the shim's Response: V8 hands each source to this
// callback, which checks it as Edge does and feeds the whole body to the streaming compiler at once.
Deno.core.setWasmStreamingCallback(async (source, rid) => {
  const fail = message => new TypeError(`Failed to execute 'compile' on 'WebAssembly': ${message}`);
  try {
    const response = await source;
    if (!(response instanceof Response)) throw fail('An argument must be provided, which must be a Response or Promise<Response> object.');
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/wasm') throw fail("Incorrect response MIME type. Expected 'application/wasm'.");
    if (!response.ok) throw fail('HTTP status code is not ok.');
    if (response.bodyUsed) throw fail('Cannot compile WebAssembly.Module from an already read Response.');
    if (response.url) ops.op_wasm_streaming_set_url(rid, response.url);
    ops.op_wasm_streaming_feed(rid, await response.bytes());
    Deno.core.close(rid);
  } catch (error) {
    Deno.core.abortWasmStreaming(rid, error);
  }
});

// The host's input facts, one per window or script event, become the DOM events Edge fires.
const facts = {
  keydown: fact => router.key(fact),
  keyup: fact => router.key(fact),
  pointermove: fact => router.pointer(fact),
  pointerdown: fact => router.pointer(fact),
  pointerup: fact => router.pointer(fact),
  pointerleave: () => router.leave(),
  wheel: fact => router.wheel(fact),
  focus: fact => router.focus(fact),
  gamepads: fact => events.asHost(() => gamepads.update(fact.pads, performance.now())),
  resize: fact => events.asHost(() => {
    window.innerWidth = window.outerWidth = fact.width;
    window.innerHeight = window.outerHeight = fact.height;
    window.devicePixelRatio = fact.ratio ?? window.devicePixelRatio;
    window.dispatchEvent(events.trusted(new events.Event('resize')));
    updateMedia();
  }),
  'gpu-response': fact => {
    for (const response of fact.responses) {
      if (response.type === 'readback') response.bytes = ops.op_gpu_readback(response.request);
    }
    window.dispatchEvent(Object.assign(new events.Event('gpu-response'), { responses: fact.responses }));
  },
};
globalThis.__hostDispatch = fact => {
  const handle = facts[fact.type];
  const { type, ...fields } = fact;
  if (handle) handle(fact);
  else window.dispatchEvent(Object.assign(new events.Event(type), fields));
};
