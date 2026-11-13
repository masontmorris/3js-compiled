// WebGPU's invalid-object rules for each object type, run natively and in Edge. Frames 0-19 draw red. From frame 20
// three draws yellow, and then a raw pass loads the canvas and draws a full-screen blue triangle with one bind group
// of a uniform buffer, a sampler and a texture. In frame 20 the mode builds one of those objects, or the pipeline,
// from an invalid descriptor or an invalid parent, and frames 20-59 use it. Frame 60 destroys or releases the invalid
// objects and returns to the valid ones. A valid raw pass shows blue and an invalid one leaves yellow.
//   buffer           a uniform buffer over maxBufferSize, written every frame and bound through the bind group
//   sampler          a sampler with lodMinClamp -1
//   layout           a bind group layout with binding 0 twice, and the group, pipeline layout and pipeline built on it
//   group            a bind group whose texture view is of a texture with too many mips
//   pipeline-layout  a pipeline layout with five bind group layouts, over maxBindGroups, and its pipeline
//   pipeline         a pipeline whose fragment shader does not compile
//   bundle           a render bundle that sets the invalid pipeline, executed in the raw pass
//   query            an occlusion query set with 5000 queries, over the 4096 limit
// The page logs `uncaptured <frame>: <message>` for each uncaptured error and the running count at frames 19, 30,
// 40, 59, 70, 80 and 90.
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
let frames = 0;
let errors = 0;
const device = renderer.backend.device;
const report = device.onuncapturederror;
device.onuncapturederror = event => {
  errors++;
  if (errors <= 80) console.log(`uncaptured ${frames}: ${(event.error?.message ?? String(event)).split('\n').filter(Boolean).join(' | ').slice(0, 200)}`);
  report?.call(device, event);
};
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
const draw = color => { scene.background = new THREE.Color(color); renderer.render(scene, camera); };

const code = `
struct U { color: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var t: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs() -> @location(0) vec4f { return u.color + 0 * textureSample(t, s, vec2f(0.5)); }`;
const entries = [
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
];
let valid = null;
let objects = null;

function build(bad) {
  const format = renderer.backend.context.getConfiguration().format;
  const set = {};
  set.buffer = device.createBuffer({ label: `${mode}-buffer`, size: bad === 'buffer' ? 512 * 1024 * 1024 : 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  set.sampler = device.createSampler({ label: `${mode}-sampler`, lodMinClamp: bad === 'sampler' ? -1 : 0 });
  set.texture = device.createTexture({ label: `${mode}-texture`, size: [4, 4], mipLevelCount: bad === 'group' ? 4 : 1, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  set.layout = device.createBindGroupLayout({ label: `${mode}-layout`, entries: bad === 'layout' ? [...entries, { ...entries[0] }] : entries });
  set.group = device.createBindGroup({ label: `${mode}-group`, layout: set.layout, entries: [
    { binding: 0, resource: { buffer: set.buffer } },
    { binding: 1, resource: set.sampler },
    { binding: 2, resource: set.texture.createView() },
  ] });
  set.pipelineLayout = device.createPipelineLayout({ label: `${mode}-pipeline-layout`, bindGroupLayouts: bad === 'pipeline-layout' ? Array(5).fill(set.layout) : [set.layout] });
  const shader = bad === 'pipeline' || bad === 'bundle' ? code.replace('return u.color', 'return u.colour') : code;
  set.module = device.createShaderModule({ label: `${mode}-shader`, code: shader });
  set.pipeline = device.createRenderPipeline({
    label: `${mode}-pipeline`, layout: set.pipelineLayout,
    vertex: { module: set.module, entryPoint: 'vs' },
    fragment: { module: set.module, entryPoint: 'fs', targets: [{ format }] },
  });
  if (bad === 'bundle') {
    const encoder = device.createRenderBundleEncoder({ label: `${mode}-bundle`, colorFormats: [format] });
    encoder.setPipeline(set.pipeline);
    encoder.setBindGroup(0, set.group);
    encoder.draw(3);
    set.bundle = encoder.finish();
  }
  if (bad === 'query') set.query = device.createQuerySet({ label: `${mode}-query`, type: 'occlusion', count: 5000 });
  return set;
}

function rawPass(set) {
  device.queue.writeBuffer(set.buffer, 0, new Float32Array([0, 0, 1, 1]));
  const encoder = device.createCommandEncoder({ label: `${mode}-encoder` });
  const view = renderer.backend.context.getCurrentTexture().createView();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }], occlusionQuerySet: set.query });
  if (set.bundle) pass.executeBundles([set.bundle]);
  else {
    pass.setPipeline(set.pipeline);
    pass.setBindGroup(0, set.group);
    pass.draw(3);
  }
  pass.end();
  device.queue.submit([encoder.finish()]);
}

// The native device releases what three would release when it drops an object, which WebGPU leaves to the collector.
function release(set) {
  set.buffer.destroy();
  set.texture.destroy();
  if (!native) return;
  device.releaseBindGroup(set.group);
  device.releaseSampler(set.sampler);
  device.releasePipeline(set.pipeline);
  device.releasePipelineLayout(set.pipelineLayout);
  device.releaseBindGroupLayout(set.layout);
  device.releaseShader(set.module);
}

function frame() {
  if (frames < 20) draw(0xff0000);
  else {
    draw(0xffff00);
    if (frames === 20) {
      valid = build(null);
      objects = build(mode);
    }
    if (frames === 60) release(objects);
    rawPass(frames < 60 ? objects : valid);
  }
  if (native) submitGpuCommands(backend.takeFrame());
  if ([19, 30, 40, 59, 70, 80, 90].includes(frames)) console.log(`frame ${frames}: ${errors} uncaptured errors so far`);
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
