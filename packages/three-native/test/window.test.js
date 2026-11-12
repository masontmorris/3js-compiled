import test from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar, Crypto, evaluateMedia, openWindow } from '../src/platform/window.js';

test('cookies keep Edge 157 order, attributes and serialization', () => {
  let now = 1_000_000;
  const saved = [];
  const jar = new CookieJar([], '/', () => now, cookies => saved.push(cookies.map(cookie => cookie.name)));
  jar.set('b=2; max-age=3600');
  jar.set('a=1');
  jar.set('c=3; path=/');
  jar.set('a=11');
  assert.equal(jar.get(), 'b=2; c=3; a=11');
  jar.set('b=; max-age=0');
  jar.set('c=gone; expires=Thu, 01 Jan 1970 00:00:00 GMT');
  jar.set('d=4; path=/other');
  jar.set('novalue');
  jar.set(' e = 5 ; max-age=60');
  assert.equal(jar.get(), 'a=11; novalue; e=5');
  now += 61_000;
  assert.equal(jar.get(), 'a=11; novalue', 'max-age runs out');
  const restored = new CookieJar(jar.cookies, '/', () => now, () => {});
  assert.equal(restored.get(), 'a=11; novalue', 'a restart keeps the cookies');
  assert.ok(saved.length > 0);
});

test('crypto fills integer arrays from the random source with Edge 157 errors', () => {
  const crypto = new Crypto(bytes => bytes.fill(7));
  const array = new Uint16Array(2);
  assert.equal(crypto.getRandomValues(array), array);
  assert.deepEqual([...array], [0x0707, 0x0707]);
  assert.equal(crypto.getRandomValues(new Uint8Array(65536)).length, 65536);
  crypto.getRandomValues(new BigInt64Array(1));
  crypto.getRandomValues(new Uint8ClampedArray(1));
  assert.throws(() => crypto.getRandomValues(new Float32Array(1)), { name: 'TypeMismatchError', message: "Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type 'Float32', which is not an integer array type." });
  assert.throws(() => crypto.getRandomValues(new DataView(new ArrayBuffer(4))), { name: 'TypeMismatchError', message: /of type 'DataView'/ });
  assert.throws(() => crypto.getRandomValues(new Uint8Array(65537)), { name: 'QuotaExceededError', message: "Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (65537) exceeds the number of bytes of entropy available via this API (65536)." });
  assert.throws(() => crypto.getRandomValues(), { name: 'TypeError', message: "Failed to execute 'getRandomValues' on 'Crypto': 1 argument required, but only 0 present." });
  const random = new Crypto(bytes => { for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 255; });
  assert.match(random.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('matchMedia answers boolean and range forms as Edge 157 does at 1280x720', () => {
  const env = { width: 1280, height: 720, ratio: 1 };
  const expected = {
    '(aspect-ratio)': true, '(resolution)': true, '(width)': true, '(height)': true, '(orientation)': true, '(color)': true,
    '(hover)': true, '(pointer)': true, '(any-hover)': true, '(prefers-reduced-motion)': false, '(prefers-color-scheme)': true,
    '(monochrome)': false, '(display-mode)': true, '(min-width: 1000px) and (max-width: 2000px)': true,
    'not all and (monochrome)': true, '(width >= 1000px)': true, '(400px <= width <= 2000px)': true, print: false,
    'screen and (orientation: landscape)': true, '(width < 1000px)': false, '(min-aspect-ratio: 16/9)': true,
  };
  for (const [query, matches] of Object.entries(expected)) assert.equal(evaluateMedia(query, env), matches, query);
});

test('window.open sends http and https URLs to the default browser and returns null', () => {
  const opened = [];
  const logged = [];
  assert.equal(openWindow('https://example.com/a?b=1', url => opened.push(url), message => logged.push(message)), null);
  assert.equal(openWindow('mailto:me@example.com', url => opened.push(url), message => logged.push(message)), null);
  assert.equal(openWindow('relative.html', url => opened.push(url), message => logged.push(message)), null);
  assert.deepEqual(opened, ['https://example.com/a?b=1']);
  assert.equal(logged.length, 2);
});
