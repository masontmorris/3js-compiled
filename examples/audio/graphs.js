// Renders every reference graph and decode case through the host's Web Audio binding and compares each with Edge's
// render, a float WAV under the folder that `#ref=<file URL>` names. It logs one `AUDIO-PARITY <json>` line per render,
// a `AUDIO-SAMPLES <name> <base64>` line per render whose name contains `#dump=<text>`, and `AUDIO-PARITY-DONE` at
// the end. tools/audio-parity/host.mjs runs it and reads host.log.
import { decodeCases, referenceGraphs } from '../../tools/audio-parity/graphs.mjs';
import { decodeClip, renderGraph } from '../../tools/audio-parity/run-graph.mjs';

const params = new URLSearchParams(location.hash.slice(1));
const reference = params.get('ref');
const dump = params.get('dump');
const filter = params.get('filter') ?? '';

function readWav(bytes) {
  const view = new DataView(bytes);
  let offset = 12;
  let format;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(...new Uint8Array(bytes, offset, 4));
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') format = { tag: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    if (id === 'data') {
      const width = format.bits / 8;
      const frames = Math.floor(size / (width * format.channels));
      const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < format.channels; c++) {
          const at = body + (i * format.channels + c) * width;
          channels[c][i] = format.tag === 3 ? view.getFloat32(at, true) : view.getInt16(at, true) / 32768;
        }
      }
      return { sampleRate: format.sampleRate, channels };
    }
    offset = body + size + (size & 1);
  }
  throw new Error('no data chunk');
}

const db = x => 20 * Math.log10(Math.max(x, 1e-12));
const rms = values => Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / Math.max(values.length, 1));

function compare(name, lane, sampleRate, ours, edge) {
  const n = Math.min(ours[0]?.length ?? 0, edge.channels[0].length);
  const diffs = [];
  ours.forEach((channel, c) => { for (let i = 0; i < n; i++) diffs.push(channel[i] - (edge.channels[c]?.[i] ?? 0)); });
  const row = {
    name, lane,
    sampleRate: [sampleRate, edge.sampleRate],
    channels: [ours.length, edge.channels.length],
    length: [ours[0]?.length ?? 0, edge.channels[0].length],
    diffDb: db(rms(diffs)),
  };
  if (lane === 'hrtf') row.levelsDb = ours.map((channel, c) => db(rms(channel)) - db(rms(edge.channels[c])));
  return row;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// The host has no btoa.
function base64(channels) {
  return channels.map(channel => {
    const bytes = new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength);
    let text = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      text += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? ALPHABET[n & 63] : '=');
    }
    return text;
  }).join(',');
}

async function check(name, lane, render) {
  try {
    const { sampleRate, channels } = await render();
    const edge = readWav(await (await fetch(`${reference}/${name}.wav`)).arrayBuffer());
    console.log(`AUDIO-PARITY ${JSON.stringify(compare(name, lane, sampleRate, channels, edge))}`);
    if (dump && name.includes(dump)) console.log(`AUDIO-SAMPLES ${name} ${sampleRate} ${base64(channels)}`);
  } catch (error) {
    console.log(`AUDIO-PARITY ${JSON.stringify({ name, lane, error: `${error.name}: ${error.message}` })}`);
  }
}

for (const spec of referenceGraphs().filter(g => g.name.includes(filter))) {
  await check(spec.name, spec.lane, async () => ({ sampleRate: spec.sampleRate, channels: await renderGraph(spec) }));
}
for (const c of decodeCases().filter(g => g.name.includes(filter))) {
  await check(c.name, c.lane, async () => {
    const bytes = await (await fetch(new URL(`clips/${c.file}`, import.meta.url))).arrayBuffer();
    return decodeClip(bytes, c.sampleRate);
  });
}
console.log('AUDIO-PARITY-DONE');
