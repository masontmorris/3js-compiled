import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const canvas = { width: innerWidth, height: innerHeight, style: {}, addEventListener() {}, removeEventListener() {} };
const capabilities = { features: ['core-features-and-limits'], limits: { maxUniformBufferBindingSize: 65536 } };
class FailingBackend extends NativeBackend {
  async init(renderer) {
    await super.init(renderer);
    throw new Error('init failed');
  }
}
function renderer(background, mesh, Backend = NativeBackend) {
  const backend = new Backend({ canvas }, capabilities);
  const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false });
  renderer.setSize(canvas.width, canvas.height, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  scene.add(mesh);
  const camera = new THREE.PerspectiveCamera(40, canvas.width / canvas.height, 0.1, 100);
  camera.position.z = 8;
  return { backend, renderer, scene, camera, mesh };
}
const box = () => new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: 0x0000ff }));
await renderer(0x000000, box()).renderer.dispose();
const failed = renderer(0x000000, box(), FailingBackend);
await failed.renderer.init().catch(error => console.log(`failed init: ${error.message}`));
await failed.renderer.dispose().catch(() => {});
let current = renderer(0xff0000, box());
await current.renderer.init();
let frames = 0;
async function frame() {
  if (++frames === 3) {
    const late = current.renderer.getArrayBufferAsync(current.mesh.geometry.getAttribute('position'));
    late.then(() => console.log('late readback resolved'), error => console.log(`late readback rejected: ${error.message}`));
    current.renderer.render(current.scene, current.camera);
    submitGpuCommands(current.backend.takeFrame());
    current.renderer.dispose();
    current = renderer(0x00ff00, new THREE.Mesh(new THREE.SphereGeometry(1.6, 32, 16), new THREE.MeshBasicMaterial({ color: 0xffff00 })));
    let errors = 0;
    await current.renderer.init();
    current.backend.recordingDevice.onuncapturederror = () => console.log(`new renderer error ${++errors}`);
    try {
      new NativeBackend({ canvas }, capabilities);
      console.log('a second live renderer was accepted');
    } catch (error) {
      console.log(`a second live renderer was rejected: ${error.message}`);
    }
  } else {
    current.renderer.render(current.scene, current.camera);
    submitGpuCommands(current.backend.takeFrame());
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
