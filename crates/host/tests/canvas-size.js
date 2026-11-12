// Draws every frame at a drawing-buffer size that changes every 10 frames for 300 frames, through
// setPixelRatio and setSize, then at a fixed 1280x720 that ignores resize until KeyS stops drawing.
// Each frame's image is a function of the canvas size and the frame's counter, whose bits fill the
// top quarter, so a capture of the window shows which frame it holds.
import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const native = typeof submitGpuCommands === 'function';
const canvas = native
  ? { width: 1280, height: 720, style: {}, addEventListener() {}, removeEventListener() {} }
  : document.querySelector('canvas');
const backend = native
  ? new NativeBackend({ canvas }, { features: ['core-features-and-limits'], limits: { maxUniformBufferBindingSize: 65536 } })
  : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false });
const sizes = [
  [0.5, 1280, 720], [2, 1280, 720], [1, 1000, 1000], [1, 853, 480], [0.75, 1280, 720],
  [1, 1280, 720], [1.5, 1280, 720], [1, 720, 1280], [0.625, 1280, 720], [1.25, 1280, 720],
  [0.25, 1280, 720], [1, 1600, 400], [0.875, 1280, 720], [1, 1279, 721], [1.75, 1280, 720],
];
const [ratio, width, height] = sizes[0];
renderer.setPixelRatio(ratio);
renderer.setSize(width, height, false);
await renderer.init();
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const material = new THREE.MeshBasicMaterial();
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
if (native) setClearColor(1, 0, 1, 1);
const BITS = 12;
let texture = null;
let counter = 0;
let stopped = false;
addEventListener('keydown', event => { if (event.code === 'KeyS') stopped = true; });

// Canvas pixel (x, y), with y down from the top: counter bits in the top quarter, then 1-pixel
// red columns, a 2-pixel green checker and 1-pixel blue rows.
function fill(data, w, h, top) {
  for (let y = 0; y < (top ? Math.floor(h / 4) : h); y++) {
    const row = (h - 1 - y) * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      if (y < Math.floor(h / 4)) {
        const on = (counter >> Math.floor(x * BITS / w)) & 1 ? 255 : 0;
        data[i] = data[i + 1] = data[i + 2] = on;
      } else {
        data[i] = (x & 1) * 255;
        data[i + 1] = ((x >> 1) ^ (y >> 1)) & 1 ? 255 : 0;
        data[i + 2] = (y & 1) * 255;
      }
      data[i + 3] = 255;
    }
  }
}

function frame() {
  if (!stopped) {
    if (counter < 300 && counter % 10 === 0) {
      const [ratio, width, height] = sizes[(counter / 10) % sizes.length];
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
    } else if (counter === 300) {
      renderer.setPixelRatio(1);
      renderer.setSize(1280, 720, false);
    }
    const [w, h] = [canvas.width, canvas.height];
    if (texture?.image.width !== w || texture?.image.height !== h) {
      texture?.dispose();
      texture = new THREE.DataTexture(new Uint8Array(w * h * 4), w, h);
      texture.magFilter = texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      fill(texture.image.data, w, h, false);
      material.map = texture;
      material.needsUpdate = true;
    } else {
      fill(texture.image.data, w, h, true);
    }
    texture.needsUpdate = true;
    renderer.render(scene, camera);
    if (native) submitGpuCommands(backend.takeFrame());
    console.log(`draw ${counter} ${w}x${h}`);
    globalThis.__counter = counter++;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
