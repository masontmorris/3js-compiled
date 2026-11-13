import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hostPath = [resolve(root, process.env.THREEJSC_HOST ?? 'target/release/host.exe')].find(path => existsSync(path));

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

// npm test runs each workspace's tests from its own folder, so a THREEJSC_HOST relative to the repo has to resolve
// from the repo, not from the working directory.
test('a THREEJSC_HOST relative to the repo runs the host test from the package folder', { skip: !hostPath && 'no host executable; set THREEJSC_HOST' }, () => {
  // A nested node --test that inherits NODE_TEST_CONTEXT reports to its parent instead of stdout.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', '^a headless page', fileURLToPath(import.meta.url)], {
    cwd: join(root, 'packages/three-native'), env: { ...env, THREEJSC_HOST: relative(root, resolve(hostPath)) }, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /# pass 1\b/);
  assert.match(child.stdout, /# skipped 0\b/);
});

test('a THREEJSC_HOST that names no file fails the host test instead of skipping it', () => {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', '^a headless page', fileURLToPath(import.meta.url)], {
    cwd: join(root, 'packages/three-native'), env: { ...env, THREEJSC_HOST: 'target/no-such-host.exe' }, encoding: 'utf8', timeout: 60_000,
  });
  assert.notEqual(child.status, 0, child.stdout);
  assert.match(child.stdout, /# fail 1\b/);
});
