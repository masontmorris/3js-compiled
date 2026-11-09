// Runs one example scene against the recording device in Node and saves each submitted frame.
// Usage, from the repository root: node tools/scenes/record.mjs <scene> <out-dir> [frames]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [scene, out, count = '3'] = process.argv.slice(2);
if (!scene || !out) throw new Error('Usage: node tools/scenes/record.mjs <scene> <out-dir> [frames]');
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
  submitGpuCommands: bytes => frames.push(bytes.slice()),
});
await import(pathToFileURL(resolve('examples/scenes/scene-bundle.js')));
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
