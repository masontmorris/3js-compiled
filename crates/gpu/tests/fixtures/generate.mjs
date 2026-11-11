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

const drawDevice = new RecordingDevice();
const drawGroupLayout = drawDevice.createBindGroupLayout({ entries: [{ binding: 0, visibility: 2, buffer: { minBindingSize: 16 } }] });
const drawLayout = drawDevice.createPipelineLayout({ bindGroupLayouts: [drawGroupLayout] });
const drawVertex = drawDevice.createShaderModule({ label: 'draw vertex', code: '@vertex fn main(@location(0) p: vec2f) -> @builtin(position) vec4f { return vec4f(p, 0.0, 1.0); }' });
const drawFragment = drawDevice.createShaderModule({ label: 'draw fragment', code: '@group(0) @binding(0) var<uniform> color: vec4f; @fragment fn main() -> @location(0) vec4f { return color; }' });
const drawPipeline = drawDevice.createRenderPipeline({
  label: 'draw material', layout: drawLayout,
  vertex: { module: drawVertex, buffers: [{ arrayStride: 8, attributes: [{ format: 'float32x2', offset: 0, shaderLocation: 0 }] }] },
  fragment: { module: drawFragment, targets: [{ format: 'rgba8unorm' }] },
});
const vertices = drawDevice.createBuffer({ size: 24, usage: 40 });
drawDevice.queue.writeBuffer(vertices, 0, new Float32Array([-1, -1, 3, -1, -1, 3]));
const indices = drawDevice.createBuffer({ size: 8, usage: 24 });
drawDevice.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 0]));
const uniform = drawDevice.createBuffer({ size: 16, usage: 72 });
drawDevice.queue.writeBuffer(uniform, 0, new Float32Array([1, 0, 0, 1]));
const drawGroup = drawDevice.createBindGroup({ layout: drawGroupLayout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
const outputs = [0, 1].map(() => drawDevice.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 17 }));
const drawEncoder = drawDevice.createCommandEncoder();
for (const [index, output] of outputs.entries()) {
  const pass = drawEncoder.beginRenderPass({ colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
  pass.setPipeline(drawPipeline);
  pass.setBindGroup(0, drawGroup);
  pass.setVertexBuffer(0, vertices);
  pass.setViewport(0, 0, 4, 4, 0, 1);
  pass.setScissorRect(0, 0, 4, 4);
  pass.setBlendConstant([0, 0, 0, 0]);
  pass.setStencilReference(0);
  if (index === 0) pass.draw(3);
  else { pass.setIndexBuffer(indices, 'uint16'); pass.drawIndexed(3); }
  pass.end();
}
drawDevice.queue.submit([drawEncoder.finish()]);
outputs.forEach((output, index) => drawDevice.commands.readTexture(100 + index, output.handle, { mip: 0, x: 0, y: 0, layer: 0, width: 4, height: 4 }));
writeFileSync(new URL('./draw.bin', import.meta.url), drawDevice.takeFrame());

const surfaceDevice = new RecordingDevice();
const surfaceShader = surfaceDevice.createShaderModule({ label: 'surface', code: '@group(0) @binding(0) var<uniform> color: vec4f; @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(vec2f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0), 0.0, 1.0); } @fragment fn fs() -> @location(0) vec4f { return color; }' });
const surfacePipeline = surfaceDevice.createRenderPipeline({ layout: 'auto', vertex: { module: surfaceShader }, fragment: { module: surfaceShader, targets: [{ format: 'bgra8unorm' }] } });
const surfaceColor = surfaceDevice.createBuffer({ size: 16, usage: 72 });
surfaceDevice.queue.writeBuffer(surfaceColor, 0, new Float32Array([0, 0, 1, 1]));
const surfaceGroup = surfaceDevice.createBindGroup({ layout: surfacePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: surfaceColor } }] });
const bundleEncoder = surfaceDevice.createRenderBundleEncoder({ colorFormats: ['bgra8unorm'] });
bundleEncoder.setPipeline(surfacePipeline);
bundleEncoder.setBindGroup(0, surfaceGroup);
bundleEncoder.draw(3);
const bundle = bundleEncoder.finish();
const surfaceEncoder = surfaceDevice.createCommandEncoder();
const surface = surfaceDevice.surfaceTexture(4, 4, { format: 'bgra8unorm', usage: 17 });
const surfacePass = surfaceEncoder.beginRenderPass({ colorAttachments: [{ view: surface.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
surfacePass.executeBundles([bundle]);
surfacePass.end();
surfaceDevice.queue.submit([surfaceEncoder.finish()]);
surfaceDevice.commands.readTexture(100, surface.handle, { mip: 0, x: 0, y: 0, layer: 0, width: 4, height: 4 });
writeFileSync(new URL('./surface.bin', import.meta.url), surfaceDevice.takeFrame());
for (const [size, color] of [[8, [1, 0, 0, 1]], [4, [0, 1, 0, 1]]]) {
  const encoder = surfaceDevice.createCommandEncoder();
  const view = surfaceDevice.surfaceTexture(size, size, { format: 'bgra8unorm', usage: 17 }).createView();
  encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: color }] }).end();
  surfaceDevice.queue.submit([encoder.finish()]);
}
surfaceDevice.commands.readTexture(100, surfaceDevice.surface.handle, { mip: 0, x: 0, y: 0, layer: 0, width: 4, height: 4 });
writeFileSync(new URL('./surface-resize.bin', import.meta.url), surfaceDevice.takeFrame());

const labelDevice = new RecordingDevice();
const particles = labelDevice.createBuffer({ label: 'particles', size: 16, usage: 12 });
const shadowMap = labelDevice.createTexture({ label: 'shadow-map', size: [4, 4], format: 'rgba8unorm', usage: 2 });
writeFileSync(new URL('./labels-0.bin', import.meta.url), labelDevice.takeFrame());
labelDevice.queue.writeBuffer(particles, 2, new Uint8Array(4));
writeFileSync(new URL('./labels-1.bin', import.meta.url), labelDevice.takeFrame());
const labelEncoder = labelDevice.createCommandEncoder();
labelEncoder.beginRenderPass({ colorAttachments: [{ view: shadowMap.createView(), loadOp: 'clear', storeOp: 'store' }] }).end();
labelDevice.queue.submit([labelEncoder.finish()]);
const uniformLayout = labelDevice.createBindGroupLayout({ entries: [{ binding: 0, visibility: 1, buffer: {} }] });
labelDevice.createBindGroup({ layout: uniformLayout, entries: [{ binding: 0, resource: { buffer: particles } }] });
writeFileSync(new URL('./labels-2.bin', import.meta.url), labelDevice.takeFrame());
labelDevice.queue.writeBuffer(particles, 2, new Uint8Array(4));
writeFileSync(new URL('./labels-3.bin', import.meta.url), labelDevice.takeFrame());

const ownedDevice = new RecordingDevice();
const owned = ownedDevice.surfaceTexture(4, 4, { format: 'bgra8unorm', usage: 17 });
ownedDevice.commands.destroyTexture(owned.handle);
const ownedEncoder = ownedDevice.createCommandEncoder();
ownedEncoder.beginRenderPass({ colorAttachments: [{ view: owned.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 1, 0, 1] }] }).end();
ownedDevice.queue.submit([ownedEncoder.finish()]);
ownedDevice.commands.readTexture(100, owned.handle, { mip: 0, x: 0, y: 0, layer: 0, width: 4, height: 4 });
writeFileSync(new URL('./surface-destroy.bin', import.meta.url), ownedDevice.takeFrame());

const formats = new CommandEncoder();
formats.createTexture(1, { width: 2, height: 1, layers: 1, mips: 1, samples: 1, usage: 3, format: 'rgba16float' });
formats.writeTexture(1, { mip: 0, x: 0, y: 0, layer: 0, bytesPerRow: 16, rowsPerImage: 1, width: 2, height: 1, layers: 1 }, new Uint8Array(new Uint16Array([0x3c00, 0x3800, 0x3400, 0x3c00, 0, 0x3c00, 0, 0x3c00]).buffer));
formats.readTexture(10, 1, { mip: 0, x: 0, y: 0, layer: 0, width: 2, height: 1 });
formats.createTexture(2, { width: 1, height: 1, layers: 1, mips: 1, samples: 1, usage: 3, format: 'r32float' });
formats.writeTexture(2, { mip: 0, x: 0, y: 0, layer: 0, bytesPerRow: 4, rowsPerImage: 1, width: 1, height: 1, layers: 1 }, new Uint8Array(new Float32Array([0.25]).buffer));
formats.readTexture(11, 2, { mip: 0, x: 0, y: 0, layer: 0, width: 1, height: 1 });
formats.createTexture(3, { width: 2, height: 2, layers: 1, mips: 1, samples: 1, usage: 17, format: 'depth32float' });
formats.createTextureView(4, 3, { baseMip: 0, mips: 0, baseLayer: 0, layers: 0, dimension: 0, aspect: 0, usage: 0 });
formats.beginRenderPass([], { view: 4, flags: 1, depthLoad: 1, depthStore: 1, depthClear: 0.5, stencilLoad: 0, stencilStore: 0, stencilClear: 0 });
formats.append(Opcode.END_RENDER_PASS);
formats.append(Opcode.SUBMIT);
formats.readTexture(12, 3, { mip: 0, x: 0, y: 0, layer: 0, width: 2, height: 2 });
formats.createTexture(5, { width: 1, height: 1, layers: 1, mips: 1, samples: 1, usage: 17, format: 'depth24plus' });
formats.readTexture(13, 5, { mip: 0, x: 0, y: 0, layer: 0, width: 1, height: 1 });
writeFileSync(new URL('./readback-formats.bin', import.meta.url), formats.finish());

// One invalid object of each type, made as C:\3jsc\swarm\e3-r12\kit\apps\objects.js makes it for Edge. Frame 0
// creates a valid set and the mode's set, and frames 0 and 1 clear the canvas yellow and then, in another submit as
// three's render and the page's pass are, draw blue with the mode's set. Frame 2 releases the mode's set and draws with the valid one. Each frame reads the canvas back.
// `empty` draws nothing from a zero-size vertex buffer before its draw, and `copy` copies an invalid texture.
const objectsCode = `
struct U { color: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var t: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs() -> @location(0) vec4f { return u.color + 0 * textureSample(t, s, vec2f(0.5)); }`;
const objectsEntries = [
  { binding: 0, visibility: 2, buffer: {} },
  { binding: 1, visibility: 2, sampler: {} },
  { binding: 2, visibility: 2, texture: {} },
];
function objectSet(device, bad) {
  const set = {};
  set.buffer = device.createBuffer({ label: `${bad}-buffer`, size: bad === 'buffer' ? 512 * 1024 * 1024 : 16, usage: 72 });
  set.sampler = device.createSampler({ lodMinClamp: bad === 'sampler' ? -1 : 0 });
  set.texture = device.createTexture({ label: `${bad}-texture`, size: [4, 4], mipLevelCount: bad === 'group' || bad === 'copy' ? 4 : 1, format: 'rgba8unorm', usage: 5 });
  set.layout = device.createBindGroupLayout({ entries: bad === 'layout' ? [...objectsEntries, { ...objectsEntries[0] }] : objectsEntries });
  set.group = device.createBindGroup({ layout: set.layout, entries: [
    { binding: 0, resource: { buffer: set.buffer } },
    { binding: 1, resource: set.sampler },
    { binding: 2, resource: set.texture.createView() },
  ] });
  set.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: bad === 'pipeline-layout' ? Array(5).fill(set.layout) : [set.layout] });
  set.module = device.createShaderModule({ label: `${bad}-shader`, code: bad === 'pipeline' || bad === 'bundle' ? objectsCode.replace('return u.color', 'return u.colour') : objectsCode });
  set.pipeline = device.createRenderPipeline({ label: `${bad}-pipeline`, layout: set.pipelineLayout,
    vertex: { module: set.module, entryPoint: 'vs' }, fragment: { module: set.module, entryPoint: 'fs', targets: [{ format: 'bgra8unorm' }] } });
  if (bad === 'bundle') {
    const encoder = device.createRenderBundleEncoder({ colorFormats: ['bgra8unorm'] });
    encoder.setPipeline(set.pipeline);
    encoder.setBindGroup(0, set.group);
    encoder.draw(3);
    set.bundle = encoder.finish();
  }
  if (bad === 'empty') set.empty = device.createBuffer({ size: 0, usage: 40 });
  if (bad === 'copy') set.target = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 2 });
  return set;
}
function objectsFrame(device, set, bad) {
  device.queue.writeBuffer(set.buffer, 0, new Float32Array([0, 0, 1, 1]));
  const view = device.surfaceTexture(4, 4, { format: 'bgra8unorm', usage: 17 }).createView();
  const clearing = device.createCommandEncoder();
  clearing.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 0, 1] }] }).end();
  device.queue.submit([clearing.finish()]);
  const encoder = device.createCommandEncoder();
  if (bad === 'copy') {
    encoder.copyTextureToTexture({ texture: set.texture }, { texture: set.target }, [4, 4]);
  }
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] });
  if (set.bundle) pass.executeBundles([set.bundle]);
  else {
    pass.setPipeline(set.pipeline);
    pass.setBindGroup(0, set.group);
    if (set.empty) {
      pass.setVertexBuffer(0, set.empty);
      pass.draw(0);
    }
    pass.draw(3);
  }
  pass.end();
  device.queue.submit([encoder.finish()]);
  device.commands.readTexture(100, device.surface.handle, { mip: 0, x: 0, y: 0, layer: 0, width: 4, height: 4 });
  return device.takeFrame();
}
for (const bad of ['valid', 'buffer', 'sampler', 'layout', 'group', 'pipeline-layout', 'pipeline', 'bundle', 'empty', 'copy']) {
  const device = new RecordingDevice();
  const valid = objectSet(device, 'valid');
  const set = objectSet(device, bad);
  const frames = [objectsFrame(device, set, bad), objectsFrame(device, set, bad)];
  set.buffer.destroy();
  set.empty?.destroy();
  set.target?.destroy();
  set.texture.destroy();
  device.releaseBindGroup(set.group);
  device.releaseSampler(set.sampler);
  device.releaseRenderPipeline(set.pipeline);
  device.releasePipelineLayout(set.pipelineLayout);
  device.releaseBindGroupLayout(set.layout);
  device.releaseShader(set.module);
  frames.push(objectsFrame(device, valid, 'valid'));
  frames.forEach((frame, index) => writeFileSync(new URL(`./objects-${bad}-${index}.bin`, import.meta.url), frame));
}

// Copies, clears, passes and queue writes with validation errors and destroyed objects, one frame per case, as
// C:/3jsc/swarm/e3-r12/kit/apps/rules.js `copies` and the round-11 adversary's probe.js `copy-destroyed` and
// `bundle-destroyed` make them for Edge. A case whose name ends in `-earlier` uses what the case before it destroyed.
{
const copyDevice = new RecordingDevice();
const copyUsage = 12;
const buffer = (size = 256, usage = copyUsage) => copyDevice.createBuffer({ size, usage });
const texture = (usage = 3) => copyDevice.createTexture({ size: [4, 4], format: 'rgba8unorm', usage });
const submit = encode => {
  const encoder = copyDevice.createCommandEncoder();
  encode(encoder);
  copyDevice.queue.submit([encoder.finish()]);
};
const pass = (encoder, view) => encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
const copyModule = copyDevice.createShaderModule({ code: `
@group(0) @binding(0) var<uniform> u: vec4f;
@vertex fn vsUniform(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return u + vec4f(f32(i), 0, 0, 1); }
@vertex fn vsVertex(@location(0) p: vec4f) -> @builtin(position) vec4f { return p; }
@fragment fn fsMain() -> @location(0) vec4f { return vec4f(1); }` });
const copyTargets = [{ format: 'rgba8unorm' }];
const uniformPipeline = copyDevice.createRenderPipeline({ layout: 'auto', vertex: { module: copyModule, entryPoint: 'vsUniform' }, fragment: { module: copyModule, entryPoint: 'fsMain', targets: copyTargets } });
const vertexPipeline = copyDevice.createRenderPipeline({
  layout: 'auto', fragment: { module: copyModule, entryPoint: 'fsMain', targets: copyTargets },
  vertex: { module: copyModule, entryPoint: 'vsVertex', buffers: [{ arrayStride: 16, attributes: [{ format: 'float32x4', offset: 0, shaderLocation: 0 }] }] },
});
const target = () => texture(16).createView();
const kept = {};
const copyCases = [
  ['setup', () => {}],
  ['unaligned-offset', () => submit(encoder => encoder.copyBufferToBuffer(buffer(), 2, buffer(), 0, 64))],
  ['unaligned-size', () => submit(encoder => encoder.copyBufferToBuffer(buffer(), 0, buffer(), 0, 6))],
  ['out-of-range', () => submit(encoder => encoder.copyBufferToBuffer(buffer(), 0, buffer(), 0, 512))],
  ['clear-unaligned', () => submit(encoder => encoder.clearBuffer(buffer(), 2))],
  ['bytes-per-row', () => submit(encoder => encoder.copyBufferToTexture({ buffer: buffer(1024), bytesPerRow: 100 }, { texture: texture() }, [4, 4]))],
  ['texture-bounds', () => submit(encoder => encoder.copyTextureToTexture({ texture: texture() }, { texture: texture() }, [8, 8]))],
  ['destroyed-before-submit', () => {
    kept.buffer = buffer();
    const encoder = copyDevice.createCommandEncoder();
    encoder.copyBufferToBuffer(kept.buffer, 0, buffer(), 0, 64);
    const commands = encoder.finish();
    kept.buffer.destroy();
    copyDevice.queue.submit([commands]);
  }],
  ['destroyed-earlier', () => submit(encoder => encoder.copyBufferToBuffer(kept.buffer, 0, buffer(), 0, 64))],
  ['attachment-destroyed', () => {
    const attachment = texture(16);
    kept.view = attachment.createView();
    attachment.destroy();
    submit(encoder => pass(encoder, kept.view).end());
  }],
  ['attachment-destroyed-earlier', () => submit(encoder => pass(encoder, kept.view).end())],
  ['bind-group-destroyed', () => {
    const uniform = buffer(16, 64);
    kept.group = copyDevice.createBindGroup({ layout: uniformPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    uniform.destroy();
    submit(encoder => {
      const p = pass(encoder, target());
      p.setPipeline(uniformPipeline);
      p.setBindGroup(0, kept.group);
      p.draw(3);
      p.end();
    });
  }],
  ['bind-group-destroyed-earlier', () => submit(encoder => {
    const p = pass(encoder, target());
    p.setPipeline(uniformPipeline);
    p.setBindGroup(0, kept.group);
    p.draw(3);
    p.end();
  })],
  ['vertex-destroyed', () => {
    kept.vertices = buffer(64, 32);
    kept.vertices.destroy();
    submit(encoder => {
      const p = pass(encoder, target());
      p.setPipeline(vertexPipeline);
      p.setVertexBuffer(0, kept.vertices);
      p.draw(3);
      p.end();
    });
  }],
  ['vertex-destroyed-earlier', () => submit(encoder => {
    const p = pass(encoder, target());
    p.setPipeline(vertexPipeline);
    p.setVertexBuffer(0, kept.vertices);
    p.draw(3);
    p.end();
  })],
  ['size-and-destroyed', () => {
    const source = buffer();
    source.destroy();
    submit(encoder => encoder.copyBufferToBuffer(source, 2, buffer(), 0, 64));
  }],
  ['write-destroyed', () => {
    const destination = buffer();
    destination.destroy();
    copyDevice.queue.writeBuffer(destination, 0, new Uint8Array(16));
  }],
  ['write-texture-destroyed', () => {
    const destination = texture();
    destination.destroy();
    copyDevice.queue.writeTexture({ texture: destination }, new Uint8Array(64), { bytesPerRow: 16 }, [4, 4]);
  }],
  ['valid-copy', () => submit(encoder => encoder.copyBufferToBuffer(buffer(), 0, buffer(), 0, 64))],
  ...[
    ['probe-copy-buffer', (encoder, set) => encoder.copyBufferToBuffer(set.src, 0, set.dst, 0, 64)],
    ['probe-clear-buffer', (encoder, set) => encoder.clearBuffer(set.src)],
    ['probe-buffer-to-texture', (encoder, set) => encoder.copyBufferToTexture({ buffer: set.src, bytesPerRow: 256 }, { texture: set.other }, [4, 4])],
    ['probe-texture-to-buffer', (encoder, set) => encoder.copyTextureToBuffer({ texture: set.texture }, { buffer: set.dst, bytesPerRow: 256 }, [4, 4])],
    ['probe-texture-to-texture', (encoder, set) => encoder.copyTextureToTexture({ texture: set.texture }, { texture: set.other }, [4, 4])],
  ].map(([name, copy]) => [name, () => {
    const set = { src: buffer(), dst: buffer(), texture: texture(), other: texture() };
    set.src.destroy();
    set.texture.destroy();
    submit(encoder => copy(encoder, set));
  }]),
  ['bundle-finish', () => {
    const layout = { colorFormats: ['rgba8unorm'] };
    const before = buffer(16, 32);
    const after = buffer(16, 32);
    const first = copyDevice.createRenderBundleEncoder(layout);
    first.setVertexBuffer(0, before);
    before.destroy();
    const second = copyDevice.createRenderBundleEncoder(layout);
    second.setVertexBuffer(0, after);
    kept.bundles = [first.finish(), second.finish()];
    after.destroy();
  }],
  ...[0, 1].map(index => [`bundle-execute-${index}`, () => submit(encoder => {
    const p = pass(encoder, target());
    p.executeBundles([kept.bundles[index]]);
    p.end();
  })]),
];
copyCases.forEach(([name, run], index) => {
  run();
  writeFileSync(new URL(`./copies-${String(index).padStart(2, '0')}-${name}.bin`, import.meta.url), copyDevice.takeFrame());
});
}

// Buffers with MAP_READ or MAP_WRITE usage, one frame per case, as C:/3jsc/swarm/e3-r12/kit/apps/rules.js `buffers`
// makes them for Edge. The mapped-at-creation case copies its data to a buffer that the frame reads back.
{
  const device = new RecordingDevice();
  const cases = [
    ['map-read', () => device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })],
    ['map-write', () => device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_WRITE })],
    ['map-read-copy-src', () => device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_READ })],
    ['map-write-mapped', () => {
      const mapped = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_WRITE, mappedAtCreation: true });
      new Uint8Array(mapped.getMappedRange()).fill(7);
      mapped.unmap();
      const copy = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(mapped, 0, copy, 0, 16);
      device.queue.submit([encoder.finish()]);
      device.commands.readBuffer(100, copy.handle, 0, 16);
    }],
    ['map-read-copied', () => {
      const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const source = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_SRC });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, readback, 0, 64);
      device.queue.submit([encoder.finish()]);
    }],
  ];
  cases.forEach(([name, run], index) => {
    run();
    writeFileSync(new URL(`./map-${index}-${name}.bin`, import.meta.url), device.takeFrame());
  });
}

// Buffers mapped at creation that are invalid, one frame per case, as the round-12 adversary's probe.js
// `mapped-invalid` and `attr-huge` make them for Edge. `over-max` is a vertex buffer over maxBufferSize that a pass
// sets and draws from, as three's attribute over that limit does, in two frames.
{
  const device = new RecordingDevice();
  const module = device.createShaderModule({ code: `
@vertex fn vs(@location(0) p: vec4f) -> @builtin(position) vec4f { return p; }
@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }` });
  const pipeline = device.createRenderPipeline({
    layout: 'auto', fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 16, attributes: [{ format: 'float32x4', offset: 0, shaderLocation: 0 }] }] },
  });
  const target = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT }).createView();
  const mapped = descriptor => {
    const buffer = device.createBuffer({ ...descriptor, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).fill(7);
    buffer.unmap();
    return buffer;
  };
  let huge = null;
  const draw = () => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, huge);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
  const cases = [
    ['setup', () => {}],
    ['map-write-vertex', () => mapped({ size: 16, usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.VERTEX })],
    ['usage-zero', () => mapped({ size: 16, usage: 0 })],
    ['map-write-copy-src', () => mapped({ size: 16, usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC })],
    ['size-zero', () => mapped({ size: 0, usage: GPUBufferUsage.VERTEX })],
    ['over-max', () => {
      huge = mapped({ size: device.limits.maxBufferSize + 16, usage: GPUBufferUsage.VERTEX });
      draw();
    }],
    ['over-max-again', draw],
  ];
  cases.forEach(([name, run], index) => {
    run();
    writeFileSync(new URL(`./mapped-${index}-${name}.bin`, import.meta.url), device.takeFrame());
  });
}

// Compute passes, as crates/host/tests/compute-rules.js `compute` makes them for Edge: a dispatch that fills a storage
// buffer, an indirect dispatch, pipelines and dispatches that fail validation, and a destroyed storage buffer. Each
// frame maps a readback buffer, whose map the next frame cancels, as nothing answers it here.
{
  const device = new RecordingDevice();
  const module = device.createShaderModule({ label: 'storage', code: `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < arrayLength(&data)) { data[id.x] = id.x * 3u + 1u; }
}
@compute @workgroup_size(64) fn other(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < arrayLength(&data)) { data[id.x] = 7u; }
}` });
  const fill = device.createComputePipeline({ label: 'fill', layout: 'auto', compute: { module, entryPoint: 'main' } });
  const other = device.createComputePipeline({ label: 'other', layout: 'auto', compute: { module, entryPoint: 'other' } });
  const storage = device.createBuffer({ size: 1024, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const group = pipeline => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
  let readback = null;
  const dispatch = ({ pipeline, bindGroup, x = 4, indirect = null }) => {
    readback?.unmap();
    readback = device.createBuffer({ size: 1024, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    if (pipeline) pass.setPipeline(pipeline);
    if (bindGroup) pass.setBindGroup(0, bindGroup);
    if (indirect) pass.dispatchWorkgroupsIndirect(indirect, 0);
    else pass.dispatchWorkgroups(x);
    pass.end();
    encoder.copyBufferToBuffer(storage, 0, readback, 0, 1024);
    device.queue.submit([encoder.finish()]);
    readback.mapAsync(GPUMapMode.READ).catch(() => {});
  };
  const cases = [
    ['dispatch', () => dispatch({ pipeline: fill, bindGroup: group(fill) })],
    ['indirect', () => {
      const args = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(args, 0, Uint32Array.from([2, 1, 1]));
      dispatch({ pipeline: other, bindGroup: group(other), indirect: args });
    }],
    ['bad-shader', () => {
      const bad = device.createShaderModule({ label: 'bad-compute', code: '@compute @workgroup_size(1) fn main( {' });
      dispatch({ pipeline: device.createComputePipeline({ label: 'bad', layout: 'auto', compute: { module: bad, entryPoint: 'main' } }) });
    }],
    ['bad-entry', () => dispatch({ pipeline: device.createComputePipeline({ label: 'missing', layout: 'auto', compute: { module, entryPoint: 'missing' } }) })],
    ['no-pipeline', () => dispatch({})],
    ['too-many-groups', () => dispatch({ pipeline: fill, bindGroup: group(fill), x: 70000 })],
    ['destroyed-storage', () => {
      const lost = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE });
      const bindGroup = device.createBindGroup({ layout: fill.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: lost } }] });
      lost.destroy();
      dispatch({ pipeline: fill, bindGroup });
    }],
  ];
  cases.forEach(([name, run], index) => {
    run();
    writeFileSync(new URL(`./compute-${index}-${name}.bin`, import.meta.url), device.takeFrame());
  });
}

// Maps, as crates/host/tests/compute-rules.js `map` makes them for Edge, one frame per case. A map that nothing
// answers here stays pending, so each case maps a buffer of its own.
{
  const device = new RecordingDevice();
  const readable = () => device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const map = (buffer, mode, offset, size) => buffer.mapAsync(mode, offset, size).catch(() => {});
  const cases = [
    ['read', () => {
      const buffer = readable();
      device.queue.writeBuffer(buffer, 0, Uint32Array.from([11, 22, 33, 44, 55, 66]));
      map(buffer, GPUMapMode.READ, 8, 16);
    }],
    ['write', () => map(device.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC }), GPUMapMode.WRITE, 16, 16)],
    ['no-usage', () => map(device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST }), GPUMapMode.READ)],
    ['wrong-mode', () => map(readable(), GPUMapMode.WRITE)],
    ['both-modes', () => map(readable(), GPUMapMode.READ | GPUMapMode.WRITE)],
    ['unaligned-offset', () => map(readable(), GPUMapMode.READ, 4)],
    ['unaligned-size', () => map(readable(), GPUMapMode.READ, 0, 6)],
    ['out-of-range', () => map(readable(), GPUMapMode.READ, 0, 512)],
    ['destroyed', () => {
      const buffer = readable();
      buffer.destroy();
      map(buffer, GPUMapMode.READ);
    }],
    ['mapped-submit', () => {
      const buffer = readable();
      map(buffer, GPUMapMode.READ);
      const source = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_SRC });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, buffer, 0, 64);
      device.queue.submit([encoder.finish()]);
      buffer.unmap();
    }],
    ['remap', () => {
      const buffer = readable();
      map(buffer, GPUMapMode.READ);
      buffer.unmap();
      map(buffer, GPUMapMode.READ, 0, 8);
    }],
    ['written-ranges', () => {
      // A buffer mapped at creation writes two ranges, which a copy then reads back.
      const buffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
      new Uint32Array(buffer.getMappedRange(8, 8)).set([3, 4]);
      new Uint32Array(buffer.getMappedRange(0, 8)).set([1, 2]);
      buffer.unmap();
      const copy = device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, copy, 0, 32);
      device.queue.submit([encoder.finish()]);
      device.commands.readBuffer(900, copy.handle, 0, 32);
    }],
  ];
  cases.forEach(([name, run], index) => {
    run();
    writeFileSync(new URL(`./mapasync-${String(index).padStart(2, '0')}-${name}.bin`, import.meta.url), device.takeFrame());
  });
}

// Timestamp queries, as crates/host/tests/compute-rules.js `queries` makes them for Edge: a render pass and a compute
// pass that write timestamps, a resolve, and resolves and passes that fail validation.
{
  const device = new RecordingDevice({ features: ['timestamp-query'] });
  const set = device.createQuerySet({ type: 'timestamp', count: 8, label: 'times' });
  const module = device.createShaderModule({ code: `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { if (id.x < arrayLength(&data)) { data[id.x] = id.x; } }` });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const storage = device.createBuffer({ size: 1024, usage: GPUBufferUsage.STORAGE });
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
  const target = device.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT }).createView();
  const submit = encode => {
    const encoder = device.createCommandEncoder();
    encode(encoder);
    device.queue.submit([encoder.finish()]);
  };
  const timed = (encoder, writes) => encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store' }], timestampWrites: writes }).end();
  const resolveBuffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const cases = [
    ['passes', () => {
      submit(encoder => {
        timed(encoder, { querySet: set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
        const pass = encoder.beginComputePass({ timestampWrites: { querySet: set, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(16);
        pass.end();
        encoder.resolveQuerySet(set, 0, 4, resolveBuffer, 0);
      });
      device.commands.readBuffer(800, resolveBuffer.handle, 0, 32);
    }],
    ['same-index', () => submit(encoder => timed(encoder, { querySet: set, beginningOfPassWriteIndex: 5, endOfPassWriteIndex: 5 }))],
    ['index-past-count', () => submit(encoder => timed(encoder, { querySet: set, beginningOfPassWriteIndex: 8, endOfPassWriteIndex: 9 }))],
    ['resolve-unaligned', () => submit(encoder => encoder.resolveQuerySet(set, 0, 2, device.createBuffer({ size: 512, usage: GPUBufferUsage.QUERY_RESOLVE }), 128))],
    ['resolve-usage', () => submit(encoder => encoder.resolveQuerySet(set, 0, 2, device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_SRC }), 0))],
    ['resolve-past-count', () => submit(encoder => encoder.resolveQuerySet(set, 6, 4, resolveBuffer, 0))],
    ['too-many', () => submit(encoder => timed(encoder, { querySet: device.createQuerySet({ type: 'timestamp', count: 5000 }), beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }))],
    ['destroyed', () => {
      const lost = device.createQuerySet({ type: 'timestamp', count: 2 });
      const encoder = device.createCommandEncoder();
      timed(encoder, { querySet: lost, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
      const commands = encoder.finish();
      lost.destroy();
      device.queue.submit([commands]);
    }],
  ];
  cases.forEach(([name, run], index) => {
    run();
    writeFileSync(new URL(`./timestamps-${index}-${name}.bin`, import.meta.url), device.takeFrame());
  });
}

// A copy of the canvas mid-frame, as three's copyFramebufferToTexture() makes it: a pass clears the canvas, the
// encoder copies it to a texture and from that texture's first mip to its second, and a later pass loads the canvas.
{
  const device = new RecordingDevice();
  const surface = device.surfaceTexture(4, 4, { format: 'bgra8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const copy = device.createTexture({ size: [4, 4], mipLevelCount: 2, format: 'bgra8unorm', usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
  const encoder = device.createCommandEncoder();
  const view = surface.createView();
  encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [1, 0.5, 0, 1] }] }).end();
  encoder.copyTextureToTexture({ texture: surface }, { texture: copy }, [4, 4]);
  encoder.copyTextureToTexture({ texture: copy, origin: [2, 2] }, { texture: copy, mipLevel: 1 }, [2, 2]);
  encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] }).end();
  device.queue.submit([encoder.finish()]);
  device.commands.readTexture(700, copy.handle, { mip: 1, x: 0, y: 0, layer: 0, width: 2, height: 2 });
  device.commands.readTexture(701, surface.handle, { mip: 0, x: 0, y: 0, layer: 0, width: 1, height: 1 });
  writeFileSync(new URL('./copy-surface.bin', import.meta.url), device.takeFrame());
}
