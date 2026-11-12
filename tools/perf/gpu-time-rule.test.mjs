import assert from 'node:assert/strict';
import test from 'node:test';
import { frameTimes, judge } from './gpu-time-rule.mjs';

test('a frame splits into the scene pass and the chain by three\'s render call number', () => {
  const passes = [['r:1:0:f9', 0.4], ['r:2:1:f9', 0.05], ['r:3:2:f9', 0.07], ['r:15:3:f9', 0.02], ['c:1:7:f9', 0.3]];
  const times = frameTimes(passes, 2);
  assert.equal(times.passes, 4, 'a compute pass is not a render pass');
  assert.ok(Math.abs(times.whole - 0.54) < 1e-9);
  assert.ok(Math.abs(times.chain - 0.14) < 1e-9, 'render call 1 is the scene pass');
});

const run = (side, index, chain, whole, clock, clockSamples = 20) => ({
  side, run: index, chainP50: chain, wholeP50: whole, gpu: { samples: clockSamples, graphicsMedian: clock },
});

test('a pair counts unless native ran more than 5 percent above Edge\'s graphics clock', () => {
  const verdict = judge([
    run('edge', 1, 0.24, 0.65, 2032), run('native', 1, 0.25, 0.61, 2032),
    run('edge', 2, 0.24, 0.65, 2032), run('native', 2, 0.25, 0.61, 1912),
    run('edge', 3, 0.24, 0.65, 1900), run('native', 3, 0.20, 0.55, 2032),
  ], 0.1);
  assert.deepEqual(verdict.pairs.map(pair => pair.counted), [true, true, false]);
  assert.equal(verdict.pairs[2].reason, 'native graphics clock 6.9% above Edge');
  assert.equal(verdict.counted, 2);
  assert.equal(verdict.edge.chainP50, 0.24);
  assert.equal(verdict.native.chainP50, 0.25);
  assert.equal(verdict.pass, true, '0.25 ms is within 10 percent of 0.24 ms');
});

test('a pair with under 10 clock samples on either side does not count, and no counted pair is inconclusive', () => {
  const verdict = judge([run('edge', 1, 0.24, 0.65, 2032, 9), run('native', 1, 0.25, 0.61, 2032)], 0.1);
  assert.equal(verdict.pairs[0].counted, false);
  assert.equal(verdict.pairs[0].reason, 'Edge had 9 clock samples, under 10');
  assert.equal(verdict.outcome, 'INCONCLUSIVE');
});

test('the rule fails when the native chain median exceeds Edge\'s by more than the margin', () => {
  const verdict = judge([run('edge', 1, 0.24, 0.65, 2032), run('native', 1, 0.27, 0.61, 2032)], 0.1);
  assert.equal(verdict.outcome, 'FAIL');
});
