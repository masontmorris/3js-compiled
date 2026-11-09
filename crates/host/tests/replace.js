import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const canvas = { width: innerWidth, height: innerHeight, style: {}, addEventListener() {}, removeEventListener() {} };
async function renderer(background, mesh) {
  const backend = new NativeBackend({ canvas }, { features: ['core-features-and-limits'], limits: { maxUniformBufferBindingSize: 65536 } });
  const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false });
  renderer.setSize(canvas.width, canvas.height, false);
  await renderer.init();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  scene.add(mesh);
  const camera = new THREE.PerspectiveCamera(40, canvas.width / canvas.height, 0.1, 100);
  camera.position.z = 8;
  return { backend, renderer, scene, camera };
}
let current = await renderer(0xff0000, new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: 0x0000ff })));
let frames = 0;
async function frame() {
  if (++frames === 3) {
    await current.renderer.dispose();
    current = await renderer(0x00ff00, new THREE.Mesh(new THREE.SphereGeometry(1.6, 32, 16), new THREE.MeshBasicMaterial({ color: 0xffff00 })));
  }
  current.renderer.render(current.scene, current.camera);
  submitGpuCommands(current.backend.takeFrame());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
