import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const patch = 'packages/three-native/patches/three@0.187.0.patch';
const version = JSON.parse(readFileSync(new URL('../../node_modules/three/package.json', import.meta.url))).version;
if (version !== '0.187.0') throw new Error(`Expected three 0.187.0, found ${version}`);
const git = (...args) => spawnSync('git', ['apply', '--unidiff-zero', ...args, patch], { cwd: root, encoding: 'utf8' });
if (git('--reverse', '--check').status !== 0) {
  const result = git('--check');
  if (result.status !== 0) throw new Error(`Cannot apply three patch: ${result.stderr || result.error}`);
  const applied = git();
  if (applied.status !== 0) throw new Error(`Cannot apply three patch: ${applied.stderr || applied.error}`);
}
