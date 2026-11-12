import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findGaps } from './gaps.mjs';

const rate = 48000;
function noise(seconds, seed = 7) {
  const out = new Float32Array(Math.round(seconds * rate));
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = ((x >>> 0) / 2 ** 32 - 0.5) * 0.2;
  }
  return out;
}
const stereo = samples => ({ sampleRate: rate, channels: [samples, samples] });
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const silence = ms => new Float32Array(Math.round((ms * rate) / 1000));
const ms = n => Math.round((n * rate) / 1000);

test('a loopback that matches the expected signal at one lag and gain has no discontinuity', () => {
  const expected = noise(3);
  const result = findGaps(stereo(expected), stereo(join(silence(94), expected.map(v => v * 0.5))));
  assert.equal(result.aligned, true);
  assert.equal(Math.round(result.lagMs), 94);
  assert.deepEqual(result.events, []);
});

test('silence the device inserted is a gap of its length, and dropped frames are a skip', () => {
  const expected = noise(3);
  const captured = join(silence(50), expected.subarray(0, ms(1000)), silence(20), expected.subarray(ms(1000), ms(2000)), expected.subarray(ms(2010)));
  const { events } = findGaps(stereo(expected), stereo(captured));
  assert.deepEqual(events.map(e => [e.kind, Math.round(e.shiftMs), Math.round(e.atSeconds * 100) / 100]), [['gap', 20, 1], ['skip', -10, 2]]);
});

test('a stretch that matches nothing is a mismatch', () => {
  const expected = noise(3);
  const captured = join(silence(50), expected);
  captured.set(noise(0.03, 99), ms(50) + ms(1500));
  const { events } = findGaps(stereo(expected), stereo(captured));
  assert.ok(events.length >= 1 && events.every(e => e.kind === 'mismatch'), JSON.stringify(events));
  assert.ok(Math.abs(events[0].atSeconds - 1.5) < 0.02);
});
