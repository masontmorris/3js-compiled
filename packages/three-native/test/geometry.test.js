import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMRect, DOMRectReadOnly, DOMPoint, DOMMatrix } from '../src/platform/geometry.js';
import { btoa, atob } from '../src/platform/window.js';
import { Document } from '../src/platform/dom.js';
import { addEventListener, dispatchEvent } from '../src/platform/events.js';

// Every expectation here is Edge 157's value (probe/f1-probe.json in the E5 owner folder).
test('DOMRect and DOMRectReadOnly derive their edges and serialize as in Edge', () => {
  const rect = new DOMRect(1, 2, 3, 4);
  assert.deepEqual([rect.x, rect.y, rect.width, rect.height, rect.top, rect.right, rect.bottom, rect.left], [1, 2, 3, 4, 2, 4, 6, 1]);
  assert.equal(JSON.stringify(rect), '{"x":1,"y":2,"width":3,"height":4,"top":2,"right":4,"bottom":6,"left":1}');
  assert.equal(String(rect), '[object DOMRect]');
  assert.ok(rect instanceof DOMRectReadOnly);
  const negative = new DOMRect(10, 10, -4, -6);
  assert.deepEqual([negative.top, negative.right, negative.bottom, negative.left], [4, 10, 10, 6]);
  assert.equal(JSON.stringify(new DOMRect()), '{"x":0,"y":0,"width":0,"height":0,"top":0,"right":0,"bottom":0,"left":0}');
  rect.x = 5;
  assert.deepEqual([rect.x, rect.right], [5, 8]);
  const readOnly = new DOMRectReadOnly(1, 2, 3, 4);
  // A module is strict, where assigning to a getter-only accessor throws; Reflect.set reports the refusal instead.
  assert.equal(Reflect.set(readOnly, 'x', 9), false);
  assert.equal(readOnly.x, 1);
  assert.equal(JSON.stringify(DOMRect.fromRect({ x: 1, width: 2 })), '{"x":1,"y":0,"width":2,"height":0,"top":0,"right":3,"bottom":0,"left":1}');
});

test('DOMPoint and DOMMatrix construct, combine and print as in Edge', () => {
  const point = new DOMPoint(1, 2, 3);
  assert.deepEqual([JSON.stringify(point), String(point), point.w], ['{"x":1,"y":2,"z":3,"w":1}', '[object DOMPoint]', 1]);
  assert.equal(JSON.stringify(DOMPoint.fromPoint({ x: 7 })), '{"x":7,"y":0,"z":0,"w":1}');
  const identity = new DOMMatrix();
  assert.deepEqual([identity.is2D, identity.isIdentity, identity.a, identity.d, identity.m11, identity.m44, String(identity)], [true, true, 1, 1, 1, 1, 'matrix(1, 0, 0, 1, 0, 0)']);
  const m = new DOMMatrix([1, 2, 3, 4, 5, 6]);
  assert.deepEqual([m.a, m.b, m.c, m.d, m.e, m.f, m.is2D, String(m)], [1, 2, 3, 4, 5, 6, true, 'matrix(1, 2, 3, 4, 5, 6)']);
  const moved = new DOMMatrix().translate(10, 20).scale(2);
  assert.deepEqual([moved.a, moved.d, moved.e, moved.f, JSON.stringify(moved.transformPoint(new DOMPoint(1, 1)))], [2, 2, 10, 20, '{"x":12,"y":22,"z":0,"w":1}']);
  assert.equal(String(new DOMMatrix([1, 0, 0, 1, 5, 0]).multiply(new DOMMatrix([2, 0, 0, 2, 0, 0]))), 'matrix(2, 0, 0, 2, 5, 0)');
  assert.equal(String(new DOMMatrix([2, 0, 0, 2, 10, 0]).inverse()), 'matrix(0.5, 0, 0, 0.5, -5, 0)');
  assert.equal(new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]).m43, 9);
  assert.throws(() => new DOMMatrix([1, 2]), { name: 'TypeError', message: "Failed to construct 'DOMMatrix': The sequence must contain 6 elements for a 2D matrix or 16 elements for a 3D matrix." });
});

test('getBoundingClientRect returns a DOMRect', () => {
  const window = { addEventListener, dispatchEvent, innerWidth: 1280, innerHeight: 720 };
  const document = new Document(window);
  const element = document.createElement('div');
  document.body.append(element);
  const box = element.getBoundingClientRect();
  assert.equal(box.constructor.name, 'DOMRect');
  assert.ok(box instanceof DOMRect);
});

test('btoa and atob encode Latin-1 and throw Edge 157 errors', () => {
  assert.deepEqual([btoa('hello'), btoa(''), btoa('ÿþ')], ['aGVsbG8=', '', '//4=']);
  assert.throws(() => btoa('Ā'), { name: 'InvalidCharacterError', message: "Failed to execute 'btoa' on 'Window': The string to be encoded contains characters outside of the Latin1 range." });
  assert.deepEqual([atob('aGVsbG8='), atob(' aGVs bG8 '), atob('aGVsbG8'), atob('')], ['hello', 'hello', 'hello', '']);
  for (const bad of ['a', 'a*==']) {
    assert.throws(() => atob(bad), { name: 'InvalidCharacterError', message: "Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded." });
  }
  assert.throws(() => atob(), { name: 'TypeError', message: "Failed to execute 'atob' on 'Window': 1 argument required, but only 0 present." });
});

test('the style attribute and the style declaration reflect each other, and unset properties read empty', () => {
  const window = { addEventListener, dispatchEvent, innerWidth: 1280, innerHeight: 720 };
  const document = new Document(window);
  const div = document.createElement('div');
  div.setAttribute('style', 'position: fixed; width: 10px');
  assert.deepEqual([div.style.position, div.style.width, div.style.height, div.style.cssText, div.getAttribute('style')], ['fixed', '10px', '', 'position: fixed; width: 10px;', 'position: fixed; width: 10px']);
  div.style.height = '5px';
  assert.equal(div.getAttribute('style'), 'position: fixed; width: 10px; height: 5px;');
  div.style.cssText = 'color: red';
  assert.deepEqual([div.getAttribute('style'), div.style.width], ['color: red;', '']);
  assert.equal(div.style.notAProperty, undefined);
});
