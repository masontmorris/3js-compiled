import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandEncoder, decodeCommands, Handles, Opcode } from '../src/commands.js';

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
  for (const [offset, value] of [[0, 0], [4, 2], [6, 1], [16, 255], [18, 1], [20, 255]]) {
    const corrupt = valid.slice();
    corrupt[offset] = value;
    assert.throws(() => decodeCommands(corrupt));
  }
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
