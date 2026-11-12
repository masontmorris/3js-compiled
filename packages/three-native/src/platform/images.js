// Images and the loading APIs three's loaders use: URL with object URLs, Blob, fetch for local files, data and blob
// URLs, the image element, ImageBitmap and createImageBitmap. The host reads files and decodes PNG, JPEG and WebP off
// the main thread. A decoded image keeps straight-alpha RGBA8 rows, top row first, under a registered symbol, so
// every copy of NativeBackend in a bundle can upload it.
import { Event } from './events.js';
import { HTMLElement, ELEMENT_CLASSES, logOnce } from './dom.js';

export const PIXELS = Symbol.for('threejsc.pixels');

const SPECIAL = new Set(['http:', 'https:', 'file:', 'ws:', 'wss:', 'ftp:']);
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };
// WHATWG URL's percent-encode sets. Each encodes C0 controls, space, every code point above U+007E as UTF-8, and
// the characters it names, and leaves existing escapes.
const ENCODE_SETS = { path: '"#<>?`{}^', query: '"#<>\'', fragment: '"<>`' };
function encode(text, set) {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code > 0x7e) out += encodeURIComponent(char);
    else if (code <= 0x20 || ENCODE_SETS[set].includes(char)) out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    else out += char;
  }
  return out;
}
function removeDots(path) {
  const output = [];
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (segment === '.' || segment.toLowerCase() === '%2e') { if (last) output.push(''); continue; }
    if (segment === '..' || /^(\.|%2e){2}$/i.test(segment)) {
      if (output.length > 1 && !/^[a-zA-Z]:$/.test(output.at(-1))) output.pop();
      if (last) output.push('');
      continue;
    }
    output.push(segment);
  }
  return output.join('/');
}

export class URLSearchParams {
  #list = [];
  #url = null;
  constructor(init = '') {
    if (typeof init === 'string') this.#parse(init);
    else if (init instanceof URLSearchParams) this.#list = [...init.#list];
    else if (init && typeof init === 'object') {
      for (const pair of Symbol.iterator in init ? init : Object.entries(init)) this.#list.push([String(pair[0]), String(pair[1])]);
    }
  }
  static attach(params, url) { params.#url = url; }
  #parse(text) {
    this.#list = [];
    for (const part of text.replace(/^\?/, '').split('&')) {
      if (!part) continue;
      const index = part.indexOf('=');
      const decode = value => decodeURIComponent(value.replace(/\+/g, ' '));
      this.#list.push(index < 0 ? [decode(part), ''] : [decode(part.slice(0, index)), decode(part.slice(index + 1))]);
    }
  }
  static reparse(params, text) { params.#parse(text); }
  #update() { if (this.#url) this.#url.search = this.toString(); }
  get size() { return this.#list.length; }
  append(name, value) { this.#list.push([String(name), String(value)]); this.#update(); }
  delete(name) { this.#list = this.#list.filter(([key]) => key !== String(name)); this.#update(); }
  get(name) { return this.#list.find(([key]) => key === String(name))?.[1] ?? null; }
  getAll(name) { return this.#list.filter(([key]) => key === String(name)).map(([, value]) => value); }
  has(name) { return this.#list.some(([key]) => key === String(name)); }
  set(name, value) {
    const index = this.#list.findIndex(([key]) => key === String(name));
    if (index < 0) this.#list.push([String(name), String(value)]);
    else this.#list = this.#list.filter(([key], i) => i === index || key !== String(name)).map(pair => pair[0] === String(name) ? [pair[0], String(value)] : pair);
    this.#update();
  }
  sort() { this.#list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); this.#update(); }
  forEach(callback, thisArg) { for (const [key, value] of this.#list) callback.call(thisArg, value, key, this); }
  entries() { return this.#list.map(pair => [...pair])[Symbol.iterator](); }
  keys() { return this.#list.map(([key]) => key)[Symbol.iterator](); }
  values() { return this.#list.map(([, value]) => value)[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  toString() {
    const form = value => encodeURIComponent(value).replace(/%20/g, '+').replace(/[!'()~]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return this.#list.map(([key, value]) => `${form(key)}=${form(value)}`).join('&');
  }
}

// WHATWG URL for the schemes a game loads from: special schemes with an authority, and opaque ones such as blob:
// and data:. Hosts are not converted from Unicode.
export class URL {
  #parts;
  #params;
  constructor(input, base) {
    input = String(input).trim();
    const baseParts = base === undefined ? null : (base instanceof URL ? base : new URL(base)).#parts;
    const parts = URL.#parse(input, baseParts);
    if (!parts) throw new TypeError(`Failed to construct 'URL': Invalid URL`);
    this.#parts = parts;
  }
  static canParse(input, base) {
    try { new URL(input, base); return true; } catch { return false; }
  }
  static parse(input, base) {
    try { return new URL(input, base); } catch { return null; }
  }
  static #parse(input, base) {
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(input);
    if (scheme) {
      const protocol = `${scheme[1].toLowerCase()}:`;
      let rest = input.slice(scheme[0].length);
      if (!SPECIAL.has(protocol)) {
        const hash = rest.indexOf('#');
        const fragment = hash < 0 ? '' : rest.slice(hash);
        if (hash >= 0) rest = rest.slice(0, hash);
        if (rest.startsWith('//')) return URL.#hierarchical(protocol, rest, fragment);
        const query = rest.indexOf('?');
        return { protocol, host: '', port: '', path: query < 0 ? rest : rest.slice(0, query), search: query < 0 ? '' : rest.slice(query), hash: fragment, opaque: true };
      }
      rest = rest.replace(/\\/g, '/');
      if (base && base.protocol === protocol && !rest.startsWith('/')) return URL.#relative(rest, base);
      if (protocol === 'file:' && !rest.startsWith('//')) rest = `//${rest.startsWith('/') ? '' : '/'}${rest}`;
      if (!rest.startsWith('//')) rest = `//${rest.replace(/^\/*/, '')}`;
      return URL.#hierarchical(protocol, rest, null);
    }
    if (!base) return null;
    if (base.opaque) {
      if (input.startsWith('#')) return { ...base, hash: encode(input, 'fragment') };
      return null;
    }
    return URL.#relative(SPECIAL.has(base.protocol) ? input.replace(/\\/g, '/') : input, base);
  }
  static #hierarchical(protocol, rest, fragment) {
    const hashIndex = rest.indexOf('#');
    const hash = fragment ?? (hashIndex < 0 ? '' : rest.slice(hashIndex));
    if (fragment === null && hashIndex >= 0) rest = rest.slice(0, hashIndex);
    const queryIndex = rest.indexOf('?');
    const search = queryIndex < 0 ? '' : rest.slice(queryIndex);
    if (queryIndex >= 0) rest = rest.slice(0, queryIndex);
    const slash = rest.indexOf('/', 2);
    let authority = slash < 0 ? rest.slice(2) : rest.slice(2, slash);
    let path = slash < 0 ? '' : rest.slice(slash);
    if (protocol === 'file:' && /^[a-zA-Z][:|]$/.test(authority)) { path = `/${authority[0]}:${path}`; authority = ''; }
    authority = authority.replace(/^[^@]*@/, '');
    const portMatch = /:(\d*)$/.exec(authority);
    let host = (portMatch ? authority.slice(0, portMatch.index) : authority).toLowerCase();
    let port = portMatch ? portMatch[1].replace(/^0+(?=\d)/, '') : '';
    if (port === DEFAULT_PORTS[protocol]) port = '';
    if (SPECIAL.has(protocol) && protocol !== 'file:' && !host) return null;
    if (protocol === 'file:' && host === 'localhost') host = '';
    path = path.replace(/^\/([a-zA-Z])\|/, '/$1:');
    if (SPECIAL.has(protocol) && !path) path = '/';
    return { protocol, host, port, path: encode(removeDots(path), 'path'), search: encode(search, 'query'), hash: encode(hash, 'fragment'), opaque: false };
  }
  static #relative(input, base) {
    if (input.startsWith('//')) return URL.#hierarchical(base.protocol, input, null);
    const hashIndex = input.indexOf('#');
    const hash = hashIndex < 0 ? '' : input.slice(hashIndex);
    let rest = hashIndex < 0 ? input : input.slice(0, hashIndex);
    const queryIndex = rest.indexOf('?');
    const search = queryIndex < 0 ? null : rest.slice(queryIndex);
    rest = queryIndex < 0 ? rest : rest.slice(0, queryIndex);
    let path;
    if (!rest) path = base.path;
    else if (rest.startsWith('/')) path = base.protocol === 'file:' && /^\/[a-zA-Z]:/.test(base.path) && !/^\/[a-zA-Z][:|]/.test(rest) ? base.path.slice(0, 3) + rest : rest;
    else if (base.protocol === 'file:' && /^[a-zA-Z][:|](?:$|[/?#])/.test(rest)) path = `/${rest}`;
    else path = base.path.slice(0, base.path.lastIndexOf('/') + 1) + rest;
    return {
      ...base,
      path: encode(removeDots(path), 'path'),
      search: search === null ? (rest ? '' : base.search) : encode(search, 'query'),
      hash: encode(hash, 'fragment'),
    };
  }
  get href() {
    const { protocol, path, search, hash, opaque } = this.#parts;
    if (opaque) return `${protocol}${path}${search}${hash}`;
    return `${protocol}//${this.host}${path}${search}${hash}`;
  }
  set href(value) { this.#parts = new URL(value).#parts; if (this.#params) URLSearchParams.reparse(this.#params, this.search); }
  get protocol() { return this.#parts.protocol; }
  get host() { return this.#parts.port ? `${this.#parts.host}:${this.#parts.port}` : this.#parts.host; }
  get hostname() { return this.#parts.host; }
  get port() { return this.#parts.port; }
  get pathname() { return this.#parts.path; }
  set pathname(value) { if (!this.#parts.opaque) this.#parts.path = encode(removeDots(String(value).startsWith('/') ? String(value) : `/${value}`), 'path'); }
  get search() { return this.#parts.search.length > 1 ? this.#parts.search : ''; }
  set search(value) {
    value = String(value);
    this.#parts.search = value ? encode(value.startsWith('?') ? value : `?${value}`, 'query') : '';
    if (this.#params) URLSearchParams.reparse(this.#params, this.#parts.search);
  }
  get hash() { return this.#parts.hash.length > 1 ? this.#parts.hash : ''; }
  set hash(value) { value = String(value); this.#parts.hash = value ? encode(value.startsWith('#') ? value : `#${value}`, 'fragment') : ''; }
  get username() { return ''; }
  get password() { return ''; }
  get origin() {
    const { protocol } = this.#parts;
    if (protocol === 'blob:') { try { return new URL(this.pathname).origin; } catch { return 'null'; } }
    return SPECIAL.has(protocol) && protocol !== 'file:' ? `${protocol}//${this.host}` : 'null';
  }
  get searchParams() {
    if (!this.#params) {
      this.#params = new URLSearchParams(this.search);
      URLSearchParams.attach(this.#params, this);
    }
    return this.#params;
  }
  toString() { return this.href; }
  toJSON() { return this.href; }
  static createObjectURL(blob) {
    if (!(blob instanceof Blob)) throw new TypeError("Failed to execute 'createObjectURL' on 'URL': Overload resolution failed.");
    const url = `blob:${globalThis.location?.origin ?? 'null'}/${randomId()}`;
    objectURLs.set(url, blob);
    return url;
  }
  static revokeObjectURL(url) { objectURLs.delete(String(url)); }
}

const objectURLs = new Map();
function randomId() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${((Math.random() * 4) | 8).toString(16)}${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

const BYTES = Symbol('bytes');
const utf8 = text => new TextEncoder().encode(text);
export class Blob {
  constructor(parts = [], { type = '' } = {}) {
    const chunks = [];
    for (const part of parts) {
      if (part instanceof Blob) chunks.push(part[BYTES]);
      else if (part instanceof ArrayBuffer) chunks.push(new Uint8Array(part));
      else if (ArrayBuffer.isView(part)) chunks.push(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
      else chunks.push(utf8(String(part)));
    }
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    this[BYTES] = bytes;
    this.type = /^[\x20-\x7e]*$/.test(type) ? String(type).toLowerCase() : '';
  }
  static of(bytes, type) {
    const blob = new Blob([], { type });
    blob[BYTES] = bytes;
    return blob;
  }
  get size() { return this[BYTES].byteLength; }
  async arrayBuffer() { return this[BYTES].slice().buffer; }
  async bytes() { return this[BYTES].slice(); }
  async text() { return new TextDecoder().decode(this[BYTES]); }
  slice(start = 0, end = this.size, type = '') {
    const clamp = value => (value < 0 ? Math.max(this.size + value, 0) : Math.min(value, this.size));
    return Blob.of(this[BYTES].slice(clamp(start), clamp(end)), type);
  }
  stream() { logOnce('Blob.stream is not implemented'); return undefined; }
  get [Symbol.toStringTag]() { return 'Blob'; }
}
export class File extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = String(name);
    this.lastModified = options.lastModified ?? Date.now();
  }
}

export class Headers {
  #map = new Map();
  constructor(init) {
    if (init instanceof Headers) init.forEach((value, key) => this.append(key, value));
    else if (Array.isArray(init)) for (const [key, value] of init) this.append(key, value);
    else if (init) for (const [key, value] of Object.entries(init)) this.append(key, value);
  }
  append(name, value) {
    const key = String(name).toLowerCase();
    this.#map.set(key, this.#map.has(key) ? `${this.#map.get(key)}, ${value}` : String(value));
  }
  delete(name) { this.#map.delete(String(name).toLowerCase()); }
  get(name) { return this.#map.get(String(name).toLowerCase()) ?? null; }
  has(name) { return this.#map.has(String(name).toLowerCase()); }
  set(name, value) { this.#map.set(String(name).toLowerCase(), String(value)); }
  forEach(callback, thisArg) { for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this); }
  entries() { return [...this.#map].sort(([a], [b]) => (a < b ? -1 : 1))[Symbol.iterator](); }
  keys() { return [...this.entries()].map(([key]) => key)[Symbol.iterator](); }
  values() { return [...this.entries()].map(([, value]) => value)[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
}

export class Request {
  constructor(input, init = {}) {
    const source = input instanceof Request ? input : null;
    this.url = source ? source.url : new URL(String(input), globalThis.location?.href).href;
    this.method = (init.method ?? source?.method ?? 'GET').toUpperCase();
    this.headers = new Headers(init.headers ?? source?.headers);
    this.credentials = init.credentials ?? source?.credentials ?? 'same-origin';
    this.mode = init.mode ?? source?.mode ?? 'cors';
    this.cache = init.cache ?? source?.cache ?? 'default';
    this.redirect = init.redirect ?? source?.redirect ?? 'follow';
    this.signal = init.signal ?? source?.signal ?? null;
    this.body = init.body ?? null;
  }
  clone() { return new Request(this); }
}

export class Response {
  #bytes;
  constructor(body = null, { status = 200, statusText = '', headers } = {}) {
    this.#bytes = body instanceof Blob ? body[BYTES] : body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : body === null ? new Uint8Array() : utf8(String(body));
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
    this.headers = new Headers(headers);
    this.url = '';
    this.type = 'basic';
    this.redirected = false;
    this.bodyUsed = false;
  }
  #consume() {
    if (this.bodyUsed) return Promise.reject(new TypeError("Failed to execute 'arrayBuffer' on 'Response': body stream already read"));
    this.bodyUsed = true;
    return Promise.resolve(this.#bytes);
  }
  async arrayBuffer() { return (await this.#consume()).slice().buffer; }
  async bytes() { return (await this.#consume()).slice(); }
  async blob() { const bytes = await this.#consume(); return Blob.of(bytes, this.headers.get('content-type') ?? ''); }
  async text() { return new TextDecoder().decode(await this.#consume()); }
  async json() { return JSON.parse(await this.text()); }
  clone() {
    if (this.bodyUsed) throw new TypeError("Failed to execute 'clone' on 'Response': Response body is already used");
    const copy = new Response(this.#bytes, { status: this.status, statusText: this.statusText, headers: this.headers });
    copy.url = this.url;
    return copy;
  }
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', html: 'text/html', css: 'text/css',
  txt: 'text/plain', glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream',
  wasm: 'application/wasm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', ktx2: 'image/ktx2',
};
const STATUS = { 200: 'OK', 404: 'Not Found', 405: 'Method Not Allowed' };

function decodeBase64(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = text.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bytes = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new TypeError('Invalid base64 data');
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes[index++] = (value >> bits) & 0xff; }
  }
  return bytes.subarray(0, index);
}

// The host's file reader and image decoder, which the platform sets. `decode(bytes, convert)` converts the image's
// declared color space to sRGB when `convert` is set.
let host = {
  readFile: async () => null,
  decode: async () => { throw new Error('No image decoder'); },
};
export function setHost(value) { host = value; }

// A local file's path from its file URL: C:/dir/file.png for file:///C:/dir/file.png.
export function filePath(url) {
  const path = decodeURIComponent(url.pathname);
  return /^\/[a-zA-Z]:/.test(path) ? path.slice(1) : path;
}

// fetch for file, blob and data URLs. A missing file answers 404, as a dev server does. Network URLs reject with
// the TypeError Edge gives a failed request. It rejects with its signal's reason when the signal aborts before the
// response, as in Edge.
export function fetch(input, init) {
  const request = new Request(input, init);
  const signal = request.signal;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const response = fetchResponse(request);
  if (!signal) return response;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    response.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function fetchResponse(request) {
  const url = new URL(request.url);
  const respond = (bytes, type, status = 200) => {
    const response = new Response(bytes, { status, statusText: STATUS[status] ?? '', headers: type ? { 'content-type': type, 'content-length': String(bytes.byteLength) } : {} });
    response.url = url.href;
    return response;
  };
  if (url.protocol === 'blob:') {
    const blob = objectURLs.get(url.href.replace(/#.*/, ''));
    if (!blob || request.method !== 'GET') throw new TypeError('Failed to fetch');
    return respond(blob[BYTES], blob.type);
  }
  if (url.protocol === 'data:') {
    const match = /^([^,]*?)(;base64)?,(.*)$/s.exec(url.href.slice(5));
    if (!match) throw new TypeError('Failed to fetch');
    const bytes = match[2] ? decodeBase64(decodeURIComponent(match[3])) : utf8(decodeURIComponent(match[3]));
    return respond(bytes, match[1] || 'text/plain;charset=US-ASCII');
  }
  if (url.protocol === 'file:') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return respond(new Uint8Array(), '', 405);
    const bytes = await host.readFile(filePath(url));
    if (!bytes) return respond(new Uint8Array(), 'text/plain', 404);
    return respond(request.method === 'HEAD' ? new Uint8Array() : bytes, MIME[url.pathname.split('.').at(-1).toLowerCase()] ?? 'application/octet-stream');
  }
  logOnce(`fetch: ${url.protocol} URLs are not supported, only file, blob and data URLs`);
  throw new TypeError('Failed to fetch');
}

// RGBA8 pixels with the rows in the other order.
export function flipRows({ width, height, data }) {
  const row = width * 4;
  const flipped = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) flipped.set(data.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  return flipped;
}
export function premultiply(data) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    out[i] = Math.round((data[i] * alpha) / 255);
    out[i + 1] = Math.round((data[i + 1] * alpha) / 255);
    out[i + 2] = Math.round((data[i + 2] * alpha) / 255);
    out[i + 3] = alpha;
  }
  return out;
}

async function decodeURL(src) {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return host.decode(await response.bytes(), true);
}

export class HTMLImageElement extends HTMLElement {
  constructor(document, localName = 'img') {
    super(document, localName);
    this.complete = true;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.currentSrc = '';
    this.decoding = 'auto';
    this.loading = 'eager';
    this.generation = 0;
    this.loaded = null;
  }
  get src() { return this.getAttribute('src') ?? ''; }
  set src(value) {
    this.setAttribute('src', value);
    this.load(String(value));
  }
  get crossOrigin() { return this.getAttribute('crossorigin'); }
  set crossOrigin(value) { if (value === null) this.removeAttribute('crossorigin'); else this.setAttribute('crossorigin', value); }
  get width() { return Number.parseInt(this.getAttribute('width'), 10) || this.naturalWidth; }
  set width(value) { this.setAttribute('width', String(value >>> 0)); }
  get height() { return Number.parseInt(this.getAttribute('height'), 10) || this.naturalHeight; }
  set height(value) { this.setAttribute('height', String(value >>> 0)); }
  // Loads `src` and fires load or error, unless a later src replaced it first.
  load(src) {
    const generation = ++this.generation;
    this.complete = false;
    this[PIXELS] = undefined;
    this.naturalWidth = this.naturalHeight = 0;
    let url;
    try { url = src ? new URL(src, globalThis.location?.href).href : null; } catch { url = null; }
    this.currentSrc = url ?? '';
    this.loaded = (async () => {
      if (!url) throw new Error('empty or invalid src');
      return decodeURL(url);
    })().then(
      pixels => {
        if (generation !== this.generation) return;
        this[PIXELS] = pixels;
        this.naturalWidth = pixels.width;
        this.naturalHeight = pixels.height;
        this.complete = true;
        this.dispatchEvent(new Event('load'));
      },
      () => {
        if (generation !== this.generation) return;
        this.complete = true;
        this.dispatchEvent(new Event('error'));
        throw new DOMException('The source image cannot be decoded.', 'EncodingError');
      },
    );
    this.loaded.catch(() => {});
  }
  decode() {
    if (!this.loaded) return Promise.reject(new DOMException('The source image cannot be decoded.', 'EncodingError'));
    return this.loaded.then(() => undefined);
  }
}
ELEMENT_CLASSES.set('img', HTMLImageElement);

export class ImageBitmap {
  constructor(pixels) {
    this[PIXELS] = pixels;
  }
  get width() { return this[PIXELS]?.width ?? 0; }
  get height() { return this[PIXELS]?.height ?? 0; }
  close() { this[PIXELS] = undefined; }
}

// createImageBitmap from a Blob, a decoded image element, an ImageBitmap or ImageData, with a crop rectangle,
// imageOrientation, premultiplyAlpha and colorSpaceConversion, which for a Blob converts to sRGB unless it is 'none',
// as in Edge. An image element's pixels are already converted. A canvas source and resize options are not
// implemented.
export async function createImageBitmap(source, ...rest) {
  const options = (typeof rest.at(-1) === 'object' && rest.at(-1) !== null ? rest.pop() : undefined) ?? {};
  let pixels;
  if (source instanceof Blob) {
    try { pixels = await host.decode(source[BYTES], options.colorSpaceConversion !== 'none'); } catch { throw new DOMException('The source image could not be decoded.', 'InvalidStateError'); }
  } else if (source?.[PIXELS]) {
    pixels = source[PIXELS];
  } else if (source instanceof HTMLImageElement || source instanceof ImageBitmap) {
    throw new DOMException("Failed to execute 'createImageBitmap' on 'Window': The image element contains no image data.", 'InvalidStateError');
  } else if (source?.data && source.width && source.height) {
    pixels = { width: source.width, height: source.height, data: new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength) };
  } else {
    logOnce(`createImageBitmap: ${source?.constructor?.name ?? typeof source} sources are not implemented`);
    throw new TypeError("Failed to execute 'createImageBitmap' on 'Window': The provided value is not of type '(Blob or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or ImageData or OffscreenCanvas or SVGImageElement or VideoFrame)'.");
  }
  if (rest.length === 4) {
    const [sx, sy, sw, sh] = rest.map(Math.trunc);
    if (!sw || !sh) throw new RangeError(`Failed to execute 'createImageBitmap' on 'Window': The crop rect ${sw ? 'height' : 'width'} is 0.`);
    const width = Math.abs(sw);
    const height = Math.abs(sh);
    const left = sw < 0 ? sx + sw : sx;
    const top = sh < 0 ? sy + sh : sy;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const fromX = left + x;
        const fromY = top + y;
        if (fromX < 0 || fromY < 0 || fromX >= pixels.width || fromY >= pixels.height) continue;
        data.set(pixels.data.subarray((fromY * pixels.width + fromX) * 4, (fromY * pixels.width + fromX) * 4 + 4), (y * width + x) * 4);
      }
    }
    pixels = { width, height, data };
  }
  if (options.resizeWidth !== undefined || options.resizeHeight !== undefined) logOnce('createImageBitmap: resizeWidth and resizeHeight are not implemented; the bitmap keeps its size');
  let data = pixels.data;
  if (options.imageOrientation === 'flipY') data = flipRows({ ...pixels, data });
  const premultiplied = options.premultiplyAlpha === 'premultiply';
  if (premultiplied) data = premultiply(data);
  return new ImageBitmap({ width: pixels.width, height: pixels.height, data, premultiplied });
}

// The image constructor, whose instances are image elements of `document`.
export function imageConstructor(document) {
  function Image(width, height) {
    if (!new.target) throw new TypeError("Failed to construct 'Image': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const image = document.createElement('img');
    if (width !== undefined) image.width = width;
    if (height !== undefined) image.height = height;
    return image;
  }
  Image.prototype = HTMLImageElement.prototype;
  return Image;
}
