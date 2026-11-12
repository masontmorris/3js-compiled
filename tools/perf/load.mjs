// frame-cost's rule on the rest of the machine's load. Readings are cumulative milliseconds summed over every
// processor, from the sampler's `machine` command: busy time, and the DPC and interrupt time inside it.
import { setTimeout as sleep } from 'node:timers/promises';

export const baselineMs = 5000;
// A baseline above this many cores means the machine is too busy to measure, so the tool waits and measures again.
export const busyBaselineCores = 3;
export const marginCores = 1;

// Over `elapsedMs`, the cores of busy time that is neither DPC nor interrupt time nor the measured processes'
// `measuredMs`, and the cores of DPC and interrupt time, which a run's own presents and GPU work raise.
export function load(before, after, elapsedMs, measuredMs = 0) {
  const dpcInterruptMs = after.dpcMs - before.dpcMs + after.interruptMs - before.interruptMs;
  return {
    otherCores: (after.busyMs - before.busyMs - dpcInterruptMs - measuredMs) / elapsedMs,
    dpcInterruptCores: dpcInterruptMs / elapsedMs,
  };
}

// Why a run's other load keeps it from counting, or null when it is at most the baseline plus one core.
export function loadRejection({ otherCores, baselineCores }) {
  return otherCores > baselineCores + marginCores
    ? `the rest of the machine averaged ${otherCores.toFixed(2)} cores, over the ${baselineCores.toFixed(2)}-core baseline plus ${marginCores}`
    : null;
}

// Measures the load over `baselineMs` with nothing measured running, and while it is over `busyBaselineCores`
// waits `retryMs` and measures again, up to `tries` times. Returns the last measurement and whether it is quiet.
export async function quietBaseline(machine, { tries = 20, retryMs = 15000, wait = sleep, now = () => performance.now(), log = console.log } = {}) {
  let baseline;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const before = await machine();
    const startedAt = now();
    await wait(baselineMs);
    const after = await machine();
    baseline = load(before, after, now() - startedAt);
    if (baseline.otherCores <= busyBaselineCores) return { ...baseline, quiet: true };
    log(`  the machine is busy: ${baseline.otherCores.toFixed(2)} cores with nothing measured running; measuring again in ${retryMs / 1000} s`);
    if (attempt < tries) await wait(retryMs);
  }
  return { ...baseline, quiet: false };
}
