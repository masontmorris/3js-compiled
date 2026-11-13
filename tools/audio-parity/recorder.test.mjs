import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { stopRecorder } from './recorder.mjs';

const recorder = script => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'ignore', 'inherit'] });

test('the stop line ends a running recorder', async () => {
  const child = recorder("process.stdin.on('data', d => { if (String(d).includes('stop')) process.exit(3); })");
  const exited = once(child, 'exit');
  stopRecorder(child);
  assert.deepEqual(await exited, [3, null]);
});

// Blocks the event loop until the process is gone and its pipe has closed, which takes a few more milliseconds, so
// Node has not yet seen it exit.
const gone = pid => {
  const started = Date.now();
  for (;;) {
    try { process.kill(pid, 0); } catch { break; }
    assert.ok(Date.now() - started < 10000, 'the recorder did not exit');
  }
  const closing = Date.now();
  while (Date.now() - closing < 100);
};

test('a recorder that exited before Node saw it counts as stopped', async () => {
  const child = recorder('');
  const exited = once(child, 'exit');
  gone(child.pid);
  assert.equal(child.exitCode, null);
  stopRecorder(child);
  await exited;
  // The write to the closed pipe fails a turn after it starts.
  await new Promise(resolve => setTimeout(resolve, 100));
});
