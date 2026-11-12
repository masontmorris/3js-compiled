// DOM events as Edge dispatches them: Event and its input subclasses, EventTarget with capture, target and bubble
// phases, and event handler attributes. Listener state lives under symbols, so the window, which no constructor
// makes, can be an EventTarget too.
const LISTENERS = Symbol('listeners');
// A mouse event's exact pointer position, from which its offset is rounded.
const EXACT = Symbol('exact position');
const STATE = Symbol('event state');

export class Event {
  static NONE = 0;
  static CAPTURING_PHASE = 1;
  static AT_TARGET = 2;
  static BUBBLING_PHASE = 3;

  constructor(type, { bubbles = false, cancelable = false, composed = false } = {}) {
    if (arguments.length === 0) throw new TypeError("Failed to construct 'Event': 1 argument required, but only 0 present.");
    this[STATE] = { type: String(type), bubbles: !!bubbles, cancelable: !!cancelable, composed: !!composed, phase: 0, target: null, current: null, canceled: false, stopped: false, stoppedNow: false, passive: false, trusted: false, path: [], timeStamp: globalThis.performance?.now() ?? 0 };
  }
  get type() { return this[STATE].type; }
  get bubbles() { return this[STATE].bubbles; }
  get cancelable() { return this[STATE].cancelable; }
  get composed() { return this[STATE].composed; }
  get eventPhase() { return this[STATE].phase; }
  get target() { return this[STATE].target; }
  get srcElement() { return this[STATE].target; }
  get currentTarget() { return this[STATE].current; }
  get defaultPrevented() { return this[STATE].canceled; }
  get returnValue() { return !this[STATE].canceled; }
  set returnValue(value) { if (!value) this.preventDefault(); }
  get cancelBubble() { return this[STATE].stopped; }
  set cancelBubble(value) { if (value) this[STATE].stopped = true; }
  get isTrusted() { return this[STATE].trusted; }
  get timeStamp() { return this[STATE].timeStamp; }
  composedPath() { return this[STATE].phase ? [...this[STATE].path] : []; }
  preventDefault() { if (this[STATE].cancelable && !this[STATE].passive) this[STATE].canceled = true; }
  stopPropagation() { this[STATE].stopped = true; }
  stopImmediatePropagation() { this[STATE].stopped = this[STATE].stoppedNow = true; }
  get [Symbol.toStringTag]() { return 'Event'; }
}
for (const [name, value] of Object.entries({ NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 })) Object.defineProperty(Event.prototype, name, { value });

// Copies the dictionary members an event interface defines onto the event, with their defaults.
function assign(event, init, defaults) {
  for (const [key, fallback] of Object.entries(defaults)) event[key] = init[key] ?? fallback;
}

export class CustomEvent extends Event {
  constructor(type, init = {}) { super(type, init); this.detail = init.detail ?? null; }
}
export class ErrorEvent extends Event {
  constructor(type, init = {}) { super(type, init); assign(this, init, { message: '', filename: '', lineno: 0, colno: 0, error: null }); }
}
export class UIEvent extends Event {
  constructor(type, init = {}) { super(type, init); assign(this, init, { view: null, detail: 0, which: 0 }); }
}
export class FocusEvent extends UIEvent {
  constructor(type, init = {}) { super(type, init); this.relatedTarget = init.relatedTarget ?? null; }
}
const MODIFIERS = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
export class KeyboardEvent extends UIEvent {
  static DOM_KEY_LOCATION_STANDARD = 0;
  static DOM_KEY_LOCATION_LEFT = 1;
  static DOM_KEY_LOCATION_RIGHT = 2;
  static DOM_KEY_LOCATION_NUMPAD = 3;
  constructor(type, init = {}) {
    super(type, init);
    assign(this, init, { key: '', code: '', location: 0, repeat: false, isComposing: false, charCode: 0, keyCode: 0, ...MODIFIERS });
  }
  getModifierState(key) { return { Control: this.ctrlKey, Shift: this.shiftKey, Alt: this.altKey, Meta: this.metaKey }[key] ?? false; }
}
export class MouseEvent extends UIEvent {
  constructor(type, init = {}) {
    super(type, init);
    assign(this, init, { screenX: 0, screenY: 0, clientX: 0, clientY: 0, button: 0, buttons: 0, relatedTarget: null, movementX: 0, movementY: 0, ...MODIFIERS });
    if (init[EXACT]) this[EXACT] = init[EXACT];
  }
  get pageX() { return this.clientX; }
  get pageY() { return this.clientY; }
  get x() { return this.clientX; }
  get y() { return this.clientY; }
  // Edge gives a mouse event whole-pixel client coordinates but rounds its offset from the pointer's exact position.
  get offsetX() { return Math.round((this[EXACT]?.[0] ?? this.clientX) - (this.target?.getBoundingClientRect?.().left ?? 0)); }
  get offsetY() { return Math.round((this[EXACT]?.[1] ?? this.clientY) - (this.target?.getBoundingClientRect?.().top ?? 0)); }
  get layerX() { return this.offsetX; }
  get layerY() { return this.offsetY; }
  getModifierState(key) { return KeyboardEvent.prototype.getModifierState.call(this, key); }
}
export class PointerEvent extends MouseEvent {
  get offsetX() { return this.clientX - (this.target?.getBoundingClientRect?.().left ?? 0); }
  get offsetY() { return this.clientY - (this.target?.getBoundingClientRect?.().top ?? 0); }
  constructor(type, init = {}) {
    super(type, init);
    assign(this, init, { pointerId: 0, width: 1, height: 1, pressure: 0, tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0, altitudeAngle: Math.PI / 2, azimuthAngle: 0, pointerType: '', isPrimary: false });
  }
  getCoalescedEvents() { return this.type === 'pointermove' && this.isTrusted ? [this] : []; }
  getPredictedEvents() { return []; }
}
export class WheelEvent extends MouseEvent {
  static DOM_DELTA_PIXEL = 0;
  static DOM_DELTA_LINE = 1;
  static DOM_DELTA_PAGE = 2;
  constructor(type, init = {}) { super(type, init); assign(this, init, { deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 0 }); }
}

// Marks an event the host made from real or scripted input, as a browser does for user agent events.
export function trusted(event) {
  event[STATE].trusted = true;
  return event;
}

function listeners(target, type) {
  const map = target[LISTENERS] ??= new Map();
  if (!map.has(type)) map.set(type, []);
  return map.get(type);
}
function flatten(options) {
  return typeof options === 'object' && options !== null
    ? { capture: !!options.capture, once: !!options.once, passive: options.passive, signal: options.signal }
    : { capture: !!options };
}
// Edge makes wheel and touch listeners on the window, the document, the root element and the body passive unless
// they say otherwise, so such an event is not cancelable when only they listen.
const PASSIVE_TYPES = new Set(['wheel', 'mousewheel', 'touchstart', 'touchmove']);
const passiveByDefault = (target, type) => PASSIVE_TYPES.has(type) && (target?.document?.defaultView === target || target?.nodeType === 9 || target?.localName === 'html' || target?.localName === 'body');
export function addEventListener(type, callback, options) {
  if (callback == null) return;
  const { capture, once, passive, signal } = flatten(options);
  if (signal?.aborted) return;
  type = String(type);
  const list = listeners(this, type);
  if (list.some(entry => entry.callback === callback && entry.capture === capture)) return;
  const entry = { callback, capture, once, passive: passive === undefined ? passiveByDefault(this, type) : !!passive, removed: false };
  list.push(entry);
  signal?.addEventListener?.('abort', () => removeEventListener.call(this, type, callback, { capture }));
}
export function removeEventListener(type, callback, options) {
  const list = this[LISTENERS]?.get(String(type));
  if (!list) return;
  const capture = flatten(options).capture;
  const index = list.findIndex(entry => entry.callback === callback && entry.capture === capture && !entry.handler);
  if (index >= 0) list.splice(index, 1)[0].removed = true;
}
// Whether `node` has a listener for `type`, or a listener that is not passive when `active` is set.
export function hasListener(node, type, active = false) {
  return !!node?.[LISTENERS]?.get(type)?.some(entry => !entry.removed && (!active || !entry.passive));
}
export function dispatchEvent(event) {
  if (!(event instanceof Event)) throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
  if (event[STATE].phase) throw new DOMException("Failed to execute 'dispatchEvent' on 'EventTarget': The event is already being dispatched.", 'InvalidStateError');
  return dispatch(this, event);
}

// The event's path from its target up through its ancestors to the document and the window.
function path(target) {
  const nodes = [];
  for (let node = target; node; node = node.parentNode ?? (node.nodeType === 9 ? node.defaultView : null)) nodes.push(node);
  return nodes;
}
function invoke(node, event, phase) {
  const state = event[STATE];
  const list = node[LISTENERS]?.get(state.type);
  if (!list?.length) return;
  state.current = node;
  for (const entry of [...list]) {
    if (entry.removed) continue;
    if (phase === Event.CAPTURING_PHASE && !entry.capture) continue;
    if (phase === Event.BUBBLING_PHASE && entry.capture) continue;
    if (entry.once) removeEventListener.call(node, state.type, entry.callback, { capture: entry.capture });
    state.passive = !!entry.passive;
    try {
      if (typeof entry.callback === 'function') entry.callback.call(node, event);
      else entry.callback.handleEvent(event);
    } catch (error) {
      globalThis.reportError?.(error);
    }
    if (depth === 1 && hostDispatch) checkpoint?.();
    state.passive = false;
    if (state.stoppedNow) break;
  }
}
// The microtask checkpoint HTML performs after each listener the user agent calls, which the platform sets.
let checkpoint = null;
export function setCheckpoint(callback) { checkpoint = callback; }
// How deep dispatches nest, and whether the outermost one is the user agent's rather than a script's.
let depth = 0;
let hostDispatch = false;
let host = false;
// Runs `callback` as the user agent: each listener a dispatch it starts calls is followed by a checkpoint, while a
// dispatch a listener starts from script is not.
export function asHost(callback) {
  const saved = host;
  host = true;
  try { return callback(); } finally { host = saved; }
}
function dispatch(target, event) {
  if (depth === 0) hostDispatch = host;
  depth++;
  try { return dispatchAt(target, event); } finally { depth--; }
}
function dispatchAt(target, event) {
  const state = event[STATE];
  state.target = target;
  state.path = path(target);
  for (let i = state.path.length - 1; i > 0 && !state.stopped; i--) {
    state.phase = Event.CAPTURING_PHASE;
    invoke(state.path[i], event, Event.CAPTURING_PHASE);
  }
  if (!state.stopped) {
    state.phase = Event.AT_TARGET;
    invoke(target, event, Event.CAPTURING_PHASE);
    if (!state.stopped) invoke(target, event, Event.BUBBLING_PHASE);
  }
  for (let i = 1; i < state.path.length && state.bubbles && !state.stopped; i++) {
    state.phase = Event.BUBBLING_PHASE;
    invoke(state.path[i], event, Event.BUBBLING_PHASE);
  }
  state.phase = 0;
  state.current = null;
  state.stopped = state.stoppedNow = false;
  return !state.canceled;
}

export class EventTarget {
  addEventListener(type, callback, options) { addEventListener.call(this, type, callback, options); }
  removeEventListener(type, callback, options) { removeEventListener.call(this, type, callback, options); }
  dispatchEvent(event) { return dispatchEvent.call(this, event); }
}

// Event handler attributes such as `onclick`. A handler takes its place among the listeners when it is first set
// and keeps it while it is replaced, as in HTML.
export function defineHandlers(target, types) {
  for (const type of types) {
    const key = Symbol(`on${type}`);
    Object.defineProperty(target, `on${type}`, {
      configurable: true,
      enumerable: true,
      get() { return this[key]?.handler ?? null; },
      set(value) {
        const handler = typeof value === 'function' || (typeof value === 'object' && value !== null) ? value : null;
        if (!this[key]) {
          if (!handler) return;
          const entry = { capture: false, once: false, passive: false, removed: false, handler };
          entry.callback = function (event) {
            const result = typeof entry.handler === 'function' ? entry.handler.call(this, event) : undefined;
            if (result === false) event.preventDefault();
          };
          this[key] = entry;
          listeners(this, type).push(entry);
        } else if (!handler) {
          const list = listeners(this, type);
          const index = list.indexOf(this[key]);
          if (index >= 0) list.splice(index, 1)[0].removed = true;
          this[key] = undefined;
        } else {
          this[key].handler = handler;
        }
      },
    });
  }
}

export const HANDLER_TYPES = [
  'abort', 'auxclick', 'blur', 'click', 'contextmenu', 'dblclick', 'focus', 'gotpointercapture', 'input', 'keydown',
  'keypress', 'keyup', 'load', 'lostpointercapture', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove', 'mouseout',
  'mouseover', 'mouseup', 'pointercancel', 'pointerdown', 'pointerenter', 'pointerleave', 'pointermove', 'pointerout',
  'pointerover', 'pointerup', 'resize', 'scroll', 'wheel',
];

// The document's input router, which elements reach for pointer capture.
export const INPUT = Symbol('input');

// Windows virtual-key codes that Edge reports as keyCode on a US layout, by code.
const KEY_CODES = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17,
  AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 44, Insert: 45, Delete: 46, MetaLeft: 91,
  MetaRight: 92, ContextMenu: 93, NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110,
  NumpadDivide: 111, NumLock: 144, ScrollLock: 145, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190,
  Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222, IntlBackslash: 226,
  NumpadEqual: 187, NumpadComma: 194, AudioVolumeMute: 173, AudioVolumeDown: 174, AudioVolumeUp: 175,
  MediaTrackNext: 176, MediaTrackPrevious: 177, MediaStop: 178, MediaPlayPause: 179,
};
export function keyCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit\d$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad\d$/.test(code)) return 96 + Number(code[6]);
  if (/^F\d+$/.test(code)) return 111 + Number(code.slice(1));
  return KEY_CODES[code] ?? 0;
}
function keyLocation(code) {
  if (/^(Shift|Control|Alt|Meta)Left$/.test(code)) return 1;
  if (/^(Shift|Control|Alt|Meta)Right$/.test(code)) return 2;
  return code.startsWith('Numpad') ? 3 : 0;
}
// The bit a button sets in MouseEvent.buttons: primary, auxiliary, secondary, back, forward.
const BUTTON_BITS = [1, 4, 2, 8, 16];
const POINTER = { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
const ancestors = node => { const list = []; for (; node; node = node.parentNode) list.push(node); return list; };

// Turns the host's input facts into the DOM events Edge fires for them, in Edge's order. A key goes to the focused
// element. Pointer and wheel events go to the element under the pointer, which is the last canvas in the document,
// since the canvas fills the window, or else the body, unless an element has captured the pointer.
export class InputRouter {
  constructor(window, document) {
    this.window = window;
    this.document = document;
    this.x = 0;
    this.y = 0;
    this.buttons = 0;
    this.hover = null;
    this.captureTarget = null;
    this.pendingCapture = null;
    this.suppressMouse = false;
    this.pressed = new Map();
    document[INPUT] = this;
  }
  hit() {
    return this.document.querySelectorAll('canvas').at(-1) ?? this.document.body ?? this.document.documentElement;
  }
  modifiers(fact) {
    return { ctrlKey: !!fact.ctrl, shiftKey: !!fact.shift, altKey: !!fact.alt, metaKey: !!fact.meta };
  }
  key(fact) {
    fact = { key: 'Unidentified', code: '', ...fact };
    const target = this.document.activeElement ?? this.window;
    const code = keyCode(fact.code);
    const init = {
      bubbles: true, cancelable: true, composed: true, view: this.window, key: fact.key, code: fact.code,
      location: keyLocation(fact.code), repeat: !!fact.repeat, keyCode: code, which: code, ...this.modifiers(fact),
    };
    const proceed = target.dispatchEvent(trusted(new KeyboardEvent(fact.type, init)));
    const printable = [...fact.key].length === 1 || fact.key === 'Enter';
    if (fact.type === 'keydown' && proceed && printable && !fact.ctrl && !fact.meta) {
      const charCode = fact.key === 'Enter' ? 13 : fact.key.codePointAt(0);
      // A keydown listener that moves focus sends the keypress to the newly focused element, as in Edge.
      const focused = this.document.activeElement ?? this.window;
      focused.dispatchEvent(trusted(new KeyboardEvent('keypress', { ...init, keyCode: charCode, which: charCode, charCode })));
    }
  }
  capture(element, pointerId) {
    if (pointerId !== POINTER.pointerId) throw new DOMException("Failed to execute 'setPointerCapture' on 'Element': No active pointer with the given id is found.", 'NotFoundError');
    if (this.buttons) this.pendingCapture = element;
  }
  release(element, pointerId) {
    if (pointerId !== POINTER.pointerId) throw new DOMException("Failed to execute 'releasePointerCapture' on 'Element': No active pointer with the given id is found.", 'NotFoundError');
    if (this.pendingCapture === element) this.pendingCapture = null;
  }
  captured(pointerId) { return pointerId === POINTER.pointerId ? this.pendingCapture : null; }
  removed(node) {
    if (this.pendingCapture && node.contains(this.pendingCapture)) this.pendingCapture = null;
  }
  pointerInit(fields, modifiers) {
    return {
      bubbles: true, cancelable: true, composed: true, view: this.window, clientX: this.x, clientY: this.y,
      screenX: this.x, screenY: this.y, buttons: this.buttons, detail: 0, ...modifiers, ...POINTER,
      pressure: this.buttons ? 0.5 : 0, ...fields,
    };
  }
  fire(target, Class, type, init) {
    return target.dispatchEvent(trusted(new Class(type, init)));
  }
  // Fires lostpointercapture and gotpointercapture when capture changed since the last pointer event.
  processCapture() {
    if (this.pendingCapture === this.captureTarget) return;
    const old = this.captureTarget;
    this.captureTarget = this.pendingCapture;
    const init = { ...this.pointerInit({ button: -1 }, {}), cancelable: false };
    if (old) this.fire(old.isConnected ? old : this.document, PointerEvent, 'lostpointercapture', init);
    if (this.captureTarget) this.fire(this.captureTarget, PointerEvent, 'gotpointercapture', init);
  }
  // A compatibility mouse event's init from its pointer event's. Edge gives mouse events whole-pixel coordinates.
  mouseInit(init, fields) {
    const mouse = { ...init, clientX: Math.floor(init.clientX), clientY: Math.floor(init.clientY), screenX: Math.floor(init.screenX), screenY: Math.floor(init.screenY), [EXACT]: [init.clientX, init.clientY], ...fields };
    for (const key of Object.keys(POINTER)) delete mouse[key];
    delete mouse.pressure;
    return mouse;
  }
  // Fires the boundary events for a pointer that moves onto `target` from the element it was over.
  enter(target, modifiers) {
    const old = this.hover;
    this.hover = target;
    const pointer = this.pointerInit({ button: -1, relatedTarget: old }, modifiers);
    const mouse = this.mouseInit(pointer, { button: 0 });
    const leaving = ancestors(old).filter(node => !ancestors(target).includes(node) && node.nodeType === 1);
    const entering = ancestors(target).filter(node => !ancestors(old).includes(node) && node.nodeType === 1).reverse();
    // Edge fires enter and leave events only at the elements that listen for them.
    const boundary = (nodes, Class, type, init) => {
      for (const node of nodes) if (hasListener(node, type)) this.fire(node, Class, type, { ...init, bubbles: false, cancelable: false });
    };
    if (old) {
      this.fire(old, PointerEvent, 'pointerout', { ...pointer, relatedTarget: target });
      boundary(leaving, PointerEvent, 'pointerleave', { ...pointer, relatedTarget: target });
      this.fire(old, MouseEvent, 'mouseout', { ...mouse, relatedTarget: target });
      boundary(leaving, MouseEvent, 'mouseleave', { ...mouse, relatedTarget: target });
    }
    if (target) {
      this.fire(target, PointerEvent, 'pointerover', pointer);
      boundary(entering, PointerEvent, 'pointerenter', pointer);
      this.fire(target, MouseEvent, 'mouseover', mouse);
      boundary(entering, MouseEvent, 'mouseenter', mouse);
    }
  }
  pointer(fact) {
    const modifiers = this.modifiers(fact);
    // Edge's movement is whole pixels between moves, and zero on a press or release.
    const moving = fact.type === 'pointermove' && this.hover;
    const movementX = moving ? Math.floor(fact.clientX) - Math.floor(this.x) : 0;
    const movementY = moving ? Math.floor(fact.clientY) - Math.floor(this.y) : 0;
    this.x = fact.clientX;
    this.y = fact.clientY;
    const hit = this.hit();
    if (!this.captureTarget && this.hover !== hit) this.enter(hit, modifiers);
    const bit = BUTTON_BITS[fact.button] ?? 0;
    if (fact.type === 'pointerdown' && (this.buttons & bit)) return;
    if (fact.type === 'pointerup' && !(this.buttons & bit)) return;
    const first = fact.type === 'pointerdown' && this.buttons === 0;
    if (fact.type === 'pointerdown') this.buttons |= bit;
    if (fact.type === 'pointerup') this.buttons &= ~bit;
    const last = fact.type === 'pointerup' && this.buttons === 0;
    const button = fact.type === 'pointermove' ? -1 : fact.button;
    this.processCapture();
    const target = this.captureTarget ?? hit;
    const detail = fact.type === 'pointermove' ? 0 : fact.clicks ?? 1;
    const init = this.pointerInit({ button, movementX, movementY }, modifiers);
    const proceed = this.fire(target, PointerEvent, first ? 'pointerdown' : last ? 'pointerup' : 'pointermove', init);
    if (first && !proceed) this.suppressMouse = true;
    // Pressing another button between this button's press and release cancels its click, and its mouseup then
    // counts no click, as in Edge.
    const clicked = fact.type !== 'pointerup' || this.lastPressed === fact.button;
    if (fact.type === 'pointerdown') this.lastPressed = fact.button;
    const mouse = this.mouseInit(init, { button: Math.max(button, 0), detail: clicked ? detail : 0 });
    const mouseType = { pointermove: 'mousemove', pointerdown: 'mousedown', pointerup: 'mouseup' }[fact.type];
    const mouseProceed = this.suppressMouse || this.fire(target, MouseEvent, mouseType, mouse);
    if (fact.type === 'pointerdown') {
      this.pressed.set(fact.button, target);
      if (mouseProceed) {
        let focus = target;
        while (focus?.nodeType === 1 && !focus.hasAttribute('tabindex') && focus.tabIndex < 0) focus = focus.parentElement;
        if (focus?.nodeType === 1) focus.focus(); else this.document.setFocus(null);
      }
    }
    if (fact.type === 'pointerup') {
      const downTarget = this.pressed.get(fact.button);
      this.pressed.delete(fact.button);
      const common = downTarget?.contains?.(target) ? downTarget : target.contains?.(downTarget) ? target : null;
      if (common && clicked) {
        const click = { ...init, button: fact.button, detail, pressure: 0, isPrimary: false, movementX: 0, movementY: 0 };
        this.fire(common, PointerEvent, fact.button === 0 ? 'click' : 'auxclick', click);
        if (fact.button === 0 && detail === 2) this.fire(common, MouseEvent, 'dblclick', mouse);
      }
      if (fact.button === 2) this.fire(target, PointerEvent, 'contextmenu', { ...init, button: 2, detail: 0, pressure: 0, isPrimary: false, movementX: 0, movementY: 0 });
      if (last) {
        this.lastPressed = undefined;
        this.suppressMouse = false;
        this.pendingCapture = null;
        this.processCapture();
      }
    }
  }
  leave() {
    if (this.hover && !this.buttons) this.enter(null, {});
  }
  wheel(fact) {
    if (fact.clientX !== undefined) {
      this.x = fact.clientX;
      this.y = fact.clientY;
    }
    const init = this.pointerInit({ button: 0, deltaX: fact.deltaX ?? 0, deltaY: fact.deltaY ?? 0, deltaZ: 0, deltaMode: 0 }, this.modifiers(fact));
    for (const key of Object.keys(POINTER)) delete init[key];
    delete init.pressure;
    const target = this.hit();
    init.cancelable = ancestors(target).concat(this.window).some(node => hasListener(node, 'wheel', true));
    this.fire(target, WheelEvent, 'wheel', init);
  }
  focus(fact) {
    const document = this.document;
    if (document.focused === !!fact.focused) return;
    document.focused = !!fact.focused;
    const element = document.activeElement !== document.body ? document.activeElement : null;
    const init = { view: this.window, relatedTarget: null, composed: true };
    if (!fact.focused) {
      if (element) {
        this.fire(element, FocusEvent, 'blur', init);
        this.fire(element, FocusEvent, 'focusout', { ...init, bubbles: true });
      }
      this.fire(this.window, FocusEvent, 'blur', init);
    } else {
      this.fire(this.window, FocusEvent, 'focus', init);
      if (element) {
        this.fire(element, FocusEvent, 'focus', init);
        this.fire(element, FocusEvent, 'focusin', { ...init, bubbles: true });
      }
    }
  }
}

// Every input fact is the user agent's dispatch, so its listeners each end with a promise job checkpoint.
for (const name of ['key', 'pointer', 'leave', 'wheel', 'focus']) {
  const handle = InputRouter.prototype[name];
  InputRouter.prototype[name] = function (...args) { return asHost(() => handle.apply(this, args)); };
}

// Legacy wheel deltas. Edge gives an input wheel event one tick of 120 against each axis it scrolls, and a
// constructed one its pixel deltas.
const legacy = (event, delta) => (event.isTrusted ? -Math.sign(delta) * 120 : delta) || 0;
Object.defineProperties(WheelEvent.prototype, {
  wheelDeltaX: { get() { return legacy(this, this.deltaX); }, configurable: true },
  wheelDeltaY: { get() { return legacy(this, this.deltaY); }, configurable: true },
  wheelDelta: { get() { return legacy(this, this.deltaY || this.deltaX); }, configurable: true },
});
