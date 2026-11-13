import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

test('a completed browser operation does not leave its timeout running', () => {
  const moduleUrl = pathToFileURL(resolve('tools/canvas2d/edge.mjs')).href;
  const script = `import { withTimeout } from ${JSON.stringify(moduleUrl)}; await withTimeout(Promise.resolve(), 'done', 5000);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 2000, encoding: 'utf8' });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
});
