// Runs one example scene against the recording device in Node and saves each submitted frame.
// Usage, from the repository root: node tools/scenes/record.mjs <scene> <out-dir> [frames] [--no-shadows]
// --no-shadows disables the renderer's shadow map before the first frame, as a negative control for parity gates.
// --fail-pipelines=<name> answers the error scope around each render pipeline whose label contains <name> with an error
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
// Answers each pop of a validation error scope that a failing pipeline was created in with that pipeline's error.
const failures = bytes => {
  const open = [];
  const responses = [];
  for (const { opcode, payload } of decodeCommands(bytes)) {
    const word = () => new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
    if (opcode === Opcode.PUSH_ERROR_SCOPE) open.push({ validation: word() === 0, message: null });
    else if (opcode === Opcode.POP_ERROR_SCOPE) {
      const { message } = open.pop();
      if (message) responses.push({ type: 'scope', request: word(), filter: 'validation', message });
    } else if (opcode === Opcode.CREATE_RENDER_PIPELINE) {
      const { label } = JSON.parse(new TextDecoder().decode(payload.subarray(4)));
      const scope = open.findLast(scope => scope.validation);
      if (scope && label.includes(failing)) scope.message ??= `pipeline ${label}: its shader does not compile`;
    }
  }
  return responses;
};
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
