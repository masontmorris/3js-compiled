// WebGPU's rules for limits, error scopes, copies and destroyed objects. The same code runs in headless Edge and in
// the host. Every frame draws a red background with a
// green box through three's WebGPURenderer, and a mode runs raw WebGPU cases. Each case starts at frame 10 + 4k, and
// every uncaptured error counts toward the case whose 4-frame window it arrives in, because Edge delivers errors a
// frame late and the host two. `R <name>: <value>` lines give results, and frame 80 logs `case <name>: <n> errors`.
//   limits-rule       requiredLimits worse than WebGPU's defaults for maximums and alignments, one better one, and
//                     one equal one; logs device.limits for each.
//   limits-over-align requires minUniformBufferOffsetAlignment 1, better than any adapter has.
//   limits-over-max   requires maxBindGroups 1000.
//   scopes            nested error scopes with the validation, out-of-memory and internal filters.
//   copies            copy and clear validation errors on live objects, and destroyed buffers and textures in copies,
//                     render pass attachments, bind groups and vertex buffers, destroyed in the same frame or before.
//   destroyed         promise-returning calls pending at device.destroy() and made after it.
import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const native = typeof submitGpuCommands === 'function';
const mode = native ? globalThis.__sceneName : new URLSearchParams(location.search).get('scene');
const canvas = native
  ? { width: 1280, height: 720, style: {}, addEventListener() {}, removeEventListener() {} }
  : document.querySelector('canvas');
const result = (name, value) => console.log(`R ${name}: ${value}`);
const describe = error => (error?.message ?? String(error)).split('\n').filter(Boolean).join(' | ').slice(0, 200);
const kind = value => value === null ? 'null' : value === undefined ? 'undefined' : typeof value === 'number' ? `Number ${value}` : value?.constructor?.name ?? typeof value;
const settle = promise => promise.then(value => `resolved ${kind(value)}${value?.message ? ` (${describe(value)})` : ''}`,
  error => `rejected ${error?.name ?? kind(error)} (${describe(error)})`);
const attempt = fn => { try { const value = fn(); return `ok ${kind(value)}`; } catch (error) { return `threw ${error?.name ?? kind(error)} (${describe(error)})`; } };

const requiredLimits = {
  'limits-rule': {
    maxTextureDimension2D: 4096, maxBindGroups: 2, maxVertexBuffers: 4, maxBufferSize: 1048576,
    minUniformBufferOffsetAlignment: 512, minStorageBufferOffsetAlignment: 1024, maxColorAttachments: 8,
    maxStorageBufferBindingSize: 268435456,
  },
  'limits-over-align': { minUniformBufferOffsetAlignment: 1 },
  'limits-over-max': { maxBindGroups: 1000 },
}[mode];
const backend = native
  ? new NativeBackend({ canvas, requiredLimits }, { features: ['core-features-and-limits'], limits: { maxUniformBufferBindingSize: 65536 } })
  : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false, requiredLimits });
renderer._getFallback = null;
renderer.setSize(1280, 720, false);
result('init', await settle(renderer.init()));
const device = renderer.backend.device;
let frames = 0;
let current = 'setup';
const errors = new Map();
let logged = 0;
if (device) {
  const report = device.onuncapturederror;
  device.onuncapturederror = event => {
    errors.set(current, (errors.get(current) ?? 0) + 1);
    if (logged++ < 60) console.log(`uncaptured ${frames} (${current}): ${kind(event.error)} ${describe(event.error)}`);
    report?.call(device, event);
  };
  if (requiredLimits) for (const name of [...Object.keys(requiredLimits), 'maxUniformBufferBindingSize']) result(`limits.${name}`, device.limits[name]);
}

const scene = new THREE.Scene();
scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x00ff00 })));
scene.background = new THREE.Color(0xff0000);
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
camera.position.z = 4;

const broken = label => device.createShaderModule({ label, code: '@fragment fn main( -> {' });
const pop = name => settle(device.popErrorScope()).then(value => result(name, value));
const copyUsage = GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
const buffer = (size = 256, usage = copyUsage) => device.createBuffer({ size, usage });
const texture = (usage = GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST) =>
  device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage });
function submit(name, encode) {
  const encoder = device.createCommandEncoder();
  result(`${name} encode`, attempt(() => encode(encoder)));
  device.queue.submit([encoder.finish()]);
}
function pass(encoder, view) {
  return encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
}
let pipelines = null;
function makePipelines() {
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var<uniform> u: vec4f;
    @vertex fn vsUniform(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return u + vec4f(f32(i), 0, 0, 1); }
    @vertex fn vsVertex(@location(0) p: vec4f) -> @builtin(position) vec4f { return p; }
    @fragment fn fsMain() -> @location(0) vec4f { return vec4f(1); }` });
  const targets = [{ format: 'rgba8unorm' }];
  return {
    uniform: device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vsUniform' }, fragment: { module, entryPoint: 'fsMain', targets } }),
    vertex: device.createRenderPipeline({
      layout: 'auto', fragment: { module, entryPoint: 'fsMain', targets },
      vertex: { module, entryPoint: 'vsVertex', buffers: [{ arrayStride: 16, attributes: [{ format: 'float32x4', offset: 0, shaderLocation: 0 }] }] },
    }),
  };
}
const target = () => texture(GPUTextureUsage.RENDER_ATTACHMENT).createView();
const kept = {};

const cases = {
  scopes: [
    ['nested-same', () => {
      device.pushErrorScope('validation');
      device.pushErrorScope('validation');
      broken('a');
      pop('nested-same inner');
      pop('nested-same outer');
    }],
    ['oom-inside-validation', () => {
      device.pushErrorScope('validation');
      device.pushErrorScope('out-of-memory');
      broken('b');
      pop('oom-inside-validation oom');
      pop('oom-inside-validation validation');
    }],
    ['internal-inside-validation', () => {
      device.pushErrorScope('validation');
      device.pushErrorScope('internal');
      broken('c');
      pop('internal-inside-validation internal');
      pop('internal-inside-validation validation');
    }],
    ['oom-only', () => {
      device.pushErrorScope('out-of-memory');
      broken('d');
      pop('oom-only oom');
    }],
    ['first-error-kept', () => {
      device.pushErrorScope('validation');
      broken('first');
      broken('second');
      pop('first-error-kept');
    }],
    ['empty-stack', () => { pop('empty-stack'); }],
    ['bad-filter', () => { result('bad-filter push', attempt(() => device.pushErrorScope('bogus'))); }],
    ['submit-in-scope', () => {
      device.pushErrorScope('validation');
      submit('submit-in-scope', encoder => encoder.copyBufferToBuffer(buffer(), 2, buffer(), 0, 64));
      pop('submit-in-scope');
    }],
    ['finish-in-scope', () => {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer(), 2, buffer(), 0, 64);
      device.pushErrorScope('validation');
      const commands = encoder.finish();
      pop('finish-in-scope');
      device.queue.submit([commands]);
    }],
    ['valid-in-scope', () => {
      device.pushErrorScope('validation');
      device.createShaderModule({ code: '@fragment fn main() -> @location(0) vec4f { return vec4f(1); }' });
      pop('valid-in-scope');
    }],
  ],
  copies: [
    ['unaligned-offset', () => submit('unaligned-offset', encoder => encoder.copyBufferToBuffer(buffer(), 2, buffer(), 0, 64))],
    ['unaligned-size', () => submit('unaligned-size', encoder => encoder.copyBufferToBuffer(buffer(), 0, buffer(), 0, 6))],
    ['out-of-range', () => submit('out-of-range', encoder => encoder.copyBufferToBuffer(buffer(), 0, buffer(), 0, 512))],
    ['clear-unaligned', () => submit('clear-unaligned', encoder => encoder.clearBuffer(buffer(), 2))],
    ['bytes-per-row', () => submit('bytes-per-row', encoder => encoder.copyBufferToTexture({ buffer: buffer(1024), bytesPerRow: 100 }, { texture: texture() }, [4, 4]))],
    ['texture-bounds', () => submit('texture-bounds', encoder => encoder.copyTextureToTexture({ texture: texture() }, { texture: texture() }, [8, 8]))],
    ['destroyed-before-submit', () => {
      const source = buffer();
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, buffer(), 0, 64);
      const commands = encoder.finish();
      source.destroy();
      device.queue.submit([commands]);
      kept.buffer = source;
    }],
    ['destroyed-earlier-frame', () => submit('destroyed-earlier-frame', encoder => encoder.copyBufferToBuffer(kept.buffer, 0, buffer(), 0, 64))],
    ['attachment-destroyed', () => {
      const attachment = texture(GPUTextureUsage.RENDER_ATTACHMENT);
      const view = attachment.createView();
      attachment.destroy();
      submit('attachment-destroyed', encoder => pass(encoder, view).end());
      kept.view = view;
    }],
    ['attachment-destroyed-earlier', () => submit('attachment-destroyed-earlier', encoder => pass(encoder, kept.view).end())],
    ['bind-group-destroyed', () => {
      pipelines ??= makePipelines();
      const uniform = buffer(16, GPUBufferUsage.UNIFORM);
      const group = device.createBindGroup({ layout: pipelines.uniform.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
      uniform.destroy();
      submit('bind-group-destroyed', encoder => {
        const p = pass(encoder, target());
        p.setPipeline(pipelines.uniform);
        p.setBindGroup(0, group);
        p.draw(3);
        p.end();
      });
      kept.group = group;
    }],
    ['bind-group-destroyed-earlier', () => submit('bind-group-destroyed-earlier', encoder => {
      const p = pass(encoder, target());
      p.setPipeline(pipelines.uniform);
      p.setBindGroup(0, kept.group);
      p.draw(3);
      p.end();
    })],
    ['vertex-destroyed', () => {
      pipelines ??= makePipelines();
      const vertices = buffer(64, GPUBufferUsage.VERTEX);
      vertices.destroy();
      submit('vertex-destroyed', encoder => {
        const p = pass(encoder, target());
        p.setPipeline(pipelines.vertex);
        p.setVertexBuffer(0, vertices);
        p.draw(3);
        p.end();
      });
      kept.vertices = vertices;
    }],
    ['vertex-destroyed-earlier', () => submit('vertex-destroyed-earlier', encoder => {
      const p = pass(encoder, target());
      p.setPipeline(pipelines.vertex);
      p.setVertexBuffer(0, kept.vertices);
      p.draw(3);
      p.end();
    })],
    ['size-and-destroyed', () => {
      const source = buffer();
      source.destroy();
      submit('size-and-destroyed', encoder => encoder.copyBufferToBuffer(source, 2, buffer(), 0, 64));
    }],
    ['write-destroyed', () => {
      const destination = buffer();
      destination.destroy();
      result('write-destroyed', attempt(() => device.queue.writeBuffer(destination, 0, new Uint8Array(16))));
    }],
    ['write-texture-destroyed', () => {
      const destination = texture();
      destination.destroy();
      result('write-texture-destroyed', attempt(() => device.queue.writeTexture({ texture: destination }, new Uint8Array(64), { bytesPerRow: 16 }, [4, 4])));
    }],
    ['valid-copy', () => submit('valid-copy', encoder => encoder.copyBufferToBuffer(buffer(), 0, buffer(), 0, 64))],
  ],
  destroyed: [
    ['destroy', () => {
      const shader = device.createShaderModule({ code: '@vertex fn v() -> @builtin(position) vec4f { return vec4f(0); }' });
      device.pushErrorScope('validation');
      const pendingPop = settle(device.popErrorScope());
      const pendingInfo = settle(shader.getCompilationInfo().then(info => info.messages.length));
      const pendingWork = settle(device.queue.onSubmittedWorkDone());
      device.pushErrorScope('validation');
      device.destroy();
      pendingPop.then(value => result('popErrorScope pending at destroy', value));
      pendingInfo.then(value => result('getCompilationInfo pending at destroy', value));
      pendingWork.then(value => result('onSubmittedWorkDone pending at destroy', value));
      for (const [name, call] of [
        ['popErrorScope of a scope pushed before destroy', () => device.popErrorScope()],
        ['popErrorScope with an empty stack', () => device.popErrorScope()],
        ['popErrorScope after a push after destroy', () => { device.pushErrorScope('validation'); return device.popErrorScope(); }],
        ['onSubmittedWorkDone after destroy', () => device.queue.onSubmittedWorkDone()],
        ['getCompilationInfo after destroy', () => shader.getCompilationInfo().then(info => info.messages.length)],
        ['createRenderPipelineAsync after destroy', () => device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: shader, entryPoint: 'v' } })],
      ]) {
        let promise = null;
        const thrown = attempt(() => { promise = call(); });
        if (promise) settle(promise).then(value => result(name, value));
        else result(name, thrown);
      }
      for (const [name, call] of [
        ['createBuffer after destroy', () => device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST })],
        ['createShaderModule after destroy', () => device.createShaderModule({ code: '' })],
        ['createCommandEncoder after destroy', () => device.createCommandEncoder()],
      ]) result(name, attempt(call));
      stopped = true;
    }],
  ],
}[mode] ?? [];

let stopped = !device;
function frame() {
  if (!stopped) {
    renderer.render(scene, camera);
    const index = (frames - 10) / 4;
    if (Number.isInteger(index) && index >= 0 && index < cases.length) {
      current = cases[index][0];
      cases[index][1]();
    }
    if (native && !stopped) submitGpuCommands(renderer.backend.takeFrame());
  }
  if (frames === 10 + 4 * cases.length) current = 'after';
  if (frames === 80) {
    for (const [name] of cases) console.log(`case ${name}: ${errors.get(name) ?? 0} errors`);
    console.log(`case after: ${errors.get('after') ?? 0} errors`);
  }
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
