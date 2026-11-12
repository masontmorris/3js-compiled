// Rebuilds third_party/web-audio-api from upstream web-audio-api-rs at `rev` with the patches in
// third_party/web-audio-api.patches applied. With --check it rebuilds into a temporary directory and fails when the
// vendored copy differs. `node tools/vendor/web-audio-api.mjs [--check]`
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const rev = '40402e22c8c45381afed2773e181e04ede2f5627';
const upstream = 'https://github.com/orottier/web-audio-api-rs';
const vendored = 'third_party/web-audio-api';
const patches = 'third_party/web-audio-api.patches';
const check = process.argv.includes('--check');

const work = mkdtempSync(join(tmpdir(), 'threejsc-vendor-'));
const git = (...args) => execFileSync('git', ['-C', work, '-c', 'core.autocrlf=false', ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
try {
  git('init', '-q');
  git('fetch', '-q', '--depth', '1', upstream, rev);
  git('checkout', '-q', 'FETCH_HEAD');
  for (const patch of readdirSync(patches).filter(name => name.endsWith('.patch')).sort()) {
    git('apply', '--whitespace=nowarn', join(process.cwd(), patches, patch));
  }
  // Cargo never resolves a non-member's dev-dependencies, and the benches are not vendored.
  const manifest = readFileSync(join(work, 'Cargo.toml'), 'utf8')
    .split(/^(?=\[)/m)
    .filter(table => !/^\[(dev-dependencies|\[bench\])\]/.test(table))
    .join('');
  const out = check ? mkdtempSync(join(tmpdir(), 'threejsc-vendor-out-')) : vendored;
  rmSync(out, { recursive: true, force: true });
  for (const entry of ['src', 'resources', 'LICENSE', 'README.md']) cpSync(join(work, entry), join(out, entry), { recursive: true });
  writeFileSync(join(out, 'Cargo.toml'), manifest);
  if (check) {
    const files = dir => readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, f)).isFile()).map(f => relative(dir, join(dir, f))).sort();
    const want = files(out);
    const have = files(vendored);
    const differ = [...new Set([...want, ...have])].filter(f => !want.includes(f) || !have.includes(f) || !readFileSync(join(out, f)).equals(readFileSync(join(vendored, f))));
    rmSync(out, { recursive: true, force: true });
    if (differ.length) {
      console.error(`${vendored} differs from ${rev} plus ${patches}: ${differ.join(', ')}`);
      process.exit(1);
    }
    console.log(`${vendored} matches ${rev} plus ${patches}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
