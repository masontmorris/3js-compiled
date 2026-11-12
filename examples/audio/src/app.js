// The audio example. A cube sweeps left and right across the window carrying a 1 kHz tone through three.js's
// PositionalAudio in HRTF, so the tone pans with it, with an AudioListener on the camera. Each frame logs one
// `A f=<frame> x=<cube x> px=<panner x> peak=<analyser peak bin>` line, so a run in Edge and in the host compare
// frame by frame. `#frames=<n>` stops the log after n frames.
import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const native = typeof globalThis.submitGpuCommands === 'function';
const params = new URLSearchParams(location.hash.slice(1));
const frames = Number(params.get('frames') ?? Infinity);

const canvas = document.createElement('canvas');
canvas.width = innerWidth;
canvas.height = innerHeight;
document.body.append(canvas);

const backend = native ? new NativeBackend({ canvas }, { features: ['core-features-and-limits'] }) : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false });
renderer.setSize(innerWidth, innerHeight, false);
await renderer.init();

const world = new THREE.Scene();
world.background = new THREE.Color(0x101820);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 8);
const listener = new THREE.AudioListener();
camera.add(listener);
world.add(camera);

const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffa040 }));
world.add(cube);

const sound = new THREE.PositionalAudio(listener);
sound.panner.panningModel = 'HRTF';
sound.setRefDistance(2);
const oscillator = listener.context.createOscillator();
oscillator.frequency.value = 1000;
oscillator.start();
sound.setNodeSource(oscillator);
sound.setVolume(0.5);
cube.add(sound);
const analyser = new THREE.AudioAnalyser(sound, 2048);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});

let frame = 0;
const peak = data => data.reduce((best, value, i) => (value > data[best] ? i : best), 0);
renderer.setAnimationLoop(time => {
  cube.position.x = 4 * Math.sin(time / 1000);
  cube.rotation.y = time / 700;
  renderer.render(world, camera);
  // The host shows the stream a page submits, once per frame, and keeps what the page records until it does.
  if (native) globalThis.submitGpuCommands(backend.takeFrame());
  if (frame < frames) {
    console.log(`A f=${frame} x=${cube.position.x.toFixed(4)} px=${sound.panner.positionX.value.toFixed(4)} peak=${peak(analyser.getFrequencyData())}`);
  }
  frame++;
});
