// WebGPU's rules for compute passes, timestamp queries and buffer mapping. The same code runs in headless Edge and in
// the host. Every frame draws a red background with a green box through three's WebGPURenderer, and a mode runs raw
// WebGPU cases. Each case starts at frame 10 + 4k, and every uncaptured error counts toward the case whose 4-frame
// window it arrives in, because Edge delivers errors a frame late and the host two. `R <name>: <value>` lines give
// results, and after the last case each case logs `case <name>: <n> errors`.
//   map               mapAsync for reading and writing, ranges, mapState, and its validation errors and aborts.
//   compute           compute pipelines, dispatches, indirect dispatches, storage buffers and their errors.
//   queries           timestamp query sets in render and compute passes, resolves and their errors.
//   queries-nofeature a device without timestamp-query, whose timestamp query sets cannot be created.
//   lost              maps and compute pipelines pending at device.destroy() and made after it.
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

const features = mode === 'queries-nofeature' ? ['core-features-and-limits'] : ['core-features-and-limits', 'timestamp-query'];
const backend = native
  ? new NativeBackend({ canvas }, { features, limits: { maxUniformBufferBindingSize: 65536 } })
  : undefined;
// In Edge, three requests every feature the adapter has, so a device without timestamp-query comes from the page.
const device0 = !native && mode === 'queries-nofeature' ? await (await navigator.gpu.requestAdapter()).requestDevice() : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, device: device0, antialias: false });
renderer._getFallback = null;
renderer.setSize(1280, 720, false);
result('init', await settle(renderer.init()));
const device = renderer.backend.device;
result('timestamp-query', device.features.has('timestamp-query'));
let frames = 0;
let current = 'setup';
const errors = new Map();
let logged = 0;
const report = device.onuncapturederror;
device.onuncapturederror = event => {
  errors.set(current, (errors.get(current) ?? 0) + 1);
  if (logged++ < 80) console.log(`uncaptured ${frames} (${current}): ${kind(event.error)} ${describe(event.error)}`);
  report?.call(device, event);
};

const scene = new THREE.Scene();
scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x00ff00 })));
scene.background = new THREE.Color(0xff0000);
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
camera.position.z = 4;

const buffer = (size, usage) => device.createBuffer({ size, usage });
const readable = size => buffer(size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
function submit(name, encode) {
  const encoder = device.createCommandEncoder();
  result(`${name} encode`, attempt(() => encode(encoder)));
  device.queue.submit([encoder.finish()]);
}
// Maps `target` for reading and logs the result, the mapState it passes through, and `read`'s view of its bytes.
function mapped(name, target, read = bytes => [...new Uint32Array(bytes).slice(0, 4)].join(','), offset, size) {
  const promise = target.mapAsync(GPUMapMode.READ, offset, size);
  const pending = target.mapState;
  settle(promise).then(value => {
    let bytes = '';
    if (target.mapState === 'mapped') {
      bytes = ` ${read(target.getMappedRange(offset, size))}`;
      target.unmap();
    }
    result(name, `${pending} ${value}${bytes} then ${target.mapState}`);
  });
}
const counting = size => {
  const source = device.createBuffer({ size, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(source, 0, Uint32Array.from({ length: size / 4 }, (_, i) => i * 10 + 1));
  return source;
};
const storageModule = () => device.createShaderModule({ label: 'storage', code: `
  @group(0) @binding(0) var<storage, read_write> data: array<u32>;
  @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < arrayLength(&data)) { data[id.x] = id.x * 3u + 1u; }
  }
  @compute @workgroup_size(64) fn other(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < arrayLength(&data)) { data[id.x] = 7u; }
  }` });
let computeKit = null;
function computeSetup() {
  if (computeKit) return computeKit;
  const module = storageModule();
  const pipeline = device.createComputePipeline({ label: 'fill', layout: 'auto', compute: { module, entryPoint: 'main' } });
  const storage = buffer(1024, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
  computeKit = { module, pipeline, storage, group };
  return computeKit;
}
function dispatch(name, { pipeline, group, x = 4, indirect = null, after } = {}) {
  submit(name, encoder => {
    const pass = encoder.beginComputePass();
    if (pipeline) pass.setPipeline(pipeline);
    if (group) pass.setBindGroup(0, group);
    if (indirect) pass.dispatchWorkgroupsIndirect(indirect, 0);
    else pass.dispatchWorkgroups(x);
    pass.end();
    after?.(encoder);
  });
}
let querySet = null;
const timestamps = () => querySet ??= device.createQuerySet({ type: 'timestamp', count: 8, label: 'times' });
const target = () => device.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT }).createView();
const timedPass = (encoder, writes) => encoder.beginRenderPass({
  colorAttachments: [{ view: target(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 1, 1] }], timestampWrites: writes,
});
// Resolves queries `first` to `first + count` and logs whether each pair is ordered.
function resolved(name, first, count) {
  const resolve = buffer(256, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
  const readback = readable(256);
  submit(`${name} resolve`, encoder => {
    encoder.resolveQuerySet(timestamps(), first, count, resolve, 0);
    encoder.copyBufferToBuffer(resolve, 0, readback, 0, 256);
  });
  mapped(name, readback, bytes => {
    const times = new BigUint64Array(bytes).slice(0, count);
    const pairs = [];
    for (let i = 0; i + 1 < count; i += 2) pairs.push(times[i + 1] >= times[i] && times[i] > 0n);
    return `ordered ${pairs.join(',')}`;
  });
}
const kept = {};

const cases = {
  map: [
    ['read', () => {
      const target = readable(256);
      device.queue.writeBuffer(target, 0, Uint32Array.from([11, 22, 33, 44, 55, 66]));
      result('read before', target.mapState);
      mapped('read', target);
    }],
    ['read-range', () => {
      const target = readable(256);
      device.queue.writeBuffer(target, 0, Uint32Array.from({ length: 64 }, (_, i) => i));
      target.mapAsync(GPUMapMode.READ, 8, 32).then(() => {
        result('read-range first', [...new Uint32Array(target.getMappedRange(8, 8))].join(','));
        result('read-range second', [...new Uint32Array(target.getMappedRange(16, 8))].join(','));
        for (const [label, offset, size] of [['overlap', 8, 4], ['before', 0, 8], ['past', 32, 16], ['unaligned offset', 12, 4], ['unaligned size', 40, 2]]) {
          result(`read-range ${label}`, attempt(() => target.getMappedRange(offset, size)));
        }
        const range = target.getMappedRange(32, 8);
        target.unmap();
        result('read-range detached', range.byteLength);
      }, error => result('read-range', `rejected ${error.name}`));
    }],
    ['write', () => {
      const source = buffer(64, GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC);
      source.mapAsync(GPUMapMode.WRITE, 16, 16).then(() => {
        const range = new Uint32Array(source.getMappedRange(16, 16));
        result('write initial', [...range].join(','));
        range.set([5, 6, 7, 8]);
        source.unmap();
        const readback = readable(64);
        submit('write copy', encoder => encoder.copyBufferToBuffer(source, 0, readback, 0, 64));
        mapped('write', readback, bytes => [...new Uint32Array(bytes)].join(','));
      }, error => result('write', `rejected ${error.name}`));
    }],
    ['no-usage', () => mapped('no-usage', counting(256))],
    ['wrong-mode', () => {
      const target = readable(256);
      settle(target.mapAsync(GPUMapMode.WRITE)).then(value => result('wrong-mode', value));
    }],
    ['both-modes', () => {
      const target = readable(256);
      settle(target.mapAsync(GPUMapMode.READ | GPUMapMode.WRITE)).then(value => result('both-modes', value));
    }],
    ['unaligned-offset', () => mapped('unaligned-offset', readable(256), undefined, 4)],
    ['unaligned-size', () => mapped('unaligned-size', readable(256), undefined, 0, 6)],
    ['out-of-range', () => mapped('out-of-range', readable(256), undefined, 0, 512)],
    ['empty-range', () => mapped('empty-range', readable(256), bytes => `bytes ${bytes.byteLength}`, 256)],
    ['pending-twice', () => {
      const target = readable(256);
      const first = settle(target.mapAsync(GPUMapMode.READ));
      const second = settle(target.mapAsync(GPUMapMode.READ));
      Promise.all([first, second]).then(([a, b]) => {
        result('pending-twice', `first ${a}, second ${b}, ${target.mapState}`);
        if (target.mapState === 'mapped') target.unmap();
      });
    }],
    ['unmap-pending', () => {
      const target = readable(256);
      const promise = settle(target.mapAsync(GPUMapMode.READ));
      target.unmap();
      result('unmap-pending state', target.mapState);
      promise.then(value => result('unmap-pending', `${value}, ${target.mapState}`));
    }],
    ['destroy-pending', () => {
      const target = readable(256);
      const promise = settle(target.mapAsync(GPUMapMode.READ));
      target.destroy();
      promise.then(value => result('destroy-pending', `${value}, ${target.mapState}`));
    }],
    ['destroyed', () => {
      const target = readable(256);
      target.destroy();
      mapped('destroyed', target);
    }],
    ['mapped-again', () => {
      const target = readable(256);
      target.mapAsync(GPUMapMode.READ).then(() => {
        settle(target.mapAsync(GPUMapMode.READ)).then(value => {
          result('mapped-again', `${value}, ${target.mapState}`);
          target.unmap();
        });
      });
    }],
    ['mapped-submit', () => {
      const target = readable(256);
      target.mapAsync(GPUMapMode.READ).then(() => {
        submit('mapped-submit', encoder => encoder.copyBufferToBuffer(counting(256), 0, target, 0, 64));
        result('mapped-submit state', target.mapState);
        target.unmap();
      });
    }],
    ['pending-submit', () => {
      const target = readable(256);
      const promise = settle(target.mapAsync(GPUMapMode.READ));
      submit('pending-submit', encoder => encoder.copyBufferToBuffer(counting(256), 0, target, 0, 64));
      promise.then(value => {
        result('pending-submit', value);
        if (target.mapState === 'mapped') target.unmap();
      });
    }],
    ['remap', () => {
      const target = readable(256);
      device.queue.writeBuffer(target, 0, Uint32Array.from([1, 2, 3, 4]));
      target.mapAsync(GPUMapMode.READ).then(() => {
        target.unmap();
        device.queue.writeBuffer(target, 0, Uint32Array.from([9, 8, 7, 6]));
        mapped('remap', target);
      });
    }],
    ['mapped-at-creation-range', () => {
      const target = device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
      new Uint32Array(target.getMappedRange(8, 8)).set([3, 4]);
      new Uint32Array(target.getMappedRange(0, 8)).set([1, 2]);
      result('mapped-at-creation-range overlap', attempt(() => target.getMappedRange(4, 8)));
      target.unmap();
      const readback = readable(32);
      submit('mapped-at-creation-range copy', encoder => encoder.copyBufferToBuffer(target, 0, readback, 0, 32));
      mapped('mapped-at-creation-range', readback, bytes => [...new Uint32Array(bytes)].join(','));
    }],
  ],
  compute: [
    ['dispatch', () => {
      const { pipeline, group, storage } = computeSetup();
      const readback = readable(1024);
      dispatch('dispatch', { pipeline, group, after: encoder => encoder.copyBufferToBuffer(storage, 0, readback, 0, 1024) });
      mapped('dispatch', readback, bytes => {
        const values = new Uint32Array(bytes);
        return `${values[0]},${values[1]},${values[255]} sum ${values.reduce((a, b) => a + b, 0)}`;
      });
    }],
    ['indirect', () => {
      const { pipeline, group, storage } = computeSetup();
      const args = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(args, 0, Uint32Array.from([2, 1, 1]));
      const clear = buffer(1024, GPUBufferUsage.COPY_SRC);
      const readback = readable(1024);
      submit('indirect clear', encoder => encoder.copyBufferToBuffer(clear, 0, storage, 0, 1024));
      result('indirect clear usage', 'storage lacks COPY_DST');
      dispatch('indirect', { pipeline, group, indirect: args, after: encoder => encoder.copyBufferToBuffer(storage, 0, readback, 0, 1024) });
      mapped('indirect', readback, bytes => {
        const values = new Uint32Array(bytes);
        return `${values[0]},${values[127]},${values[128]}`;
      });
    }],
    ['async', () => {
      const { module } = computeSetup();
      settle(device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'other' } })).then(value => result('async', value));
    }],
    ['async-invalid', () => {
      const { module } = computeSetup();
      device.pushErrorScope('validation');
      settle(device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'missing' } })).then(value => result('async-invalid', value));
      settle(device.popErrorScope()).then(value => result('async-invalid scope', value));
    }],
    ['bad-shader', () => {
      const module = device.createShaderModule({ label: 'bad-compute', code: '@compute @workgroup_size(1) fn main( {' });
      const pipeline = device.createComputePipeline({ label: 'bad', layout: 'auto', compute: { module, entryPoint: 'main' } });
      dispatch('bad-shader', { pipeline });
    }],
    ['bad-entry', () => {
      const pipeline = device.createComputePipeline({ label: 'missing-entry', layout: 'auto', compute: { module: computeSetup().module, entryPoint: 'missing' } });
      dispatch('bad-entry', { pipeline });
    }],
    ['no-pipeline', () => dispatch('no-pipeline', {})],
    ['too-many-groups', () => {
      const { pipeline, group } = computeSetup();
      dispatch('too-many-groups', { pipeline, group, x: 70000 });
    }],
    ['missing-group', () => dispatch('missing-group', { pipeline: computeSetup().pipeline })],
    ['wrong-usage', () => {
      const { pipeline } = computeSetup();
      result('wrong-usage group', attempt(() => {
        kept.wrongGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: counting(256) } }] });
      }));
      dispatch('wrong-usage', { pipeline, group: kept.wrongGroup });
    }],
    ['destroyed-storage', () => {
      const { pipeline } = computeSetup();
      const storage = buffer(256, GPUBufferUsage.STORAGE);
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
      storage.destroy();
      dispatch('destroyed-storage', { pipeline, group });
      kept.destroyedGroup = group;
    }],
    ['destroyed-storage-earlier', () => dispatch('destroyed-storage-earlier', { pipeline: computeSetup().pipeline, group: kept.destroyedGroup })],
    ['destroyed-indirect', () => {
      const { pipeline, group } = computeSetup();
      const args = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDIRECT });
      args.destroy();
      dispatch('destroyed-indirect', { pipeline, group, indirect: args });
    }],
    ['render-pipeline-in-compute', () => {
      const module = device.createShaderModule({ code: '@vertex fn v() -> @builtin(position) vec4f { return vec4f(0); }' });
      const render = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'v' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' } });
      submit('render-pipeline-in-compute', encoder => {
        const pass = encoder.beginComputePass();
        try {
          pass.setPipeline(render);
        } finally {
          pass.end();
        }
      });
    }],
    ['storage-vertex', () => {
      // A buffer that a compute pass writes and a render pass reads as vertices, as three's instancedArray().toAttribute() does.
      const module = device.createShaderModule({ code: `
        @group(0) @binding(0) var<storage, read_write> points: array<vec4f>;
        @compute @workgroup_size(1) fn fill(@builtin(global_invocation_id) id: vec3u) {
          points[id.x] = vec4f(f32(id.x) - 1.0, select(-1.0, 1.0, id.x == 1u), 0.0, 1.0);
        }
        @vertex fn vs(@location(0) p: vec4f) -> @builtin(position) vec4f { return p; }
        @fragment fn fs() -> @location(0) vec4f { return vec4f(1.0, 1.0, 0.0, 1.0); }` });
      const points = buffer(48, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX);
      const fill = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'fill' } });
      const draw = device.createRenderPipeline({
        layout: 'auto', vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 16, attributes: [{ format: 'float32x4', offset: 0, shaderLocation: 0 }] }] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });
      const texture = device.createTexture({ size: [16, 16], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const readback = readable(1024);
      dispatch('storage-vertex', {
        pipeline: fill, group: device.createBindGroup({ layout: fill.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: points } }] }), x: 3,
        after: encoder => {
          const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
          pass.setPipeline(draw);
          pass.setVertexBuffer(0, points);
          pass.draw(3);
          pass.end();
          encoder.copyTextureToBuffer({ texture, origin: [0, 0] }, { buffer: readback, bytesPerRow: 256 }, [16, 4]);
        },
      });
      mapped('storage-vertex', readback, bytes => {
        const row = new Uint8Array(bytes, 256 * 3, 64);
        return `row 3 yellow ${[...Array(16).keys()].filter(x => row[x * 4] === 255 && row[x * 4 + 1] === 255).length} of 16`;
      });
    }],
  ],
  queries: [
    ['create', () => {
      const set = timestamps();
      result('create', `${set.type} ${set.count} ${set.label}`);
    }],
    ['render', () => {
      submit('render', encoder => timedPass(encoder, { querySet: timestamps(), beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }).end());
      resolved('render', 0, 2);
    }],
    ['compute', () => {
      const { pipeline, group } = computeSetup();
      submit('compute', encoder => {
        const pass = encoder.beginComputePass({ timestampWrites: { querySet: timestamps(), beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(4);
        pass.end();
      });
      resolved('compute', 2, 2);
    }],
    ['end-only', () => {
      submit('end-only', encoder => timedPass(encoder, { querySet: timestamps(), endOfPassWriteIndex: 4 }).end());
      resolved('end-only', 4, 1);
    }],
    ['same-index', () => submit('same-index', encoder => timedPass(encoder, { querySet: timestamps(), beginningOfPassWriteIndex: 5, endOfPassWriteIndex: 5 }).end())],
    ['index-past-count', () => submit('index-past-count', encoder => timedPass(encoder, { querySet: timestamps(), beginningOfPassWriteIndex: 8, endOfPassWriteIndex: 9 }).end())],
    ['resolve-unaligned', () => submit('resolve-unaligned', encoder => encoder.resolveQuerySet(timestamps(), 0, 2, buffer(512, GPUBufferUsage.QUERY_RESOLVE), 128))],
    ['resolve-usage', () => submit('resolve-usage', encoder => encoder.resolveQuerySet(timestamps(), 0, 2, buffer(256, GPUBufferUsage.COPY_SRC), 0))],
    ['resolve-past-count', () => submit('resolve-past-count', encoder => encoder.resolveQuerySet(timestamps(), 6, 4, buffer(256, GPUBufferUsage.QUERY_RESOLVE), 0))],
    ['resolve-past-buffer', () => submit('resolve-past-buffer', encoder => encoder.resolveQuerySet(timestamps(), 0, 8, buffer(32, GPUBufferUsage.QUERY_RESOLVE), 0))],
    ['too-many', () => {
      result('too-many', attempt(() => { kept.big = device.createQuerySet({ type: 'timestamp', count: 5000 }); }));
      submit('too-many use', encoder => timedPass(encoder, { querySet: kept.big, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }).end());
    }],
    ['destroyed', () => {
      const set = device.createQuerySet({ type: 'timestamp', count: 2 });
      const encoder = device.createCommandEncoder();
      timedPass(encoder, { querySet: set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }).end();
      const commands = encoder.finish();
      set.destroy();
      device.queue.submit([commands]);
      kept.destroyedSet = set;
    }],
    ['destroyed-earlier', () => submit('destroyed-earlier', encoder => encoder.resolveQuerySet(kept.destroyedSet, 0, 2, buffer(256, GPUBufferUsage.QUERY_RESOLVE), 0))],
  ],
  'queries-nofeature': [
    ['create', () => result('create', attempt(() => device.createQuerySet({ type: 'timestamp', count: 2 })))],
  ],
  lost: [
    ['destroy', () => {
      const target = readable(256);
      const late = readable(256);
      const pending = settle(target.mapAsync(GPUMapMode.READ));
      const { module } = computeSetup();
      const pipeline = settle(device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } }));
      device.destroy();
      pending.then(value => result('mapAsync pending at destroy', `${value}, ${target.mapState}`));
      pipeline.then(value => result('createComputePipelineAsync pending at destroy', value));
      settle(late.mapAsync(GPUMapMode.READ)).then(value => result('mapAsync after destroy', value));
      settle(device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })).then(value => result('createComputePipelineAsync after destroy', value));
      stopped = true;
    }],
  ],
}[mode] ?? [];

let stopped = false;
const summary = 10 + 4 * cases.length + 12;
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
  if (frames === summary) {
    for (const [name] of cases) console.log(`case ${name}: ${errors.get(name) ?? 0} errors`);
    console.log(`case after: ${errors.get('after') ?? 0} errors`);
  }
  globalThis.__frame = frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
