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

export class RecordingDevice {
  constructor({ features = [], limits = {} } = {}) {
    this.handles = new Handles();
    this.commands = new CommandEncoder();
    this.buffers = new Set();
    this.shaders = new Set();
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

  createBuffer(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const buffer = new RecordingBuffer(this, descriptor);
    this.buffers.add(buffer);
    return buffer;
  }

  destroy() {
    if (this.destroyed) return;
    for (const buffer of this.buffers) buffer.destroy();
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

  async getArrayBufferAsync(attribute, target = null, offset = 0, count = -1) {
    if (target !== null && !(target instanceof ArrayBuffer)) throw new Error('ReadbackBuffer targets are not implemented');
    const buffer = this.get(this.getBufferAttribute(attribute)).buffer;
    const bytes = await this.recordingDevice.readBuffer(buffer, offset, count === -1 ? buffer.size - offset : count);
    if (target === null) return bytes;
    new Uint8Array(target).set(new Uint8Array(bytes));
    return target;
  }

  destroyProgram(program) {
    const shader = this.get(program).module?.module;
    if (shader) this.recordingDevice.releaseShader(shader);
    super.destroyProgram(program);
  }
}
