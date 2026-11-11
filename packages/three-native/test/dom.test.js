import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, setLog } from '../src/platform/dom.js';
import { Event, EventTarget, InputRouter, keyCode, addEventListener, dispatchEvent } from '../src/platform/events.js';

function page() {
  const window = { addEventListener, dispatchEvent, innerWidth: 1280, innerHeight: 720 };
  const document = new Document(window);
  window.document = document;
  return { window, document };
}

test('querySelector matches type, id, class, attribute and combinators in document order', () => {
  const { document } = page();
  const game = document.createElement('div');
  game.className = 'game is-started';
  const canvas = document.createElement('canvas');
  canvas.classList.add('js-canvas');
  canvas.dataset.quality = 'high';
  const menu = document.createElement('section');
  menu.id = 'menu';
  const input = document.createElement('input');
  input.setAttribute('type', 'text');
  menu.append(input);
  game.append(canvas, menu);
  document.body.append(game);

  assert.equal(document.querySelector('.game'), game);
  assert.equal(document.querySelector('.game .js-canvas'), canvas);
  assert.equal(document.querySelector('div > canvas.js-canvas[data-quality="high"]'), canvas);
  assert.equal(document.querySelector('#menu input[type=text]'), input);
  assert.equal(document.querySelector('canvas + section'), menu);
  assert.equal(document.querySelector('canvas ~ #menu'), menu);
  assert.equal(document.querySelector('.missing'), null);
  assert.deepEqual(document.querySelectorAll('canvas, input'), [canvas, input]);
  assert.equal(input.matches('input, textarea, [contenteditable]'), true);
  assert.equal(canvas.matches('input, textarea, [contenteditable]'), false);
  assert.equal(input.closest('.game'), game);
  assert.equal(document.querySelector('div:not(.menu) canvas'), canvas);
  assert.equal(document.getElementById('menu'), menu);
  assert.throws(() => document.querySelector('div >'), { name: 'SyntaxError' });
});

test('classList edits the class attribute and keeps Edge errors', () => {
  const { document } = page();
  const html = document.documentElement;
  html.classList.add('is-mode-mouse', 'is-gamepad-xbox');
  html.classList.remove('is-mode-mouse');
  assert.equal(html.classList.toggle('input-filter-menu'), true);
  assert.equal(html.classList.toggle('input-filter-menu'), false);
  assert.equal(html.classList.toggle('is-audio-muted', true), true);
  assert.equal(html.classList.replace('is-gamepad-xbox', 'is-gamepad-playstation'), true);
  assert.equal(html.className, 'is-gamepad-playstation is-audio-muted');
  assert.equal(html.classList.length, 2);
  assert.deepEqual([...html.classList], ['is-gamepad-playstation', 'is-audio-muted']);
  assert.throws(() => html.classList.add(''), { name: 'SyntaxError' });
  assert.throws(() => html.classList.add('a b'), { name: 'InvalidCharacterError' });
});

test('style and dataset reflect their declarations and attributes', () => {
  const { document } = page();
  const element = document.createElement('div');
  element.style.backgroundColor = 'red';
  element.style.setProperty('--progress', '0.5');
  element.style.setProperty('margin-top', '4px');
  assert.equal(element.style.getPropertyValue('background-color'), 'red');
  assert.equal(element.style.marginTop, '4px');
  assert.equal(element.style.cssText, 'background-color: red; --progress: 0.5; margin-top: 4px;');
  element.dataset.achievementId = 'driver';
  assert.equal(element.getAttribute('data-achievement-id'), 'driver');
  assert.deepEqual(Object.keys(element.dataset), ['achievementId']);
  delete element.dataset.achievementId;
  assert.equal(element.hasAttribute('data-achievement-id'), false);
});

test('listeners run in capture, target and bubble order, each in the order it was added', () => {
  const { window, document } = page();
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const order = [];
  const log = name => event => order.push(`${name}:${event.eventPhase}`);
  window.addEventListener('click', log('window-capture'), true);
  window.addEventListener('click', log('window'));
  document.addEventListener('click', log('document-capture'), { capture: true });
  document.body.addEventListener('click', log('body'));
  canvas.addEventListener('click', log('canvas-bubble'));
  canvas.addEventListener('click', log('canvas-capture'), true);
  canvas.onclick = log('canvas-handler');
  canvas.addEventListener('click', log('canvas-once'), { once: true });
  canvas.dispatchEvent(new Event('click', { bubbles: true }));
  assert.deepEqual(order, ['window-capture:1', 'document-capture:1', 'canvas-capture:2', 'canvas-bubble:2', 'canvas-handler:2', 'canvas-once:2', 'body:3', 'window:3']);
  order.length = 0;
  canvas.dispatchEvent(new Event('click'));
  assert.deepEqual(order, ['window-capture:1', 'document-capture:1', 'canvas-capture:2', 'canvas-bubble:2', 'canvas-handler:2']);
});

test('stopImmediatePropagation, a duplicate listener, removal during dispatch and preventDefault', () => {
  const target = new EventTarget();
  const order = [];
  const first = () => order.push('first');
  const second = () => { order.push('second'); target.removeEventListener('x', third); };
  const third = () => order.push('third');
  target.addEventListener('x', first);
  target.addEventListener('x', first);
  target.addEventListener('x', second);
  target.addEventListener('x', third);
  target.dispatchEvent(new Event('x'));
  assert.deepEqual(order, ['first', 'second']);
  const stopper = new EventTarget();
  stopper.addEventListener('y', event => { event.stopImmediatePropagation(); event.preventDefault(); });
  stopper.addEventListener('y', () => assert.fail('a stopped event reached the next listener'));
  assert.equal(stopper.dispatchEvent(new Event('y', { cancelable: true })), false);
  const passive = new EventTarget();
  passive.addEventListener('wheel', event => event.preventDefault(), { passive: true });
  assert.equal(passive.dispatchEvent(new Event('wheel', { cancelable: true })), true);
});

test('a missing DOM method logs once and returns undefined, and other missing names stay undefined', () => {
  const messages = [];
  setLog(message => messages.push(message));
  const { document } = page();
  const canvas = document.createElement('canvas');
  assert.equal(canvas.requestFullscreen(), undefined);
  assert.equal(canvas.requestFullscreen(), undefined);
  assert.equal('requestPointerLock' in canvas, true);
  assert.equal(canvas.notAMethod, undefined);
  assert.equal(canvas.then, undefined);
  canvas.width = 640;
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 150);
  assert.deepEqual(messages, ['DOM method not implemented: HTMLCanvasElement.requestFullscreen']);
});

test('focus moves the active element with blur, focusout, focus and focusin', () => {
  const { document } = page();
  const order = [];
  const a = document.createElement('input');
  const b = document.createElement('div');
  b.tabIndex = 0;
  document.body.append(a, b);
  for (const type of ['focus', 'blur', 'focusin', 'focusout']) {
    a.addEventListener(type, () => order.push(`a:${type}`));
    b.addEventListener(type, () => order.push(`b:${type}`));
  }
  assert.equal(document.activeElement, document.body);
  a.focus();
  b.focus();
  b.blur();
  assert.deepEqual(order, ['a:focus', 'a:focusin', 'a:blur', 'a:focusout', 'b:focus', 'b:focusin', 'b:blur', 'b:focusout']);
  assert.equal(document.activeElement, document.body);
  const plain = document.createElement('div');
  document.body.append(plain);
  plain.focus();
  assert.equal(document.activeElement, document.body);
});

test('the router turns a click into pointer, mouse and click events on the canvas', () => {
  const { window, document } = page();
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const router = new InputRouter(window, document);
  const order = [];
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'contextmenu', 'auxclick', 'gotpointercapture', 'lostpointercapture']) {
    canvas.addEventListener(type, event => order.push(`${type}(${event.button},${event.buttons},${event.clientX},${event.isTrusted})`));
  }
  canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
  router.pointer({ type: 'pointermove', clientX: 10, clientY: 20, button: 0 });
  router.pointer({ type: 'pointerdown', clientX: 10, clientY: 20, button: 0 });
  router.pointer({ type: 'pointerup', clientX: 10, clientY: 20, button: 0 });
  assert.deepEqual(order, [
    'pointerover(-1,0,10,true)', 'pointerenter(-1,0,10,true)', 'mouseover(0,0,10,true)', 'mouseenter(0,0,10,true)',
    'pointermove(-1,0,10,true)', 'mousemove(0,0,10,true)', 'pointerdown(0,1,10,true)', 'mousedown(0,1,10,true)',
    'gotpointercapture(-1,0,10,true)', 'pointerup(0,0,10,true)', 'mouseup(0,0,10,true)', 'click(0,0,10,true)',
    'lostpointercapture(-1,0,10,true)',
  ]);
});

test('keys reach the focused element with Edge codes, and printable keys add keypress', () => {
  const { window, document } = page();
  const router = new InputRouter(window, document);
  const seen = [];
  window.addEventListener('keydown', event => seen.push(`down ${event.key} ${event.code} ${event.keyCode} ${event.location} ${event.repeat} ${event.target.localName}`));
  window.addEventListener('keypress', event => seen.push(`press ${event.key} ${event.charCode}`));
  router.key({ type: 'keydown', code: 'KeyW', key: 'w', repeat: false });
  router.key({ type: 'keydown', code: 'KeyW', key: 'w', repeat: true });
  router.key({ type: 'keydown', code: 'ShiftLeft', key: 'Shift', repeat: false, shift: true });
  router.key({ type: 'keydown', code: 'KeyA', key: 'a', ctrl: true });
  assert.deepEqual(seen, ['down w KeyW 87 0 false body', 'press w 119', 'down w KeyW 87 0 true body', 'press w 119', 'down Shift ShiftLeft 16 1 false body', 'down a KeyA 65 0 false body']);
  assert.equal(keyCode('F12'), 123);
  assert.equal(keyCode('Numpad7'), 103);
  assert.equal(keyCode('Semicolon'), 186);
});

test('routing follows the Edge rows of the event table', () => {
  const { window, document } = page();
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const router = new InputRouter(window, document);
  const seen = [];
  document.body.addEventListener('pointerenter', event => seen.push(`enter ${event.target.localName}`));
  window.addEventListener('mousemove', event => seen.push(`mousemove ${event.clientX},${event.clientY}`));
  window.addEventListener('pointermove', event => seen.push(`pointermove ${event.clientX},${event.clientY}`));
  router.pointer({ type: 'pointermove', clientX: 300.5, clientY: 200.25, button: 0 });
  assert.deepEqual(seen, ['enter body', 'pointermove 300.5,200.25', 'mousemove 300,200'], 'enter fires only where it is listened for, and mouse events get whole pixels');
  seen.length = 0;
  for (const type of ['mouseup', 'click', 'auxclick']) window.addEventListener(type, event => seen.push(`${type} ${event.button} ${event.detail}`));
  router.pointer({ type: 'pointerdown', clientX: 10, clientY: 10, button: 0 });
  router.pointer({ type: 'pointerdown', clientX: 10, clientY: 10, button: 2 });
  router.pointer({ type: 'pointerup', clientX: 10, clientY: 10, button: 2 });
  router.pointer({ type: 'pointerup', clientX: 10, clientY: 10, button: 0 });
  assert.deepEqual(seen.filter(line => !line.includes('move')), ['mouseup 2 1', 'auxclick 2 1', 'mouseup 0 0'], 'a chord cancels the first button click');
  const wheels = [];
  window.addEventListener('wheel', event => wheels.push(`${event.cancelable} ${event.wheelDeltaY}`));
  router.wheel({ deltaX: 0, deltaY: 250 });
  canvas.addEventListener('wheel', event => event.preventDefault());
  router.wheel({ deltaX: 0, deltaY: -100 });
  assert.deepEqual(wheels, ['false -120', 'true 120'], 'window wheel listeners are passive by default');
  const field = document.createElement('input');
  document.body.append(field);
  const presses = [];
  window.addEventListener('keydown', () => field.focus());
  window.addEventListener('keypress', event => presses.push(event.target.localName));
  router.key({ type: 'keydown', code: 'KeyF', key: 'f' });
  assert.deepEqual(presses, ['input'], 'keypress goes to the element the keydown focused');
});

test('click, auxclick and contextmenu carry no pressure, as in Edge', () => {
  const { window, document } = page();
  document.body.append(document.createElement('canvas'));
  const router = new InputRouter(window, document);
  const seen = [];
  for (const type of ['auxclick', 'contextmenu']) window.addEventListener(type, event => seen.push(`${type} ${event.buttons} ${event.pressure}`));
  router.pointer({ type: 'pointerdown', clientX: 1, clientY: 1, button: 0 });
  router.pointer({ type: 'pointerdown', clientX: 1, clientY: 1, button: 2 });
  router.pointer({ type: 'pointerup', clientX: 1, clientY: 1, button: 2 });
  assert.deepEqual(seen, ['auxclick 1 0', 'contextmenu 1 0']);
});
