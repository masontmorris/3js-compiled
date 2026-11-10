import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countPresents, startCapture } from './presentmon.mjs';

const csv = [
  '\uFEFFApplication,ProcessID,SwapChainAddress,PresentMode,MsBetweenPresents,MsUntilDisplayed,CPUStartQPCTimeInMs',
  'host.exe,10,0xA,Hardware: Independent Flip,1.0,2.0,99.5',
  'host.exe,10,0xA,Hardware: Independent Flip,1.0,2.0,100.0',
  'host.exe,10,0xA,Hardware: Independent Flip,1.0,NA,100.5',
  'host.exe,10,0xA,Composed: Flip,1.0,0.5,101.0',
  'other.exe,20,0xB,Composed: Flip,1.0,2.0,100.5',
  'host.exe,10,0xA,Hardware: Independent Flip,1.0,2.0,101.5',
].join('\r\n');

test('counts presented and displayed frames of the given processes inside the window', () => {
  const counts = countPresents(csv, new Set([10]), 100, 101);
  assert.equal(counts.presented, 3);
  assert.equal(counts.displayed, 2);
  assert.equal(counts.before, 1);
  assert.equal(counts.after, 1);
  assert.deepEqual(counts.processes, { 10: 3 });
  assert.deepEqual(counts.presentModes, { 'Hardware: Independent Flip': 2, 'Composed: Flip': 1 });
});

test('a CSV without the QPC time column is an error, not a count', () => {
  assert.throws(() => countPresents('ProcessID,MsUntilDisplayed\n10,1.0', new Set([10]), 0, 1), /CPUStartQPCTimeInMs/);
});

test('a capture whose client is missing rejects', async () => {
  await assert.rejects(startCapture('C:/no/such/capture.py', ['host.exe'], 1, 'unused.csv'));
});
