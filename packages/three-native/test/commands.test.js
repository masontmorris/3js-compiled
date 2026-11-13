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

test('compute, copy, timestamp and map records keep their binary fields', () => {
  const encoder = new CommandEncoder();
  encoder.createComputePipeline(3, { label: 'fill', layout: 0, module: 2, entryPoint: 'main' });
  encoder.createComputePipeline(4, { label: '', layout: 9, module: 2 });
  encoder.createQuerySet(5, 1, 8, 'times');
  encoder.beginComputePass({ querySet: 5, begin: 0, end: 1 });
  encoder.words(Opcode.DISPATCH, [4, 2, 1]);
  encoder.dispatchIndirect(6, 12);
  encoder.append(Opcode.END_COMPUTE_PASS);
  encoder.beginComputePass();
  encoder.beginRenderPass([], null, { querySet: 5, end: 3 });
  encoder.resolveQuerySet(5, 2, 4, 7, 256);
  encoder.copyTextureToTexture({ handle: 10, mip: 1, x: 2, y: 3, layer: 4, aspect: 0 }, { handle: 11, mip: 0, x: 0, y: 0, layer: 0, aspect: 0 },
    { width: 8, height: 8, layers: 1 });
  encoder.mapBuffer(12, 7, 1, 8, 16);
  encoder.unmapBuffer(7, 8, new Uint8Array([1, 2, 3, 4]));
  const records = decodeCommands(encoder.finish());
  assert.deepEqual(records.map(record => record.opcode), [Opcode.CREATE_COMPUTE_PIPELINE, Opcode.CREATE_COMPUTE_PIPELINE, Opcode.CREATE_QUERY_SET,
    Opcode.BEGIN_COMPUTE_PASS, Opcode.DISPATCH, Opcode.DISPATCH_INDIRECT, Opcode.END_COMPUTE_PASS, Opcode.BEGIN_COMPUTE_PASS, Opcode.BEGIN_RENDER_PASS,
    Opcode.RESOLVE_QUERY_SET, Opcode.COPY_TEXTURE_TO_TEXTURE, Opcode.MAP_BUFFER, Opcode.UNMAP_BUFFER]);
  const view = index => new DataView(records[index].payload.buffer);
  const words = (index, count, from = 0) => Array.from({ length: count }, (_, i) => view(index).getUint32(from + i * 4, true));
  const text = (index, from, length) => new TextDecoder().decode(records[index].payload.slice(from, from + length));
  assert.deepEqual(words(0, 5), [3, 0, 2, 4, 4]);
  assert.equal(text(0, 20, 8), 'fillmain');
  assert.deepEqual(words(1, 5), [4, 9, 2, 0, 0], 'no entry point records an empty name');
  assert.deepEqual(words(2, 4), [5, 1, 8, 5]);
  assert.equal(text(2, 16, 5), 'times');
  assert.deepEqual(words(3, 3), [5, 0, 1]);
  assert.deepEqual(words(4, 3), [4, 2, 1]);
  assert.deepEqual([view(5).getUint32(0, true), view(5).getBigUint64(4, true)], [6, 12n]);
  assert.equal(records[6].payload.byteLength, 0);
  assert.deepEqual(words(7, 3), [0, 0, 0], 'a pass without timestampWrites names no query set');
  assert.equal(records[8].payload.byteLength, 4 + 32 + 12);
  assert.deepEqual(words(8, 3, 36), [5, 0xffffffff, 3], 'an absent write index records as 0xffffffff');
  assert.deepEqual([...words(9, 4), view(9).getBigUint64(16, true)], [5, 2, 4, 7, 256n]);
  assert.deepEqual(words(10, 15), [10, 1, 2, 3, 4, 0, 11, 0, 0, 0, 0, 0, 8, 8, 1]);
  assert.deepEqual([...words(11, 3), view(11).getBigUint64(12, true), view(11).getBigUint64(20, true)], [12, 7, 1, 8n, 16n]);
  assert.deepEqual([view(12).getUint32(0, true), view(12).getBigUint64(4, true), ...records[12].payload.slice(12)], [7, 8n, 1, 2, 3, 4]);
  assert.throws(() => encoder.createComputePipeline(0, { label: '', layout: 0, module: 2 }));
  assert.throws(() => encoder.createComputePipeline(3, { label: '', layout: 0, module: 0 }));
  assert.throws(() => encoder.resolveQuerySet(5, 0, 2, 7, -256));
  assert.throws(() => encoder.mapBuffer(0, 7, 1, 0, 4));
  assert.throws(() => encoder.beginComputePass({ querySet: 0, begin: 0, end: 1 }));
});
