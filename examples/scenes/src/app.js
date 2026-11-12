import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';
import { buildScene } from './scenes.js';

const native = typeof globalThis.submitGpuCommands === 'function';
const name = native ? (globalThis.__sceneName ?? 'basic-cube') : (new URL(location.href).searchParams.get('scene') ?? 'basic-cube');
const canvas = native
  ? { width: innerWidth, height: innerHeight, style: {}, addEventListener() {}, removeEventListener() {} }
  : document.querySelector('canvas');
// tools/perf/gpu-time.mjs sets __gpuTime, which receives each frame's GPU time from three's timestamp queries.
const timed = globalThis.__gpuTime !== undefined;
const features = ['core-features-and-limits', ...(timed ? ['timestamp-query'] : [])];
const backend = native ? new NativeBackend({ canvas, trackTimestamp: timed }, { features, limits: { maxUniformBufferBindingSize: 65536 } }) : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false, trackTimestamp: timed });
renderer.setSize(canvas.width, canvas.height, false);
await renderer.init();
// How many shader modules and pipelines the device created, which the warm-up lane reads for the first frames.
const created = { modules: 0, pipelines: 0 };
const device = renderer.backend.device;
for (const [method, key] of [['createShaderModule', 'modules'], ['createRenderPipeline', 'pipelines'], ['createRenderPipelineAsync', 'pipelines'],
  ['createComputePipeline', 'pipelines'], ['createComputePipelineAsync', 'pipelines']]) {
  const create = device[method].bind(device);
  device[method] = (...args) => {
    created[key]++;
    return create(...args);
  };
}
const context = await buildScene(name, renderer);
globalThis.__scene = { renderer, context };
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  context.camera.aspect = innerWidth / innerHeight;
  context.camera.updateProjectionMatrix();
});
let frames = 0;
console.log(`before frame 0: ${created.modules} shader modules, ${created.pipelines} pipelines`);
function frame() {
  try {
    const before = { ...created };
    context.render();
    // A resolution carries the GPU time of the last frame it resolved, which three numbers in its query labels.
    if (timed) renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then(ms => globalThis.__gpuTime.record(ms, renderer.backend.timestampQueryPool[THREE.TimestampQuery.RENDER]?.frames.at(-1)));
    if (native) globalThis.submitGpuCommands(backend.takeFrame());
    if (frames < 3) console.log(`frame ${frames}: ${created.modules - before.modules} shader modules, ${created.pipelines - before.pipelines} pipelines`);
    frames++;
    if (frames === context.readyFrame) globalThis.__sceneReady = true;
    requestAnimationFrame(frame);
  } catch (error) {
    globalThis.__sceneError = String(error?.stack ?? error);
    console.error(globalThis.__sceneError);
  }
}
requestAnimationFrame(frame);
