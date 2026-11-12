// Plays one reference graph from graphs.mjs against the page's Web Audio and returns the rendered channels.
// It runs unchanged in Edge and in the host. crates/audio/tests/offline.rs mirrors signal() in Rust.

export function signal(name, channel, i, sampleRate, state) {
  if (name === 'mix') {
    const t = i / sampleRate;
    const phase = channel * 0.7;
    return 0.15 * (Math.sin(2 * Math.PI * 220 * t + phase) + Math.sin(2 * Math.PI * 1330 * t + phase) + Math.sin(2 * Math.PI * 4100 * t + phase));
  }
  if (name === 'noise') {
    state.x ^= state.x << 13;
    state.x ^= state.x >>> 17;
    state.x ^= state.x << 5;
    state.x >>>= 0;
    return state.x / 4294967296 - 0.5;
  }
  throw new Error(`unknown signal ${name}`);
}

export function makeBuffer(ctx, { channels, length, sampleRate, signal: name }) {
  const buffer = ctx.createBuffer(channels, length, sampleRate);
  for (let c = 0; c < channels; c++) {
    const data = new Float32Array(length);
    const state = { x: 0x9e3779b9 ^ (c * 0x85ebca6b) };
    for (let i = 0; i < length; i++) data[i] = signal(name, c, i, sampleRate, state);
    buffer.copyToChannel(data, c);
  }
  return buffer;
}

export function build(ctx, ops) {
  const items = { out: ctx.destination };
  for (const [op, id, ...args] of ops) {
    if (op === 'buffer') items[id] = makeBuffer(ctx, args[0]);
    else if (op === 'node') {
      const [kind, options] = args;
      const resolved = { ...options };
      if (typeof resolved.buffer === 'string') resolved.buffer = items[resolved.buffer];
      items[id] = new globalThis[`${kind}Node`](ctx, resolved);
    } else if (op === 'param') {
      const [name, method, ...rest] = args;
      const param = items[id][name];
      if (method === 'value') param.value = rest[0];
      else param[method](...rest.map(v => (Array.isArray(v) ? new Float32Array(v) : v)));
    } else if (op === 'listener') ctx.listener[id].value = args[0];
    else if (op === 'connect') items[id].connect(items[args[0]]);
    else if (op === 'start') items[id].start(...args);
    else if (op === 'stop') items[id].stop(...args);
    else throw new Error(`unknown op ${op}`);
  }
  return items;
}

export async function renderGraph(spec) {
  const ctx = new OfflineAudioContext({ numberOfChannels: spec.channels, length: spec.length, sampleRate: spec.sampleRate });
  build(ctx, spec.ops);
  const rendered = await ctx.startRendering();
  return channelsOf(rendered);
}

export async function decodeClip(bytes, sampleRate) {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate });
  const decoded = await ctx.decodeAudioData(bytes);
  return { sampleRate: decoded.sampleRate, channels: channelsOf(decoded) };
}

function channelsOf(buffer) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return channels;
}
