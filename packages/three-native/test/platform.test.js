import test from 'node:test';
import assert from 'node:assert/strict';
import { URL as ShimURL, Blob as ShimBlob, fetch as shimFetch, createImageBitmap, setHost, PIXELS, HTMLImageElement } from '../src/platform/images.js';
import { Document } from '../src/platform/dom.js';
import { Storage } from '../src/platform/storage.js';
import { Gamepads } from '../src/platform/gamepad.js';
import { addEventListener, dispatchEvent } from '../src/platform/events.js';
import { externalImageBytes } from '../src/NativeBackend.js';

test('URL resolves relative, file, blob and data URLs as Edge does', () => {
  const base = 'file:///C:/game/examples/platform/index.js#debug';
  assert.equal(new ShimURL('assets/a.png', base).href, 'file:///C:/game/examples/platform/assets/a.png');
  assert.equal(new ShimURL('../scenes/b c.png?x=1#h', base).href, 'file:///C:/game/examples/scenes/b%20c.png?x=1#h');
  assert.equal(new ShimURL('/root.png', base).href, 'file:///C:/root.png');
  assert.equal(new ShimURL(base).hash, '#debug');
  assert.equal(new ShimURL(base).origin, 'null');
  const web = new ShimURL('https://Example.com:443/a/./b/../c?q=1 2#f');
  assert.deepEqual([web.href, web.host, web.pathname, web.search, web.hash, web.origin], ['https://example.com/a/c?q=1%202#f', 'example.com', '/a/c', '?q=1%202', '#f', 'https://example.com']);
  assert.equal(web.searchParams.get('q'), '1 2');
  assert.equal(new ShimURL('blob:null/1234').pathname, 'null/1234');
  assert.equal(new ShimURL('data:image/png;base64,AAAA').protocol, 'data:');
  assert.throws(() => new ShimURL('no-scheme'), TypeError);
});

test('fetch reads blob, data and file URLs, and a missing file answers 404', async () => {
  globalThis.location = { href: 'file:///C:/game/index.js', origin: 'null' };
  setHost({ readFile: async path => (path === 'C:/game/assets/a.bin' ? new Uint8Array([1, 2, 3]) : null), decode: async () => { throw new Error('no'); } });
  const blob = new ShimBlob(['ab', new Uint8Array([99])], { type: 'Text/Plain' });
  assert.equal(blob.type, 'text/plain');
  const url = ShimURL.createObjectURL(blob);
  assert.match(url, /^blob:null\/[0-9a-f-]{36}$/);
  assert.equal(await (await shimFetch(url)).text(), 'abc');
  assert.equal((await shimFetch(url)).headers.get('content-type'), 'text/plain');
  ShimURL.revokeObjectURL(url);
  await assert.rejects(shimFetch(url), TypeError);
  assert.deepEqual([...await (await shimFetch('data:application/octet-stream;base64,AQID')).bytes()], [1, 2, 3]);
  const file = await shimFetch('assets/a.bin');
  assert.deepEqual([file.status, file.ok, [...new Uint8Array(await file.arrayBuffer())]], [200, true, [1, 2, 3]]);
  await assert.rejects(file.text(), TypeError, 'a body reads once');
  const missing = await shimFetch('assets/none.png');
  assert.deepEqual([missing.status, missing.ok, missing.statusText], [404, false, 'Not Found']);
  await assert.rejects(shimFetch('https://example.com/a.png'), TypeError);
});

test('an image element loads a blob URL, fires load, and keeps the decoded pixels', async () => {
  globalThis.location = { href: 'file:///C:/game/index.js', origin: 'null' };
  const pixels = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]) };
  setHost({ readFile: async () => null, decode: async bytes => { if (bytes[0] !== 0x89) throw new Error('bad'); return pixels; } });
  const document = new Document({ addEventListener, dispatchEvent });
  const image = document.createElement('img');
  assert.ok(image instanceof HTMLImageElement);
  const loaded = new Promise((resolve, reject) => { image.addEventListener('load', resolve); image.addEventListener('error', reject); });
  image.src = ShimURL.createObjectURL(new ShimBlob([new Uint8Array([0x89, 0x50])], { type: 'image/png' }));
  assert.equal(image.complete, false);
  await loaded;
  assert.deepEqual([image.complete, image.naturalWidth, image.width, image.height], [true, 2, 2, 1]);
  assert.equal(image[PIXELS], pixels);
  const broken = document.createElement('img');
  const failed = new Promise(resolve => broken.addEventListener('error', resolve));
  broken.src = ShimURL.createObjectURL(new ShimBlob([new Uint8Array([1])]));
  await failed;
  await assert.rejects(broken.decode(), { name: 'EncodingError' });
});

test('createImageBitmap flips, premultiplies and crops', async () => {
  const pixels = { width: 2, height: 2, data: new Uint8Array([10, 20, 30, 255, 200, 100, 50, 128, 1, 2, 3, 4, 5, 6, 7, 8]) };
  setHost({ readFile: async () => null, decode: async () => pixels });
  const plain = await createImageBitmap(new ShimBlob([new Uint8Array([1])]));
  assert.deepEqual([plain.width, plain.height, [...plain[PIXELS].data]], [2, 2, [...pixels.data]]);
  const flipped = await createImageBitmap(new ShimBlob([new Uint8Array([1])]), { imageOrientation: 'flipY', premultiplyAlpha: 'premultiply' });
  assert.deepEqual([...flipped[PIXELS].data.subarray(0, 8)], [0, 0, 0, 4, 0, 0, 0, 8]);
  assert.deepEqual([...flipped[PIXELS].data.subarray(8)], [10, 20, 30, 255, 100, 50, 25, 128]);
  const cropped = await createImageBitmap(plain, 1, 0, 1, 2);
  assert.deepEqual([cropped.width, cropped.height, [...cropped[PIXELS].data]], [1, 2, [200, 100, 50, 128, 5, 6, 7, 8]]);
  setHost({ readFile: async () => null, decode: async () => { throw new Error('bad'); } });
  await assert.rejects(createImageBitmap(new ShimBlob([new Uint8Array([1])])), { name: 'InvalidStateError' });
});

test('copyExternalImageToTexture bytes follow flipY, premultipliedAlpha, the origin and the format', () => {
  const pixels = { width: 2, height: 2, data: new Uint8Array([10, 20, 30, 255, 200, 100, 50, 128, 1, 2, 3, 4, 5, 6, 7, 8]) };
  assert.deepEqual([...externalImageBytes(pixels, { width: 2, height: 2, format: 'rgba8unorm' })], [...pixels.data]);
  assert.deepEqual([...externalImageBytes(pixels, { width: 1, height: 1, flipY: true, format: 'rgba8unorm-srgb' })], [1, 2, 3, 4]);
  assert.deepEqual([...externalImageBytes(pixels, { from: { x: 1, y: 0 }, width: 1, height: 1, premultiplied: true, format: 'bgra8unorm' })], [25, 50, 100, 128]);
  assert.throws(() => externalImageBytes(pixels, { from: { x: 1 }, width: 2, height: 2, format: 'rgba8unorm' }), { name: 'OperationError' });
  assert.throws(() => externalImageBytes(pixels, { width: 2, height: 2, format: 'rgba16float' }), /not implemented/);
});

test('Storage keeps string values, named properties, the quota and every change in its sink', () => {
  const changes = [];
  const storage = new Storage([['b', '2']], { set: (key, value) => changes.push(['set', key, value]), remove: key => changes.push(['remove', key]), clear: () => changes.push(['clear']) }, 20);
  storage.setItem('a', 1);
  storage.c = 'x';
  assert.deepEqual([storage.getItem('a'), storage.a, storage.c, storage.length, storage.getItem('none')], ['1', '1', 'x', 3, null]);
  assert.deepEqual(Object.keys(storage), ['b', 'a', 'c']);
  assert.throws(() => storage.setItem('big', 'x'.repeat(20)), { name: 'QuotaExceededError' });
  storage.removeItem('a');
  delete storage.c;
  storage.clear();
  assert.deepEqual(changes, [['set', 'a', '1'], ['set', 'c', 'x'], ['remove', 'a'], ['remove', 'c'], ['clear']]);
  assert.equal(storage.length, 0);
});

test('gamepads stay hidden until a button is pressed, then connect in the standard mapping', () => {
  const window = { addEventListener, dispatchEvent };
  const events = [];
  window.addEventListener('gamepadconnected', event => events.push(`connected ${event.gamepad.index} ${event.gamepad.mapping}`));
  window.addEventListener('gamepaddisconnected', event => events.push(`disconnected ${event.gamepad.index}`));
  const pads = new Gamepads(window);
  const pad = (buttons, axes = [0, 0, 0, 0]) => ({ index: 0, id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', buttons, axes });
  const idle = new Array(17).fill(0);
  pads.update([pad(idle)], 1);
  assert.deepEqual(pads.getGamepads(), new Array(8).fill(null));
  const a = [...idle];
  a[0] = 1;
  a[7] = 0.1;
  pads.update([pad(a, [0, 0.25, 0, 0])], 2);
  const [first] = pads.getGamepads();
  assert.deepEqual([first.buttons.length, first.buttons[0].pressed, first.buttons[7].pressed, first.buttons[7].touched, first.axes[1], first.timestamp], [17, true, false, true, 0.25, 2]);
  pads.update([pad(a, [0, 0.25, 0, 0])], 3);
  assert.equal(pads.getGamepads()[0], first, 'an unchanged pad keeps its snapshot');
  pads.update([], 4);
  assert.deepEqual(events, ['connected 0 standard', 'disconnected 0']);
  assert.equal(first.connected, false);
});

test('AbortController and AbortSignal behave as in Edge 157', async () => {
  const { AbortController: Controller, AbortSignal: Signal } = await import('../src/platform/abort.js');
  const controller = new Controller();
  const order = [];
  controller.signal.onabort = event => order.push(`onabort ${event.type} ${event.target === controller.signal}`);
  controller.signal.addEventListener('abort', () => order.push('listener'));
  assert.deepEqual([controller.signal.aborted, controller.signal.reason], [false, undefined]);
  controller.abort();
  controller.abort('again');
  const reason = controller.signal.reason;
  assert.deepEqual([controller.signal.aborted, reason.name, reason.message, reason.code, order], [true, 'AbortError', 'signal is aborted without reason', 20, ['onabort abort true', 'listener']]);
  assert.throws(() => controller.signal.throwIfAborted(), error => error === reason);
  assert.equal(Signal.abort('why').reason, 'why');
  assert.equal(Signal.abort().reason.message, 'signal is aborted without reason');
  const timeout = Signal.timeout(5);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual([timeout.aborted, timeout.reason.name, timeout.reason.message, timeout.reason.code], [true, 'TimeoutError', 'signal timed out', 23]);
  const a = new Controller();
  const b = new Controller();
  const any = Signal.any([a.signal, b.signal]);
  b.abort('b-reason');
  assert.deepEqual([any.aborted, any.reason], [true, 'b-reason']);
  assert.equal(Signal.any([Signal.abort('x')]).reason, 'x');
  assert.throws(() => new Signal(), { name: 'TypeError', message: "Failed to construct 'AbortSignal': Illegal constructor" });
  assert.equal(Object.prototype.toString.call(controller.signal), '[object AbortSignal]');
});

test('fetch rejects with the signal reason, and an abort removes the listener re-added for its callback, as Edge does', async () => {
  const { AbortController: Controller } = await import('../src/platform/abort.js');
  globalThis.location = { href: 'file:///C:/game/index.js', origin: 'null' };
  setHost({ readFile: async () => new Uint8Array([1]), decode: async () => { throw new Error('no'); } });
  const aborted = new Controller();
  aborted.abort();
  await assert.rejects(shimFetch('a.bin', { signal: aborted.signal }), { name: 'AbortError', message: 'signal is aborted without reason' });
  const late = new Controller();
  const pending = shimFetch('a.bin', { signal: late.signal });
  late.abort('late');
  await assert.rejects(pending, reason => reason === 'late');
  const target = new (await import('../src/platform/events.js')).EventTarget();
  const signal = new Controller();
  const calls = [];
  const listener = () => calls.push('x');
  target.addEventListener('ping', listener, { signal: signal.signal });
  target.removeEventListener('ping', listener);
  target.addEventListener('ping', listener);
  signal.abort();
  target.dispatchEvent(new (await import('../src/platform/events.js')).Event('ping'));
  assert.deepEqual(calls, [], 'Edge 157 removes it too (probe/abort-probe.json)');
});

test('copyExternalImageToTexture with flipY takes the source rows from the origin, then flips them, as Edge does', () => {
  const rows = [10, 20, 30, 40];
  const pixels = { width: 1, height: 4, data: new Uint8Array(rows.flatMap(v => [v, v, v, 255])) };
  const read = y => [...externalImageBytes(pixels, { from: { y }, flipY: true, width: 1, height: 2, format: 'rgba8unorm' })].filter((_, i) => i % 4 === 0);
  assert.deepEqual(read(0), [20, 10]);
  assert.deepEqual(read(1), [30, 20]);
});

test('URL percent-encodes paths, queries and fragments with WHATWG sets, as Node does', () => {
  const base = 'file:///C:/games/folio/index.js';
  for (const input of ['assets/{name}.png', 'assets/a^b.png', 'assets/naïve.png', 'assets/😀.png', "assets/it's.png", "x.png?a=1&b='2'", 'tex.png#a b`<>', 'a|b.png', 'https://x.com/p{q}?r={s}\'#t{u}']) {
    assert.equal(new ShimURL(input, base).href, new URL(input, base).href, input);
  }
});
