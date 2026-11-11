// Draws a red background with a green box at 1280x720 for 20 frames, runs a mode in frame 20, and from frame 60
// draws a blue background at 1280x720. Every uncaptured GPU error is logged as `uncaptured <frame>: <message>`, and
// frames 21, 30, 40 and 70 log the error count so far.
//   oversize-16400  sets the size to 16400x64, over every device's texture limit, and draws every frame until 60
//   oversize-9000   the same at 9000x64, over the WebGPU default limit of 8192 that three's Edge device has
//   oversize-9000-limits  the same with a backend that requires maxTextureDimension2D 16384, so it draws
//   configure-after-draw  draws yellow, then calls configure() again with the same configuration, and draws
//                   nothing until frame 60. WebGPU's configure() discards the texture the frame drew.
//   configure-redraw  draws yellow, configures again, and renders again without clearing, drawing only the
//                   green box. WebGPU's getCurrentTexture() after configure() returns a new, transparent texture.
//   oversize-target  from frame 20 to 59 also renders the scene into a 16400x64 render target, whose textures fail,
//                   before each draw of the canvas, so each frame has one invalid pass and one valid one
//   empty-geometry  adds a mesh whose geometry has an empty position attribute, as a particle system or a line
//                   filled later starts, and draws every frame. WebGPU accepts a buffer of size 0.
//   unconfigure     draws yellow, calls unconfigure(), and draws nothing until frame 60, where it configures
//                   again with the saved configuration and draws blue.
//   configure-idle  draws nothing in frame 20 and calls configure() again with the same configuration
//   unconfigure-idle  draws nothing in frame 20, calls unconfigure(), and configures again at frame 60
import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const native = typeof submitGpuCommands === 'function';
const mode = native ? globalThis.__sceneName : new URLSearchParams(location.search).get('scene');
const canvas = native
  ? { width: 1280, height: 720, style: {}, addEventListener() {}, removeEventListener() {} }
  : document.querySelector('canvas');
const requiredLimits = mode.endsWith('-limits') ? { maxTextureDimension2D: 16384 } : undefined;
const backend = native
  ? new NativeBackend({ canvas, requiredLimits }, { features: ['core-features-and-limits'], limits: { maxUniformBufferBindingSize: 65536 } })
  : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false, requiredLimits });
renderer.setSize(1280, 720, false);
await renderer.init();
let frames = 0;
let errors = 0;
const device = renderer.backend.device;
const report = device.onuncapturederror;
device.onuncapturederror = event => {
  errors++;
  if (errors <= 60) console.log(`uncaptured ${frames}: ${(event.error?.message ?? String(event)).split('\n').filter(Boolean).join(' | ').slice(0, 200)}`);
  report?.call(device, event);
};
const scene = new THREE.Scene();
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
scene.add(box);
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
camera.position.z = 4;
const draw = color => { scene.background = color === null ? null : new THREE.Color(color); renderer.render(scene, camera); };
const oversize = /^oversize-(\d+)(-limits)?$/.exec(mode);
let saved = null;
let target = null;
if (mode === 'empty-geometry') {
  const empty = new THREE.BufferGeometry();
  empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  scene.add(new THREE.Mesh(empty, new THREE.MeshBasicMaterial({ color: 0xffffff })));
}
function frame() {
  const context = renderer.backend.context;
  if (frames < 20) draw(0xff0000);
  else if (frames < 60) {
    if (mode === 'oversize-target') {
      target ??= new THREE.RenderTarget(16400, 64);
      renderer.setRenderTarget(target);
      draw(0xff00ff);
      renderer.setRenderTarget(null);
      draw(0xffff00);
    } else if (oversize) {
      if (frames === 20) renderer.setSize(Number(oversize[1]), 64, false);
      draw(0xffff00);
    } else if (mode.endsWith('-idle')) {
      saved ??= context.getConfiguration();
      if (frames === 20 && mode === 'configure-idle') context.configure(saved);
      if (frames === 20 && mode === 'unconfigure-idle') context.unconfigure();
    } else if (frames === 20) {
      draw(0xffff00);
      saved = context.getConfiguration();
      if (mode === 'configure-after-draw') context.configure(saved);
      else if (mode === 'configure-redraw') {
        context.configure(saved);
        renderer.autoClear = false;
        draw(null);
        renderer.autoClear = true;
      } else if (mode === 'unconfigure') context.unconfigure();
    }
  } else {
    if (frames === 60) {
      if (oversize) renderer.setSize(1280, 720, false);
      if (mode.startsWith('unconfigure')) context.configure(saved);
    }
    draw(0x0000ff);
  }
  if (native) submitGpuCommands(backend.takeFrame());
  if ([21, 30, 40, 70].includes(frames)) console.log(`frame ${frames}: canvas ${canvas.width}x${canvas.height}, ${errors} uncaptured errors so far`);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
