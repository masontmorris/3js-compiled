// Stores Edge's renders in crates/audio/tests/fixtures as 16-bit FLAC, which offline.rs reads by default. FLAC keeps
// the 16-bit samples exactly at about a third of a WAV's size. Needs ffmpeg. `node tools/audio-parity/fixtures.mjs <edge render dir>`
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readWav, writeWav } from './wav.mjs';

const [from] = process.argv.slice(2);
const to = 'crates/audio/tests/fixtures';
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
for (const file of readdirSync(from).filter(name => name.endsWith('.wav'))) {
  const { sampleRate, channels } = readWav(join(from, file));
  const wav = join(to, file);
  writeWav(wav, channels, sampleRate);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'flac', '-compression_level', '12', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', wav.replace(/\.wav$/, '.flac')]);
  rmSync(wav);
}
