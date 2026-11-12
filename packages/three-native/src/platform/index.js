// Installs the platform shims on the host's global object before the entry module runs, and turns the host's
// input facts into DOM events. The host serves this module and its siblings as threejsc:/platform/.
import * as events from './events.js';
import { Document, DocumentFragment, Element, HTMLElement, HTMLCanvasElement, HTMLInputElement, HTMLTextAreaElement, Node, Text, DOMTokenList, CSSStyleDeclaration, setLog, logOnce } from './dom.js';
import { Gamepad, GamepadButton, GamepadEvent, GamepadHapticActuator, Gamepads } from './gamepad.js';
import { Storage } from './storage.js';
import { URL, URLSearchParams, Blob, File, Headers, Request, Response, fetch, HTMLImageElement, ImageBitmap, createImageBitmap, imageConstructor, setHost } from './images.js';
import { AbortController, AbortSignal } from './abort.js';

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
events.defineHandlers(window, [...events.HANDLER_TYPES, 'beforeunload', 'gamepadconnected', 'gamepaddisconnected', 'hashchange', 'pagehide', 'pageshow', 'storage', 'unload']);

const document = new Document(window);
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

// Media queries over the window's size and Edge's defaults for a desktop with a mouse.
function evaluateMedia(query) {
  const feature = (name, value) => {
    const number = Number.parseFloat(value);
    switch (name) {
      case 'min-width': return window.innerWidth >= number;
      case 'max-width': return window.innerWidth <= number;
      case 'width': return window.innerWidth === number;
      case 'min-height': return window.innerHeight >= number;
      case 'max-height': return window.innerHeight <= number;
      case 'height': return window.innerHeight === number;
      case 'orientation': return value === (window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape');
      case 'min-aspect-ratio': case 'max-aspect-ratio': {
        const [w, h] = value.split('/').map(Number);
        const ratio = window.innerWidth / window.innerHeight;
        return name.startsWith('min') ? ratio >= w / h : ratio <= w / h;
      }
      case 'min-resolution': return window.devicePixelRatio >= (value.endsWith('dpi') ? number / 96 : number);
      case 'max-resolution': return window.devicePixelRatio <= (value.endsWith('dpi') ? number / 96 : number);
      case '-webkit-min-device-pixel-ratio': return window.devicePixelRatio >= number;
      case '-webkit-max-device-pixel-ratio': return window.devicePixelRatio <= number;
      case 'prefers-color-scheme': return value === 'light';
      case 'prefers-reduced-motion': return value === 'no-preference';
      case 'prefers-contrast': return value === 'no-preference';
      case 'hover': case 'any-hover': return value === undefined || value === 'hover';
      case 'pointer': case 'any-pointer': return value === undefined || value === 'fine';
      case 'display-mode': return value === 'browser';
      case 'color': return true;
      default: logOnce(`matchMedia: the ${name} feature is not implemented and does not match`); return false;
    }
  };
  return String(query).split(',').some(part => {
    let text = part.trim().toLowerCase();
    const negate = text.startsWith('not ');
    if (negate) text = text.slice(4);
    const result = text.split(/\s+and\s+/).every(term => {
      const match = /^\(\s*([\w-]+)\s*(?::\s*([^)]+?))?\s*\)$/.exec(term.trim());
      if (match) return feature(match[1], match[2]);
      return ['all', 'screen', 'only screen'].includes(term.trim());
    });
    return negate ? !result : result;
  });
}
class MediaQueryList extends events.EventTarget {
  constructor(media) {
    super();
    this.media = String(media);
    this.matches = evaluateMedia(this.media);
    mediaLists.add(new WeakRef(this));
  }
  addListener(callback) { this.addEventListener('change', callback); }
  removeListener(callback) { this.removeEventListener('change', callback); }
}
events.defineHandlers(MediaQueryList.prototype, ['change']);
class MediaQueryListEvent extends events.Event {
  constructor(type, init = {}) { super(type, init); this.media = init.media ?? ''; this.matches = !!init.matches; }
}
const mediaLists = new Set();
function updateMedia() {
  for (const ref of mediaLists) {
    const list = ref.deref();
    if (!list) { mediaLists.delete(ref); continue; }
    const matches = evaluateMedia(list.media);
    if (matches === list.matches) continue;
    list.matches = matches;
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
  ...Object.fromEntries(['Event', 'CustomEvent', 'ErrorEvent', 'UIEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'WheelEvent', 'EventTarget'].map(name => [name, events[name]])),
  Node, Element, HTMLElement, HTMLCanvasElement, HTMLInputElement, HTMLTextAreaElement, HTMLImageElement, Text, Document,
  DocumentFragment, DOMTokenList, CSSStyleDeclaration, Gamepad, GamepadButton, GamepadEvent, GamepadHapticActuator,
  Storage, URL, URLSearchParams, Blob, File, Headers, Request, Response, ImageBitmap, MediaQueryList, MediaQueryListEvent,
  AbortController, AbortSignal,
  fetch, createImageBitmap, document, navigator, screen, localStorage,
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
  open(url) { logOnce(`window.open is not implemented; ${url} does not open`); return null; },
  alert(message) { ops.op_log(`alert: ${message}`); },
  confirm(message) { ops.op_log(`confirm: ${message}`); return false; },
  prompt(message) { ops.op_log(`prompt: ${message}`); return null; },
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
