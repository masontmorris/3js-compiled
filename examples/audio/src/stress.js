// The E7 perf probe: 32 looping voices, each through a gain and an HRTF panner, with rate, volume and position
// changed on every frame, as a busy game does through Howler. `#audio=off` does the same per-frame work but skips the
// audio calls, so the two runs differ only by what audio adds to the game thread. Each voice plays 2 s of its own
// seeded noise, so the mix never repeats within a loopback check's search range and a gap the device inserts or a
// skip it makes stands out against what the engine handed it.
import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const VOICES = 32;
const native = typeof globalThis.submitGpuCommands === 'function';
const audioOn = new URLSearchParams(location.hash.slice(1)).get('audio') !== 'off';

const canvas = document.createElement('canvas');
canvas.width = innerWidth;
canvas.height = innerHeight;
document.body.append(canvas);
const backend = native ? new NativeBackend({ canvas }, { features: ['core-features-and-limits'] }) : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false });
renderer.setSize(innerWidth, innerHeight, false);
await renderer.init();
const world = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 12);
const cubes = Array.from({ length: VOICES }, (_, i) => {
  const cube = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(i / VOICES, 0.7, 0.5) }));
  world.add(cube);
  return cube;
});

const voices = [];
if (audioOn) {
  const ctx = new AudioContext();
  const length = 2 * ctx.sampleRate;
  for (let i = 0; i < VOICES; i++) {
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let x = 0x9e3779b9 ^ (i + 1);
    for (let n = 0; n < length; n++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      data[n] = (x >>> 0) / 2 ** 31 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.02;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    source.connect(gain).connect(panner).connect(ctx.destination);
    source.start();
    voices.push({ ctx, source, gain, panner });
  }
}

renderer.setAnimationLoop(time => {
  const t = time / 1000;
  for (let i = 0; i < VOICES; i++) {
    const angle = t + (i * 2 * Math.PI) / VOICES;
    const x = 4 * Math.cos(angle);
    const y = Math.sin(angle * 2);
    const z = 4 * Math.sin(angle);
    cubes[i].position.set(x, y, z);
    const voice = voices[i];
    if (!voice) continue;
    const now = voice.ctx.currentTime;
    voice.source.playbackRate.setValueAtTime(1 + 0.25 * Math.sin(t + i), now);
    voice.gain.gain.setValueAtTime(0.02 * (1 + Math.sin(t * 3 + i)) / 2, now);
    voice.panner.positionX.setValueAtTime(x, now);
    voice.panner.positionY.setValueAtTime(y, now);
    voice.panner.positionZ.setValueAtTime(z, now);
  }
  renderer.render(world, camera);
  // The host shows the stream a page submits, once per frame, and keeps what the page records until it does.
  if (native) globalThis.submitGpuCommands(backend.takeFrame());
});
