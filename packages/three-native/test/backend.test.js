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
