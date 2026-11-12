// AbortController and AbortSignal as Edge 157 has them, which three's FileLoader and ImageBitmapLoader pass to
// fetch through AbortSignal.any().
import { Event, EventTarget, defineHandlers, trusted } from './events.js';

const ABORT = Symbol('abort');
let constructing = false;

export class AbortSignal extends EventTarget {
  #aborted = false;
  #reason = undefined;
  #dependents = new Set();
  constructor() {
    if (!constructing) throw new TypeError("Failed to construct 'AbortSignal': Illegal constructor");
    super();
  }
  static #create() {
    constructing = true;
    try { return new AbortSignal(); } finally { constructing = false; }
  }
  get aborted() { return this.#aborted; }
  get reason() { return this.#reason; }
  throwIfAborted() { if (this.#aborted) throw this.#reason; }
  // Aborts the signal and the signals that depend on it, firing abort at each, as DOM's signal abort does.
  [ABORT](reason) {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason === undefined ? new DOMException('signal is aborted without reason', 'AbortError') : reason;
    const dependents = [...this.#dependents];
    this.#dependents.clear();
    this.dispatchEvent(trusted(new Event('abort')));
    for (const dependent of dependents) dependent[ABORT](this.#reason);
  }
  static abort(reason) {
    const signal = AbortSignal.#create();
    signal[ABORT](reason);
    return signal;
  }
  static timeout(ms) {
    const signal = AbortSignal.#create();
    setTimeout(() => signal[ABORT](new DOMException('signal timed out', 'TimeoutError')), ms);
    return signal;
  }
  static any(signals) {
    const signal = AbortSignal.#create();
    const sources = [...signals];
    const aborted = sources.find(source => source.aborted);
    if (aborted) signal[ABORT](aborted.reason);
    else for (const source of sources) source.#dependents.add(signal);
    return signal;
  }
  get [Symbol.toStringTag]() { return 'AbortSignal'; }
}
defineHandlers(AbortSignal.prototype, ['abort']);

export class AbortController {
  #signal;
  constructor() {
    constructing = true;
    try { this.#signal = new AbortSignal(); } finally { constructing = false; }
  }
  get signal() { return this.#signal; }
  abort(reason) { this.#signal[ABORT](reason); }
  get [Symbol.toStringTag]() { return 'AbortController'; }
}
