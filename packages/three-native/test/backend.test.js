import assert from 'node:assert/strict';
import test from 'node:test';
import { WebGPURenderer } from 'three/webgpu';
import { NativeBackend, RecordingDevice } from '../src/NativeBackend.js';
import { decodeCommands, Opcode, streamFrame } from '../src/commands.js';

Object.assign(globalThis, { self: globalThis, requestAnimationFrame: () => 0, cancelAnimationFrame() {} });

test('renderer initializes the native backend and hides unsupported subgroups', async () => {
  const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
  const backend = new NativeBackend({ canvas }, { features: ['core-features-and-limits', 'subgroups'] });
  const renderer = new WebGPURenderer({ canvas, backend });
  await renderer.init();
  assert.equal(renderer.backend, backend);
  assert.equal(renderer.hasFeature('subgroups'), false);
  assert.equal(backend.recordingDevice.features.has('subgroups'), false);
  assert.equal(backend.recordingDevice.features.has('core-features-and-limits'), true);
  await renderer.dispose();
});

test('mapped creation and typed-array writes record the selected bytes', () => {
  const device = new RecordingDevice();
  const buffer = device.createBuffer({ size: 8, usage: 32, mappedAtCreation: true });
  new Uint8Array(buffer.getMappedRange()).set([1, 2, 3, 4, 5, 6, 7, 8]);
  buffer.unmap();
  device.queue.writeBuffer(buffer, 0, new Uint16Array([0x0102, 0x0304, 0x0506, 0x0708]), 1, 2);
  buffer.destroy();
  const records = decodeCommands(device.takeFrame());
  assert.deepEqual(records.map(record => record.opcode), [Opcode.CREATE_BUFFER, Opcode.WRITE_BUFFER, Opcode.WRITE_BUFFER, Opcode.DESTROY_BUFFER]);
  assert.deepEqual([...records[1].payload.slice(12)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...records[2].payload.slice(12)], [4, 3, 6, 5]);
  assert.throws(() => device.queue.writeBuffer(buffer, 0, new Uint8Array(4)));
  assert.deepEqual(decodeCommands(device.takeFrame()), []);
});

test('shader modules remove the subgroup directive and retain labels', () => {
  const device = new RecordingDevice({ features: ['subgroups'] });
  const shader = device.createShaderModule({ label: 'material-\u2603', code: 'enable subgroups;\n@fragment fn main() {}' });
  const [record] = decodeCommands(device.takeFrame());
  const view = new DataView(record.payload.buffer);
  const labelLength = view.getUint32(4, true);
  const decoder = new TextDecoder();
  assert.equal(record.opcode, Opcode.CREATE_SHADER);
  assert.equal(view.getUint32(0, true), shader.handle);
  assert.equal(decoder.decode(record.payload.slice(16, 16 + labelLength)), 'material-\u2603');
  assert.equal(decoder.decode(record.payload.slice(16 + labelLength)), '\n@fragment fn main() {}');
});

test('shader compilation information arrives on the response channel', async () => {
  const device = new RecordingDevice();
  const shader = device.createShaderModule({ label: 'broken', code: '@fragment fn main() {}' });
  const [record] = decodeCommands(device.takeFrame());
  const request = new DataView(record.payload.buffer).getUint32(12, true);
  device.receiveResponses([{ type: 'error', request, message: 'shader broken: wgsl:2:7 invalid expression' }]);
  const info = await shader.getCompilationInfo();
  assert.equal(info.messages[0].lineNum, 2);
  assert.equal(info.messages[0].linePos, 7);
  assert.match(info.messages[0].message, /invalid expression/);
});

test('program disposal records shader release', async () => {
  const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
  const backend = new NativeBackend({ canvas });
  const renderer = new WebGPURenderer({ canvas, backend });
  await renderer.init();
  const program = { stage: 'vertex', name: 'material', code: '@vertex fn main() {}' };
  backend.createProgram(program);
  backend.destroyProgram(program);
  assert.deepEqual(decodeCommands(backend.takeFrame()).map(record => record.opcode), [Opcode.CREATE_SHADER, Opcode.DESTROY_RESOURCE]);
  await renderer.dispose();
});

test('readbacks resolve by request ID and errors reject separately', async () => {
  const device = new RecordingDevice();
  const buffer = device.createBuffer({ size: 4, usage: 12 });
  const first = device.readBuffer(buffer, 0, 4);
  const second = device.readBuffer(buffer, 0, 4);
  const records = decodeCommands(device.takeFrame());
  const request = record => new DataView(record.payload.buffer).getUint32(0, true);
  device.receiveResponses([{ type: 'error', request: request(records[2]), message: 'read failed' }]);
  device.receiveResponses([{ type: 'readback', request: request(records[1]), bytes: [1, 2, 3, 4] }]);
  assert.deepEqual([...new Uint8Array(await first)], [1, 2, 3, 4]);
  await assert.rejects(second, /read failed/);
});

test('texture uploads copy the specified source bytes and readbacks use a request ID', async () => {
  const device = new RecordingDevice();
  const texture = device.createTexture({ size: [2, 1], format: 'rgba8unorm', usage: 3 });
  device.queue.writeTexture({ texture }, new Uint8Array([99, 1, 2, 3, 4, 5, 6, 7, 8]), { offset: 1 }, [2, 1]);
  const pending = device.readTexture(texture, { mip: 0, x: 0, y: 0, layer: 0, width: 2, height: 1 });
  const records = decodeCommands(device.takeFrame());
  assert.deepEqual(records.map(record => record.opcode), [Opcode.CREATE_TEXTURE, Opcode.WRITE_TEXTURE, Opcode.READ_TEXTURE]);
  assert.deepEqual([...records[1].payload.slice(40)], [1, 2, 3, 4, 5, 6, 7, 8]);
  const request = new DataView(records[2].payload.buffer).getUint32(0, true);
  device.receiveResponses([{ type: 'readback', request, bytes: [1, 2, 3, 4, 5, 6, 7, 8] }]);
  assert.deepEqual([...new Uint8Array(await pending)], [1, 2, 3, 4, 5, 6, 7, 8]);
  texture.destroy();
  assert.equal(decodeCommands(device.takeFrame())[0].opcode, Opcode.DESTROY_TEXTURE);
});

test('texture views retain their parent and record selected mip and layer ranges', () => {
  const device = new RecordingDevice();
  const texture = device.createTexture({ size: [4, 4, 2], format: 'rgba8unorm', usage: 4, mipLevelCount: 3 });
  const view = texture.createView({ dimension: '2d-array', baseMipLevel: 1, mipLevelCount: 2, baseArrayLayer: 1, arrayLayerCount: 1 });
  const records = decodeCommands(device.takeFrame());
  const payload = new DataView(records[1].payload.buffer);
  assert.equal(records[1].opcode, Opcode.CREATE_TEXTURE_VIEW);
  assert.equal(payload.getUint32(0, true), view.handle);
  assert.equal(payload.getUint32(4, true), texture.handle);
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => payload.getUint32(8 + index * 4, true)), [1, 2, 1, 1, 2, 0, 0]);
  texture.destroy();
  assert.throws(() => texture.createView());
});

test('sampler options and release are recorded', () => {
  const device = new RecordingDevice();
  const sampler = device.createSampler({ addressModeU: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8, compare: 'less' });
  device.releaseSampler(sampler);
  const records = decodeCommands(device.takeFrame());
  const payload = new DataView(records[0].payload.buffer);
  assert.deepEqual(records.map(record => record.opcode), [Opcode.CREATE_SAMPLER, Opcode.DESTROY_RESOURCE]);
  assert.equal(payload.getUint32(0, true), sampler.handle);
  assert.equal(payload.getUint32(4, true), 1);
  assert.equal(payload.getUint32(36, true), 2);
  assert.equal(payload.getUint32(40, true), 8);
});

test('shared samplers release only after the last binding', async () => {
  const { Texture } = await import('three/webgpu');
  const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
  const backend = new NativeBackend({ canvas });
  const renderer = new WebGPURenderer({ canvas, backend });
  await renderer.init();
  const texture = new Texture();
  const first = { texture, textureNode: {} };
  const second = { texture, textureNode: {} };
  backend.updateSampler(first);
  backend.updateSampler(second);
  backend.destroySampler(first);
  backend.destroySampler(second);
  assert.deepEqual(decodeCommands(backend.takeFrame()).map(record => record.opcode), [Opcode.CREATE_SAMPLER, Opcode.DESTROY_RESOURCE]);
  await renderer.dispose();
});

test('bind group layouts record binding types and release once', () => {
  const device = new RecordingDevice();
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: 3, buffer: { type: 'uniform', minBindingSize: 16 } },
    { binding: 1, visibility: 2, sampler: { type: 'comparison' } },
    { binding: 2, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
  ] });
  device.releaseBindGroupLayout(layout);
  device.releaseBindGroupLayout(layout);
  const records = decodeCommands(device.takeFrame());
  assert.deepEqual(records.map(record => record.opcode), [Opcode.CREATE_BIND_GROUP_LAYOUT, Opcode.DESTROY_RESOURCE]);
  const view = new DataView(records[0].payload.buffer);
  assert.equal(view.getUint32(0, true), layout.handle);
  assert.equal(view.getUint32(4, true), 3);
  assert.equal(view.getBigUint64(32, true), 16n);
  assert.equal(view.getUint32(8 + 32 + 12, true), 2);
  assert.equal(view.getUint32(8 + 64 + 16, true), 2);
  assert.throws(() => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 1, storageTexture: {} }] }), /Unsupported/);
});

test('shared bind group layouts are released after the last binding group', async () => {
  const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
  const backend = new NativeBackend({ canvas });
  const renderer = new WebGPURenderer({ canvas, backend });
  await renderer.init();
  const first = { bindings: [{ isUniformBuffer: true, visibility: 3 }] };
  const second = { bindings: [{ isUniformBuffer: true, visibility: 3 }] };
  assert.equal(backend.bindingUtils.createBindingsLayout(first), backend.bindingUtils.createBindingsLayout(second));
  backend.deleteBindGroupData(first);
  assert.deepEqual(decodeCommands(backend.takeFrame()).map(record => record.opcode), [Opcode.CREATE_BIND_GROUP_LAYOUT]);
  backend.deleteBindGroupData(second);
  assert.deepEqual(decodeCommands(backend.takeFrame()).map(record => record.opcode), [Opcode.DESTROY_RESOURCE]);
  await renderer.dispose();
});

test('bind groups retain typed buffer, sampler, and texture view handles', () => {
  const device = new RecordingDevice();
  const layout = device.createBindGroupLayout({ entries: [] });
  const buffer = device.createBuffer({ size: 32, usage: 64 });
  const sampler = device.createSampler();
  const texture = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 4 });
  const view = texture.createView();
  const group = device.createBindGroup({ layout, entries: [
    { binding: 0, resource: { buffer, offset: 16, size: 16 } },
    { binding: 1, resource: sampler },
    { binding: 2, resource: view },
  ] });
  device.releaseBindGroup(group);
  const records = decodeCommands(device.takeFrame());
  const record = records.find(item => item.opcode === Opcode.CREATE_BIND_GROUP);
  const bytes = new DataView(record.payload.buffer);
  assert.equal(bytes.getUint32(0, true), group.handle);
  assert.equal(bytes.getUint32(4, true), layout.handle);
  assert.equal(bytes.getBigUint64(24, true), 16n);
  assert.equal(bytes.getUint32(12 + 28 + 8, true), sampler.handle);
  assert.equal(bytes.getUint32(12 + 56 + 8, true), view.handle);
  assert.throws(() => device.createBindGroup({ layout, entries: [{ binding: 0, resource: {} }] }), /Invalid bind group resource/);
});

test('replacing and deleting cached bindings releases their groups', async () => {
  const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
  const backend = new NativeBackend({ canvas });
  const renderer = new WebGPURenderer({ canvas, backend });
  await renderer.init();
  const binding = { isUniformBuffer: true, visibility: 3 };
  backend.get(binding).buffer = backend.recordingDevice.createBuffer({ size: 16, usage: 64 });
  const group = { name: 'test', bindings: [binding] };
  backend.createBindings(group, [], 'key', 0);
  backend.updateBindings(group, [], 'key', 1);
  backend.deleteBindGroupData(group);
  assert.deepEqual(decodeCommands(backend.takeFrame()).map(record => record.opcode), [
    Opcode.CREATE_BUFFER, Opcode.CREATE_BIND_GROUP_LAYOUT, Opcode.CREATE_BIND_GROUP,
    Opcode.CREATE_BIND_GROUP, Opcode.DESTROY_RESOURCE, Opcode.DESTROY_RESOURCE, Opcode.DESTROY_RESOURCE,
  ]);
  await renderer.dispose();
});

test('pipeline layouts retain their ordered bind group layouts', () => {
  const device = new RecordingDevice();
  const first = device.createBindGroupLayout({ entries: [] });
  const second = device.createBindGroupLayout({ entries: [] });
  const pipeline = device.createPipelineLayout({ bindGroupLayouts: [second, first] });
  device.releasePipelineLayout(pipeline);
  const records = decodeCommands(device.takeFrame());
  const payload = new DataView(records[2].payload.buffer);
  assert.equal(records[2].opcode, Opcode.CREATE_PIPELINE_LAYOUT);
  assert.deepEqual([0, 4, 8, 12].map(offset => payload.getUint32(offset, true)), [pipeline.handle, 2, second.handle, first.handle]);
  assert.equal(records[3].opcode, Opcode.DESTROY_RESOURCE);
  assert.throws(() => device.createPipelineLayout({ bindGroupLayouts: [{}] }), /Invalid bind group layout/);
});

test('render passes record attachments at submission and reject resubmission', () => {
  const device = new RecordingDevice();
  const texture = device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 17 });
  const view = texture.createView();
  const encoder = device.createCommandEncoder();
  const color = { r: 1, g: 0, b: 0, a: 1 };
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view, clearValue: color, loadOp: 'clear', storeOp: 'store' }] });
  color.r = 0;
  assert.throws(() => encoder.finish(), /not complete/);
  pass.end();
  const buffer = encoder.finish();
  assert.deepEqual(decodeCommands(device.takeFrame()).map(item => item.opcode), [Opcode.CREATE_TEXTURE, Opcode.CREATE_TEXTURE_VIEW]);
  device.queue.submit([buffer]);
  const records = decodeCommands(device.takeFrame());
  assert.deepEqual(records.map(item => item.opcode), [Opcode.BEGIN_RENDER_PASS, Opcode.END_RENDER_PASS, Opcode.SUBMIT]);
  assert.equal(new DataView(records[0].payload.buffer).getFloat64(24, true), 1);
  assert.throws(() => device.queue.submit([buffer]), /Invalid command buffer/);
});

test('render pass records depth and multisample resolve attachments', () => {
  const device = new RecordingDevice();
  const color = device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 16, sampleCount: 4 });
  const target = device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 16 });
  const depth = device.createTexture({ size: [2, 2], format: 'depth24plus', usage: 16, sampleCount: 4 });
  const colorView = color.createView();
  const targetView = target.createView();
  const depthView = depth.createView();
  const encoder = device.createCommandEncoder();
  encoder.beginRenderPass({
    colorAttachments: [{ view: colorView, resolveTarget: targetView, loadOp: 'clear', storeOp: 'discard' }],
    depthStencilAttachment: { view: depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0.5 },
  }).end();
  device.queue.submit([encoder.finish()]);
  const record = decodeCommands(device.takeFrame()).find(item => item.opcode === Opcode.BEGIN_RENDER_PASS);
  const view = new DataView(record.payload.buffer);
  assert.equal(view.getUint32(4, true), 3);
  assert.equal(view.getUint32(12, true), targetView.handle);
  assert.equal(view.getUint32(56, true), depthView.handle);
  assert.equal(view.getUint32(60, true), 1);
  assert.equal(view.getFloat32(72, true), 0.5);
});

test('render pass draw state records typed fields and rejects use after end', () => {
  const device = new RecordingDevice();
  const texture = device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 16 });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] });
  const shader = device.createShaderModule({ code: '' });
  const pipeline = device.createRenderPipeline({ layout, vertex: { module: shader }, fragment: { module: shader, targets: [{ format: 'rgba8unorm' }] } });
  const vertices = device.createBuffer({ size: 64, usage: 32 });
  const indices = device.createBuffer({ size: 64, usage: 16 });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'load', storeOp: 'store' }] });
  pass.setPipeline(pipeline);
  pass.setVertexBuffer(1, vertices, 16);
  pass.setIndexBuffer(indices, 'uint32', 8, 24);
  pass.setViewport(0, 0, 2, 2, 0, 1);
  pass.drawIndexed(6, 2, 0, -3, 1);
  pass.end();
  assert.throws(() => pass.draw(3), /ended/);
  device.queue.submit([encoder.finish()]);
  const records = decodeCommands(device.takeFrame()).filter(item => item.opcode > Opcode.BEGIN_RENDER_PASS && item.opcode < Opcode.END_RENDER_PASS);
  assert.deepEqual(records.map(item => item.opcode), [Opcode.SET_PIPELINE, Opcode.SET_VERTEX_BUFFER, Opcode.SET_INDEX_BUFFER, Opcode.SET_VIEWPORT, Opcode.DRAW_INDEXED]);
  const field = (index, offset, bits = 32) => {
    const view = new DataView(records[index].payload.buffer);
    return bits === 64 ? Number(view.getBigUint64(offset, true)) : bits === 'f' ? view.getFloat32(offset, true) : view.getUint32(offset, true);
  };
  assert.equal(field(0, 0), pipeline.handle);
  assert.deepEqual([field(1, 0), field(1, 4), field(1, 8, 64), field(1, 16, 64)], [1, vertices.handle, 16, 0]);
  assert.deepEqual([field(2, 0), field(2, 4), field(2, 8, 64), field(2, 16, 64)], [1, indices.handle, 8, 24]);
  assert.equal(field(3, 8, 'f'), 2);
  assert.deepEqual([0, 4, 8, 12, 16].map(offset => field(4, offset)), [6, 2, 0, 0xfffffffd, 1]);
});

test('a canvas resize within a frame acquires a texture of the new size', async () => {
  const canvas = { width: 1280, height: 720, style: {}, addEventListener() {}, removeEventListener() {} };
  const backend = new NativeBackend({ canvas }, { features: ['core-features-and-limits'] });
  const renderer = new WebGPURenderer({ canvas, backend });
  await renderer.init();
  const { Scene, PerspectiveCamera } = await import('three/webgpu');
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  renderer.render(scene, camera);
  renderer.setSize(800, 600, false);
  renderer.render(scene, camera);
  assert.deepEqual([backend.context.getCurrentTexture().width, backend.context.getCurrentTexture().height], [800, 600]);
  const acquired = decodeCommands(backend.takeFrame()).filter(item => item.opcode === Opcode.ACQUIRE_SURFACE);
  assert.deepEqual(acquired.map(item => [...new Uint32Array(item.payload.buffer)].slice(1)), [[1280, 720], [800, 600]]);
  await renderer.dispose();
});

test('render target readbacks return the typed array three returns for the format', async () => {
  const canvas = { width: 4, height: 4, style: {}, addEventListener() {}, removeEventListener() {} };
  const backend = new NativeBackend({ canvas }, { features: ['core-features-and-limits'] });
  const renderer = new WebGPURenderer({ canvas, backend });
  await renderer.init();
  const { HalfFloatType, FloatType, RenderTarget, Scene, PerspectiveCamera } = await import('three/webgpu');
  const results = [];
  for (const type of [HalfFloatType, FloatType]) {
    const target = new RenderTarget(2, 2, { type });
    renderer.setRenderTarget(target);
    renderer.render(new Scene(), new PerspectiveCamera());
    renderer.setRenderTarget(null);
    const pending = renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    const read = decodeCommands(backend.takeFrame()).find(item => item.opcode === Opcode.READ_TEXTURE);
    const request = new DataView(read.payload.buffer).getUint32(0, true);
    const bytes = new Uint8Array(type === HalfFloatType ? 8 : 16).fill(0x3c);
    backend.recordingDevice.receiveResponses([{ type: 'readback', request, bytes }]);
    results.push(await pending);
  }
  assert.ok(results[0] instanceof Uint16Array && results[0].length === 4, String(results[0]));
  assert.ok(results[1] instanceof Float32Array && results[1].length === 4, String(results[1]));
  await renderer.dispose();
});

test('the canvas texture is acquired once per frame and released with the frame', async () => {
  const canvas = { width: 4, height: 2, style: {}, addEventListener() {}, removeEventListener() {} };
  const backend = new NativeBackend({ canvas }, { features: ['core-features-and-limits'] });
  const renderer = new WebGPURenderer({ canvas, backend });
  await renderer.init();
  const first = backend.context.getCurrentTexture();
  assert.equal(backend.context.getCurrentTexture(), first);
  assert.equal(backend.context.getConfiguration().format, 'bgra8unorm');
  const acquired = decodeCommands(backend.takeFrame()).filter(item => item.opcode === Opcode.ACQUIRE_SURFACE);
  assert.deepEqual(acquired.map(item => [...new Uint32Array(item.payload.buffer)]), [[first.handle, 4, 2]]);
  assert.equal(first.destroyed, true);
  assert.throws(() => first.createView(), /destroyed/);
  assert.notEqual(backend.context.getCurrentTexture(), first);
  await renderer.dispose();
});

test('automatic pipeline layouts are shared and bundles replay inline in each pass', () => {
  const device = new RecordingDevice();
  const shader = device.createShaderModule({ code: '' });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader }, fragment: { module: shader, targets: [{ format: 'rgba8unorm' }] } });
  const layout = pipeline.getBindGroupLayout(0);
  assert.equal(pipeline.getBindGroupLayout(0), layout);
  const bundleEncoder = device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
  bundleEncoder.setPipeline(pipeline);
  bundleEncoder.draw(3);
  const bundle = bundleEncoder.finish();
  assert.throws(() => bundleEncoder.draw(3), /finished/);
  const view = device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 16 }).createView();
  const encoder = device.createCommandEncoder();
  for (let i = 0; i < 2; i++) {
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
    pass.executeBundles([bundle]);
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
  device.releaseRenderPipeline(pipeline);
  const records = decodeCommands(device.takeFrame());
  const spec = JSON.parse(new TextDecoder().decode(records.find(item => item.opcode === Opcode.CREATE_RENDER_PIPELINE).payload.slice(8)));
  assert.equal(spec.layout, 0);
  assert.equal(spec.vertex.entryPoint, null);
  assert.equal(records.filter(item => item.opcode === Opcode.GET_BIND_GROUP_LAYOUT).length, 1);
  assert.equal(records.filter(item => item.opcode === Opcode.DRAW).length, 2);
  const released = records.filter(item => item.opcode === Opcode.DESTROY_RESOURCE).map(item => new DataView(item.payload.buffer).getUint32(0, true));
  assert.deepEqual(released, [layout.handle, pipeline.handle]);
});

test('render pipeline snapshots its shader and vertex descriptors', () => {
  const device = new RecordingDevice();
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] });
  const vertex = device.createShaderModule({ code: '@vertex fn main() {}' });
  const fragment = device.createShaderModule({ code: '@fragment fn main() {}' });
  const attribute = { format: 'float32x2', offset: 0, shaderLocation: 0 };
  const pipeline = device.createRenderPipeline({
    label: 'material', layout,
    vertex: { module: vertex, entryPoint: 'main', buffers: [{ arrayStride: 8, attributes: [attribute] }] },
    fragment: { module: fragment, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  });
  attribute.offset = 4;
  const record = decodeCommands(device.takeFrame()).find(item => item.opcode === Opcode.CREATE_RENDER_PIPELINE);
  const spec = JSON.parse(new TextDecoder().decode(record.payload.slice(8)));
  assert.equal(new DataView(record.payload.buffer).getUint32(0, true), pipeline.handle);
  assert.equal(spec.layout, layout.handle);
  assert.equal(spec.vertex.module, vertex.handle);
  assert.equal(spec.buffers[0].attributes[0].offset, 0);
  assert.equal(spec.depth.depthCompare, 'less');
  assert.equal(spec.targets[0].writeMask, 15);
});

test('pipeline validation scopes resolve from the separate response channel', async () => {
  const device = new RecordingDevice();
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] });
  const vertex = device.createShaderModule({ code: '@vertex fn main() {}' });
  const descriptor = { layout, vertex: { module: vertex, buffers: [] } };
  device.pushErrorScope('validation');
  device.createRenderPipeline(descriptor);
  const first = device.popErrorScope();
  device.pushErrorScope('validation');
  device.createRenderPipeline(descriptor);
  const second = device.popErrorScope();
  const records = decodeCommands(device.takeFrame()).filter(item => item.opcode === Opcode.CREATE_RENDER_PIPELINE);
  const request = item => new DataView(item.payload.buffer).getUint32(4, true);
  device.receiveResponses([{ type: 'error', request: request(records[1]), message: 'bad pipeline' }]);
  device.receiveResponses([{ type: 'validation', request: request(records[0]) }]);
  assert.equal(await first, null);
  assert.equal((await second).message, 'bad pipeline');
});

const creates = new Set([Opcode.CREATE_BUFFER, Opcode.CREATE_TEXTURE, Opcode.CREATE_TEXTURE_VIEW, Opcode.CREATE_SAMPLER, Opcode.CREATE_SHADER,
  Opcode.CREATE_BIND_GROUP_LAYOUT, Opcode.CREATE_BIND_GROUP, Opcode.CREATE_PIPELINE_LAYOUT, Opcode.CREATE_RENDER_PIPELINE, Opcode.GET_BIND_GROUP_LAYOUT, Opcode.ACQUIRE_SURFACE]);
const releases = new Set([Opcode.DESTROY_BUFFER, Opcode.DESTROY_TEXTURE, Opcode.DESTROY_RESOURCE]);

// Tracks live handles as the host's one executor does: a create of a live handle is rejected,
// a texture takes its views with it, and the surface lasts one frame.
function replayHandles(frames) {
  const live = new Map();
  const duplicates = [];
  const released = new Set();
  const repeated = [];
  for (const bytes of frames) {
    for (const { opcode, payload } of decodeCommands(bytes)) {
      if (!creates.has(opcode) && !releases.has(opcode)) continue;
      const view = new DataView(payload.buffer);
      const handle = view.getUint32(0, true);
      if (creates.has(opcode)) {
        if (live.has(handle)) duplicates.push(handle);
        else live.set(handle, { parent: opcode === Opcode.CREATE_TEXTURE_VIEW ? view.getUint32(4, true) : null, surface: opcode === Opcode.ACQUIRE_SURFACE });
      } else if (releases.has(opcode)) {
        if (released.has(handle)) repeated.push(handle);
        released.add(handle);
        live.delete(handle);
        for (const [child, entry] of live) if (entry.parent === handle) live.delete(child);
      }
    }
    for (const [handle, entry] of live) if (entry.surface) {
      live.delete(handle);
      for (const [child, other] of live) if (other.parent === handle) live.delete(child);
    }
  }
  return { live, duplicates, repeated };
}

async function boxRenderer(canvas, color) {
  const { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } = await import('three/webgpu');
  const backend = new NativeBackend({ canvas }, { features: ['core-features-and-limits'] });
  const renderer = new WebGPURenderer({ canvas, backend });
  await renderer.init();
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color })));
  return { backend, renderer, render: () => renderer.render(scene, new PerspectiveCamera()) };
}

test('a replaced renderer releases its resources and the next renderer reuses no handle or frame', async () => {
  const listeners = new Set();
  Object.assign(globalThis, { addEventListener: (type, listener) => listeners.add(listener), removeEventListener: (type, listener) => listeners.delete(listener) });
  try {
    const canvas = { width: 4, height: 4, style: {}, addEventListener() {}, removeEventListener() {} };
    const first = await boxRenderer(canvas, 0xff0000);
    const frames = [];
    for (let i = 0; i < 2; i++) {
      first.render();
      frames.push(first.backend.takeFrame());
    }
    const stale = [];
    first.backend.recordingDevice.onuncapturederror = event => stale.push(event);
    const created = replayHandles(frames).live;
    await first.renderer.dispose();
    const second = await boxRenderer(canvas, 0x00ff00);
    second.render();
    frames.push(second.backend.takeFrame());
    const { live, duplicates } = replayHandles(frames);
    assert.deepEqual(duplicates, []);
    assert.deepEqual([...created.keys()].filter(handle => live.has(handle)), []);
    assert.deepEqual(frames.map(streamFrame).slice(1).map((frame, index) => frame - streamFrame(frames[index])), [1, 1]);
    const fresh = [];
    second.backend.recordingDevice.onuncapturederror = event => fresh.push(event);
    for (const listener of listeners) listener({ responses: [{ type: 'error', request: null, message: 'lost' }] });
    assert.deepEqual([stale.length, fresh.length], [0, 1]);
    await second.renderer.dispose();
  } finally {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
  }
});

test('a second live native renderer is rejected until the first is disposed', async () => {
  const canvas = { width: 4, height: 4, style: {}, addEventListener() {}, removeEventListener() {} };
  const first = await boxRenderer(canvas, 0xff0000);
  assert.throws(() => new NativeBackend({ canvas }), /one live NativeBackend/);
  await first.renderer.dispose();
  const second = await boxRenderer(canvas, 0x00ff00);
  await second.renderer.dispose();
});

test('a renderer disposed before init or after a failed init leaves the surface to the next renderer', async () => {
  const canvas = { width: 4, height: 4, style: {}, addEventListener() {}, removeEventListener() {} };
  const unused = new WebGPURenderer({ canvas, backend: new NativeBackend({ canvas }, { features: ['core-features-and-limits'] }) });
  await unused.dispose();
  class FailingBackend extends NativeBackend {
    async init(renderer) {
      await super.init(renderer);
      throw new Error('init failed');
    }
  }
  const failed = new WebGPURenderer({ canvas, backend: new FailingBackend({ canvas }, { features: ['core-features-and-limits'] }) });
  await assert.rejects(failed.init());
  await assert.rejects(failed.dispose());
  const next = await boxRenderer(canvas, 0x00ff00);
  next.render();
  assert.ok(decodeCommands(next.backend.takeFrame()).some(record => record.opcode === Opcode.ACQUIRE_SURFACE));
  await next.renderer.dispose();
});

test('a renderer replaced without awaiting its dispose hands the surface to the next one', async () => {
  const listeners = new Set();
  Object.assign(globalThis, { addEventListener: (type, listener) => listeners.add(listener), removeEventListener: (type, listener) => listeners.delete(listener) });
  try {
    const canvas = { width: 4, height: 4, style: {}, addEventListener() {}, removeEventListener() {} };
    const first = await boxRenderer(canvas, 0xff0000);
    first.render();
    const late = first.backend.recordingDevice.readBuffer([...first.backend.recordingDevice.buffers][0], 0, 4);
    const frames = [first.backend.takeFrame()];
    const [{ payload }] = decodeCommands(frames[0]).filter(record => record.opcode === Opcode.READ_BUFFER);
    const request = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
    const { Scene, PerspectiveCamera } = await import('three/webgpu');
    const disposed = first.renderer.dispose();
    const backend = new NativeBackend({ canvas }, { features: ['core-features-and-limits'] });
    const renderer = new WebGPURenderer({ canvas, backend });
    await renderer.init();
    assert.throws(() => new NativeBackend({ canvas }), /one live NativeBackend/);
    await disposed;
    renderer.render(new Scene(), new PerspectiveCamera());
    frames.push(backend.takeFrame());
    const fresh = [];
    backend.recordingDevice.onuncapturederror = event => fresh.push(event);
    for (const listener of listeners) listener({ responses: [{ type: 'readback', request, bytes: new ArrayBuffer(4) }, { type: 'error', request, message: 'stale' }] });
    await assert.rejects(late, /Device is destroyed/);
    assert.deepEqual(fresh, []);
    assert.deepEqual(replayHandles(frames).duplicates, []);
    assert.deepEqual(replayHandles(frames).repeated, []);
    await renderer.dispose();
  } finally {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
  }
});
