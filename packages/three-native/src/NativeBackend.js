import { WebGPUBackend } from 'three/webgpu';
import { CommandEncoder, Handles, Opcode } from './commands.js';

class RecordingBuffer {
  constructor(device, descriptor) {
    this.device = device;
    this.handle = device.handles.allocate();
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.destroyed = false;
    this.mapped = descriptor.mappedAtCreation ? new ArrayBuffer(descriptor.size) : null;
    const usage = descriptor.mappedAtCreation ? descriptor.usage | 8 : descriptor.usage;
    device.commands.createBuffer(this.handle, descriptor.size, usage);
  }

  getMappedRange(offset = 0, size = this.size - offset) {
    if (!this.mapped || offset !== 0 || size !== this.size) throw new Error('Only a whole mapped-at-creation buffer is supported');
    return this.mapped;
  }

  unmap() {
    if (!this.mapped) throw new Error('Buffer is not mapped');
    this.device.commands.writeBuffer(this.handle, 0, new Uint8Array(this.mapped));
    this.mapped = null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mapped = null;
    this.device.commands.destroyBuffer(this.handle);
    this.device.buffers.delete(this);
  }
}

class RecordingTexture {
  constructor(device, descriptor) {
    if ((descriptor.dimension ?? '2d') !== '2d') throw new Error('Only 2D textures are implemented');
    if (descriptor.viewFormats?.length || descriptor.textureBindingViewDimension) throw new Error('Texture view formats and binding dimensions are not implemented');
    const size = descriptor.size;
    this.width = Array.isArray(size) ? size[0] : size.width;
    this.height = (Array.isArray(size) ? size[1] : size.height) ?? 1;
    this.depthOrArrayLayers = (Array.isArray(size) ? size[2] : size.depthOrArrayLayers) ?? 1;
    this.mipLevelCount = descriptor.mipLevelCount ?? 1;
    this.sampleCount = descriptor.sampleCount ?? 1;
    this.format = descriptor.format;
    this.usage = descriptor.usage;
    this.device = device;
    this.handle = device.handles.allocate();
    this.destroyed = false;
    device.commands.createTexture(this.handle, {
      width: this.width, height: this.height, layers: this.depthOrArrayLayers,
      mips: this.mipLevelCount, samples: this.sampleCount, usage: this.usage, format: this.format,
    });
  }

  createView(descriptor = {}) {
    if (this.destroyed) throw new Error('Texture is destroyed');
    if (descriptor.format && descriptor.format !== this.format) throw new Error('Texture view format changes are not implemented');
    if (descriptor.swizzle && descriptor.swizzle !== 'rgba') throw new Error('Texture swizzles are not implemented');
    const dimensions = { '2d': 1, '2d-array': 2, cube: 3, 'cube-array': 4 };
    const aspects = { all: 0, 'depth-only': 1, 'stencil-only': 2 };
    const dimension = descriptor.dimension === undefined ? 0 : dimensions[descriptor.dimension];
    const aspect = aspects[descriptor.aspect ?? 'all'];
    if (dimension === undefined || aspect === undefined) throw new Error('Unsupported texture view');
    const handle = this.device.handles.allocate();
    this.device.commands.createTextureView(handle, this.handle, {
      baseMip: descriptor.baseMipLevel ?? 0, mips: descriptor.mipLevelCount ?? 0,
      baseLayer: descriptor.baseArrayLayer ?? 0, layers: descriptor.arrayLayerCount ?? 0,
      dimension, aspect, usage: descriptor.usage ?? 0,
    });
    return { handle, texture: this };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.device.commands.destroyTexture(this.handle);
    this.device.textures.delete(this);
  }
}

function extent(value) {
  return Array.isArray(value)
    ? { width: value[0], height: value[1] ?? 1, layers: value[2] ?? 1 }
    : { width: value.width, height: value.height ?? 1, layers: value.depthOrArrayLayers ?? 1 };
}

function origin(value = {}) {
  return Array.isArray(value)
    ? { x: value[0] ?? 0, y: value[1] ?? 0, layer: value[2] ?? 0 }
    : { x: value.x ?? 0, y: value.y ?? 0, layer: value.z ?? 0 };
}

export class RecordingDevice {
  constructor({ features = [], limits = {} } = {}) {
    this.handles = new Handles();
    this.commands = new CommandEncoder();
    this.buffers = new Set();
    this.textures = new Set();
    this.shaders = new Set();
    this.samplers = new Set();
    this.pending = new Map();
    this.onResponse = event => this.receiveResponses(event.responses);
    globalThis.addEventListener?.('gpu-response', this.onResponse);
    this.destroyed = false;
    this.features = new Set(features.filter(feature => feature !== 'subgroups'));
    this.limits = limits;
    this.lost = new Promise(resolve => { this.resolveLost = resolve; });
    this.queue = {
      writeBuffer: (buffer, offset, data, dataOffset = 0, size) => {
        if (!(buffer instanceof RecordingBuffer) || buffer.device !== this || buffer.destroyed) throw new Error('Invalid buffer');
        const array = ArrayBuffer.isView(data);
        if (!array && !(data instanceof ArrayBuffer)) throw new TypeError('Expected buffer data');
        const elementSize = array ? data.BYTES_PER_ELEMENT ?? 1 : 1;
        const bytes = array ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        const start = dataOffset * elementSize;
        const length = size === undefined ? bytes.byteLength - start : size * elementSize;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > bytes.byteLength) throw new RangeError('Invalid buffer data range');
        this.commands.writeBuffer(buffer.handle, offset, bytes.subarray(start, start + length));
      },
      writeTexture: (destination, data, layout, size) => {
        const texture = destination.texture;
        if (!(texture instanceof RecordingTexture) || texture.device !== this || texture.destroyed) throw new Error('Invalid texture');
        if (destination.aspect && destination.aspect !== 'all') throw new Error('Texture aspects are not implemented');
        if (!ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) throw new TypeError('Expected texture data');
        const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        const offset = layout.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw new RangeError('Invalid texture data offset');
        this.commands.writeTexture(texture.handle, {
          mip: destination.mipLevel ?? 0, ...origin(destination.origin), ...extent(size),
          bytesPerRow: layout.bytesPerRow ?? 0, rowsPerImage: layout.rowsPerImage ?? 0,
        }, bytes.subarray(offset));
      },
      submit: commands => {
        if (commands.length !== 0) throw new Error('Command buffer submission is not implemented');
        this.commands.append(Opcode.SUBMIT);
      },
    };
  }

  createShaderModule(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const handle = this.handles.allocate();
    const code = descriptor.code.replace(/^[\t ]*enable[\t ]+subgroups[\t ]*;[\t ]*(?:\/\/[^\r\n]*)?(?=\r?$)/gm, '');
    this.commands.createShader(handle, descriptor.label ?? '', code);
    const shader = { handle, label: descriptor.label ?? '' };
    this.shaders.add(shader);
    return shader;
  }

  readBuffer(buffer, offset, size) {
    if (!(buffer instanceof RecordingBuffer) || buffer.device !== this || buffer.destroyed) throw new Error('Invalid buffer');
    const request = this.handles.allocate();
    this.commands.readBuffer(request, buffer.handle, offset, size);
    return new Promise((resolve, reject) => this.pending.set(request, { resolve, reject }));
  }

  receiveResponses(responses) {
    for (const response of responses) {
      const pending = this.pending.get(response.request);
      if (pending) {
        this.pending.delete(response.request);
        if (response.type === 'readback') pending.resolve(Uint8Array.from(response.bytes).buffer);
        else pending.reject(new Error(response.message));
      } else if (response.type === 'error' && response.request == null) {
        this.onuncapturederror?.({ error: new Error(response.message) });
      }
    }
  }

  releaseShader(shader) {
    if (!this.shaders.delete(shader)) return;
    this.commands.destroyResource(shader.handle);
  }

  createSampler(descriptor = {}) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const addresses = { 'clamp-to-edge': 0, repeat: 1, 'mirror-repeat': 2 };
    const filters = { nearest: 0, linear: 1 };
    const comparisons = { never: 1, less: 2, equal: 3, 'less-equal': 4, greater: 5, 'not-equal': 6, 'greater-equal': 7, always: 8 };
    const value = (map, key, fallback) => {
      const result = map[key ?? fallback];
      if (result === undefined) throw new Error('Unsupported sampler option');
      return result;
    };
    const handle = this.handles.allocate();
    this.commands.createSampler(handle, {
      addressU: value(addresses, descriptor.addressModeU, 'clamp-to-edge'),
      addressV: value(addresses, descriptor.addressModeV, 'clamp-to-edge'),
      addressW: value(addresses, descriptor.addressModeW, 'clamp-to-edge'),
      mag: value(filters, descriptor.magFilter, 'nearest'),
      min: value(filters, descriptor.minFilter, 'nearest'),
      mipmap: value(filters, descriptor.mipmapFilter, 'nearest'),
      lodMin: descriptor.lodMinClamp ?? 0,
      lodMax: descriptor.lodMaxClamp ?? 32,
      compare: descriptor.compare === undefined ? 0 : value(comparisons, descriptor.compare),
      anisotropy: descriptor.maxAnisotropy ?? 1,
    });
    const sampler = { handle };
    this.samplers.add(sampler);
    return sampler;
  }

  releaseSampler(sampler) {
    if (!this.samplers.delete(sampler)) return;
    this.commands.destroyResource(sampler.handle);
  }

  createTexture(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const texture = new RecordingTexture(this, descriptor);
    this.textures.add(texture);
    return texture;
  }

  readTexture(texture, descriptor) {
    if (!(texture instanceof RecordingTexture) || texture.device !== this || texture.destroyed) throw new Error('Invalid texture');
    const request = this.handles.allocate();
    this.commands.readTexture(request, texture.handle, descriptor);
    return new Promise((resolve, reject) => this.pending.set(request, { resolve, reject }));
  }

  createBuffer(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const buffer = new RecordingBuffer(this, descriptor);
    this.buffers.add(buffer);
    return buffer;
  }

  destroy() {
    if (this.destroyed) return;
    for (const buffer of this.buffers) buffer.destroy();
    for (const texture of this.textures) texture.destroy();
    for (const sampler of this.samplers) this.releaseSampler(sampler);
    for (const shader of this.shaders) this.releaseShader(shader);
    this.destroyed = true;
    globalThis.removeEventListener?.('gpu-response', this.onResponse);
    for (const pending of this.pending.values()) pending.reject(new Error('Device is destroyed'));
    this.pending.clear();
    this.resolveLost({ reason: 'destroyed', message: '' });
  }

  takeFrame() {
    return this.commands.finish();
  }
}

export class NativeBackend extends WebGPUBackend {
  constructor(parameters = {}, capabilities = {}) {
    const device = new RecordingDevice(capabilities);
    super({ ...parameters, device });
    this.recordingDevice = device;
    this.isNativeBackend = true;
  }

  takeFrame() {
    return this.recordingDevice.takeFrame();
  }

  async copyTextureToBuffer(texture, x, y, width, height, faceIndex = 0) {
    const gpuTexture = this.get(texture).texture;
    const bytes = await this.recordingDevice.readTexture(gpuTexture, { mip: 0, x, y, layer: faceIndex, width, height });
    return new Uint8Array(bytes);
  }

  async getArrayBufferAsync(attribute, target = null, offset = 0, count = -1) {
    if (target !== null && !(target instanceof ArrayBuffer)) throw new Error('ReadbackBuffer targets are not implemented');
    const buffer = this.get(this.getBufferAttribute(attribute)).buffer;
    const bytes = await this.recordingDevice.readBuffer(buffer, offset, count === -1 ? buffer.size - offset : count);
    if (target === null) return bytes;
    new Uint8Array(target).set(new Uint8Array(bytes));
    return target;
  }

  updateSampler(binding) {
    const { sampler: previous, samplerKey: key } = this.get(binding);
    const result = super.updateSampler(binding);
    if (previous && !this.textureUtils._samplerCache.has(key)) this.recordingDevice.releaseSampler(previous);
    return result;
  }

  destroySampler(binding) {
    const { sampler, samplerKey: key } = this.get(binding);
    super.destroySampler(binding);
    if (sampler && !this.textureUtils._samplerCache.has(key)) this.recordingDevice.releaseSampler(sampler);
  }

  destroyProgram(program) {
    const shader = this.get(program).module?.module;
    if (shader) this.recordingDevice.releaseShader(shader);
    super.destroyProgram(program);
  }
}
