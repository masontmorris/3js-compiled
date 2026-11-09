import assert from 'node:assert/strict';
import test from 'node:test';
import { WebGPURenderer } from 'three/webgpu';
import { NativeBackend, RecordingDevice } from '../src/NativeBackend.js';
import { decodeCommands, Opcode } from '../src/commands.js';

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
  assert.equal(decoder.decode(record.payload.slice(12, 12 + labelLength)), 'material-\u2603');
  assert.equal(decoder.decode(record.payload.slice(12 + labelLength)), '\n@fragment fn main() {}');
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
