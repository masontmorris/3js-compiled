import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { FOLIO_CANVASES } from '../../examples/canvas2d/src/folio-canvases.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hostPath = [resolve(root, process.env.THREEJSC_HOST ?? 'target/release/host.exe')].find(path => existsSync(path));

test('the raster diff rejects an Edge reference of another size', { skip: !hostPath && 'no host executable; set THREEJSC_HOST' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejsc-raster-diff-'));
  try {
    const refs = join(dir, 'refs');
    const png = new PNG({ width: 1, height: 1 });
    mkdirSync(refs);
    writeFileSync(join(refs, `${FOLIO_CANVASES[0].name}.png`), PNG.sync.write(png));
    const run = spawnSync(hostPath, ['--headless', '1', '--entry', join(root, 'tools/canvas2d/raster-diff.js'), '--hash', `refs=${pathToFileURL(refs).href}/`], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    const log = existsSync(join(dir, 'host.log')) ? readFileSync(join(dir, 'host.log'), 'utf8') : '';
    assert.doesNotMatch(log, /^D /m, 'no canvas is compared');
    assert.match(run.stderr + log, new RegExp(`${FOLIO_CANVASES[0].name}\\.png is 1x1, not \\d+x\\d+`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a THREEJSC_HOST that names no file fails the raster diff test instead of skipping it', () => {
  // A nested node --test that inherits NODE_TEST_CONTEXT reports to its parent instead of stdout.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', '^the raster diff rejects', fileURLToPath(import.meta.url)], {
    cwd: root, env: { ...env, THREEJSC_HOST: 'target/no-such-host.exe' }, encoding: 'utf8', timeout: 60_000,
  });
  assert.notEqual(child.status, 0, child.stdout);
  assert.match(child.stdout, /# fail 1\b/);
});
