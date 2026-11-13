import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSteps, parse } from './perf-log.mjs';

const summary = frames => `dynamic frames=${frames} draw median ms=0.1 p95 ms=0.2 max ms=0.3 span median ms=0.2 p95 ms=0.3 max ms=0.4`;

test('a perf page that logged no measurements names what it is missing', () => {
  assert.deepEqual(parse(['scene perf ready', 'Error: no font'], 'perf').missing, ['perf load run=0', 'perf loadspan', 'perf frame1']);
  assert.deepEqual(parse(['perf load run=0 ms=25', 'perf frame1 ms=3', 'perf loadspan ms=230'], 'perf').missing, []);
  assert.deepEqual(parse([summary(300)], 'dynamic').missing, ['a dynamic summary after the first']);
  assert.deepEqual(parse([summary(300), summary(600)], 'dynamic').missing, []);
});

test('a perf page that logged a scene error fails even with every measurement', () => {
  const complete = ['perf load run=0 ms=25', 'perf frame1 ms=3', 'perf loadspan ms=230'];
  assert.equal(parse(complete, 'perf').failed, false);
  assert.equal(parse([...complete, 'R scene error'], 'perf').failed, true);
  assert.equal(parse([summary(300), summary(600), 'R scene error'], 'dynamic').failed, true);
});

test('a native perf page waits until its scene is ready or failed, so a failed scene ends the run normally', () => {
  const [wait, frames] = nativeSteps(10);
  // As the host evaluates a wait_for step in the page.
  const evaluate = globals => {
    Object.assign(globalThis, globals);
    try { return new Function(`return Boolean((${wait.expression}))`)(); } finally { for (const name of Object.keys(globals)) delete globalThis[name]; }
  };
  assert.equal(wait.type, 'wait_for');
  assert.equal(evaluate({}), false);
  assert.equal(evaluate({ __sceneReady: true }), true);
  assert.equal(evaluate({ __sceneError: 'Error: no scene missing' }), true);
  assert.deepEqual(frames, { type: 'wait', frames: 10 });
});
