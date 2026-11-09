import { writeFileSync } from 'node:fs';
import { CommandEncoder, Opcode } from '../../../../packages/three-native/src/commands.js';
import { RecordingDevice } from '../../../../packages/three-native/src/NativeBackend.js';

const envelope = new CommandEncoder();
envelope.append(Opcode.CREATE_BUFFER, new Uint8Array([0, 1, 2, 255]));
envelope.append(Opcode.DRAW, new Uint8Array([42]));
envelope.append(Opcode.SUBMIT);
writeFileSync(new URL('./frame.bin', import.meta.url), envelope.finish());

const replay = new CommandEncoder();
replay.createBuffer(1, 16, 12);
replay.writeBuffer(1, 4, new Uint8Array([11, 22, 33, 44]));
replay.readBuffer(2, 1, 0, 16);
replay.destroyBuffer(1);
replay.readBuffer(3, 1, 0, 4);
writeFileSync(new URL('./buffers.bin', import.meta.url), replay.finish());

const shaders = new CommandEncoder();
shaders.createShader(4, 'broken-material', '@vertex fn main() -> @builtin(position) vec4f {\n  return vec4f(;\n}');
shaders.createShader(5, 'valid-material', '@compute @workgroup_size(1) fn main() {}');
shaders.destroyResource(4);
shaders.destroyResource(5);
shaders.createBuffer(6, 4, 12);
shaders.writeBuffer(6, 0, new Uint8Array([8, 7, 6, 5]));
shaders.readBuffer(7, 6, 0, 4);
writeFileSync(new URL('./shaders.bin', import.meta.url), shaders.finish());

const textures = new CommandEncoder();
textures.createTexture(10, { width: 2, height: 2, layers: 1, mips: 1, samples: 1, usage: 3, format: 'rgba8unorm' });
textures.createTextureView(14, 10, { baseMip: 0, mips: 1, baseLayer: 0, layers: 1, dimension: 1, aspect: 0, usage: 0 });
textures.writeTexture(10, { mip: 0, x: 0, y: 0, layer: 0, bytesPerRow: 8, rowsPerImage: 2, width: 2, height: 2, layers: 1 }, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]));
textures.readTexture(11, 10, { mip: 0, x: 0, y: 0, layer: 0, width: 2, height: 2 });
textures.writeTexture(10, { mip: 0, x: 0, y: 1, layer: 0, bytesPerRow: 0, rowsPerImage: 0, width: 2, height: 1, layers: 1 }, new Uint8Array([4, 3, 2, 1, 8, 7, 6, 5]));
textures.readTexture(13, 10, { mip: 0, x: 0, y: 1, layer: 0, width: 2, height: 1 });
textures.destroyTexture(10);
textures.readTexture(12, 10, { mip: 0, x: 0, y: 0, layer: 0, width: 1, height: 1 });
textures.destroyResource(14);
writeFileSync(new URL('./textures.bin', import.meta.url), textures.finish());

const samplers = new CommandEncoder();
samplers.createSampler(20, { addressU: 1, addressV: 0, addressW: 2, mag: 1, min: 1, mipmap: 1, lodMin: 0, lodMax: 8, compare: 2, anisotropy: 8 });
samplers.destroyResource(20);
samplers.destroyResource(20);
writeFileSync(new URL('./samplers.bin', import.meta.url), samplers.finish());

const layouts = new CommandEncoder();
layouts.createBindGroupLayout(30, [
  { binding: 0, visibility: 3, kind: 1, type: 0, dimension: 0, flags: 0, minSize: 16 },
  { binding: 1, visibility: 2, kind: 2, type: 2, dimension: 0, flags: 0, minSize: 0 },
  { binding: 2, visibility: 2, kind: 3, type: 2, dimension: 1, flags: 0, minSize: 0 },
]);
layouts.createBuffer(30, 16, 12);
layouts.destroyResource(30);
layouts.destroyResource(30);
writeFileSync(new URL('./layouts.bin', import.meta.url), layouts.finish());

const device = new RecordingDevice();
const layout = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: 3, buffer: { minBindingSize: 16 } },
  { binding: 1, visibility: 2, sampler: { type: 'comparison' } },
  { binding: 2, visibility: 2, texture: { sampleType: 'depth' } },
] });
const buffer = device.createBuffer({ size: 16, usage: 76 });
device.queue.writeBuffer(buffer, 0, new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
const sampler = device.createSampler({ compare: 'less' });
const texture = device.createTexture({ size: [1, 1], format: 'depth24plus', usage: 20 });
const view = texture.createView();
const group = device.createBindGroup({ layout, entries: [
  { binding: 0, resource: { buffer } },
  { binding: 1, resource: sampler },
  { binding: 2, resource: view },
] });
device.commands.readBuffer(100, buffer.handle, 0, 16);
device.releaseBindGroup(group);
device.releaseBindGroupLayout(layout);
writeFileSync(new URL('./bindings.bin', import.meta.url), device.takeFrame());

const pipelineDevice = new RecordingDevice();
const groupLayout = pipelineDevice.createBindGroupLayout({ entries: [] });
const pipelineLayout = pipelineDevice.createPipelineLayout({ bindGroupLayouts: [groupLayout] });
pipelineDevice.releaseBindGroupLayout(groupLayout);
pipelineDevice.commands.createBuffer(pipelineLayout.handle, 16, 12);
pipelineDevice.releasePipelineLayout(pipelineLayout);
writeFileSync(new URL('./pipeline-layouts.bin', import.meta.url), pipelineDevice.takeFrame());

const clearDevice = new RecordingDevice();
const colorTexture = clearDevice.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 17 });
const colorView = colorTexture.createView();
const encoder = clearDevice.createCommandEncoder();
encoder.beginRenderPass({ colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store', clearValue: [1, 0, 0, 1] }] }).end();
clearDevice.queue.submit([encoder.finish()]);
clearDevice.commands.readTexture(100, colorTexture.handle, { mip: 0, x: 0, y: 0, layer: 0, width: 2, height: 2 });
writeFileSync(new URL('./clear-pass.bin', import.meta.url), clearDevice.takeFrame());

const msaaDevice = new RecordingDevice();
const msaa = msaaDevice.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 16, sampleCount: 4 });
const resolved = msaaDevice.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: 17 });
const depth = msaaDevice.createTexture({ size: [2, 2], format: 'depth24plus', usage: 16, sampleCount: 4 });
const msaaEncoder = msaaDevice.createCommandEncoder();
msaaEncoder.beginRenderPass({
  colorAttachments: [{ view: msaa.createView(), resolveTarget: resolved.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 1, 0, 1] }],
  depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
}).end();
msaaDevice.queue.submit([msaaEncoder.finish()]);
msaaDevice.commands.readTexture(100, resolved.handle, { mip: 0, x: 0, y: 0, layer: 0, width: 2, height: 2 });
writeFileSync(new URL('./msaa-pass.bin', import.meta.url), msaaDevice.takeFrame());

const renderDevice = new RecordingDevice();
const renderLayout = renderDevice.createPipelineLayout({ bindGroupLayouts: [] });
const vertex = renderDevice.createShaderModule({ label: 'triangle vertex', code: '@vertex fn main(@location(0) p: vec2f) -> @builtin(position) vec4f { return vec4f(p, 0.0, 1.0); }' });
const fragment = renderDevice.createShaderModule({ label: 'triangle fragment', code: '@fragment fn main() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }' });
renderDevice.pushErrorScope('validation');
const pipeline = renderDevice.createRenderPipeline({
  label: 'triangle material', layout: renderLayout,
  vertex: { module: vertex, entryPoint: 'main', buffers: [{ arrayStride: 8, stepMode: 'vertex', attributes: [{ format: 'float32x2', offset: 0, shaderLocation: 0 }] }] },
  fragment: { module: fragment, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
  depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
});
renderDevice.popErrorScope();
const marker = renderDevice.createBuffer({ size: 4, usage: 12 });
renderDevice.queue.writeBuffer(marker, 0, new Uint8Array([4, 3, 2, 1]));
renderDevice.commands.readBuffer(100, marker.handle, 0, 4);
renderDevice.releaseRenderPipeline(pipeline);
renderDevice.releasePipelineLayout(renderLayout);
writeFileSync(new URL('./pipeline.bin', import.meta.url), renderDevice.takeFrame());

const diagnosticDevice = new RecordingDevice();
const diagnosticLayout = diagnosticDevice.createPipelineLayout({ bindGroupLayouts: [] });
const bad = diagnosticDevice.createShaderModule({ label: 'broken material', code: '@vertex fn main() -> @builtin(position) vec4f {\n return vec4f(;\n}' });
const good = diagnosticDevice.createShaderModule({ label: 'good vertex', code: '@vertex fn main() -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }' });
const pixel = diagnosticDevice.createShaderModule({ label: 'good fragment', code: '@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }' });
const makePipeline = (shader, label) => ({ label, layout: diagnosticLayout, vertex: { module: shader, buffers: [] }, fragment: { module: pixel, targets: [{ format: 'rgba8unorm' }] } });
diagnosticDevice.pushErrorScope('validation');
diagnosticDevice.createRenderPipeline(makePipeline(bad, 'broken material pipeline'));
diagnosticDevice.popErrorScope();
diagnosticDevice.pushErrorScope('validation');
diagnosticDevice.createRenderPipeline(makePipeline(good, 'good material pipeline'));
diagnosticDevice.popErrorScope();
const diagnosticMarker = diagnosticDevice.createBuffer({ size: 4, usage: 12 });
diagnosticDevice.queue.writeBuffer(diagnosticMarker, 0, new Uint8Array([9, 8, 7, 6]));
diagnosticDevice.commands.readBuffer(100, diagnosticMarker.handle, 0, 4);
writeFileSync(new URL('./pipeline-errors.bin', import.meta.url), diagnosticDevice.takeFrame());
