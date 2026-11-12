// Lane 5: plays lane 3's 48 kHz reference graphs in one real-time AudioContext, each starting on its own whole second
// so its events fall on the same frames as offline, and blocks the game thread for 200 ms in the middle of each. It
// logs `REALTIME <json>` per graph with the context frame where it starts, and `REALTIME-DONE`. host.mjs realtime cuts
// each graph out of the --audio-out capture and compares it with the offline render.
import { referenceGraphs } from '../../tools/audio-parity/graphs.mjs';
import { build, shiftOps } from '../../tools/audio-parity/run-graph.mjs';

const ctx = new AudioContext();
console.log(`REALTIME ${JSON.stringify({ sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency })}`);
const graphs = referenceGraphs().filter(g => g.lane === 'graph' && g.sampleRate === ctx.sampleRate);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let second = Math.ceil(ctx.currentTime) + 1;
for (const spec of graphs) {
  const start = second;
  // Each graph plays through its own gain, cut afterwards, so a looping source stops before the next graph.
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  build(ctx, shiftOps(spec.ops, start), gain);
  while (ctx.currentTime < start + 0.25) await wait(5);
  const blocked = performance.now();
  while (performance.now() - blocked < 200);
  console.log(`REALTIME ${JSON.stringify({ name: spec.name, startFrame: Math.round(start * ctx.sampleRate), length: spec.length, channels: spec.channels, blockedAt: ctx.currentTime })}`);
  while (ctx.currentTime < start + 0.7) await wait(5);
  gain.disconnect();
  second = start + 1;
}
console.log(`REALTIME ${JSON.stringify({ outputLatency: ctx.outputLatency })}`);
console.log('REALTIME-DONE');
