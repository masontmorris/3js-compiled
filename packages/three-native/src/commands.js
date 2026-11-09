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

function u32(value, name, nonzero = false) {
  if (!Number.isInteger(value) || value < (nonzero ? 1 : 0) || value > 0xffffffff) {
    throw new RangeError(`Invalid ${name}`);
  }
  return value;
}

function u64(value, name) {
  if ((typeof value === 'number' && !Number.isSafeInteger(value)) ||
      (typeof value !== 'number' && typeof value !== 'bigint')) throw new RangeError(`Invalid ${name}`);
  const result = BigInt(value);
  if (result < 0n || result > 0xffffffffffffffffn) throw new RangeError(`Invalid ${name}`);
  return result;
}

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

  createShader(handle, label, code) {
    const encode = value => {
      const bytes = [];
      for (const character of value) {
        let point = character.codePointAt(0);
        if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
        if (point < 0x80) bytes.push(point);
        else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 63));
        else if (point < 0x10000) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
        else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 63), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
      }
      return new Uint8Array(bytes);
    };
    if (typeof label !== 'string' || typeof code !== 'string') throw new TypeError('Shader label and code must be strings');
    const name = encode(label);
    const source = encode(code);
    const payload = new Uint8Array(12 + name.length + source.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(handle, 'handle', true), true);
    view.setUint32(4, name.length, true);
    view.setUint32(8, source.length, true);
    payload.set(name, 12);
    payload.set(source, 12 + name.length);
    this.append(Opcode.CREATE_SHADER, payload);
  }

  createTexture(handle, descriptor) {
    const format = descriptor.format;
    if (typeof format !== 'string' || !/^[a-z0-9-]+$/.test(format)) throw new TypeError('Invalid texture format');
    const payload = new Uint8Array(32 + format.length);
    const view = new DataView(payload.buffer);
    const values = [u32(handle, 'handle', true), descriptor.width, descriptor.height, descriptor.layers, descriptor.mips, descriptor.samples, descriptor.usage, format.length];
    values.forEach((value, index) => view.setUint32(index * 4, u32(value, 'texture field'), true));
    for (let i = 0; i < format.length; i++) payload[32 + i] = format.charCodeAt(i);
    this.append(Opcode.CREATE_TEXTURE, payload);
  }

  createSampler(handle, descriptor) {
    const payload = new Uint8Array(44);
    const view = new DataView(payload.buffer);
    const values = [u32(handle, 'handle', true), descriptor.addressU, descriptor.addressV, descriptor.addressW, descriptor.mag, descriptor.min, descriptor.mipmap];
    values.forEach((value, index) => view.setUint32(index * 4, u32(value, 'sampler field'), true));
    if (!Number.isFinite(descriptor.lodMin) || !Number.isFinite(descriptor.lodMax)) throw new RangeError('Invalid sampler LOD');
    view.setFloat32(28, descriptor.lodMin, true);
    view.setFloat32(32, descriptor.lodMax, true);
    view.setUint32(36, u32(descriptor.compare, 'sampler compare'), true);
    view.setUint32(40, u32(descriptor.anisotropy, 'sampler anisotropy'), true);
    this.append(Opcode.CREATE_SAMPLER, payload);
  }

  createBindGroupLayout(handle, entries) {
    const payload = new Uint8Array(8 + entries.length * 32);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(handle, 'handle', true), true);
    view.setUint32(4, u32(entries.length, 'entry count'), true);
    entries.forEach((entry, index) => {
      const offset = 8 + index * 32;
      [entry.binding, entry.visibility, entry.kind, entry.type, entry.dimension, entry.flags].forEach((value, i) =>
        view.setUint32(offset + i * 4, u32(value, 'layout entry'), true));
      view.setBigUint64(offset + 24, u64(entry.minSize, 'minimum binding size'), true);
    });
    this.append(Opcode.CREATE_BIND_GROUP_LAYOUT, payload);
  }

  createTextureView(handle, texture, descriptor) {
    const payload = new Uint8Array(36);
    const view = new DataView(payload.buffer);
    const values = [u32(handle, 'handle', true), u32(texture, 'texture', true), descriptor.baseMip, descriptor.mips, descriptor.baseLayer, descriptor.layers, descriptor.dimension, descriptor.aspect, descriptor.usage];
    values.forEach((value, index) => view.setUint32(index * 4, u32(value, 'view field'), true));
    this.append(Opcode.CREATE_TEXTURE_VIEW, payload);
  }

  writeTexture(handle, descriptor, data) {
    if (!(data instanceof Uint8Array)) throw new TypeError('Texture data must be a Uint8Array');
    const payload = new Uint8Array(40 + data.length);
    const view = new DataView(payload.buffer);
    const values = [u32(handle, 'handle', true), descriptor.mip, descriptor.x, descriptor.y, descriptor.layer, descriptor.bytesPerRow, descriptor.rowsPerImage, descriptor.width, descriptor.height, descriptor.layers];
    values.forEach((value, index) => view.setUint32(index * 4, u32(value, 'texture field'), true));
    payload.set(data, 40);
    this.append(Opcode.WRITE_TEXTURE, payload);
  }

  readTexture(request, handle, descriptor) {
    const payload = new Uint8Array(32);
    const view = new DataView(payload.buffer);
    const values = [u32(request, 'request', true), u32(handle, 'handle', true), descriptor.mip, descriptor.x, descriptor.y, descriptor.layer, descriptor.width, descriptor.height];
    values.forEach((value, index) => view.setUint32(index * 4, u32(value, 'texture field'), true));
    this.append(Opcode.READ_TEXTURE, payload);
  }

  destroyTexture(handle) {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, u32(handle, 'handle', true), true);
    this.append(Opcode.DESTROY_TEXTURE, payload);
  }

  createBuffer(handle, size, usage) {
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(handle, 'handle', true), true);
    view.setBigUint64(4, u64(size, 'size'), true);
    view.setUint32(12, u32(usage, 'usage'), true);
    this.append(Opcode.CREATE_BUFFER, payload);
  }

  writeBuffer(handle, offset, data) {
    if (!(data instanceof Uint8Array)) throw new TypeError('Buffer data must be a Uint8Array');
    const payload = new Uint8Array(12 + data.byteLength);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(handle, 'handle', true), true);
    view.setBigUint64(4, u64(offset, 'offset'), true);
    payload.set(data, 12);
    this.append(Opcode.WRITE_BUFFER, payload);
  }

  readBuffer(request, handle, offset, size) {
    const payload = new Uint8Array(24);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(request, 'request', true), true);
    view.setUint32(4, u32(handle, 'handle', true), true);
    view.setBigUint64(8, u64(offset, 'offset'), true);
    view.setBigUint64(16, u64(size, 'size'), true);
    this.append(Opcode.READ_BUFFER, payload);
  }

  destroyResource(handle) {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, u32(handle, 'handle', true), true);
    this.append(Opcode.DESTROY_RESOURCE, payload);
  }

  destroyBuffer(handle) {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, u32(handle, 'handle', true), true);
    this.append(Opcode.DESTROY_BUFFER, payload);
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
