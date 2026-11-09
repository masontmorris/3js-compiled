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
