// Writes the decode test clips to examples/audio/clips: the "mix" test signal as WAV, MP3 and Ogg Vorbis, mono and
// stereo, at each clip rate. Needs ffmpeg with libmp3lame and libvorbis on PATH. `node tools/audio-parity/make-clips.mjs`
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { clipName, clipRates } from './graphs.mjs';
import { signal } from './run-graph.mjs';
import { writeWav } from './wav.mjs';

const dir = 'examples/audio/clips';
mkdirSync(dir, { recursive: true });
for (const channels of [1, 2]) {
  for (const rate of clipRates) {
    const length = Math.round(rate * 0.5);
    const data = Array.from({ length: channels }, (_, c) => Float32Array.from({ length }, (_, i) => signal('mix', c, i, rate, {})));
    const wav = join(dir, clipName('wav', channels, rate));
    writeWav(wav, data, rate);
    const encode = (format, args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, ...args, '-map_metadata', '-1', join(dir, clipName(format, channels, rate))]);
    encode('mp3', ['-c:a', 'libmp3lame', '-b:a', rate === 22050 ? '64k' : '128k']);
    encode('ogg', ['-c:a', 'libvorbis', '-q:a', '4']);
  }
}
