import { readFileSync, writeFileSync } from 'node:fs';

// Writes channels of float samples as 16-bit PCM, or as 32-bit float with { float: true }.
export function encodeWav(channels, sampleRate, { float = false } = {}) {
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = float ? 4 : 2;
  const dataSize = frames * channels.length * bytesPerSample;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(float ? 3 : 1, 20);
  out.writeUInt16LE(channels.length, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels.length * bytesPerSample, 28);
  out.writeUInt16LE(channels.length * bytesPerSample, 32);
  out.writeUInt16LE(bytesPerSample * 8, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataSize, 40);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      if (float) out.writeFloatLE(channel[i], offset);
      else out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channel[i] * 32768))), offset);
      offset += bytesPerSample;
    }
  }
  return out;
}

export function writeWav(path, channels, sampleRate, options) {
  writeFileSync(path, encodeWav(channels, sampleRate, options));
}

export function decodeWav(bytes) {
  let offset = 12;
  let format;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      // WAVE_FORMAT_EXTENSIBLE, which hound writes for more than two channels, keeps the real tag in its subformat.
      const tag = bytes.readUInt16LE(body);
      format = { tag: tag === 0xfffe ? bytes.readUInt16LE(body + 24) : tag, channels: bytes.readUInt16LE(body + 2), sampleRate: bytes.readUInt32LE(body + 4), bits: bytes.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      const width = format.bits / 8;
      const frames = Math.floor(size / (width * format.channels));
      const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < format.channels; c++) {
          const at = body + (i * format.channels + c) * width;
          channels[c][i] = format.tag === 3 ? bytes.readFloatLE(at) : bytes.readInt16LE(at) / 32768;
        }
      }
      return { sampleRate: format.sampleRate, channels };
    }
    offset = body + size + (size & 1);
  }
  throw new Error('no data chunk');
}

export function readWav(path) {
  return decodeWav(readFileSync(path));
}
