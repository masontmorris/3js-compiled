import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';
import { buildScene } from './scenes.js';

const native = typeof globalThis.submitGpuCommands === 'function';
const name = native ? (globalThis.__sceneName ?? 'basic-cube') : (new URL(location.href).searchParams.get('scene') ?? 'basic-cube');
const canvas = native
  ? { width: innerWidth, height: innerHeight, style: {}, addEventListener() {}, removeEventListener() {} }
  : document.querySelector('canvas');
const backend = native ? new NativeBackend({ canvas }, { features: ['core-features-and-limits'], limits: { maxUniformBufferBindingSize: 65536 } }) : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false });
renderer.setSize(canvas.width, canvas.height, false);
await renderer.init();
const context = await buildScene(name, renderer);
globalThis.__scene = { renderer, context };
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  context.camera.aspect = innerWidth / innerHeight;
  context.camera.updateProjectionMatrix();
});
let frames = 0;
function frame() {
  try {
    context.render();
    if (native) globalThis.submitGpuCommands(backend.takeFrame());
    frames++;
    if (frames === 2) globalThis.__sceneReady = true;
    requestAnimationFrame(frame);
  } catch (error) {
    globalThis.__sceneError = String(error?.stack ?? error);
    console.error(globalThis.__sceneError);
  }
}
requestAnimationFrame(frame);
