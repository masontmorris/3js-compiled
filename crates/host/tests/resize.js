import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const canvas = { width: innerWidth, height: innerHeight, style: {}, addEventListener() {}, removeEventListener() {} };
const backend = new NativeBackend({ canvas }, { features: ['core-features-and-limits'], limits: { maxUniformBufferBindingSize: 65536 } });
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false });
renderer.setSize(canvas.width, canvas.height, false);
await renderer.init();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x336699);
scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0xff8800 })));
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
camera.position.z = 4;
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
setClearColor(1, 0, 1, 1);
function frame() {
  renderer.render(scene, camera);
  submitGpuCommands(backend.takeFrame());
  Promise.resolve().then(() => renderer.render(scene, camera));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
