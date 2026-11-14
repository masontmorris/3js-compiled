// Opens hud-replace.html, a blue HUD box that turns to the color of the patch it is given, sends one
// magenta patch for frames 5 to 29 only, and at frame 600 replaces the renderer with one whose device
// has higher limits, so the host starts the UI again on the new device. The canvas is red before
// and green after. The page logs the uncaptured errors so far at frame 900.
import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';
import { bridge } from '../../../packages/three-native/src/bridge.js';

bridge.open('hud-replace.html');
const canvas = { width: 1280, height: 720, style: {}, addEventListener() {}, removeEventListener() {} };
async function start(requiredLimits) {
  const backend = new NativeBackend({ canvas, requiredLimits }, { features: ['core-features-and-limits'], limits: { maxUniformBufferBindingSize: 65536 } });
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
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
function frame() {
  if (frames === 600 && !swapping) {
    swapping = true;
    renderer.dispose().then(() => start({ maxTextureDimension2D: 16384, maxBufferSize: 536870912 })).then(next => {
      renderer = next;
      swapping = false;
    });
  }
  if (frames >= 5 && frames < 30) bridge.send({ color: 'rgb(255, 0, 255)' });
  if (!swapping) {
    scene.background = new THREE.Color(frames < 600 ? 0xff0000 : 0x00ff00);
    renderer.render(scene, camera);
    submitGpuCommands(renderer.backend.takeFrame());
  }
  if (frames === 900) console.log(`frame 900: ${errors} uncaptured errors so far`);
  frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
