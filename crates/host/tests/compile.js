// renderer.compileAsync() before the page draws and while it draws. Modes:
//   top-level   awaits compileAsync(scene, camera) at the module's top level, then starts the loop
//   before-loop starts the loop once compileAsync(scene, camera) settles, without a top-level await
//   mid-run     the loop draws from frame 0; frame 20 calls compileAsync on a box with a new material, and the box
//               joins the scene once it settles
// Every mode draws a green box on red, and logs the result of compileAsync and, at frame 60, the errors so far.
import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const native = typeof submitGpuCommands === 'function';
const mode = native ? globalThis.__sceneName : new URLSearchParams(location.search).get('scene');
const canvas = native
  ? { width: 1280, height: 720, style: {}, addEventListener() {}, removeEventListener() {} }
  : document.querySelector('canvas');
const backend = native
  ? new NativeBackend({ canvas }, { features: ['core-features-and-limits'], limits: { maxUniformBufferBindingSize: 65536 } })
  : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false });
renderer.setSize(1280, 720, false);
await renderer.init();
let frames = 0;
let errors = 0;
renderer.backend.device.onuncapturederror = () => errors++;
const settle = promise => promise.then(() => 'resolved', error => `rejected ${error?.name}: ${error?.message}`);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xff0000);
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
camera.position.z = 4;
const box = () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x00ff00, emissive: 0x00ff00 }));
scene.add(new THREE.AmbientLight(0xffffff, 1));
if (mode !== 'mid-run') scene.add(box());
let started = mode === 'mid-run';
if (mode === 'top-level') {
  console.log(`compileAsync at the top level: ${await settle(renderer.compileAsync(scene, camera))}`);
  started = true;
}
if (mode === 'before-loop') {
  settle(renderer.compileAsync(scene, camera)).then(value => {
    console.log(`compileAsync before the loop: ${value}`);
    started = true;
  });
}
function frame() {
  if (mode === 'mid-run' && frames === 20) {
    const pending = box();
    const preview = new THREE.Scene();
    preview.add(pending, new THREE.AmbientLight(0xffffff, 1));
    settle(renderer.compileAsync(preview, camera)).then(value => {
      console.log(`compileAsync mid-run: ${value}`);
      scene.add(pending);
    });
  }
  if (started) {
    renderer.render(scene, camera);
    if (native) submitGpuCommands(backend.takeFrame());
  }
  if (frames === 60) console.log(`frame 60: ${errors} uncaptured errors so far`);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
