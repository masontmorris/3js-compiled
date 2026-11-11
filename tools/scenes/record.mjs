// Runs one example scene against the recording device in Node and saves each submitted frame.
// Usage, from the repository root: node tools/scenes/record.mjs <scene> <out-dir> [frames] [--no-shadows]
// --no-shadows disables the renderer's shadow map before the first frame, as a negative control for parity gates.
// --fail-pipelines=<name> answers the validation of each render pipeline whose label contains <name> with an error
// after the frame that created it, as the host does for a pipeline whose shader does not compile, so three stops
// drawing it from the next frame on.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeCommands, Opcode } from '../../packages/three-native/src/commands.js';

const flags = process.argv.slice(2).filter(arg => arg.startsWith('--'));
const [scene, out, count = '3'] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const failing = flags.find(flag => flag.startsWith('--fail-pipelines='))?.slice('--fail-pipelines='.length);
if (!scene || !out || flags.some(flag => flag !== '--no-shadows' && !flag.startsWith('--fail-pipelines='))) {
  throw new Error('Usage: node tools/scenes/record.mjs <scene> <out-dir> [frames] [--no-shadows] [--fail-pipelines=<name>]');
}
const failures = bytes => decodeCommands(bytes).filter(record => record.opcode === Opcode.CREATE_RENDER_PIPELINE).flatMap(record => {
  const request = new DataView(record.payload.buffer, record.payload.byteOffset).getUint32(4, true);
  const { label } = JSON.parse(new TextDecoder().decode(record.payload.subarray(8)));
  return request !== 0 && label.includes(failing) ? [{ type: 'error', request, message: `pipeline ${label}: its shader does not compile` }] : [];
});
await import('./build.mjs');

let callbacks = [];
const frames = [];
Object.assign(globalThis, {
  self: globalThis,
  innerWidth: 1280,
  innerHeight: 720,
  __sceneName: scene,
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: callback => callbacks.push(callback),
  submitGpuCommands: bytes => {
    frames.push(bytes.slice());
    if (failing) globalThis.__scene.renderer.backend.device.receiveResponses(failures(bytes));
  },
});
await import(pathToFileURL(resolve('examples/scenes/scene-bundle.js')));
if (flags.includes('--no-shadows')) globalThis.__scene.renderer.shadowMap.enabled = false;
for (let tick = 0; frames.length < Number(count) && !globalThis.__sceneError; tick++) {
  if (tick === 1000) throw new Error(`Scene ${scene} submitted ${frames.length} of ${count} frames`);
  const current = callbacks;
  callbacks = [];
  for (const callback of current) callback(performance.now());
  await new Promise(resolveTick => setTimeout(resolveTick, 0));
}
if (globalThis.__sceneError) throw new Error(globalThis.__sceneError);
mkdirSync(out, { recursive: true });
frames.forEach((frame, index) => writeFileSync(join(out, `${String(index).padStart(3, '0')}.bin`), frame));
