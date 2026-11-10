// Draws red at 1280x720 for 20 frames, then sets the canvas size in frame 20 or 25.
// `--scene draw-then-resize` draws green in frame 20 and then resizes the canvas to 640x360, so the
// green frame is never shown. `--scene draw-resize-back` draws green, resizes to 640x360 and back to
// 1280x720, and `--scene draw-setsize-same` draws green and sets the size the canvas already has,
// so both discard the green frame too. `--scene resize-after-draw` resizes to 640x360 in frame 20,
// draws green and resizes back to 1280x720, so the canvas ends transparent. `--scene resize-idle`
// resizes to 640x360 in frame 25 without drawing, so the last red frame stays. In frame 20,
// `--scene resized-zero-WxH` resizes to 640x360, draws green and resizes to WxH, where W or H is 0,
// `--scene drawn-zero-WxH` draws green and resizes to WxH, and `--scene idle-zero-WxH` resizes to
// WxH without drawing. The canvas then has no drawing buffer and is transparent, until frame 40
// resizes to 1280x720 and draws blue from then on. Draws stop after frame 20 in the other modes.
// Every frame submits its stream, and every uncaptured GPU error is logged.
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
const device = renderer.backend.device;
const report = device.onuncapturederror;
device.onuncapturederror = event => {
  console.log(`uncaptured: ${event.error?.message ?? event}`);
  report?.call(device, event);
};
const zero = /^(resized|drawn|idle)-zero-(\d+)x(\d+)$/.exec(mode);
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
  } else if (zero) {
    if (frames === 20) {
      if (zero[1] === 'resized') renderer.setSize(640, 360, false);
      if (zero[1] !== 'idle') draw(0x00ff00);
      renderer.setSize(Number(zero[2]), Number(zero[3]), false);
    } else if (frames >= 40) {
      if (frames === 40) renderer.setSize(1280, 720, false);
      draw(0x0000ff);
    }
  } else if (frames === 20 && mode === 'draw-then-resize') {
    draw(0x00ff00);
    renderer.setSize(640, 360, false);
  } else if (frames === 20 && mode === 'draw-resize-back') {
    draw(0x00ff00);
    renderer.setSize(640, 360, false);
    renderer.setSize(1280, 720, false);
  } else if (frames === 20 && mode === 'draw-setsize-same') {
    draw(0x00ff00);
    renderer.setSize(1280, 720, false);
  } else if (frames === 25 && mode === 'resize-idle') {
    renderer.setSize(640, 360, false);
  } else if (frames === 20 && mode === 'resize-after-draw') {
    renderer.setSize(640, 360, false);
    draw(0x00ff00);
    renderer.setSize(1280, 720, false);
  }
  if (native) submitGpuCommands(backend.takeFrame());
  if (frames === 25 || frames === 35) console.log(`frame ${frames} ends with canvas ${canvas.width}x${canvas.height}`);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
