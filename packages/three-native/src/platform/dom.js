// A stand-in DOM for game code: an inert element tree with attributes, classList, style, dataset, selectors, focus
// and listeners. Nothing lays out or paints. A canvas in the document fills the window, as a game's canvas does.
import { EventTarget, Event, FocusEvent, MouseEvent, trusted, defineHandlers, INPUT } from './events.js';
import { DOM_METHODS, EVENT_HANDLERS, CSS_PROPERTIES } from './dom-methods.js';
import { CanvasRenderingContext2D, CONTEXT_2D, FontFaceSet, RESIZE } from './canvas2d.js';
import { DOMRect } from './geometry.js';
import { platformError } from './errors.js';
import { queueAttribute, queueCharacterData, queueChildList } from './observers.js';

const ATTRIBUTES = Symbol('attributes');
const CHILDREN = Symbol('children');
const STYLE = Symbol('style');
const CLASSES = Symbol('classes');
const DATASET = Symbol('dataset');
const MARKUP = Symbol('markup');
const NAMESPACE = Symbol('namespace');
const PREFIX = Symbol('prefix');
const QUALIFIED = Symbol('qualifiedName');
const WRITE_STYLE = Symbol('writeStyle');
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

// The host's log, set by the platform, for methods and features the stand-in lacks.
let log = message => globalThis.console?.warn(message);
export function setLog(callback) { log = callback; }
const logged = new Set();
export function logOnce(message) {
  if (logged.has(message)) return;
  logged.add(message);
  log(message);
}

const kebab = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

export class DOMTokenList {
  #element;
  #attribute;
  constructor(element, attribute) { this.#element = element; this.#attribute = attribute; }
  #tokens() { return (this.#element.getAttribute(this.#attribute) ?? '').split(/[ \t\n\f\r]+/).filter(Boolean).filter((token, index, all) => all.indexOf(token) === index); }
  #write(tokens) { this.#element.setAttribute(this.#attribute, tokens.join(' ')); }
  #check(token) {
    token = String(token);
    if (!token) throw platformError("Failed to execute on 'DOMTokenList': The token provided must not be empty.", 'SyntaxError');
    if (/[ \t\n\f\r]/.test(token)) throw platformError(`Failed to execute on 'DOMTokenList': The token provided ('${token}') contains HTML space characters, which are not valid in tokens.`, 'InvalidCharacterError');
    return token;
  }
  get length() { return this.#tokens().length; }
  get value() { return this.#element.getAttribute(this.#attribute) ?? ''; }
  set value(value) { this.#element.setAttribute(this.#attribute, value); }
  item(index) { return this.#tokens()[index] ?? null; }
  contains(token) { return this.#tokens().includes(String(token)); }
  add(...tokens) {
    const list = this.#tokens();
    for (const token of tokens.map(token => this.#check(token))) if (!list.includes(token)) list.push(token);
    this.#write(list);
  }
  remove(...tokens) {
    const removed = tokens.map(token => this.#check(token));
    if (this.#element.hasAttribute(this.#attribute)) this.#write(this.#tokens().filter(token => !removed.includes(token)));
  }
  toggle(token, force) {
    token = this.#check(token);
    const has = this.contains(token);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.add(token);
    if (!want && has) this.remove(token);
    return want;
  }
  replace(token, replacement) {
    const list = this.#tokens();
    const index = list.indexOf(this.#check(token));
    if (index < 0) return false;
    list[index] = this.#check(replacement);
    this.#write(list.filter((item, i) => list.indexOf(item) === i));
    return true;
  }
  supports() { throw new TypeError("Failed to execute 'supports' on 'DOMTokenList': DOMTokenList has no supported tokens."); }
  forEach(callback, thisArg) { this.#tokens().forEach((token, index) => callback.call(thisArg, token, index, this)); }
  entries() { return this.#tokens().entries(); }
  keys() { return this.#tokens().keys(); }
  values() { return this.#tokens().values(); }
  [Symbol.iterator]() { return this.#tokens()[Symbol.iterator](); }
  toString() { return this.value; }
}

// An element's inline style, kept in step with its style attribute as in Edge: setting the attribute parses it into
// the declaration, and changing the declaration writes its text back. Every CSS property Edge knows, in camel case or
// hyphenated, reads '' while unset; other names are plain expandos. Nothing checks that a value is valid CSS.
const DECLARATIONS = Symbol('declarations');
const OWNER = Symbol('owner');
const cssName = key => key === 'cssFloat' ? 'float' : key.startsWith('-') ? key : kebab(key).replace(/^webkit-/, '-webkit-');
export class CSSStyleDeclaration {
  constructor(element = null) {
    this[DECLARATIONS] = new Map();
    this[OWNER] = element;
    return new Proxy(this, {
      get: (target, key, receiver) => typeof key === 'string' && !(key in target) && CSS_PROPERTIES.has(key)
        ? target.getPropertyValue(cssName(key)) : Reflect.get(target, key, receiver),
      set: (target, key, value, receiver) => {
        if (typeof key !== 'string' || key in target || !CSS_PROPERTIES.has(key)) return Reflect.set(target, key, value, receiver);
        target.setProperty(cssName(key), value);
        return true;
      },
      has: (target, key) => (typeof key === 'string' && CSS_PROPERTIES.has(key)) || key in target,
    });
  }
  // Writes the declaration's text to the owner's style attribute.
  [MARKUP]() { this[OWNER]?.[WRITE_STYLE](this.cssText); }
  // Replaces the declarations with those parsed from `text`, without touching the attribute.
  [STYLE](text) {
    this[DECLARATIONS].clear();
    for (const declaration of String(text).split(';')) {
      const colon = declaration.indexOf(':');
      if (colon <= 0) continue;
      const value = declaration.slice(colon + 1).trim();
      const important = /\s*!\s*important$/i.exec(value);
      const name = declaration.slice(0, colon).trim();
      if (value) this[DECLARATIONS].set(name.startsWith('--') ? name : name.toLowerCase(), { value: important ? value.slice(0, important.index) : value, priority: important ? 'important' : '' });
    }
  }
  setProperty(name, value, priority = '') {
    name = String(name);
    if (value === null || value === '') return void this.removeProperty(name);
    this[DECLARATIONS].set(name.startsWith('--') ? name : name.toLowerCase(), { value: String(value), priority: priority === 'important' ? 'important' : '' });
    this[MARKUP]();
  }
  getPropertyValue(name) { return this[DECLARATIONS].get(String(name).startsWith('--') ? String(name) : String(name).toLowerCase())?.value ?? ''; }
  getPropertyPriority(name) { return this[DECLARATIONS].get(String(name).startsWith('--') ? String(name) : String(name).toLowerCase())?.priority ?? ''; }
  removeProperty(name) {
    const key = String(name).startsWith('--') ? String(name) : String(name).toLowerCase();
    const value = this.getPropertyValue(key);
    if (this[DECLARATIONS].delete(key)) this[MARKUP]();
    return value;
  }
  get length() { return this[DECLARATIONS].size; }
  item(index) { return [...this[DECLARATIONS].keys()][index] ?? ''; }
  get cssText() {
    return [...this[DECLARATIONS]].map(([name, { value, priority }]) => `${name}: ${value}${priority ? ' !important' : ''};`).join(' ');
  }
  set cssText(text) {
    this[STYLE](text);
    this[MARKUP]();
  }
}

// Selectors: compound selectors of type, universal, id, class, attribute and a few pseudo-classes, joined by the
// descendant, child and sibling combinators, in comma-separated lists. Each list compiles once and is cached.
const selectorCache = new Map();
function invalidSelector(selector) {
  return platformError(`Failed to execute 'querySelector' on 'Document': '${selector}' is not a valid selector.`, 'SyntaxError');
}
function parseCompound(text, selector) {
  const tests = [];
  const pattern = /^(?:(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*(i)?\s*)?\]|:(not|is|where)\(([^()]*)\)|:([\w-]+))/;
  let rest = text;
  while (rest) {
    const match = pattern.exec(rest);
    if (!match) throw invalidSelector(selector);
    rest = rest.slice(match[0].length);
    const [, tag, id, className, attribute, operator, double, single, bare, insensitive, functional, argument, pseudo] = match;
    if (tag && tag !== '*') tests.push(element => element[NAMESPACE] === HTML_NAMESPACE ? element.localName.toLowerCase() === tag.toLowerCase() : element.localName === tag);
    else if (id) tests.push(element => element.id === id);
    else if (className) tests.push(element => element.classList.contains(className));
    else if (attribute) {
      const expected = double ?? single ?? bare;
      const fold = value => insensitive ? value.toLowerCase() : value;
      const want = expected === undefined ? undefined : fold(expected);
      tests.push(element => {
        const actual = element.getAttribute(attribute);
        if (actual === null) return false;
        if (want === undefined) return true;
        const value = fold(actual);
        switch (operator) {
          case '=': return value === want;
          case '~=': return value.split(/\s+/).includes(want);
          case '|=': return value === want || value.startsWith(`${want}-`);
          case '^=': return want !== '' && value.startsWith(want);
          case '$=': return want !== '' && value.endsWith(want);
          default: return want !== '' && value.includes(want);
        }
      });
    } else if (functional) {
      const inner = compile(argument);
      tests.push(functional === 'not' ? element => !inner(element) : inner);
    } else {
      const test = {
        'first-child': element => element.previousElementSibling === null,
        'last-child': element => element.nextElementSibling === null,
        'only-child': element => !element.previousElementSibling && !element.nextElementSibling,
        root: element => element.ownerDocument?.documentElement === element,
        empty: element => element.childNodes.length === 0,
        focus: element => element.ownerDocument?.activeElement === element,
        checked: element => element.hasAttribute('checked'),
        disabled: element => element.hasAttribute('disabled'),
        enabled: element => !element.hasAttribute('disabled'),
      }[pseudo];
      if (!test) throw invalidSelector(selector);
      tests.push(test);
    }
  }
  return element => tests.every(test => test(element));
}
function compileComplex(text, selector) {
  const parts = text.trim().split(/\s*([>+~])\s*|\s+/).filter(part => part !== undefined && part !== '');
  if (!parts.length || /[>+~]/.test(parts[0]) || /[>+~]/.test(parts.at(-1))) throw invalidSelector(selector);
  const steps = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[>+~]$/.test(parts[i])) continue;
    const combinator = i > 0 && /^[>+~]$/.test(parts[i - 1]) ? parts[i - 1] : ' ';
    steps.push({ test: parseCompound(parts[i], selector), combinator });
  }
  const match = (element, index) => {
    if (!steps[index].test(element)) return false;
    if (index === steps.length - 1) return true;
    const combinator = steps[index].combinator;
    if (combinator === '>') return element.parentElement !== null && match(element.parentElement, index + 1);
    if (combinator === '+') return element.previousElementSibling !== null && match(element.previousElementSibling, index + 1);
    if (combinator === '~') {
      for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (match(sibling, index + 1)) return true;
      return false;
    }
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) if (match(ancestor, index + 1)) return true;
    return false;
  };
  return element => match(element, 0);
}
function compile(selector) {
  selector = String(selector);
  let compiled = selectorCache.get(selector);
  if (!compiled) {
    const alternatives = selector.split(',').map(part => compileComplex(part, selector));
    compiled = element => alternatives.some(test => test(element));
    if (selectorCache.size > 1000) selectorCache.clear();
    selectorCache.set(selector, compiled);
  }
  return compiled;
}
function* descendants(root) {
  for (const child of root[CHILDREN] ?? []) {
    if (child.nodeType === 1) yield child;
    yield* descendants(child);
  }
}

// DOM's insert, remove and replace steps. A fragment moves its children in order, leaves itself empty, and queues one
// record on itself and one on the parent; every other move queues a removal and an insertion. The records name the
// added and removed nodes with the siblings they sat between, as Edge queues them.
function convertNodes(parent, items) {
  if (!items.length) return null;
  if (items.length === 1) return items[0] instanceof Node ? items[0] : parent.ownerDocument.createTextNode(String(items[0]));
  const fragment = parent.ownerDocument.createDocumentFragment();
  for (const item of items) fragment.appendChild(item instanceof Node ? item : parent.ownerDocument.createTextNode(String(item)));
  return fragment;
}
function detach(node) {
  const parent = node.parentNode;
  if (!parent) return null;
  const siblings = parent[CHILDREN];
  const index = siblings.indexOf(node);
  if (index < 0) { node.parentNode = null; return null; }
  const previous = siblings[index - 1] ?? null;
  const next = siblings[index + 1] ?? null;
  siblings.splice(index, 1);
  node.parentNode = null;
  parent.ownerDocument?.[INPUT]?.removed(node);
  if (parent.nodeType === 1) parent[MARKUP] = undefined;
  return { parent, previous, next };
}
function removeNode(node) {
  const removed = detach(node);
  if (removed) queueChildList(removed.parent, [], [node], removed.previous, removed.next);
}
function insertNode(parent, node, reference) {
  const nodes = node.nodeType === 11 ? [...node[CHILDREN]] : [node];
  if (!nodes.length) return;
  const previous = reference ? reference.previousSibling : parent.lastChild;
  if (node.nodeType === 11) {
    for (const child of nodes) child.parentNode = null;
    node[CHILDREN].length = 0;
    queueChildList(node, [], nodes, null, null);
  }
  for (const child of nodes) {
    if (child.parentNode) removeNode(child);
    const index = reference ? parent[CHILDREN].indexOf(reference) : parent[CHILDREN].length;
    parent[CHILDREN].splice(index, 0, child);
    child.parentNode = parent;
  }
  queueChildList(parent, nodes, [], previous, reference ?? null);
  if (parent.nodeType === 1) parent[MARKUP] = undefined;
}
function replaceNode(parent, old, node) {
  const reference = old.nextSibling === node ? node.nextSibling : old.nextSibling;
  const previous = old.previousSibling;
  const nodes = node ? (node.nodeType === 11 ? [...node[CHILDREN]] : [node]) : [];
  detach(old);
  if (node?.nodeType === 11) {
    for (const child of nodes) child.parentNode = null;
    node[CHILDREN].length = 0;
    queueChildList(node, [], nodes, null, null);
  }
  for (const child of nodes) {
    if (child.parentNode) removeNode(child);
    const index = reference ? parent[CHILDREN].indexOf(reference) : parent[CHILDREN].length;
    parent[CHILDREN].splice(index, 0, child);
    child.parentNode = parent;
  }
  queueChildList(parent, nodes, [old], previous, reference ?? null);
}
function replaceAll(parent, node) {
  const added = node ? (node.nodeType === 11 ? [...node[CHILDREN]] : [node]) : [];
  const removed = [...parent[CHILDREN]];
  queueChildList(parent, added, removed, null, null);
  for (const child of removed) {
    child.parentNode = null;
    parent.ownerDocument?.[INPUT]?.removed(child);
  }
  parent[CHILDREN].length = 0;
  if (parent.nodeType === 1) parent[MARKUP] = undefined;
  if (node?.nodeType === 11) node[CHILDREN].length = 0;
  for (const child of added) {
    if (child.parentNode) removeNode(child);
    parent[CHILDREN].push(child);
    child.parentNode = parent;
  }
}

export class Node extends EventTarget {
  static ELEMENT_NODE = 1;
  static TEXT_NODE = 3;
  static DOCUMENT_NODE = 9;
  static DOCUMENT_FRAGMENT_NODE = 11;
  constructor(document) {
    super();
    this.ownerDocument = document;
    this.parentNode = null;
    this[CHILDREN] = [];
  }
  get childNodes() { return [...this[CHILDREN]]; }
  get children() { return this[CHILDREN].filter(node => node.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this[CHILDREN][0] ?? null; }
  get lastChild() { return this[CHILDREN].at(-1) ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  #sibling(offset, elements) {
    const siblings = this.parentNode?.[CHILDREN].filter(node => !elements || node.nodeType === 1) ?? [];
    const index = siblings.indexOf(this);
    return index < 0 ? null : siblings[index + offset] ?? null;
  }
  get nextSibling() { return this.#sibling(1, false); }
  get previousSibling() { return this.#sibling(-1, false); }
  get nextElementSibling() { return this.#sibling(1, true); }
  get previousElementSibling() { return this.#sibling(-1, true); }
  get isConnected() { return this.getRootNode().nodeType === 9; }
  getRootNode() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node;
  }
  hasChildNodes() { return this[CHILDREN].length > 0; }
  contains(other) {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  appendChild(node) {
    if (!(node instanceof Node)) throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
    if (node.contains(this)) throw platformError("Failed to execute 'appendChild' on 'Node': The new child element contains the parent.", 'HierarchyRequestError');
    insertNode(this, node, null);
    return node;
  }
  insertBefore(node, reference) {
    if (!(node instanceof Node)) throw new TypeError("Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'.");
    if (reference !== null && reference !== undefined && reference.parentNode !== this) throw platformError("Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.", 'NotFoundError');
    if (node.contains(this)) throw platformError("Failed to execute 'insertBefore' on 'Node': The new child element contains the parent.", 'HierarchyRequestError');
    insertNode(this, node, reference ?? null);
    return node;
  }
  removeChild(node) {
    if (!(node instanceof Node) || node.parentNode !== this) throw platformError("Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.", 'NotFoundError');
    const index = this[CHILDREN].indexOf(node);
    const previous = this[CHILDREN][index - 1] ?? null;
    const next = this[CHILDREN][index + 1] ?? null;
    this[CHILDREN].splice(index, 1);
    node.parentNode = null;
    this.ownerDocument?.[INPUT]?.removed(node);
    queueChildList(this, [], [node], previous, next);
    if (this.nodeType === 1) this[MARKUP] = undefined;
    return node;
  }
  replaceChild(node, old) {
    if (!(node instanceof Node)) throw new TypeError("Failed to execute 'replaceChild' on 'Node': parameter 1 is not of type 'Node'.");
    if (old?.parentNode !== this) throw platformError("Failed to execute 'replaceChild' on 'Node': The node to be replaced is not a child of this node.", 'NotFoundError');
    if (node.contains(this)) throw platformError("Failed to execute 'replaceChild' on 'Node': The new child element contains the parent.", 'HierarchyRequestError');
    replaceNode(this, old, node);
    return old;
  }
  remove() { this.parentNode?.removeChild(this); }
  append(...items) { const node = convertNodes(this, items); if (node) insertNode(this, node, null); }
  prepend(...items) { const node = convertNodes(this, items); if (node) insertNode(this, node, this.firstChild); }
  replaceChildren(...items) { replaceAll(this, convertNodes(this, items)); }
  before(...items) { const node = convertNodes(this, items); if (this.parentNode && node) insertNode(this.parentNode, node, this); }
  after(...items) { const node = convertNodes(this, items); if (this.parentNode && node) insertNode(this.parentNode, node, this.nextSibling); }
  replaceWith(...items) { if (this.parentNode) replaceNode(this.parentNode, this, convertNodes(this, items)); }
  get textContent() { return this[CHILDREN].map(child => child.textContent).join(''); }
  set textContent(value) {
    const text = value === null || value === undefined ? '' : String(value);
    replaceAll(this, text === '' ? null : this.ownerDocument.createTextNode(text));
  }
  cloneNode(deep = false) {
    const copy = this.nodeType === 3 ? this.ownerDocument.createTextNode(this.data) : this.ownerDocument.createDocumentFragment();
    if (deep) for (const child of this[CHILDREN]) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  isSameNode(other) { return this === other; }
}
for (const [name, value] of Object.entries({ ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 })) Object.defineProperty(Node.prototype, name, { value });

export class Text extends Node {
  constructor(document, data) { super(document); this._data = String(data); }
  get data() { return this._data; }
  set data(value) { const old = this._data; this._data = String(value ?? ''); queueCharacterData(this, old); }
  get nodeType() { return 3; }
  get nodeName() { return '#text'; }
  get textContent() { return this._data; }
  set textContent(value) { this.data = value; }
  get nodeValue() { return this._data; }
  set nodeValue(value) { this.data = value; }
  get length() { return this._data.length; }
}

export class DocumentFragment extends Node {
  get nodeType() { return 11; }
  get nodeName() { return '#document-fragment'; }
  querySelector(selector) { return Element.prototype.querySelector.call(this, selector); }
  querySelectorAll(selector) { return Element.prototype.querySelectorAll.call(this, selector); }
}

const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const FOCUSABLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'iframe']);

// A length from an inline style, in CSS pixels against `size`: px, % of `size`, vw and vh. Anything else is unknown.
function length(value, size, window) {
  const match = /^(-?\d*\.?\d+)(px|%|vw|vh)?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const number = Number(match[1]);
  const unit = match[2] ?? (number === 0 ? 'px' : null);
  if (unit === 'px') return number;
  if (unit === '%') return (number * size) / 100;
  if (unit === 'vw') return (number * window.innerWidth) / 100;
  if (unit === 'vh') return (number * window.innerHeight) / 100;
  return null;
}
// The box an inline style with position fixed or absolute gives an element, taken against the window: each axis
// from its start and size, or its end and size, or its start and end. Null when the style does not fix the box.
// The window an element measures against.
const viewOf = element => {
  const view = element.ownerDocument?.defaultView ?? globalThis;
  return { innerWidth: view.innerWidth ?? 0, innerHeight: view.innerHeight ?? 0 };
};
function inlineBox(element) {
  const style = element.style;
  const window = viewOf(element);
  if (style.position !== 'fixed' && style.position !== 'absolute') return null;
  const inset = String(style.inset ?? '').trim().split(/\s+/).filter(Boolean);
  const sides = inset.length ? [inset[0], inset[1] ?? inset[0], inset[2] ?? inset[0], inset[3] ?? inset[1] ?? inset[0]] : [];
  const axis = (start, end, size, total) => {
    const from = length(start, total, window);
    const to = length(end, total, window);
    const extent = length(size, total, window);
    if (extent !== null && from !== null) return [from, extent];
    if (extent !== null && to !== null) return [total - to - extent, extent];
    if (from !== null && to !== null) return [from, Math.max(0, total - from - to)];
    return [from ?? 0, extent ?? 0];
  };
  const [x, width] = axis(style.left || sides[3], style.right || sides[1], style.width, window.innerWidth);
  const [y, height] = axis(style.top || sides[0], style.bottom || sides[2], style.height, window.innerHeight);
  return { x, y, width, height };
}
function fills(element) {
  const full = ['canvas', 'body', 'html'].includes(element.localName);
  const window = viewOf(element);
  return { x: 0, y: 0, width: full ? window.innerWidth : 0, height: full ? window.innerHeight : 0 };
}

// Attributes as Edge keeps them: one per namespace and local name, with the prefix and qualified name it was given.
// getAttribute() and setAttribute() lower-case only on HTML elements, and getAttribute compares qualified names.
const attributeKey = (namespace, localName) => `${namespace ?? ''}\n${localName}`;
function setAttributeValue(element, namespace, prefix, localName, qualifiedName, value, parseStyle = true) {
  const key = attributeKey(namespace, localName);
  const attributes = element[ATTRIBUTES];
  const old = attributes.get(key);
  attributes.set(key, { namespace: namespace ?? null, prefix: prefix ?? null, localName, qualifiedName, value: String(value) });
  if (namespace === null && localName === 'style' && parseStyle) element.style[STYLE](value);
  queueAttribute(element, localName, namespace ?? null, old ? old.value : null);
}
function removeAttributeValue(element, namespace, localName) {
  const key = attributeKey(namespace, localName);
  const attributes = element[ATTRIBUTES];
  const old = attributes.get(key);
  if (!old) return;
  attributes.delete(key);
  if (namespace === null && localName === 'style') element.style[STYLE]('');
  queueAttribute(element, localName, namespace ?? null, old.value);
}
// DOM's "validate and extract" for setAttributeNS, with Edge's NamespaceError for each invalid prefix.
function validateAndExtract(namespace, qualifiedName, operation) {
  namespace = namespace === null || namespace === undefined || namespace === '' ? null : String(namespace);
  qualifiedName = String(qualifiedName);
  const colon = qualifiedName.indexOf(':');
  const prefix = colon < 0 ? null : qualifiedName.slice(0, colon);
  const localName = colon < 0 ? qualifiedName : qualifiedName.slice(colon + 1);
  const bad = (prefix !== null && namespace === null)
    || (prefix === 'xml' && namespace !== XML_NAMESPACE)
    || ((qualifiedName === 'xmlns' || prefix === 'xmlns') && namespace !== XMLNS_NAMESPACE);
  if (bad) throw platformError(`Failed to execute '${operation}' on 'Element': '${namespace ?? ''}' is an invalid namespace for attributes.`, 'NamespaceError');
  return { namespace, prefix, localName, qualifiedName };
}

// SVG elements by local name, each with the class name Edge reports for its interface.
const SVG_CLASSES = new Map();
function svgClass(localName) {
  let Class = SVG_CLASSES.get(localName);
  if (!Class) {
    Class = class extends Element {};
    const name = localName === 'svg' ? 'SVGSVGElement' : `SVG${localName.slice(0, 1).toUpperCase()}${localName.slice(1)}Element`;
    Object.defineProperty(Class, 'name', { value: name });
    SVG_CLASSES.set(localName, Class);
  }
  return Class;
}

export class Element extends Node {
  constructor(document, localName = '', namespace = HTML_NAMESPACE, prefix = null, qualifiedName = localName) {
    super(document);
    this.localName = String(localName);
    this[NAMESPACE] = namespace;
    this[PREFIX] = prefix;
    this[QUALIFIED] = String(qualifiedName);
    this[ATTRIBUTES] = new Map();
  }
  get nodeType() { return 1; }
  get tagName() {
    return this[NAMESPACE] === HTML_NAMESPACE && this.ownerDocument?.contentType === 'text/html'
      ? this[QUALIFIED].toUpperCase() : this[QUALIFIED];
  }
  get nodeName() { return this.tagName; }
  get namespaceURI() { return this[NAMESPACE]; }
  get prefix() { return this[PREFIX]; }
  getAttribute(name) {
    name = this[NAMESPACE] === HTML_NAMESPACE ? String(name).toLowerCase() : String(name);
    for (const attribute of this[ATTRIBUTES].values()) if (attribute.qualifiedName === name) return attribute.value;
    return null;
  }
  setAttribute(name, value) {
    name = String(name);
    if (this[NAMESPACE] === HTML_NAMESPACE) name = name.toLowerCase();
    setAttributeValue(this, null, null, name, name, value);
  }
  removeAttribute(name) {
    name = String(name);
    if (this[NAMESPACE] === HTML_NAMESPACE) name = name.toLowerCase();
    for (const attribute of this[ATTRIBUTES].values()) {
      if (attribute.qualifiedName === name) { removeAttributeValue(this, attribute.namespace, attribute.localName); return; }
    }
  }
  hasAttribute(name) {
    name = this[NAMESPACE] === HTML_NAMESPACE ? String(name).toLowerCase() : String(name);
    for (const attribute of this[ATTRIBUTES].values()) if (attribute.qualifiedName === name) return true;
    return false;
  }
  getAttributeNS(namespace, localName) {
    namespace = namespace === null || namespace === undefined || namespace === '' ? null : String(namespace);
    return this[ATTRIBUTES].get(attributeKey(namespace, String(localName)))?.value ?? null;
  }
  setAttributeNS(namespace, qualifiedName, value) {
    if (arguments.length < 3) throw new TypeError("Failed to execute 'setAttributeNS' on 'Element': 3 arguments required, but only 2 present.");
    const { namespace: ns, prefix, localName, qualifiedName: qname } = validateAndExtract(namespace, qualifiedName, 'setAttributeNS');
    const existing = this[ATTRIBUTES].get(attributeKey(ns, localName));
    setAttributeValue(this, ns, existing ? existing.prefix : prefix, localName, existing ? existing.qualifiedName : qname, value);
  }
  removeAttributeNS(namespace, localName) {
    namespace = namespace === null || namespace === undefined || namespace === '' ? null : String(namespace);
    removeAttributeValue(this, namespace, String(localName));
  }
  hasAttributeNS(namespace, localName) {
    namespace = namespace === null || namespace === undefined || namespace === '' ? null : String(namespace);
    return this[ATTRIBUTES].has(attributeKey(namespace, String(localName)));
  }
  hasAttributes() { return this[ATTRIBUTES].size > 0; }
  getAttributeNames() { return [...this[ATTRIBUTES].values()].map(attribute => attribute.qualifiedName); }
  toggleAttribute(name, force) {
    const want = force === undefined ? !this.hasAttribute(name) : !!force;
    if (want && !this.hasAttribute(name)) this.setAttribute(name, '');
    if (!want) this.removeAttribute(name);
    return want;
  }
  get attributes() { return [...this[ATTRIBUTES].values()].map(({ qualifiedName, value }) => ({ name: qualifiedName, value })); }
  [WRITE_STYLE](text) { setAttributeValue(this, null, null, 'style', 'style', text, false); }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get classList() { return this[CLASSES] ??= new DOMTokenList(this, 'class'); }
  set classList(value) { this.classList.value = value; }
  get style() { return this[STYLE] ??= new CSSStyleDeclaration(this); }
  set style(value) { this.style.cssText = value; }
  get dataset() {
    return this[DATASET] ??= new Proxy({}, {
      get: (_, key) => typeof key === 'string' ? this.getAttribute(`data-${kebab(key)}`) ?? undefined : undefined,
      set: (_, key, value) => { this.setAttribute(`data-${kebab(String(key))}`, value); return true; },
      deleteProperty: (_, key) => { this.removeAttribute(`data-${kebab(String(key))}`); return true; },
      has: (_, key) => typeof key === 'string' && this.hasAttribute(`data-${kebab(key)}`),
      ownKeys: () => this.getAttributeNames().filter(name => name.startsWith('data-')).map(name => camel(name.slice(5))),
      getOwnPropertyDescriptor: (_, key) => typeof key === 'string' && this.hasAttribute(`data-${kebab(key)}`)
        ? { value: this.getAttribute(`data-${kebab(key)}`), writable: true, enumerable: true, configurable: true } : undefined,
    });
  }
  matches(selector) { return compile(selector)(this); }
  closest(selector) {
    const test = compile(selector);
    for (let element = this; element; element = element.parentElement) if (test(element)) return element;
    return null;
  }
  querySelector(selector) {
    const test = compile(selector);
    for (const element of descendants(this)) if (test(element)) return element;
    return null;
  }
  querySelectorAll(selector) {
    const test = compile(selector);
    return [...descendants(this)].filter(test);
  }
  getElementsByClassName(names) {
    const wanted = String(names).split(/\s+/).filter(Boolean);
    return [...descendants(this)].filter(element => wanted.every(name => element.classList.contains(name)));
  }
  getElementsByTagName(name) {
    name = String(name).toLowerCase();
    return [...descendants(this)].filter(element => name === '*' || element.localName === name);
  }
  get innerHTML() {
    if (this[MARKUP] !== undefined) return this[MARKUP];
    return this[CHILDREN].map(child => child.nodeType === 3 ? escapeText(child.data) : child.outerHTML).join('');
  }
  set innerHTML(value) {
    this.textContent = '';
    value = String(value ?? '');
    if (value) {
      logOnce('DOM stand-in: innerHTML does not parse markup; the element keeps the string and has no children');
      this[MARKUP] = value;
    }
  }
  get outerHTML() {
    const attributes = [...this[ATTRIBUTES].values()].map(({ qualifiedName, value }) => ` ${qualifiedName}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
    const tag = this[NAMESPACE] === HTML_NAMESPACE ? this[QUALIFIED].toLowerCase() : this[QUALIFIED];
    return VOID.has(this.localName) ? `<${tag}${attributes}>` : `<${tag}${attributes}>${this.innerHTML}</${tag}>`;
  }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }
  // Layout without CSS: an element whose inline style fixes its box against the window measures that box, a canvas,
  // the body and the root element otherwise fill the window, and every other element has no box.
  getBoundingClientRect() {
    const { x, y, width, height } = this.isConnected ? inlineBox(this) ?? fills(this) : { x: 0, y: 0, width: 0, height: 0 };
    return new DOMRect(x, y, width, height);
  }
  get clientWidth() { return Math.round(this.getBoundingClientRect().width); }
  get clientHeight() { return Math.round(this.getBoundingClientRect().height); }
  get offsetWidth() { return Math.round(this.getBoundingClientRect().width); }
  get offsetHeight() { return Math.round(this.getBoundingClientRect().height); }
  get clientLeft() { return 0; }
  get clientTop() { return 0; }
  get offsetLeft() { return 0; }
  get offsetTop() { return 0; }
  get offsetParent() { return null; }
  get scrollWidth() { return this.clientWidth; }
  get scrollHeight() { return this.clientHeight; }
  get scrollLeft() { return 0; }
  set scrollLeft(_) {}
  get scrollTop() { return 0; }
  set scrollTop(_) {}
  get tabIndex() {
    const value = Number.parseInt(this.getAttribute('tabindex'), 10);
    if (Number.isInteger(value)) return value;
    return FOCUSABLE.has(this.localName) && (this.localName !== 'a' || this.hasAttribute('href')) ? 0 : -1;
  }
  set tabIndex(value) { this.setAttribute('tabindex', String(value | 0)); }
  get #focusable() { return this.isConnected && (this.hasAttribute('tabindex') || this.tabIndex >= 0 || this.hasAttribute('contenteditable')); }
  focus() { if (this.#focusable) this.ownerDocument.setFocus(this); }
  blur() { if (this.ownerDocument?.activeElement === this) this.ownerDocument.setFocus(null); }
  get isContentEditable() { return this.closest('[contenteditable]:not([contenteditable="false"])') !== null; }
  setPointerCapture(pointerId) {
    if (!this.isConnected) throw platformError("Failed to execute 'setPointerCapture' on 'Element': InvalidStateError", 'InvalidStateError');
    this.ownerDocument[INPUT]?.capture(this, pointerId);
  }
  releasePointerCapture(pointerId) { this.ownerDocument[INPUT]?.release(this, pointerId); }
  hasPointerCapture(pointerId) { return this.ownerDocument[INPUT]?.captured(pointerId) === this; }
  cloneNode(deep = false) {
    const copy = this.ownerDocument.createElementNS(this[NAMESPACE], this[QUALIFIED]);
    for (const attribute of this[ATTRIBUTES].values()) setAttributeValue(copy, attribute.namespace, attribute.prefix, attribute.localName, attribute.qualifiedName, attribute.value);
    if (deep) for (const child of this[CHILDREN]) copy.appendChild(child.cloneNode(true));
    return copy;
  }
}

export class HTMLElement extends Element {
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { this.toggleAttribute('hidden', !!value); }
  get title() { return this.getAttribute('title') ?? ''; }
  set title(value) { this.setAttribute('title', value); }
  get dir() { return this.getAttribute('dir') ?? ''; }
  set dir(value) { this.setAttribute('dir', value); }
  get lang() { return this.getAttribute('lang') ?? ''; }
  set lang(value) { this.setAttribute('lang', value); }
  click() {
    this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: globalThis, detail: 1 }));
  }
}
defineHandlers(HTMLElement.prototype, EVENT_HANDLERS.element);

// Inputs keep their value and type, so a game's guard on text fields can read them.
export class HTMLInputElement extends HTMLElement {
  get value() { return this._value ?? this.getAttribute('value') ?? ''; }
  set value(value) { this._value = String(value); }
  get type() { return this.getAttribute('type') ?? 'text'; }
  set type(value) { this.setAttribute('type', value); }
  get checked() { return this.hasAttribute('checked'); }
  set checked(value) { this.toggleAttribute('checked', !!value); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { this.toggleAttribute('disabled', !!value); }
}
export class HTMLTextAreaElement extends HTMLInputElement {}

const reflectSize = (name, fallback) => ({
  get() { const value = Number.parseInt(this.getAttribute(name), 10); return Number.isInteger(value) && value >= 0 ? value : fallback; },
  set(value) { this.setAttribute(name, String(value >>> 0)); this[CONTEXT_2D]?.[RESIZE](); },
  configurable: true,
  enumerable: true,
});
export class HTMLCanvasElement extends HTMLElement {
  getContext(type) {
    if (type === '2d') return this[CONTEXT_2D] ??= new CanvasRenderingContext2D(this, this.ownerDocument?.fonts);
    logOnce(`DOM stand-in: HTMLCanvasElement.getContext('${type}') is not implemented and returns null`);
    return null;
  }
  get [Symbol.for('threejsc.pixels')]() { return this[CONTEXT_2D]?.[Symbol.for('threejsc.pixels')]; }
}
Object.defineProperties(HTMLCanvasElement.prototype, { width: reflectSize('width', 300), height: reflectSize('height', 150) });

// Element classes by tag name. images.js adds the image element.
export const ELEMENT_CLASSES = new Map([
  ['canvas', HTMLCanvasElement],
  ['input', HTMLInputElement],
  ['textarea', HTMLTextAreaElement],
]);

export class Document extends Node {
  constructor(window) {
    super(null);
    this.ownerDocument = null;
    this.defaultView = window;
    this.readyState = 'complete';
    this.fonts = new FontFaceSet();
    this.visibilityState = 'visible';
    this.hidden = false;
    this.characterSet = 'UTF-8';
    this.compatMode = 'CSS1Compat';
    this.contentType = 'text/html';
    this.cookie = '';
    this.referrer = '';
    this.title = '';
    this.currentScript = null;
    this.focused = true;
    const html = this.createElement('html');
    html.append(this.createElement('head'), this.createElement('body'));
    this.appendChild(html);
    this.activeNode = null;
  }
  get nodeType() { return 9; }
  get nodeName() { return '#document'; }
  get documentElement() { return this.firstElementChild; }
  get head() { return this.documentElement?.children.find(child => child.localName === 'head') ?? null; }
  get body() { return this.documentElement?.children.find(child => child.localName === 'body') ?? null; }
  get activeElement() { return this.activeNode?.isConnected ? this.activeNode : this.body; }
  hasFocus() { return this.focused; }
  get URL() { return globalThis.location?.href ?? 'about:blank'; }
  get documentURI() { return this.URL; }
  get location() { return globalThis.location; }
  createElement(name) {
    const localName = String(name).toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(localName)) throw platformError(`Failed to execute 'createElement' on 'Document': The tag name provided ('${name}') is not a valid name.`, 'InvalidCharacterError');
    const Class = ELEMENT_CLASSES.get(localName) ?? HTMLElement;
    return new Class(this, localName, HTML_NAMESPACE, null, localName);
  }
  createElementNS(namespace, qualifiedName) {
    if (arguments.length < 2) throw new TypeError("Failed to execute 'createElementNS' on 'Document': 2 arguments required, but only 1 present.");
    namespace = namespace === null || namespace === undefined || namespace === '' ? null : String(namespace);
    qualifiedName = String(qualifiedName);
    const colon = qualifiedName.indexOf(':');
    const prefix = colon < 0 ? null : qualifiedName.slice(0, colon);
    const localName = colon < 0 ? qualifiedName : qualifiedName.slice(colon + 1);
    if (prefix !== null && namespace === null) throw platformError("Failed to execute 'createElementNS' on 'Document': The namespace is invalid.", 'NamespaceError');
    const Class = namespace === SVG_NAMESPACE ? svgClass(localName)
      : namespace === HTML_NAMESPACE ? (ELEMENT_CLASSES.get(localName.toLowerCase()) ?? HTMLElement)
      : Element;
    return new Class(this, localName, namespace, prefix, qualifiedName);
  }
  createTextNode(data) { return new Text(this, data); }
  createDocumentFragment() { return new DocumentFragment(this); }
  createEvent(type) { return new Event('', {}); }
  getElementById(id) {
    id = String(id);
    for (const element of descendants(this)) if (element.id === id) return element;
    return null;
  }
  querySelector(selector) { return Element.prototype.querySelector.call(this, selector); }
  querySelectorAll(selector) { return Element.prototype.querySelectorAll.call(this, selector); }
  getElementsByClassName(names) { return Element.prototype.getElementsByClassName.call(this, names); }
  getElementsByTagName(name) { return Element.prototype.getElementsByTagName.call(this, name); }
  // Moves focus as HTML's focus update steps do: blur and focusout at the old element, then focus and focusin at the
  // new one. Focus on the body is no element's focus, so it fires nothing.
  setFocus(element) {
    const old = this.activeElement;
    const next = element ?? this.body;
    if (old === next) return;
    this.activeNode = element;
    if (old && old !== this.body) {
      old.dispatchEvent(trusted(new FocusEvent('blur', { view: this.defaultView, relatedTarget: null, composed: true })));
      old.dispatchEvent(trusted(new FocusEvent('focusout', { bubbles: true, view: this.defaultView, relatedTarget: null, composed: true })));
    }
    if (next && next !== this.body) {
      next.dispatchEvent(trusted(new FocusEvent('focus', { view: this.defaultView, relatedTarget: null, composed: true })));
      next.dispatchEvent(trusted(new FocusEvent('focusin', { bubbles: true, view: this.defaultView, relatedTarget: null, composed: true })));
    }
  }
}
defineHandlers(Document.prototype, EVENT_HANDLERS.document);

// Lookups that miss every class in an element's or the document's prototype chain end here. A name Edge defines as
// a DOM method returns a stub that logs the method once and returns undefined, so a game that calls one keeps
// running. Any other name reads as undefined, as it does in Edge.
const missing = new Proxy(Object.create(Object.prototype), {
  get(target, key, receiver) {
    if (key in target || typeof key !== 'string' || !DOM_METHODS.has(key)) return Reflect.get(target, key, receiver);
    const owner = receiver?.constructor?.name ?? 'Element';
    return function () { logOnce(`DOM method not implemented: ${owner}.${key}`); };
  },
  has(target, key) { return key in target || (typeof key === 'string' && DOM_METHODS.has(key)); },
});
Object.setPrototypeOf(EventTarget.prototype, missing);
