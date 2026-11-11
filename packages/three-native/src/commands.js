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
  ACQUIRE_SURFACE: 30,
  GET_BIND_GROUP_LAYOUT: 31,
  RESIZE_SURFACE: 32,
  CONFIGURE_SURFACE: 33,
  UNCONFIGURE_SURFACE: 34,
  REQUEST_DEVICE: 35,
  CREATE_RENDER_BUNDLE: 36,
  EXECUTE_BUNDLES: 37,
  COPY_BUFFER_TO_BUFFER: 38,
  CLEAR_BUFFER: 39,
  COPY_BUFFER_TO_TEXTURE: 40,
  COPY_TEXTURE_TO_BUFFER: 41,
  COPY_TEXTURE_TO_TEXTURE: 42,
  PUSH_DEBUG_GROUP: 43,
  POP_DEBUG_GROUP: 44,
  INSERT_DEBUG_MARKER: 45,
  PUSH_ERROR_SCOPE: 46,
  POP_ERROR_SCOPE: 47,
});

const MAGIC = 0x43534a33;
// threejsc_gpu::VERSION. docs/native-gpu-commands.md says when it changes.
const VERSION = 8;
const HEADER_SIZE = 20;
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

function encodeUtf8(value) {
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

  createShader(handle, label, code, request = 0) {
    if (typeof label !== 'string' || typeof code !== 'string') throw new TypeError('Shader label and code must be strings');
    const name = encodeUtf8(label);
    const source = encodeUtf8(code);
    const payload = new Uint8Array(16 + name.length + source.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(handle, 'handle', true), true);
    view.setUint32(4, name.length, true);
    view.setUint32(8, source.length, true);
    view.setUint32(12, u32(request, 'request'), true);
    payload.set(name, 16);
    payload.set(source, 16 + name.length);
    this.append(Opcode.CREATE_SHADER, payload);
  }

  createTexture(handle, descriptor) {
    const format = descriptor.format;
    if (typeof format !== 'string' || !/^[a-z0-9-]+$/.test(format)) throw new TypeError('Invalid texture format');
    const label = encodeUtf8(descriptor.label ?? '');
    const payload = new Uint8Array(36 + format.length + label.length);
    const view = new DataView(payload.buffer);
    const values = [u32(handle, 'handle', true), descriptor.width, descriptor.height, descriptor.layers, descriptor.mips, descriptor.samples, descriptor.usage, format.length, label.length];
    values.forEach((value, index) => view.setUint32(index * 4, u32(value, 'texture field'), true));
    for (let i = 0; i < format.length; i++) payload[36 + i] = format.charCodeAt(i);
    payload.set(label, 36 + format.length);
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

  createBindGroup(handle, layout, entries) {
    const payload = new Uint8Array(12 + entries.length * 28);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(handle, 'handle', true), true);
    view.setUint32(4, u32(layout, 'layout', true), true);
    view.setUint32(8, u32(entries.length, 'entry count'), true);
    entries.forEach((entry, index) => {
      const offset = 12 + index * 28;
      view.setUint32(offset, u32(entry.binding, 'binding'), true);
      view.setUint32(offset + 4, u32(entry.kind, 'binding kind'), true);
      view.setUint32(offset + 8, u32(entry.handle, 'resource handle', true), true);
      view.setBigUint64(offset + 12, u64(entry.offset, 'buffer offset'), true);
      view.setBigUint64(offset + 20, u64(entry.size, 'buffer size'), true);
    });
    this.append(Opcode.CREATE_BIND_GROUP, payload);
  }

  createPipelineLayout(handle, layouts) {
    const payload = new Uint8Array(8 + layouts.length * 4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(handle, 'handle', true), true);
    view.setUint32(4, u32(layouts.length, 'layout count'), true);
    layouts.forEach((layout, index) => view.setUint32(8 + index * 4, u32(layout, 'layout handle', true), true));
    this.append(Opcode.CREATE_PIPELINE_LAYOUT, payload);
  }

  copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
    const payload = new Uint8Array(32);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(source, 'buffer handle', true), true);
    view.setBigUint64(4, u64(sourceOffset, 'buffer offset'), true);
    view.setUint32(12, u32(destination, 'buffer handle', true), true);
    view.setBigUint64(16, u64(destinationOffset, 'buffer offset'), true);
    view.setBigUint64(24, u64(size, 'copy size'), true);
    this.append(Opcode.COPY_BUFFER_TO_BUFFER, payload);
  }

  clearBuffer(handle, offset, size) {
    const payload = new Uint8Array(20);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(handle, 'buffer handle', true), true);
    view.setBigUint64(4, u64(offset, 'buffer offset'), true);
    view.setBigUint64(12, u64(size, 'clear size'), true);
    this.append(Opcode.CLEAR_BUFFER, payload);
  }

  // A copy between a buffer and a texture, as COPY_BUFFER_TO_TEXTURE or COPY_TEXTURE_TO_BUFFER.
  bufferTextureCopy(opcode, buffer, texture, extent) {
    const payload = new Uint8Array(56);
    const view = new DataView(payload.buffer);
    [buffer.handle, buffer.bytesPerRow, buffer.rowsPerImage, texture.handle, texture.mip, texture.x, texture.y, texture.layer,
      texture.aspect, extent.width, extent.height, extent.layers]
      .forEach((value, index) => view.setUint32(index * 4, u32(value, 'copy field'), true));
    view.setBigUint64(48, u64(buffer.offset, 'buffer offset'), true);
    this.append(opcode, payload);
  }

  copyTextureToTexture(source, destination, extent) {
    const fields = texture => [texture.handle, texture.mip, texture.x, texture.y, texture.layer, texture.aspect];
    this.words(Opcode.COPY_TEXTURE_TO_TEXTURE, [...fields(source), ...fields(destination), extent.width, extent.height, extent.layers]);
  }

  debug(opcode, label = '') {
    this.append(opcode, encodeUtf8(label));
  }

  requestDevice(descriptor) {
    this.append(Opcode.REQUEST_DEVICE, encodeUtf8(JSON.stringify(descriptor)));
  }

  createRenderPipeline(handle, descriptor) {
    const bytes = encodeUtf8(JSON.stringify(descriptor));
    const payload = new Uint8Array(4 + bytes.length);
    new DataView(payload.buffer).setUint32(0, u32(handle, 'handle', true), true);
    payload.set(bytes, 4);
    this.append(Opcode.CREATE_RENDER_PIPELINE, payload);
  }

  beginRenderPass(colors, depth) {
    const payload = new Uint8Array(4 + colors.length * 52 + 32);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(colors.length, 'color attachment count'), true);
    colors.forEach((color, index) => {
      const offset = 4 + index * 52;
      if (color === null) return;
      view.setUint32(offset, 1 | (color.resolve === null ? 0 : 2), true);
      view.setUint32(offset + 4, u32(color.view, 'view handle'), true);
      view.setUint32(offset + 8, u32(color.resolve ?? 0, 'resolve handle'), true);
      view.setUint32(offset + 12, u32(color.load, 'load operation'), true);
      view.setUint32(offset + 16, u32(color.store, 'store operation'), true);
      if (color.clear.length !== 4) throw new RangeError('Invalid clear color');
      color.clear.forEach((component, i) => {
        if (!Number.isFinite(component)) throw new RangeError('Invalid clear color');
        view.setFloat64(offset + 20 + i * 8, component, true);
      });
    });
    if (depth !== null) {
      const offset = 4 + colors.length * 52;
      view.setUint32(offset, u32(depth.view, 'depth view', true), true);
      view.setUint32(offset + 4, u32(depth.flags, 'depth flags'), true);
      view.setUint32(offset + 8, u32(depth.depthLoad, 'depth load'), true);
      view.setUint32(offset + 12, u32(depth.depthStore, 'depth store'), true);
      if (!Number.isFinite(depth.depthClear)) throw new RangeError('Invalid depth clear value');
      view.setFloat32(offset + 16, depth.depthClear, true);
      view.setUint32(offset + 20, u32(depth.stencilLoad, 'stencil load'), true);
      view.setUint32(offset + 24, u32(depth.stencilStore, 'stencil store'), true);
      view.setUint32(offset + 28, u32(depth.stencilClear, 'stencil clear'), true);
    }
    this.append(Opcode.BEGIN_RENDER_PASS, payload);
  }

  copyTo(destination) {
    for (const { opcode, payload } of this.#records) destination.append(opcode, payload);
  }

  drainTo(destination) {
    this.copyTo(destination);
    this.#records = [];
    this.#size = HEADER_SIZE;
  }

  words(opcode, values) {
    const payload = new Uint8Array(values.length * 4);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => view.setUint32(index * 4, u32(value, 'command field'), true));
    this.append(opcode, payload);
  }

  floats(opcode, values, size) {
    const payload = new Uint8Array(values.length * size);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) throw new RangeError('Invalid command float');
      if (size === 4) view.setFloat32(index * size, value, true);
      else view.setFloat64(index * size, value, true);
    });
    this.append(opcode, payload);
  }

  bufferRange(opcode, first, handle, offset, size) {
    const payload = new Uint8Array(24);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(first, 'slot or format'), true);
    view.setUint32(4, u32(handle, 'buffer handle', true), true);
    view.setBigUint64(8, u64(offset, 'buffer offset'), true);
    view.setBigUint64(16, u64(size, 'buffer size'), true);
    this.append(opcode, payload);
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

  createBuffer(handle, size, usage, label = '') {
    const name = encodeUtf8(label);
    const payload = new Uint8Array(20 + name.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, u32(handle, 'handle', true), true);
    view.setBigUint64(4, u64(size, 'size'), true);
    view.setUint32(12, u32(usage, 'usage'), true);
    view.setUint32(16, name.length, true);
    payload.set(name, 20);
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

  finish(frame = 0) {
    const bytes = new Uint8Array(this.#size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint16(4, VERSION, true);
    view.setUint32(8, this.#size, true);
    view.setUint32(12, u32(frame, 'frame'), true);
    view.setUint32(16, this.#records.length, true);
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

export function streamFrame(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
}

export function decodeCommands(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Command stream must be a Uint8Array');
  if (bytes.byteLength < HEADER_SIZE) throw new RangeError('Truncated command stream header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('Invalid command stream magic');
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new Error(`Command stream version ${version} is not supported: this decoder reads version ${VERSION}`);
  if (view.getUint16(6, true) !== 0) throw new Error('Unsupported command stream flags');
  if (view.getUint32(8, true) !== bytes.byteLength) throw new RangeError('Invalid command stream length');
  const count = view.getUint32(16, true);
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
