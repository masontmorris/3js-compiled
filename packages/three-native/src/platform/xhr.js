// XMLHttpRequest for the local files a game loads, as Howler's loader and three's loaders use it. It reads through
// the shim's fetch, so file: URLs, a missing file's 404, and blob: and data: URLs behave as fetch does, and it fires
// Edge's sequence of readystatechange and progress events.
import { Event, EventTarget, defineHandlers } from './events.js';
import { Blob, URL, fetch } from './images.js';

const RESPONSE_TYPES = new Set(['', 'arraybuffer', 'blob', 'document', 'json', 'text']);

export class ProgressEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.lengthComputable = !!init.lengthComputable;
    this.loaded = Number(init.loaded ?? 0);
    this.total = Number(init.total ?? 0);
  }
}

class XMLHttpRequestEventTarget extends EventTarget {}
defineHandlers(XMLHttpRequestEventTarget.prototype, ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend']);

function fail(method, message, name = 'InvalidStateError') {
  return new DOMException(`Failed to execute '${method}' on 'XMLHttpRequest': ${message}`, name);
}

export class XMLHttpRequest extends XMLHttpRequestEventTarget {
  static UNSENT = 0;
  static OPENED = 1;
  static HEADERS_RECEIVED = 2;
  static LOADING = 3;
  static DONE = 4;
  #state = 0;
  #url = null;
  #method = 'GET';
  #responseType = '';
  #status = 0;
  #statusText = '';
  #headers = null;
  #body = null;
  #send = 0;
  #mime = null;

  constructor() {
    super();
    this.upload = new XMLHttpRequestEventTarget();
    this.withCredentials = false;
    this.timeout = 0;
  }

  get readyState() { return this.#state; }
  get status() { return this.#status; }
  get statusText() { return this.#statusText; }
  get responseURL() { return this.#state === 4 ? this.#url : ''; }
  get responseType() { return this.#responseType; }
  set responseType(value) {
    const type = String(value);
    if (!RESPONSE_TYPES.has(type)) return;
    if (this.#state === 3 || this.#state === 4) throw new DOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': The response type cannot be set if the object's state is LOADING or DONE.", 'InvalidStateError');
    this.#responseType = type;
  }

  get response() {
    if (this.#responseType === '' || this.#responseType === 'text') return this.#state >= 3 ? this.#text() : '';
    if (this.#state !== 4 || this.#body === null) return null;
    if (this.#responseType === 'arraybuffer') return this.#body.buffer.slice(this.#body.byteOffset, this.#body.byteOffset + this.#body.byteLength);
    if (this.#responseType === 'json') {
      try { return JSON.parse(this.#text()); } catch { return null; }
    }
    if (this.#responseType === 'blob') return new Blob([this.#body], { type: this.#mime ?? this.#headers?.get('content-type') ?? '' });
    return null;
  }

  get responseText() {
    if (this.#responseType !== '' && this.#responseType !== 'text') {
      throw new DOMException(`Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${this.#responseType}').`, 'InvalidStateError');
    }
    return this.response;
  }

  get responseXML() { return null; }

  #text() { return this.#body ? new TextDecoder().decode(this.#body) : ''; }

  open(method, url, async = true) {
    if (async === false) throw fail('open', 'Synchronous requests are not supported.', 'InvalidAccessError');
    this.#abortSend();
    this.#method = String(method).toUpperCase();
    this.#url = new URL(String(url), globalThis.location?.href).href;
    this.#status = 0;
    this.#statusText = '';
    this.#headers = null;
    this.#body = null;
    this.#change(1);
  }

  setRequestHeader() {
    if (this.#state !== 1) throw fail('setRequestHeader', "The object's state must be OPENED.");
  }

  overrideMimeType(mime) { this.#mime = String(mime); }

  getResponseHeader(name) { return this.#state >= 2 ? this.#headers?.get(name) ?? null : null; }

  getAllResponseHeaders() {
    if (this.#state < 2 || !this.#headers) return '';
    return [...this.#headers].map(([name, value]) => `${name}: ${value}\r\n`).join('');
  }

  send() {
    if (this.#state !== 1) throw fail('send', "The object's state must be OPENED.");
    if (this.#send) throw fail('send', 'The object state must be OPENED.');
    const send = ++this.#send;
    this.#progress('loadstart', 0, 0);
    const current = () => this.#send === send;
    fetch(this.#url, { method: this.#method }).then(async response => {
      if (!current()) return;
      const body = new Uint8Array(await response.arrayBuffer());
      if (!current()) return;
      this.#status = response.status;
      this.#statusText = response.statusText;
      this.#headers = response.headers;
      this.#change(2);
      if (body.length) {
        this.#body = body;
        this.#change(3);
        this.#progress('progress', body.length, body.length);
      } else {
        this.#body = body;
      }
      this.#send = 0;
      this.#change(4);
      this.#progress('load', body.length, body.length);
      this.#progress('loadend', body.length, body.length);
    }, () => {
      if (!current()) return;
      this.#send = 0;
      this.#change(4);
      this.#progress('error', 0, 0);
      this.#progress('loadend', 0, 0);
    });
  }

  abort() {
    const sending = this.#send !== 0;
    this.#abortSend();
    if (sending) {
      this.#change(4);
      this.#progress('abort', 0, 0);
      this.#progress('loadend', 0, 0);
    }
    if (this.#state === 4) this.#state = 0;
    this.#status = 0;
    this.#statusText = '';
  }

  #abortSend() { this.#send = 0; }

  #change(state) {
    this.#state = state;
    this.dispatchEvent(new Event('readystatechange'));
  }

  #progress(type, loaded, total) {
    this.dispatchEvent(new ProgressEvent(type, { lengthComputable: total > 0, loaded, total }));
  }
}
defineHandlers(XMLHttpRequest.prototype, ['readystatechange']);
