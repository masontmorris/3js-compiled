// MutationObserver and IntersectionObserver for the stand-in DOM, as Edge 157 has them.
//
// The DOM queues a mutation record for each change it makes (queueChildList, queueAttribute, queueCharacterData),
// and the observers interested in the target or, with `subtree`, in one of its ancestors take it. Their callbacks
// run in one microtask, in the order the observers were made. A node removed from an observed subtree is not
// followed afterwards (the spec's transient observers).
//
// An IntersectionObserver checks its targets after each frame's callbacks (the platform calls
// updateIntersections()), against the viewport or an element root, and calls back in a task before the next frame.
// A target's rect is its getBoundingClientRect(), which knows only boxes an inline style fixes, so everything that
// depends on layout, scrolling or clipping by ancestors is out of reach.
import { Node, Element } from './dom.js';
import { DOMRectReadOnly } from './geometry.js';
import { platformError } from './errors.js';

const report = error => (globalThis.reportError ?? globalThis.console?.error)?.(error);
const later = callback => Promise.resolve().then(callback);

// Each observed node's registrations: [{ observer, options }].
const REGISTRY = new WeakMap();
const CALLBACK = Symbol('callback');
const RECORDS = Symbol('records');
const NODES = Symbol('nodes');
const ORDER = Symbol('order');
let made = 0;
const pending = new Set();
let notifying = false;

// The added and removed nodes of a record. Edge's is a NodeList.
export class NodeList {
  constructor(nodes = []) {
    nodes.forEach((node, index) => { this[index] = node; });
    Object.defineProperty(this, 'length', { value: nodes.length });
  }
  item(index) { return this[index] ?? null; }
  forEach(callback, self) { for (let i = 0; i < this.length; i++) callback.call(self, this[i], i, this); }
  *[Symbol.iterator]() { for (let i = 0; i < this.length; i++) yield this[i]; }
  entries() { return Array.prototype.entries.call(this); }
  keys() { return Array.prototype.keys.call(this); }
  values() { return this[Symbol.iterator](); }
  get [Symbol.toStringTag]() { return 'NodeList'; }
}

export class MutationRecord {
  constructor(type, target, { added = [], removed = [], previous = null, next = null, name = null, namespace = null }, oldValue) {
    this.type = type;
    this.target = target;
    this.addedNodes = new NodeList(added);
    this.removedNodes = new NodeList(removed);
    this.previousSibling = previous;
    this.nextSibling = next;
    this.attributeName = name;
    this.attributeNamespace = namespace;
    this.oldValue = oldValue;
  }
  get [Symbol.toStringTag]() { return 'MutationRecord'; }
}

function notify() {
  notifying = false;
  const observers = [...pending].sort((a, b) => a[ORDER] - b[ORDER]);
  pending.clear();
  for (const observer of observers) {
    const records = observer.takeRecords();
    if (!records.length) continue;
    try { observer[CALLBACK].call(observer, records, observer); } catch (error) { report(error); }
  }
}

// DOM's "queue a mutation record".
function queue(type, target, fields, oldValue = null) {
  if (!made) return;
  const interested = new Map();
  for (let node = target; node; node = node.parentNode) {
    for (const { observer, options } of REGISTRY.get(node) ?? []) {
      if (node !== target && !options.subtree) continue;
      if (type === 'attributes' && (!options.attributes || (options.attributeFilter && (fields.namespace !== null || !options.attributeFilter.includes(fields.name))))) continue;
      if (type === 'characterData' && !options.characterData) continue;
      if (type === 'childList' && !options.childList) continue;
      if (!interested.has(observer)) interested.set(observer, null);
      if ((type === 'attributes' && options.attributeOldValue) || (type === 'characterData' && options.characterDataOldValue)) interested.set(observer, oldValue);
    }
  }
  for (const [observer, value] of interested) {
    observer[RECORDS].push(new MutationRecord(type, target, fields, value));
    pending.add(observer);
  }
  if (interested.size && !notifying) {
    notifying = true;
    later(notify);
  }
}
export const queueChildList = (target, added, removed, previous, next) => queue('childList', target, { added, removed, previous, next });
export const queueAttribute = (target, name, namespace, oldValue) => queue('attributes', target, { name, namespace }, oldValue);
export const queueCharacterData = (target, oldValue) => queue('characterData', target, {}, oldValue);

const observeError = message => new TypeError(`Failed to execute 'observe' on 'MutationObserver': ${message}`);
export class MutationObserver {
  constructor(...args) {
    if (!args.length) throw new TypeError("Failed to construct 'MutationObserver': 1 argument required, but only 0 present.");
    if (typeof args[0] !== 'function') throw new TypeError("Failed to construct 'MutationObserver': parameter 1 is not of type 'Function'.");
    this[CALLBACK] = args[0];
    this[RECORDS] = [];
    this[NODES] = [];
    this[ORDER] = made++;
  }
  observe(target, init = {}) {
    if (!(target instanceof Node)) throw observeError("parameter 1 is not of type 'Node'.");
    const options = {
      childList: !!init.childList,
      attributes: init.attributes === undefined ? init.attributeOldValue !== undefined || init.attributeFilter !== undefined : !!init.attributes,
      characterData: init.characterData === undefined ? init.characterDataOldValue !== undefined : !!init.characterData,
      subtree: !!init.subtree,
      attributeOldValue: !!init.attributeOldValue,
      characterDataOldValue: !!init.characterDataOldValue,
      attributeFilter: init.attributeFilter === undefined ? null : [...init.attributeFilter].map(String),
    };
    if (options.attributeOldValue && !options.attributes) throw observeError("The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.");
    if (options.attributeFilter && !options.attributes) throw observeError("The options object may only set 'attributeFilter' when 'attributes' is true or not present.");
    if (options.characterDataOldValue && !options.characterData) throw observeError("The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.");
    if (!options.childList && !options.attributes && !options.characterData) throw observeError("The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.");
    const registrations = REGISTRY.get(target) ?? [];
    REGISTRY.set(target, registrations);
    const existing = registrations.find(registration => registration.observer === this);
    if (existing) existing.options = options;
    else {
      registrations.push({ observer: this, options });
      this[NODES].push(target);
    }
  }
  disconnect() {
    for (const node of this[NODES]) {
      const registrations = REGISTRY.get(node) ?? [];
      const index = registrations.findIndex(registration => registration.observer === this);
      if (index >= 0) registrations.splice(index, 1);
    }
    this[NODES] = [];
    this[RECORDS] = [];
    pending.delete(this);
  }
  takeRecords() {
    const records = this[RECORDS];
    this[RECORDS] = [];
    return records;
  }
  get [Symbol.toStringTag]() { return 'MutationObserver'; }
}

// IntersectionObserver.
const TARGETS = Symbol('targets');
const ENTRIES = Symbol('entries');
const OPTIONS = Symbol('options');
const intersecting = new Set();
let delivering = false;

export class IntersectionObserverEntry {
  constructor(init) { Object.assign(this, init); }
  get [Symbol.toStringTag]() { return 'IntersectionObserverEntry'; }
}

// A margin as Edge 157 parses it: one to four px or % lengths, px truncated to whole pixels.
function margin(text, name) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  const sides = tokens.map((token, index) => {
    if (index > 3) throw platformError(`Failed to construct 'IntersectionObserver': Extra text found at the end of ${name}.`, 'SyntaxError');
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|%)$/i.exec(token);
    if (!match) throw platformError(`Failed to construct 'IntersectionObserver': ${name} must be specified in absolute length units or percent.`, 'SyntaxError');
    const percent = match[2] === '%';
    return { value: percent ? Number(match[1]) : Math.trunc(Number(match[1])) + 0, percent };
  });
  const [top = { value: 0, percent: false }, right = top, bottom = top, left = right] = sides;
  return [top, right, bottom, left];
}
const serialize = sides => sides.map(({ value, percent }) => `${value}${percent ? '%' : 'px'}`).join(' ');
const zero = () => new DOMRectReadOnly(0, 0, 0, 0);

// Whether `target` leaves `root`'s containing block chain: a fixed box's containing block is the viewport, and an
// absolute box's is its nearest positioned ancestor, both by inline style.
function escapes(target, root) {
  for (let node = target; node && node !== root;) {
    const position = node.style?.position;
    if (position === 'fixed') return true;
    if (position === 'absolute') {
      let block = node.parentElement;
      while (block && !['fixed', 'absolute', 'relative', 'sticky'].includes(block.style.position)) block = block.parentElement;
      if (!block || (block !== root && !root.contains(block))) return true;
      node = block;
    } else node = node.parentElement;
  }
  return false;
}

function measure(observer, target, time) {
  const root = observer[OPTIONS].root?.nodeType === 1 ? observer[OPTIONS].root : null;
  const outside = { time, target, rootBounds: zero(), boundingClientRect: zero(), intersectionRect: zero(), isIntersecting: false, intersectionRatio: 0, isVisible: false };
  if (!target.isConnected) return { ...outside, band: 0 };
  if (root && (!root.isConnected || root === target || !root.contains(target) || escapes(target, root))) return { ...outside, band: 0 };
  const box = target.getBoundingClientRect();
  const view = target.ownerDocument?.defaultView ?? globalThis;
  const area = root ? root.getBoundingClientRect() : { x: 0, y: 0, width: view.innerWidth ?? 0, height: view.innerHeight ?? 0 };
  const [top, right, bottom, left] = observer[OPTIONS].margin.map(({ value, percent }, side) => percent ? value / 100 * (side % 2 ? area.width : area.height) : value);
  const bounds = new DOMRectReadOnly(area.x - left, area.y - top, area.width + left + right, area.height + top + bottom);
  const x0 = Math.max(box.left, bounds.left);
  const x1 = Math.min(box.right, bounds.right);
  const y0 = Math.max(box.top, bounds.top);
  const y1 = Math.min(box.bottom, bounds.bottom);
  const meets = x0 <= x1 && y0 <= y1;
  const targetArea = box.width * box.height;
  const ratio = !meets ? 0 : targetArea > 0 ? Math.fround((x1 - x0) * (y1 - y0) / targetArea) : 1;
  const thresholds = observer[OPTIONS].thresholds;
  const above = thresholds.findIndex(threshold => threshold > ratio);
  const band = meets ? (above < 0 ? thresholds.length : above) : 0;
  return {
    time, target, rootBounds: bounds, boundingClientRect: DOMRectReadOnly.fromRect(box),
    intersectionRect: meets ? new DOMRectReadOnly(x0, y0, x1 - x0, y1 - y0) : zero(),
    isIntersecting: band > 0, intersectionRatio: ratio, isVisible: false, band,
  };
}

function deliver() {
  delivering = false;
  for (const observer of [...intersecting].sort((a, b) => a[ORDER] - b[ORDER])) {
    const entries = observer.takeRecords();
    if (!entries.length) continue;
    try { observer[CALLBACK].call(observer, entries, observer); } catch (error) { report(error); }
  }
}

// HTML's "run the update intersection observations steps" for every observer with targets. As in Edge, a target
// gets an entry on its first check and whenever its threshold band changes, and the callbacks run in a task.
export function updateIntersections() {
  if (!intersecting.size) return;
  const time = globalThis.performance?.now() ?? Date.now();
  let queued = false;
  for (const observer of [...intersecting].sort((a, b) => a[ORDER] - b[ORDER])) {
    for (const [target, previous] of observer[TARGETS]) {
      const { band, ...entry } = measure(observer, target, time);
      if (band === previous) continue;
      observer[TARGETS].set(target, band);
      observer[ENTRIES].push(new IntersectionObserverEntry(entry));
      queued = true;
    }
  }
  if (queued && !delivering) {
    delivering = true;
    setTimeout(deliver, 0);
  }
}

export class IntersectionObserver {
  constructor(...args) {
    if (!args.length) throw new TypeError("Failed to construct 'IntersectionObserver': 1 argument required, but only 0 present.");
    if (typeof args[0] !== 'function') throw new TypeError("Failed to construct 'IntersectionObserver': parameter 1 is not of type 'Function'.");
    const init = args[1] ?? {};
    const root = init.root ?? null;
    if (root !== null && root.nodeType !== 1 && root.nodeType !== 9) throw new TypeError("Failed to construct 'IntersectionObserver': Failed to read the 'root' property from 'IntersectionObserverInit': The provided value is not of type '(Document or Element)'.");
    const listed = init.threshold === undefined ? [0] : Array.isArray(init.threshold) ? init.threshold.map(Number) : [Number(init.threshold)];
    if (listed.some(value => !(value >= 0 && value <= 1))) throw new RangeError("Failed to construct 'IntersectionObserver': Threshold values must be numbers between 0 and 1");
    this[CALLBACK] = args[0];
    this[OPTIONS] = {
      root,
      margin: margin(init.rootMargin ?? '0px', 'rootMargin'),
      scrollMargin: margin(init.scrollMargin ?? '0px', 'scrollMargin'),
      thresholds: (listed.length ? listed : [0]).sort((a, b) => a - b),
      delay: Number(init.delay ?? 0),
      trackVisibility: !!init.trackVisibility,
    };
    this[TARGETS] = new Map();
    this[ENTRIES] = [];
    this[ORDER] = made++;
  }
  get root() { return this[OPTIONS].root; }
  get rootMargin() { return serialize(this[OPTIONS].margin); }
  get scrollMargin() { return serialize(this[OPTIONS].scrollMargin); }
  get thresholds() { return [...this[OPTIONS].thresholds]; }
  get delay() { return this[OPTIONS].delay; }
  get trackVisibility() { return this[OPTIONS].trackVisibility; }
  observe(target) {
    if (!(target instanceof Element)) throw new TypeError("Failed to execute 'observe' on 'IntersectionObserver': parameter 1 is not of type 'Element'.");
    if (this[TARGETS].has(target)) return;
    this[TARGETS].set(target, -1);
    intersecting.add(this);
  }
  unobserve(target) {
    this[TARGETS].delete(target);
    if (!this[TARGETS].size) intersecting.delete(this);
  }
  disconnect() {
    this[TARGETS].clear();
    intersecting.delete(this);
  }
  takeRecords() {
    const entries = this[ENTRIES];
    this[ENTRIES] = [];
    return entries;
  }
  get [Symbol.toStringTag]() { return 'IntersectionObserver'; }
}
