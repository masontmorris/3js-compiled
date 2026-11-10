import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandEncoder, decodeCommands, Handles, Opcode, streamFrame } from '../src/commands.js';

test('each opcode survives one frame in order and owns its payload bytes', () => {
  const encoder = new CommandEncoder();
  const source = new Uint8Array([7, 9, 11]);
  for (const opcode of Object.values(Opcode)) encoder.append(opcode, source);
  source.fill(0);
  const records = decodeCommands(encoder.finish());
  assert.deepEqual(records.map(record => record.opcode), Object.values(Opcode));
  for (const record of records) assert.deepEqual([...record.payload], [7, 9, 11]);
  assert.deepEqual(decodeCommands(encoder.finish()), []);
});

test('the decoder rejects corrupted and truncated streams', () => {
  const encoder = new CommandEncoder();
  encoder.append(Opcode.DRAW, new Uint8Array([1, 2, 3]));
  const valid = encoder.finish();
  for (let i = 0; i < valid.length; i++) assert.throws(() => decodeCommands(valid.subarray(0, i)));
  for (const [offset, value] of [[0, 0], [4, 1], [6, 1], [20, 255], [22, 1], [24, 255]]) {
    const corrupt = valid.slice();
    corrupt[offset] = value;
    assert.throws(() => decodeCommands(corrupt));
  }
});

test('the decoder names the version it found and the version it reads', () => {
  const stream = new CommandEncoder().finish();
  const supported = new DataView(stream.buffer).getUint16(4, true);
  new DataView(stream.buffer).setUint16(4, 2, true);
  assert.throws(() => decodeCommands(stream), {
    message: `Command stream version 2 is not supported: this decoder reads version ${supported}`,
  });
});

test('handles are nonzero and unique across frames', () => {
  const handles = new Handles();
  assert.deepEqual([handles.allocate(), handles.allocate(), handles.allocate()], [1, 2, 3]);
});

test('the installed renderer accepts an injected backend', async () => {
  const { WebGPUBackend, WebGPURenderer } = await import('three/webgpu');
  const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
  const backend = new WebGPUBackend({ canvas });
  const renderer = new WebGPURenderer({ canvas, backend });
  assert.equal(renderer.backend, backend);
});

test('buffer operations preserve their binary fields and reject invalid handles', () => {
  const encoder = new CommandEncoder();
  encoder.createBuffer(7, 16, 12, 'particles');
  encoder.writeBuffer(7, 4, new Uint8Array([1, 2, 3, 4]));
  encoder.readBuffer(8, 7, 4, 4);
  encoder.destroyBuffer(7);
  const stream = encoder.finish(42);
  assert.equal(streamFrame(stream), 42);
  const records = decodeCommands(stream);
  assert.deepEqual(records.map(record => record.opcode), [1, 2, 27, 3]);
  const create = new DataView(records[0].payload.buffer);
  assert.equal(create.getUint32(0, true), 7);
  assert.equal(create.getBigUint64(4, true), 16n);
  assert.equal(create.getUint32(12, true), 12);
  assert.equal(new TextDecoder().decode(records[0].payload.slice(20, 20 + create.getUint32(16, true))), 'particles');
  assert.deepEqual([...records[1].payload.slice(12)], [1, 2, 3, 4]);
  assert.throws(() => encoder.createBuffer(0, 16, 12));
  assert.throws(() => encoder.readBuffer(8, 7, -1, 4));
  assert.throws(() => encoder.writeBuffer(7, 0, [1, 2, 3, 4]));
});
