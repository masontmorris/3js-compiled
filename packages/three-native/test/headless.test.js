import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hostPath = [process.env.THREEJSC_HOST ?? join(root, 'target/release/host.exe')].find(path => existsSync(path));

test('a headless page can submit a command stream on every frame', { skip: !hostPath && 'no host executable; set THREEJSC_HOST' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejsc-headless-'));
  try {
    const run = spawnSync(hostPath, ['--headless', '3', '--entry', fileURLToPath(new URL('./headless-submit.js', import.meta.url))], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const log = readFileSync(join(dir, 'host.log'), 'utf8');
    assert.match(log, /H submitted 3/);
    assert.doesNotMatch(log, /Only one GPU command stream/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
