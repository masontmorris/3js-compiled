import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { load, loadRejection, quietBaseline } from './load.mjs';

const reading = (busyMs, dpcMs = 0, interruptMs = 0) => ({ busyMs, dpcMs, interruptMs });

test('a run counts when its other load is at most the baseline plus one core', () => {
  assert.equal(loadRejection({ otherCores: 3.2, baselineCores: 2.2 }), null);
  assert.match(loadRejection({ otherCores: 3.3, baselineCores: 2.2 }), /3\.30 cores, over the 2\.20-core baseline plus 1/);
});

test('DPC and interrupt time is its own column and not other load', () => {
  const { otherCores, dpcInterruptCores } = load(reading(0, 0, 0), reading(30000, 2000, 1500), 10000, 12000);
  assert.equal(dpcInterruptCores, 0.35);
  assert.ok(Math.abs(otherCores - 1.45) < 1e-9, `${otherCores}`);
});

test('a baseline over 3 cores waits and measures again', async () => {
  let clock = 0;
  const loads = [4, 3.5, 2];
  let busyMs = 0;
  const readings = [];
  const machine = async () => {
    readings.push(clock);
    if (readings.length % 2 === 0) busyMs += loads[readings.length / 2 - 1] * 5000;
    return reading(busyMs);
  };
  const waits = [];
  const baseline = await quietBaseline(machine, { wait: async ms => { waits.push(ms); clock += ms; }, now: () => clock, log() {} });
  assert.deepEqual([baseline.quiet, baseline.otherCores], [true, 2]);
  assert.deepEqual(waits, [5000, 15000, 5000, 15000, 5000]);
  const busy = await quietBaseline(async () => reading((busyMs += 20000)), { tries: 2, wait: async ms => { clock += ms; }, now: () => clock, log() {} });
  assert.equal(busy.quiet, false);
});

test('a measured process that exits inside the window keeps its CPU time', { skip: process.platform !== 'win32' }, async () => {
  const sampler = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(import.meta.dirname, 'sampler.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: sampler.stdout })[Symbol.asyncIterator]();
  const ask = async line => {
    sampler.stdin.write(line + '\n');
    return (await lines.next()).value;
  };
  try {
    const child = spawn(process.execPath, ['-e', 'const end = Date.now() + 1000; while (Date.now() < end) {}']);
    const before = Number(await ask(`cpu ${child.pid}`));
    await once(child, 'exit');
    const after = Number(await ask(`cpu ${child.pid}`));
    assert.ok(after > before && after >= 500, `the exited process reports ${after} ms after ${before} ms`);
    const [busyMs, dpcMs, interruptMs] = (await ask('machine')).split(',').map(Number);
    assert.ok(busyMs > 0 && dpcMs >= 0 && interruptMs >= 0 && dpcMs + interruptMs < busyMs, `${busyMs}, ${dpcMs}, ${interruptMs}`);
  } finally {
    sampler.stdin.end();
  }
});
