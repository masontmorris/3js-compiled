// Captures presents with PresentMon through C:\3jsc\tools\presentmon\capture.py, which runs it elevated from the
// 3jsc-presentmon scheduled task, and counts them inside a window. PresentMon's CPUStartQPCTimeInMs column is
// QueryPerformanceCounter time in milliseconds, and process.hrtime on Windows reads the same counter, so qpcNow()
// stamps windows on PresentMon's clock.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const qpcNow = () => Number(process.hrtime.bigint()) / 1e6;

// Starts a capture of the named executables and returns the earliest time it can end, on the QPC clock, and a
// function that waits for it to end and resolves to its CSV text. Both reject when the capture is unavailable.
export async function startCapture(script, processes, seconds, out) {
  const { stdout } = await exec('python', [script, '--seconds', String(seconds), ...processes.flatMap(name => ['--process', name]), '--start-only']);
  const capturedUntil = qpcNow() + seconds * 1000;
  const id = stdout.trim();
  if (!/^\w+$/.test(id)) throw new Error(`capture.py returned no capture id: ${stdout}`);
  return {
    capturedUntil,
    async collect() {
      await exec('python', [script, '--collect', id, '--out', out], { timeout: (seconds + 240) * 1000 });
      return readFile(out, 'utf8');
    },
  };
}

// Counts the presents of the given process IDs between from and to. A present is displayed when MsUntilDisplayed
// is a number, and PresentMon writes NA for a frame that never reached the screen. `before` and `after` count the
// same processes' presents outside the window, so a caller can check that the capture spans it. `largestGapMs` is
// the longest time between consecutive presents in the window. PresentMon can lose events without reporting it, and
// a long gap in a program that presents continuously is how that shows.
export function countPresents(text, ids, from, to) {
  const [header, ...lines] = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const columns = header.split(',');
  const column = name => {
    const index = columns.indexOf(name);
    if (index < 0) throw new Error(`PresentMon CSV has no ${name} column`);
    return index;
  };
  const [pid, at, untilDisplayed, mode, swapChain] = ['ProcessID', 'CPUStartQPCTimeInMs', 'MsUntilDisplayed', 'PresentMode', 'SwapChainAddress'].map(column);
  const counts = { before: 0, after: 0, presented: 0, displayed: 0, largestGapMs: 0, processes: {}, swapChains: {}, presentModes: {} };
  const add = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
  let previous = null;
  for (const line of lines) {
    const row = line.split(',');
    if (!ids.has(Number(row[pid]))) continue;
    const time = Number(row[at]);
    if (time < from) counts.before++;
    else if (time > to) counts.after++;
    else {
      counts.presented++;
      if (previous !== null) counts.largestGapMs = Math.max(counts.largestGapMs, time - previous);
      previous = time;
      if (row[untilDisplayed] !== '' && Number.isFinite(Number(row[untilDisplayed]))) counts.displayed++;
      add(counts.processes, row[pid]);
      add(counts.swapChains, row[swapChain]);
      add(counts.presentModes, row[mode]);
    }
  }
  return counts;
}
