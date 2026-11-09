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

  createBuffer(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const buffer = new RecordingBuffer(this, descriptor);
    this.buffers.add(buffer);
    return buffer;
  }

  destroy() {
    if (this.destroyed) return;
    for (const buffer of this.buffers) buffer.destroy();
    this.destroyed = true;
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
}
