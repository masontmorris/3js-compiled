// Reads Edge's baseLatency and outputLatency on one output device, chosen by sinkId, in headless Edge, muted. Each of
// `--contexts` contexts in turn is read once it runs and again after 2 s of steady running. Lane 5 judges the host's
// steady latency against Edge's on the same device, in the same session.
//   node tools/audio-parity/edge-latency.mjs <device label> <out.json> [--contexts 3]
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args.splice(i, 2)[1]; };
const contexts = Number(option('contexts', '3'));
const [label, out] = args;
const origin = 'https://reference.test';
const profile = await mkdtemp(join(tmpdir(), 'threejsc-edge-latency-'));
let context;
try {
  // Output device labels and ids need the microphone permission; the fake UI grants it without a prompt.
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, timeout: 60_000, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
  await context.grantPermissions(['microphone'], { origin });
  const tab = context.pages()[0] ?? await context.newPage();
  await tab.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>latency</title>' }));
  await tab.goto(`${origin}/`);
  const result = await tab.evaluate(async ({ label, contexts }) => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    const sink = outputs.find(d => d.label.includes(label));
    if (!sink) return { error: `no output named ${label}`, outputs: outputs.map(d => d.label) };
    const readings = [];
    for (let i = 0; i < contexts; i++) {
      const ctx = new AudioContext({ sinkId: sink.deviceId });
      while (ctx.state !== 'running') await wait(5);
      const start = { baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency };
      await wait(2000);
      readings.push({ sampleRate: ctx.sampleRate, start, steady: { baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency } });
      await ctx.close();
    }
    return { device: sink.label, userAgent: navigator.userAgent, readings };
  }, { label, contexts });
  if (result.error) throw new Error(`edge-latency.mjs: ${result.error}; outputs: ${result.outputs.join(', ')}`);
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(`edge-latency.mjs: ${result.readings.map(r => (r.steady.baseLatency + r.steady.outputLatency).toFixed(3)).join(', ')} s steady on ${result.device}`);
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
