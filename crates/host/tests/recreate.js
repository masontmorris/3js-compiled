// Draws red with a green box for 20 frames, then awaits the renderer's dispose() and creates a new renderer on the
// same canvas, which draws a green background. Mode `higher` requires a maxTextureDimension2D of 16384 and a
// maxBufferSize of 512 MiB, above WebGPU's defaults, so the new device differs from the one that presented, and
// mode `equal` requires nothing more. The page logs the new device's limits and the uncaptured errors so far.
import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const native = typeof submitGpuCommands === 'function';
const mode = native ? globalThis.__sceneName : new URLSearchParams(location.search).get('scene');
const canvas = native
  ? { width: 1280, height: 720, style: {}, addEventListener() {}, removeEventListener() {} }
  : document.querySelector('canvas');
async function start(requiredLimits) {
  const backend = native
    ? new NativeBackend({ canvas, requiredLimits }, { features: ['core-features-and-limits'], limits: { maxUniformBufferBindingSize: 65536 } })
    : undefined;
  const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false, requiredLimits });
  renderer.setSize(1280, 720, false);
  await renderer.init();
  renderer.backend.device.onuncapturederror = () => errors++;
  return renderer;
}
let errors = 0;
let frames = 0;
let renderer = await start(undefined);
let swapping = false;
const scene = new THREE.Scene();
scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x00ff00 })));
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
camera.position.z = 4;
function frame() {
  if (frames === 20 && !swapping) {
    swapping = true;
    renderer.dispose().then(() => start(mode === 'higher' ? { maxTextureDimension2D: 16384, maxBufferSize: 536870912 } : undefined)).then(next => {
      renderer = next;
      console.log(`limits: maxTextureDimension2D ${renderer.backend.device.limits.maxTextureDimension2D} maxBufferSize ${renderer.backend.device.limits.maxBufferSize}`);
      swapping = false;
    });
  }
  if (!swapping) {
    scene.background = new THREE.Color(frames < 20 ? 0xff0000 : 0x00ff00);
    renderer.render(scene, camera);
    if (native) submitGpuCommands(renderer.backend.takeFrame());
  }
  if (frames === 40) console.log(`frame 40: ${errors} uncaptured errors so far`);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
