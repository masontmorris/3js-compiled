import test from 'node:test';
import assert from 'node:assert/strict';
import { setCanvasHost } from '../../packages/three-native/src/platform/canvas2d.js';
import { Document } from '../../packages/three-native/src/platform/dom.js';
import { SCENES } from '../../examples/canvas2d/src/scenes.js';

setCanvasHost({
  fontLoad: () => 1, fillRect() {}, clearRect() {}, drawImage() {}, text() {},
  measure: request => ({ width: request.text.length }), unpremultiply: (from, to) => to.set(from),
});
globalThis.document = new Document({});

test('the perf scene starts its warm redraws after the first frame, which uploads the load draws', () => {
  const lines = [];
  const update = SCENES.perf({ show: () => ({ texture: {} }), log: line => lines.push(line) });
  update();
  assert.deepEqual(lines.filter(line => line.startsWith('perf warm')), []);
  for (let frame = 0; frame < 10; frame++) update();
  assert.deepEqual(lines.filter(line => line.startsWith('perf warm')).map(line => line.split(' ms=')[0]), [1, 2, 3, 4, 5].map(run => `perf warm run=${run}`));
});
