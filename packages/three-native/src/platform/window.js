// Window-level APIs a game reaches that need no DOM: document.cookie, crypto, media queries and window.open, each as
// Edge 157 has them.
import { logOnce } from './dom.js';

// document.cookie for one game. Cookies come back in the order they were last set, longest path first, as in Edge.
// The jar honors path, expires and max-age, ignores domain, secure, samesite and httponly, and keeps session
// cookies across a restart, as Edge does when it restores a session. `save` receives every change.
export class CookieJar {
  constructor(cookies, path, now, save) {
    this.cookies = cookies.map(cookie => ({ ...cookie }));
    this.path = path;
    this.now = now;
    this.save = save;
  }
  #live() {
    const now = this.now();
    const live = this.cookies.filter(cookie => cookie.expires === null || cookie.expires > now);
    if (live.length !== this.cookies.length) {
      this.cookies = live;
      this.save(this.cookies);
    }
    return live;
  }
  get() {
    const visible = this.#live().filter(cookie => this.path === cookie.path || this.path.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`));
    return visible
      .map((cookie, order) => ({ cookie, order }))
      .sort((a, b) => b.cookie.path.length - a.cookie.path.length || a.order - b.order)
      .map(({ cookie }) => (cookie.name ? `${cookie.name}=${cookie.value}` : cookie.value))
      .join('; ');
  }
  set(text) {
    const [pair, ...attributes] = String(text).split(';');
    const equals = pair.indexOf('=');
    const name = equals < 0 ? '' : pair.slice(0, equals).trim();
    const value = (equals < 0 ? pair : pair.slice(equals + 1)).trim();
    let expires = null;
    let path = this.path.slice(0, this.path.lastIndexOf('/')) || '/';
    for (const attribute of attributes) {
      const at = attribute.indexOf('=');
      const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
      const argument = at < 0 ? '' : attribute.slice(at + 1).trim();
      if (key === 'max-age' && /^-?\d+$/.test(argument)) expires = this.now() + Number(argument) * 1000;
      else if (key === 'expires' && expires === null && !Number.isNaN(Date.parse(argument))) expires = Date.parse(argument);
      else if (key === 'path' && argument.startsWith('/')) path = argument;
    }
    this.cookies = this.cookies.filter(cookie => cookie.name !== name || cookie.path !== path);
    if (expires === null || expires > this.now()) this.cookies.push({ name, value, path, expires });
    this.save(this.cookies);
  }
}

export class QuotaExceededError extends DOMException {
  constructor(message = '') { super(message, 'QuotaExceededError'); }
}

const INTEGER_ARRAYS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array];

// crypto.getRandomValues() and randomUUID() over the OS random source `fill`. crypto.subtle is not implemented.
export class Crypto {
  #fill;
  constructor(fill) { this.#fill = fill; }
  getRandomValues(array) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'getRandomValues' on 'Crypto': 1 argument required, but only 0 present.");
    if (!INTEGER_ARRAYS.some(Type => array instanceof Type)) {
      const type = ArrayBuffer.isView(array) ? array.constructor.name.replace(/Array$/, '') : typeof array;
      if (!ArrayBuffer.isView(array)) throw new TypeError("Failed to execute 'getRandomValues' on 'Crypto': parameter 1 is not of type 'ArrayBufferView'.");
      throw new DOMException(`Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type '${type}', which is not an integer array type.`, 'TypeMismatchError');
    }
    if (array.byteLength > 65536) throw new QuotaExceededError(`Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (${array.byteLength}) exceeds the number of bytes of entropy available via this API (65536).`);
    this.#fill(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return array;
  }
  randomUUID() {
    const bytes = this.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  get subtle() {
    logOnce('crypto.subtle is not implemented');
    return undefined;
  }
  get [Symbol.toStringTag]() { return 'Crypto'; }
}

// Media queries over a window of `width` by `height` CSS pixels at device pixel ratio `ratio`, with Edge's answers
// for a desktop with a mouse, a light color scheme and no reduced motion. Features take the plain, min-/max- and
// range forms.
const UNITS = { px: 1, em: 16, rem: 16, dppx: 1, x: 1, dpi: 1 / 96, dpcm: 2.54 / 96 };
function measure(value) {
  const ratio = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(value);
  if (ratio) return Number(ratio[1]) / Number(ratio[2]);
  const match = /^(-?\d*\.?\d+)([a-z]*)$/.exec(value);
  return match ? Number(match[1]) * (UNITS[match[2]] ?? 1) : Number.NaN;
}
const compare = (a, operator, b) => ({ '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b, '=': a === b })[operator];
function feature(name, value, env) {
  const ranged = { width: env.width, height: env.height, 'aspect-ratio': env.width / env.height, resolution: env.ratio, 'device-pixel-ratio': env.ratio, '-webkit-device-pixel-ratio': env.ratio };
  const prefix = /^(?:-webkit-)?(min|max)-/.exec(name);
  const base = prefix ? name.slice(prefix[0].length).replace(/^device-pixel-ratio$/, 'device-pixel-ratio') : name;
  if (base in ranged) {
    if (value === undefined) return true;
    const wanted = measure(value);
    return prefix ? compare(ranged[base], prefix[1] === 'min' ? '>=' : '<=', wanted) : ranged[base] === wanted;
  }
  const discrete = {
    orientation: ['landscape', 'portrait'][env.height > env.width ? 1 : 0], color: '8', hover: 'hover', 'any-hover': 'hover',
    pointer: 'fine', 'any-pointer': 'fine', 'prefers-color-scheme': 'light', 'display-mode': 'browser', scan: 'progressive',
  };
  const none = ['prefers-reduced-motion', 'prefers-reduced-transparency', 'prefers-contrast', 'monochrome', 'inverted-colors', 'forced-colors', 'grid', 'prefers-reduced-data'];
  if (name in discrete) return value === undefined || value === discrete[name] || (name === 'color' && measure(value) <= 8);
  if (none.includes(name)) return value === undefined ? false : ['no-preference', 'none', '0'].includes(value);
  if (prefix && (base === 'color' || base === 'monochrome')) return compare(base === 'color' ? 8 : 0, prefix[1] === 'min' ? '>=' : '<=', measure(value));
  logOnce(`matchMedia: the ${name} feature is not implemented and does not match`);
  return false;
}
function condition(text, env) {
  const plain = /^\(\s*([\w-]+)\s*(?::\s*([^)]+?))?\s*\)$/.exec(text);
  if (plain) return feature(plain[1], plain[2], env);
  const range = /^\(\s*(?:([^<>=\s]+)\s*(<=|<|>=|>|=)\s*)?([\w-]+)\s*(?:(<=|<|>=|>|=)\s*([^<>=\s)]+))?\s*\)$/.exec(text);
  if (range) {
    const ranged = { width: env.width, height: env.height, 'aspect-ratio': env.width / env.height, resolution: env.ratio };
    if (!(range[3] in ranged) && range[1] in ranged && !range[4]) return compare(ranged[range[1]], range[2], measure(range[3]));
    const actual = ranged[range[3]];
    if (actual === undefined) return false;
    const flip = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' };
    return (!range[1] || compare(actual, flip[range[2]], measure(range[1]))) && (!range[4] || compare(actual, range[4], measure(range[5])));
  }
  return ['all', 'screen'].includes(text);
}
// A media query list's text as Edge serializes it: lowercase, single spaces, `: ` after a feature name, spaces around
// a ratio's slash and around range operators, and `, ` between queries. Text that is not a media query stays as it is.
export function serializeMedia(query) {
  const text = String(query);
  if (!/^[\w\s(),:<>=./+-]*$/.test(text) || /\(\(|\)\(/.test(text) || (text.match(/\(/g) ?? []).length !== (text.match(/\)/g) ?? []).length) return text;
  return text
    .split(',')
    .map(part => part.trim().toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\(\s*/g, '(').replace(/\s*\)/g, ')')
      .replace(/\s*:\s*/g, ': ')
      .replace(/\s*(<=|>=|<|>|=)\s*/g, ' $1 ')
      .replace(/(\d)\s*\/\s*(\d)/g, '$1 / $2'))
    .join(', ');
}

export function evaluateMedia(query, env) {
  return String(query).split(',').some(part => {
    let text = part.trim().toLowerCase();
    const negate = text.startsWith('not ');
    if (negate) text = text.slice(4);
    text = text.replace(/^only\s+/, '');
    const result = text.split(/\s+and\s+/).every(term => condition(term.trim(), env));
    return negate ? !result : result;
  });
}

// window.open for a native game: an http or https URL opens in the system's default browser through `open`, and
// any other URL is refused. Either way it returns null, as Edge does for a noopener open.
export function openWindow(url, open, log) {
  let parsed;
  try { parsed = new globalThis.URL(String(url)); } catch { parsed = null; }
  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) open(parsed.href);
  else log(`window.open: refused ${url}; only http and https URLs open, in the default browser`);
  return null;
}
