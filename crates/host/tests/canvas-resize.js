// Draws red at 1280x720 for 20 frames, then resizes the canvas in frame 20 and draws nothing after.
// `--scene draw-then-resize` draws green and then resizes the canvas to 640x360, so the green frame
// is never shown. `--scene resize-after-draw` resizes to 640x360, draws green and resizes back to
// 1280x720, so the canvas ends transparent. Every frame submits its stream.
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
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
const draw = color => {
  scene.background = new THREE.Color(color);
  renderer.render(scene, camera);
};
let frames = 0;
function frame() {
  if (frames < 20) {
    draw(0xff0000);
  } else if (frames === 20 && mode === 'draw-then-resize') {
    draw(0x00ff00);
    renderer.setSize(640, 360, false);
  } else if (frames === 20 && mode === 'resize-after-draw') {
    renderer.setSize(640, 360, false);
    draw(0x00ff00);
    renderer.setSize(1280, 720, false);
  }
  if (native) submitGpuCommands(backend.takeFrame());
  if (frames === 20) console.log(`frame 20 ends with canvas ${canvas.width}x${canvas.height}`);
  frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
