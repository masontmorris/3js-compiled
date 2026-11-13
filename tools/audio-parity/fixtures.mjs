// Stores Edge's renders in crates/audio/tests/fixtures as 16-bit FLAC, which offline.rs reads by default. FLAC keeps
// the 16-bit samples exactly at about a third of a WAV's size. Needs ffmpeg. `node tools/audio-parity/fixtures.mjs <edge render dir>`
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readWav, writeWav } from './wav.mjs';

const [from] = process.argv.slice(2);
const to = 'crates/audio/tests/fixtures';
const files = readdirSync(from).filter(name => name.endsWith('.wav'));
if (!files.length) throw new Error('No WAV files found');
const temp = mkdtempSync(join(dirname(to), 'fixtures-temp-'));
const backup = `${temp}-backup`;
let saved = false;
try {
  for (const file of files) {
    const { sampleRate, channels } = readWav(join(from, file));
    const wav = join(temp, file);
    writeWav(wav, channels, sampleRate);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'flac', '-compression_level', '12', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', wav.replace(/\.wav$/, '.flac')]);
    rmSync(wav);
  }
  try { renameSync(to, backup); saved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { renameSync(temp, to); } catch (error) { if (saved) renameSync(backup, to); throw error; }
  if (saved) rmSync(backup, { recursive: true, force: true });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
