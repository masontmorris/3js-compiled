export const Opcode = Object.freeze({
  CREATE_BUFFER: 1,
  WRITE_BUFFER: 2,
  DESTROY_BUFFER: 3,
  CREATE_TEXTURE: 4,
  WRITE_TEXTURE: 5,
  DESTROY_TEXTURE: 6,
  CREATE_TEXTURE_VIEW: 7,
  CREATE_SAMPLER: 8,
  CREATE_SHADER: 9,
  CREATE_BIND_GROUP_LAYOUT: 10,
  CREATE_BIND_GROUP: 11,
  CREATE_PIPELINE_LAYOUT: 12,
  CREATE_RENDER_PIPELINE: 13,
  BEGIN_RENDER_PASS: 14,
  SET_PIPELINE: 15,
  SET_BIND_GROUP: 16,
  SET_VERTEX_BUFFER: 17,
  SET_INDEX_BUFFER: 18,
  SET_VIEWPORT: 19,
  SET_SCISSOR: 20,
  SET_BLEND_CONSTANT: 21,
  SET_STENCIL_REFERENCE: 22,
  DRAW: 23,
  DRAW_INDEXED: 24,
  END_RENDER_PASS: 25,
  SUBMIT: 26,
  READ_BUFFER: 27,
  READ_TEXTURE: 28,
  DESTROY_RESOURCE: 29,
});

const MAGIC = 0x43534a33;
const VERSION = 1;
const HEADER_SIZE = 16;
const RECORD_SIZE = 8;
const validOpcodes = new Set(Object.values(Opcode));

export class Handles {
  #next = 1;

  allocate() {
    if (this.#next > 0xffffffff) throw new RangeError('GPU handle space exhausted');
    return this.#next++;
  }
}

export class CommandEncoder {
  #records = [];
  #size = HEADER_SIZE;

  append(opcode, payload = new Uint8Array()) {
    if (!validOpcodes.has(opcode)) throw new RangeError('Unknown GPU opcode');
    if (!(payload instanceof Uint8Array)) throw new TypeError('Payload must be a Uint8Array');
    const size = this.#size + RECORD_SIZE + payload.byteLength;
    if (size > 0xffffffff) throw new RangeError('Command stream is too large');
    this.#records.push({ opcode, payload: payload.slice() });
    this.#size = size;
  }

  finish() {
    const bytes = new Uint8Array(this.#size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint16(4, VERSION, true);
    view.setUint32(8, this.#size, true);
    view.setUint32(12, this.#records.length, true);
    let offset = HEADER_SIZE;
    for (const { opcode, payload } of this.#records) {
      view.setUint16(offset, opcode, true);
      view.setUint32(offset + 4, payload.byteLength, true);
      bytes.set(payload, offset + RECORD_SIZE);
      offset += RECORD_SIZE + payload.byteLength;
    }
    this.#records = [];
    this.#size = HEADER_SIZE;
    return bytes;
  }
}

export function decodeCommands(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Command stream must be a Uint8Array');
  if (bytes.byteLength < HEADER_SIZE) throw new RangeError('Truncated command stream header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('Invalid command stream magic');
  if (view.getUint16(4, true) !== VERSION) throw new Error('Unsupported command stream version');
  if (view.getUint16(6, true) !== 0) throw new Error('Unsupported command stream flags');
  if (view.getUint32(8, true) !== bytes.byteLength) throw new RangeError('Invalid command stream length');
  const count = view.getUint32(12, true);
  const records = [];
  let offset = HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    if (offset + RECORD_SIZE > bytes.byteLength) throw new RangeError('Truncated command record');
    const opcode = view.getUint16(offset, true);
    if (!validOpcodes.has(opcode)) throw new Error('Unknown GPU opcode');
    if (view.getUint16(offset + 2, true) !== 0) throw new Error('Unsupported command flags');
    const size = view.getUint32(offset + 4, true);
    offset += RECORD_SIZE;
    if (size > bytes.byteLength - offset) throw new RangeError('Truncated command payload');
    records.push({ opcode, payload: bytes.slice(offset, offset + size) });
    offset += size;
  }
  if (offset !== bytes.byteLength) throw new RangeError('Trailing command stream data');
  return records;
}
