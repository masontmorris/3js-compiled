import { UnsignedByteType, WebGPUBackend } from 'three/webgpu';
import { CommandEncoder, Handles, Opcode } from './commands.js';

globalThis.GPUBufferUsage ??= Object.freeze({ MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 });
globalThis.GPUTextureUsage ??= Object.freeze({ COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 });
globalThis.GPUShaderStage ??= Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
globalThis.GPUMapMode ??= Object.freeze({ READ: 1, WRITE: 2 });
globalThis.GPURenderBundleEncoder ??= class GPURenderBundleEncoder {};
// Pipelines are instances of these, as a page that reports a value's constructor sees in Edge.
for (const name of ['GPURenderPipeline', 'GPUComputePipeline']) globalThis[name] ??= { [name]: class {} }[name];
// three reports an error's constructor name, and object keys name these classes where a bundler renames bindings.
globalThis.GPUError ??= { GPUError: class { constructor(message) { this.message = String(message); } } }.GPUError;
for (const name of ['GPUValidationError', 'GPUOutOfMemoryError', 'GPUInternalError']) {
  globalThis[name] ??= { [name]: class extends globalThis.GPUError {} }[name];
}
globalThis.GPUPipelineError ??= class GPUPipelineError extends DOMException {
  constructor(message = '', options = {}) {
    super(message, 'GPUPipelineError');
    this.reason = options.reason;
  }
};

// Each GPUErrorFilter, as the stream's PUSH_ERROR_SCOPE numbers it, and the error a scope of it captures.
const errorFilters = { validation: 0, 'out-of-memory': 1, internal: 2 };
const errorTypes = { validation: GPUValidationError, 'out-of-memory': GPUOutOfMemoryError, internal: GPUInternalError };

// The OperationError DOMException that WebGPU throws or rejects with, with a stack, as Edge's has.
const operationError = message => {
  const error = new DOMException(message, 'OperationError');
  Error.captureStackTrace?.(error, operationError);
  return error;
};

// The AbortError DOMException that rejects a map that an unmap() or a destroy() cancels.
const abortError = message => {
  const error = new DOMException(message, 'AbortError');
  Error.captureStackTrace?.(error, abortError);
  return error;
};

// The CREATE_BUFFER usage bit of threejsc_gpu's MAPPED_AT_CREATION.
const MAPPED_AT_CREATION = 2 ** 31;

// A buffer is unmapped, pending, or mapped, as its mapState says. A pending buffer has the map its mapAsync() requested,
// which the executor answers with the range's bytes or rejects. A mapped buffer has a mapping: its mode, its range,
// the range's bytes, and the ranges getMappedRange() returned, which unmap() detaches and, for writing, records.
class RecordingBuffer {
  constructor(device, descriptor) {
    this.device = device;
    this.handle = device.handles.allocate();
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.destroyed = false;
    this.pending = null;
    this.mapping = descriptor.mappedAtCreation
      ? { mode: GPUMapMode.WRITE, offset: 0, size: descriptor.size, data: new ArrayBuffer(descriptor.size), ranges: [] }
      : null;
    // The executor creates a buffer mapped at creation mapped, and unmap() records its data.
    const usage = descriptor.mappedAtCreation ? (descriptor.usage | MAPPED_AT_CREATION) >>> 0 : descriptor.usage;
    device.commands.createBuffer(this.handle, descriptor.size, usage, descriptor.label ?? '');
  }

  get mapState() {
    return this.mapping ? 'mapped' : this.pending ? 'pending' : 'unmapped';
  }

  // The executor validates the map as WebGPU's device timeline does, and a map it rejects raises a validation error
  // too.
  mapAsync(mode, offset = 0, size) {
    const device = this.device;
    if (device.destroyed) return Promise.reject(abortError('mapAsync failed: the device was lost before the map resolved'));
    if (this.pending) return Promise.reject(operationError('mapAsync failed: the buffer already has a map pending'));
    const range = size ?? Math.max(0, this.size - offset);
    const request = device.handles.allocate();
    device.commands.mapBuffer(request, this.handle, mode, offset, range);
    const answer = device.expect(request, true, resolve => resolve);
    return new Promise((resolve, reject) => {
      const pending = this.pending = { request, reject };
      answer.then(bytes => {
        if (this.pending !== pending) return;
        this.pending = null;
        this.mapping = { mode, offset, size: range, data: bytes, ranges: [] };
        resolve();
      }, error => {
        if (this.pending !== pending) return;
        this.pending = null;
        reject(operationError(error.message));
      });
    });
  }

  abortMap(message) {
    const { request, reject } = this.pending;
    this.pending = null;
    this.device.pending.delete(request);
    this.device.awaited.delete(request);
    reject(abortError(message));
  }

  getMappedRange(offset = 0, size) {
    const mapping = this.mapping;
    if (!mapping) throw operationError('getMappedRange failed: the buffer is not mapped');
    const length = size ?? Math.max(0, this.size - offset);
    const start = offset - mapping.offset;
    const overlaps = mapping.ranges.some(range => offset < range.offset + range.length && range.offset < offset + length);
    if (offset % 8 !== 0 || length % 4 !== 0 || start < 0 || start + length > mapping.size || overlaps) {
      throw operationError(`getMappedRange failed: the range from ${offset} of ${length} bytes is not mapped or overlaps a returned range`);
    }
    const bytes = mapping.data.slice(start, start + length);
    mapping.ranges.push({ offset, length, bytes });
    return bytes;
  }

  // As in WebGPU, unmap() rejects a pending map, detaches the mapped ranges, and does nothing on a buffer that is
  // not mapped, such as one already unmapped or destroyed. It records the data of a range mapped for writing. A
  // buffer over maxBufferSize is invalid, and the unmap of an invalid buffer does nothing, so its data stays here.
  unmap() {
    if (this.pending) {
      this.abortMap('unmap() was called before the map resolved');
      this.device.commands.unmapBuffer(this.handle, 0, new Uint8Array());
      return;
    }
    const mapping = this.mapping;
    if (!mapping) return;
    this.mapping = null;
    const written = mapping.mode === GPUMapMode.WRITE && this.size <= this.device.limits.maxBufferSize;
    const data = written ? new Uint8Array(mapping.data) : new Uint8Array();
    for (const range of mapping.ranges) {
      if (written) data.set(new Uint8Array(range.bytes), range.offset - mapping.offset);
      range.bytes.transfer();
    }
    this.device.commands.unmapBuffer(this.handle, mapping.offset, data);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pending) this.abortMap('the buffer was destroyed before the map resolved');
    for (const range of this.mapping?.ranges ?? []) range.bytes.transfer();
    this.mapping = null;
    this.device.commands.destroyBuffer(this.handle);
    this.device.buffers.delete(this);
  }
}

class RecordingTexture {
  constructor(device, descriptor, surface = false) {
    if ((descriptor.dimension ?? '2d') !== '2d') throw new Error('Only 2D textures are implemented');
    if (descriptor.viewFormats?.length) throw new Error('Texture view formats are not implemented');
    const size = descriptor.size;
    this.width = Array.isArray(size) ? size[0] : size.width;
    this.height = (Array.isArray(size) ? size[1] : size.height) ?? 1;
    this.depthOrArrayLayers = (Array.isArray(size) ? size[2] : size.depthOrArrayLayers) ?? 1;
    this.mipLevelCount = descriptor.mipLevelCount ?? 1;
    this.sampleCount = descriptor.sampleCount ?? 1;
    this.format = descriptor.format;
    this.usage = descriptor.usage;
    this.textureBindingViewDimension = descriptor.textureBindingViewDimension;
    this.device = device;
    this.handle = device.handles.allocate();
    this.destroyed = false;
    this.surface = surface;
    if (surface) device.commands.words(Opcode.ACQUIRE_SURFACE, [this.handle, this.width, this.height]);
    else device.commands.createTexture(this.handle, {
      width: this.width, height: this.height, layers: this.depthOrArrayLayers,
      mips: this.mipLevelCount, samples: this.sampleCount, usage: this.usage, format: this.format, label: descriptor.label ?? '',
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
    if (!this.surface) this.device.commands.destroyTexture(this.handle);
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

// The texture side of a copy, as a GPUTexelCopyTextureInfo names it. As in WebGPU, a copy of a destroyed buffer or
// texture records, and its submit fails.
function copyTexture(device, info) {
  const texture = info.texture;
  if (!(texture instanceof RecordingTexture)) throw new TypeError('Invalid copy texture');
  if (texture.device !== device) throw new Error('Invalid copy texture');
  const aspect = { all: 0, 'depth-only': 1, 'stencil-only': 2 }[info.aspect ?? 'all'];
  if (aspect === undefined) throw new TypeError('Invalid texture aspect');
  return { handle: texture.handle, mip: info.mipLevel ?? 0, ...origin(info.origin), aspect };
}

function copyBuffer(device, buffer) {
  if (!(buffer instanceof RecordingBuffer)) throw new TypeError('Invalid copy buffer');
  if (buffer.device !== device) throw new Error('Invalid copy buffer');
  return buffer.handle;
}

function notImplemented(method) {
  return () => { throw new Error(`${method} is not implemented on the native device`); };
}

// Debug groups and markers, which a command encoder and a render pass both record.
function debugCommands(commands, record) {
  return {
    pushDebugGroup: label => record(() => commands.debug(Opcode.PUSH_DEBUG_GROUP, String(label))),
    popDebugGroup: () => record(() => commands.debug(Opcode.POP_DEBUG_GROUP)),
    insertDebugMarker: label => record(() => commands.debug(Opcode.INSERT_DEBUG_MARKER, String(label))),
  };
}

// `uses` collects the handles of the objects the commands set.
function drawCommands(device, commands, record, uses = new Set()) {
  const bufferHandle = buffer => {
    if (!(buffer instanceof RecordingBuffer) || buffer.device !== device) throw new Error('Invalid render buffer');
    uses.add(buffer.handle);
    return buffer.handle;
  };
  return {
    setPipeline: pipeline => {
      if (!device.renderPipelines.has(pipeline)) throw new Error('Invalid render pipeline');
      record(() => commands.words(Opcode.SET_PIPELINE, [pipeline.handle]));
      uses.add(pipeline.handle);
    },
    setBindGroup: (index, group, offsets = []) => {
      if (!device.bindGroups.has(group)) throw new Error('Invalid bind group');
      record(() => commands.words(Opcode.SET_BIND_GROUP, [index, group.handle, offsets.length, ...offsets]));
      uses.add(group.handle);
    },
    setVertexBuffer: (slot, buffer, offset = 0, size = 0) => {
      record(() => commands.bufferRange(Opcode.SET_VERTEX_BUFFER, slot, bufferHandle(buffer), offset, size));
    },
    setIndexBuffer: (buffer, format, offset = 0, size = 0) => {
      const formatValue = { uint16: 0, uint32: 1 }[format];
      if (formatValue === undefined) throw new Error('Invalid index format');
      record(() => commands.bufferRange(Opcode.SET_INDEX_BUFFER, formatValue, bufferHandle(buffer), offset, size));
    },
    draw: (vertices, instances = 1, firstVertex = 0, firstInstance = 0) => record(() => commands.words(Opcode.DRAW, [vertices, instances, firstVertex, firstInstance])),
    drawIndexed: (indices, instances = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0) => {
      if (!Number.isInteger(baseVertex) || baseVertex < -0x80000000 || baseVertex > 0x7fffffff) throw new RangeError('Invalid base vertex');
      record(() => commands.words(Opcode.DRAW_INDEXED, [indices, instances, firstIndex, baseVertex >>> 0, firstInstance]));
    },
  };
}

// A pass copies a bundle's commands when it executes the bundle. The executor keeps only whether the
// bundle is valid, which it is when every object it sets is.
class RecordingRenderBundleEncoder extends GPURenderBundleEncoder {
  constructor(device) {
    super();
    this.device = device;
    this.commands = new CommandEncoder();
    this.uses = new Set();
    this.finished = false;
    Object.assign(this, drawCommands(device, this.commands, write => {
      if (this.finished) throw new Error('Render bundle is finished');
      write();
    }, this.uses));
  }

  finish() {
    if (this.finished) throw new Error('Render bundle is finished');
    this.finished = true;
    const bundle = { device: this.device, commands: this.commands, handle: this.device.handles.allocate() };
    this.device.commands.words(Opcode.CREATE_RENDER_BUNDLE, [bundle.handle, this.uses.size, ...this.uses]);
    this.device.bundles.register(bundle, bundle.handle);
    return bundle;
  }
}

class RecordingCommandEncoder {
  constructor(device) {
    this.device = device;
    this.commands = new CommandEncoder();
    this.activePass = null;
    this.finished = false;
  }

  writeTimestamp = notImplemented('GPUCommandEncoder.writeTimestamp');

  timestampWrites(writes) {
    if (!writes) return null;
    if (writes.querySet?.device !== this.device) throw new TypeError('Invalid timestampWrites query set');
    return { querySet: writes.querySet.handle, begin: writes.beginningOfPassWriteIndex, end: writes.endOfPassWriteIndex };
  }

  beginComputePass(descriptor = {}) {
    if (this.finished || this.activePass) throw new Error('Command encoder is not available');
    this.commands.beginComputePass(this.timestampWrites(descriptor.timestampWrites));
    const record = write => {
      if (this.activePass !== pass) throw new Error('Compute pass has ended');
      write();
    };
    const pass = {
      ...debugCommands(this.commands, record),
      setPipeline: pipeline => {
        if (!this.device.computePipelines.has(pipeline)) throw new TypeError('Invalid compute pipeline');
        record(() => this.commands.words(Opcode.SET_PIPELINE, [pipeline.handle]));
      },
      setBindGroup: (index, group, offsets = []) => {
        if (!this.device.bindGroups.has(group)) throw new Error('Invalid bind group');
        record(() => this.commands.words(Opcode.SET_BIND_GROUP, [index, group.handle, offsets.length, ...offsets]));
      },
      dispatchWorkgroups: (x, y = 1, z = 1) => record(() => this.commands.words(Opcode.DISPATCH, [x, y, z])),
      dispatchWorkgroupsIndirect: (buffer, offset) => record(() => this.commands.dispatchIndirect(copyBuffer(this.device, buffer), offset)),
      end: () => {
        if (this.activePass !== pass) throw new Error('Compute pass has ended');
        this.commands.append(Opcode.END_COMPUTE_PASS);
        this.activePass = null;
      },
    };
    this.activePass = pass;
    return pass;
  }

  resolveQuerySet(querySet, first, count, destination, destinationOffset) {
    if (querySet?.device !== this.device) throw new TypeError('Invalid query set');
    this.encode(() => this.commands.resolveQuerySet(querySet.handle, first, count, copyBuffer(this.device, destination), destinationOffset));
  }

  beginRenderPass(descriptor) {
    if (this.finished || this.activePass) throw new Error('Command encoder is not available');
    if (descriptor.occlusionQuerySet) throw new Error('Occlusion queries are not implemented on the native device');
    const viewHandle = view => {
      if (!(view?.texture instanceof RecordingTexture) || view.texture.device !== this.device) throw new Error('Invalid render attachment');
      return view.handle;
    };
    const colors = descriptor.colorAttachments.map(attachment => {
      if (attachment === null) return null;
      if (attachment.depthSlice !== undefined) throw new Error('Depth slices are not implemented');
      const load = { load: 0, clear: 1 }[attachment.loadOp];
      const store = { discard: 0, store: 1 }[attachment.storeOp];
      if (load === undefined || store === undefined) throw new Error('Invalid render attachment operation');
      const clear = attachment.clearValue ?? [0, 0, 0, 0];
      return {
        view: viewHandle(attachment.view),
        resolve: attachment.resolveTarget == null ? null : viewHandle(attachment.resolveTarget),
        load, store,
        clear: Array.isArray(clear) ? clear : [clear.r, clear.g, clear.b, clear.a],
      };
    });
    const attachment = descriptor.depthStencilAttachment;
    let depth = null;
    if (attachment) {
      const operation = (value, map) => {
        const result = map[value];
        if (result === undefined) throw new Error('Invalid depth or stencil operation');
        return result;
      };
      const hasDepth = attachment.depthLoadOp !== undefined || attachment.depthStoreOp !== undefined;
      const hasStencil = attachment.stencilLoadOp !== undefined || attachment.stencilStoreOp !== undefined;
      if ((hasDepth && attachment.depthReadOnly) || (hasStencil && attachment.stencilReadOnly)) throw new Error('Read-only attachment has write operations');
      depth = {
        view: viewHandle(attachment.view), flags: Number(hasDepth) | (Number(hasStencil) << 1),
        depthLoad: hasDepth ? operation(attachment.depthLoadOp, { load: 0, clear: 1 }) : 0,
        depthStore: hasDepth ? operation(attachment.depthStoreOp, { discard: 0, store: 1 }) : 0,
        depthClear: attachment.depthClearValue ?? 1,
        stencilLoad: hasStencil ? operation(attachment.stencilLoadOp, { load: 0, clear: 1 }) : 0,
        stencilStore: hasStencil ? operation(attachment.stencilStoreOp, { discard: 0, store: 1 }) : 0,
        stencilClear: attachment.stencilClearValue ?? 0,
      };
    }
    this.commands.beginRenderPass(colors, depth, this.timestampWrites(descriptor.timestampWrites));
    const record = write => {
      if (this.activePass !== pass) throw new Error('Render pass has ended');
      write();
    };
    const pass = {
      ...drawCommands(this.device, this.commands, record),
      ...debugCommands(this.commands, record),
      beginOcclusionQuery: notImplemented('GPURenderPassEncoder.beginOcclusionQuery'),
      endOcclusionQuery: notImplemented('GPURenderPassEncoder.endOcclusionQuery'),
      setViewport: (x, y, width, height, minDepth, maxDepth) => record(() => this.commands.floats(Opcode.SET_VIEWPORT, [x, y, width, height, minDepth, maxDepth], 4)),
      setScissorRect: (x, y, width, height) => record(() => this.commands.words(Opcode.SET_SCISSOR, [x, y, width, height])),
      setBlendConstant: color => record(() => this.commands.floats(Opcode.SET_BLEND_CONSTANT, Array.isArray(color) ? color : [color.r, color.g, color.b, color.a], 8)),
      setStencilReference: reference => record(() => this.commands.words(Opcode.SET_STENCIL_REFERENCE, [reference])),
      executeBundles: bundles => record(() => {
        if (bundles.some(bundle => bundle?.device !== this.device)) throw new Error('Invalid render bundle');
        this.commands.words(Opcode.EXECUTE_BUNDLES, [bundles.length, ...bundles.map(bundle => bundle.handle)]);
        for (const bundle of bundles) bundle.commands.copyTo(this.commands);
      }),
      end: () => {
        if (this.activePass !== pass) throw new Error('Render pass has ended');
        this.commands.append(Opcode.END_RENDER_PASS);
        this.activePass = null;
      },
    };
    this.activePass = pass;
    return pass;
  }

  // Records an encoder command, which WebGPU allows only outside a pass of an unfinished encoder.
  encode(write) {
    if (this.finished || this.activePass) throw new Error('Command encoder is not available');
    write();
  }

  copyBufferToBuffer(source, ...rest) {
    const [sourceOffset, destination, destinationOffset, size] = rest[0] instanceof RecordingBuffer ? [0, rest[0], 0, rest[1]] : rest;
    this.encode(() => this.commands.copyBufferToBuffer(copyBuffer(this.device, source), sourceOffset, copyBuffer(this.device, destination),
      destinationOffset, size ?? source.size - sourceOffset));
  }

  clearBuffer(buffer, offset = 0, size = buffer.size - offset) {
    this.encode(() => this.commands.clearBuffer(copyBuffer(this.device, buffer), offset, size));
  }

  copyBufferToTexture(source, destination, size) {
    this.encode(() => this.commands.bufferTextureCopy(Opcode.COPY_BUFFER_TO_TEXTURE, {
      handle: copyBuffer(this.device, source.buffer), offset: source.offset ?? 0,
      bytesPerRow: source.bytesPerRow ?? 0, rowsPerImage: source.rowsPerImage ?? 0,
    }, copyTexture(this.device, destination), extent(size)));
  }

  copyTextureToBuffer(source, destination, size) {
    this.encode(() => this.commands.bufferTextureCopy(Opcode.COPY_TEXTURE_TO_BUFFER, {
      handle: copyBuffer(this.device, destination.buffer), offset: destination.offset ?? 0,
      bytesPerRow: destination.bytesPerRow ?? 0, rowsPerImage: destination.rowsPerImage ?? 0,
    }, copyTexture(this.device, source), extent(size)));
  }

  copyTextureToTexture(source, destination, size) {
    this.encode(() => this.commands.copyTextureToTexture(copyTexture(this.device, source), copyTexture(this.device, destination), extent(size)));
  }

  pushDebugGroup(label) { this.encode(() => this.commands.debug(Opcode.PUSH_DEBUG_GROUP, String(label))); }

  popDebugGroup() { this.encode(() => this.commands.debug(Opcode.POP_DEBUG_GROUP)); }

  insertDebugMarker(label) { this.encode(() => this.commands.debug(Opcode.INSERT_DEBUG_MARKER, String(label))); }

  finish() {
    if (this.finished || this.activePass) throw new Error('Command encoder is not complete');
    this.finished = true;
    return { device: this.device, commands: this.commands, submitted: false };
  }
}

// How many times a script set each watched canvas's width or height, which a browser treats as a
// resize even when the value does not change.
const sizeSets = new WeakMap();

// Counts the sets of the canvas width and height. Each canvas is wrapped once, however many
// renderers use it, and the wrapper holds no renderer. A size the canvas cannot redefine, or that a
// script cannot set, stays as it is, and acquires and frames still record its changes.
function watchSize(canvas) {
  if (sizeSets.has(canvas)) return;
  sizeSets.set(canvas, 0);
  for (const key of ['width', 'height']) {
    let owner = canvas;
    while (owner && !Object.hasOwn(owner, key)) owner = Object.getPrototypeOf(owner);
    const descriptor = owner ? Object.getOwnPropertyDescriptor(owner, key) : undefined;
    const redefinable = owner === canvas ? descriptor.configurable : Object.isExtensible(canvas);
    if (!redefinable || (descriptor && !descriptor.writable && !descriptor.set)) continue;
    let { value, get = () => value, set = next => { value = next; } } = descriptor ?? {};
    Object.defineProperty(canvas, key, {
      configurable: true,
      enumerable: true,
      get() { return get.call(this); },
      set(next) {
        set.call(this, next);
        sizeSets.set(canvas, sizeSets.get(canvas) + 1);
      },
    });
  }
}

class RecordingCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.configuration = null;
    watchSize(canvas);
    this.sizeSets = sizeSets.get(canvas);
  }

  configure(configuration) {
    if (!(configuration.device instanceof RecordingDevice)) throw new Error('Invalid canvas device');
    if (configuration.format !== 'bgra8unorm') throw new Error('The native surface format is bgra8unorm');
    this.configuration = configuration;
    // three configures again after each resize, and only sets before the first configure are not
    // resizes of the canvas the device draws.
    if (configuration.device.context !== this) this.sizeSets = sizeSets.get(this.canvas);
    configuration.device.context = this;
    configuration.device.expireSurface(Opcode.CONFIGURE_SURFACE);
  }

  // The canvas size, and whether a script set it since the last call.
  takeSize() {
    const sets = sizeSets.get(this.canvas);
    const assigned = sets !== this.sizeSets;
    this.sizeSets = sets;
    return [this.canvas.width, this.canvas.height, assigned];
  }

  unconfigure() {
    this.configuration?.device.expireSurface(Opcode.UNCONFIGURE_SURFACE);
    this.configuration = null;
  }

  getConfiguration() {
    return this.configuration;
  }

  getCurrentTexture() {
    if (!this.configuration) throw new Error('Canvas context is not configured');
    const { device } = this.configuration;
    const [width, height, assigned] = this.takeSize();
    device.resizeSurface(width, height, assigned);
    return device.surfaceTexture(width, height, this.configuration);
  }
}

// WebGPU's default limits, which a device has unless its request asks for more. Their names are exactly those of
// Edge 157's adapter.limits on the RTX 3060 (C:\3jsc\swarm\e3-r14v\lane-t\out\edge-limit-names.txt), and the values
// those of Edge's device for a request that asks for nothing.
const defaultLimits = Object.freeze({
  maxTextureDimension1D: 8192, maxTextureDimension2D: 8192, maxTextureDimension3D: 2048, maxTextureArrayLayers: 256,
  maxBindGroups: 4, maxBindGroupsPlusVertexBuffers: 24, maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8, maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16, maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4, maxUniformBuffersPerShaderStage: 12, maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728, minUniformBufferOffsetAlignment: 256, minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8, maxBufferSize: 268435456, maxVertexAttributes: 16, maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 16, maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384, maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64, maxComputeWorkgroupsPerDimension: 65535,
  maxStorageBuffersInFragmentStage: 8, maxStorageBuffersInVertexStage: 8, maxStorageTexturesInFragmentStage: 4,
  maxStorageTexturesInVertexStage: 4, maxImmediateSize: 64,
});

// wgpu has no per-stage storage limits, so the adapter's per-shader-stage limit bounds them, as WebGPU bounds a
// device's. Their requests do not reach wgpu.
const stageLimits = Object.freeze({
  maxStorageBuffersInFragmentStage: 'maxStorageBuffersPerShaderStage', maxStorageBuffersInVertexStage: 'maxStorageBuffersPerShaderStage',
  maxStorageTexturesInFragmentStage: 'maxStorageTexturesPerShaderStage', maxStorageTexturesInVertexStage: 'maxStorageTexturesPerShaderStage',
});

// WebIDL's [EnforceRange] unsigned long long, which requestDevice() converts each limit with.
function enforceRange(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`Value of ${name} is not a finite number`);
  const integer = Math.trunc(number);
  if (integer < 0 || integer > Number.MAX_SAFE_INTEGER) throw new TypeError(`Value of ${name} is outside the 'unsigned long long' value range`);
  return integer + 0;
}

// WebGPU's alignment limits, which are better when lower. Every other limit is better when higher.
const alignments = new Set(['minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment']);

// The limits a device has for `requested`, as a browser's requestDevice() gives them: a requested limit
// better than its default, and the default otherwise. A limit name WebGPU does not know, an alignment that is
// no power of two, and a limit better than the adapter's `supported` one throw the OperationError that rejects
// requestDevice(). Without `supported`, as in Node, no limit is checked against an adapter.
function deviceLimits(requested, supported) {
  const limits = { ...defaultLimits };
  if (supported) supported = { ...Object.fromEntries(Object.entries(stageLimits).map(([name, bound]) => [name, supported[bound]])), ...supported };
  const reject = message => {
    throw operationError(message);
  };
  for (let [name, value] of Object.entries(requested)) {
    if (value === undefined) continue;
    value = enforceRange(value, name);
    if (!(name in defaultLimits)) reject(`The limit "${name}" with a non-undefined value is not recognized`);
    const alignment = alignments.has(name);
    if (alignment && !Number.isInteger(Math.log2(value))) reject(`Required limit (${value}) is not a power of two for ${name}`);
    const better = (a, b) => alignment ? a < b : a > b;
    if (supported?.[name] !== undefined && better(value, supported[name])) {
      reject(`Required limit (${value}) is ${alignment ? 'lower' : 'greater'} than the supported limit (${supported[name]}) for ${name}`);
    }
    if (better(value, limits[name])) limits[name] = value;
  }
  return limits;
}

// The handle space, frame count and command stream that devices recording for one executor share.
function stream() {
  return { handles: new Handles(), commands: new CommandEncoder(), frame: 0, canvasSize: null };
}

// The host replays every NativeBackend in the realm with one executor, and it has one window surface.
const host = { ...stream(), device: null };

// The host calls this at the end of a frame in which the page submitted no command stream. While the page awaits a
// response to the work recorded since the last one, such as compileAsync()'s error scopes before the page's first
// frame, that work goes to the executor, as Chrome flushes for a pending callback, so what waits on it settles.
globalThis.__gpuFrameEnd = () => {
  if (host.device && !host.device.destroyed && host.device.waiting) submitGpuCommands(host.device.takeFrame());
};

// A device has the features its descriptor requires and the limits deviceLimits() gives for them, as a
// browser's requestDevice() gives. The executor's device gets the same. `supported` holds the adapter's limits.
export class RecordingDevice {
  constructor({ features = [], limits = {} } = {}, output = stream(), supported = null) {
    const granted = deviceLimits(limits, supported);
    this.output = output;
    this.handles = output.handles;
    this.commands = output.commands;
    this.buffers = new Set();
    this.textures = new Set();
    this.shaders = new Set();
    this.samplers = new Set();
    this.bindGroupLayouts = new Set();
    this.bindGroups = new Set();
    this.pipelineLayouts = new Set();
    this.renderPipelines = new Set();
    this.computePipelines = new Set();
    this.querySets = new Set();
    this.surface = null;
    // How many error scopes are open. The executor holds the scopes, because it raises the errors.
    this.errorScopes = 0;
    this.pending = new Map();
    // The requests recorded since the stream was last taken, and those whose responses the page awaits.
    this.unsent = new Set();
    this.awaited = new Set();
    this.onResponse = event => this.receiveResponses(event.responses);
    globalThis.addEventListener?.('gpu-response', this.onResponse);
    this.destroyed = false;
    this.features = new Set(features.filter(feature => feature !== 'subgroups'));
    this.limits = Object.freeze(granted);
    this.bundles = new FinalizationRegistry(handle => {
      if (!this.destroyed) this.commands.destroyResource(handle);
    });
    // wgpu's device gets the limits the page asked for, those it has, and Edge's for the rest. Its immediate size
    // defaults to 0, not Edge's 64, so it gets the size the page asked for.
    const recorded = Object.keys(limits).filter(name => limits[name] !== undefined && name in granted && !(name in stageLimits));
    const value = name => name === 'maxImmediateSize' ? enforceRange(limits[name], name) : granted[name];
    this.commands.requestDevice({ features: [...this.features], limits: Object.fromEntries(recorded.map(name => [name, value(name)])) });
    this.lost = new Promise(resolve => { this.resolveLost = resolve; });
    this.queue = {
      writeBuffer: (buffer, offset, data, dataOffset = 0, size) => {
        // As in WebGPU, a write to a destroyed buffer or texture records, and raises its error in the executor.
        if (!(buffer instanceof RecordingBuffer) || buffer.device !== this) throw new Error('Invalid buffer');
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
        if (!(texture instanceof RecordingTexture) || texture.device !== this) throw new Error('Invalid texture');
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
      copyExternalImageToTexture: notImplemented('GPUQueue.copyExternalImageToTexture'),
      // Resolves once the executor has run this frame's earlier work, which a readback after it shows.
      onSubmittedWorkDone: () => {
        if (this.destroyed) return Promise.resolve();
        this.workDone ??= this.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_SRC });
        const request = this.handles.allocate();
        this.commands.readBuffer(request, this.workDone.handle, 0, 4);
        return this.expect(request, true, resolve => () => resolve(), undefined);
      },
      submit: commands => {
        if (new Set(commands).size !== commands.length || commands.some(command => command.device !== this || command.submitted)) throw new Error('Invalid command buffer');
        for (const command of commands) {
          command.submitted = true;
          command.commands.drainTo(this.commands);
        }
        this.commands.append(Opcode.SUBMIT);
      },
    };
  }

  createShaderModule(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const handle = this.handles.allocate();
    const request = this.handles.allocate();
    const code = descriptor.code.replace(/^[\t ]*enable[\t ]+subgroups[\t ]*;[\t ]*(?:\/\/[^\r\n]*)?(?=\r?$)/gm, '');
    const compilationInfo = this.expect(request, false, resolve => resolve, { messages: [] });
    this.commands.createShader(handle, descriptor.label ?? '', code, request);
    const shader = { handle, label: descriptor.label ?? '', getCompilationInfo: () => {
      if (this.pending.has(request)) this.awaited.add(request);
      return compilationInfo;
    } };
    this.shaders.add(shader);
    return shader;
  }

  createCommandEncoder() {
    if (this.destroyed) throw new Error('Device is destroyed');
    return new RecordingCommandEncoder(this);
  }

  createRenderBundleEncoder() {
    if (this.destroyed) throw new Error('Device is destroyed');
    return new RecordingRenderBundleEncoder(this);
  }

  importExternalTexture = notImplemented('GPUDevice.importExternalTexture');

  pushErrorScope(filter) {
    if (!(filter in errorFilters)) throw new TypeError(`'${filter}' is not a valid GPUErrorFilter`);
    if (this.destroyed) return;
    this.errorScopes++;
    this.commands.words(Opcode.PUSH_ERROR_SCOPE, [errorFilters[filter]]);
  }

  // Resolves with the first error the scope captured, or null, once the executor pops it. A lost
  // device's scopes capture nothing, so its pops resolve with null, even from an empty stack.
  popErrorScope() {
    if (this.destroyed) return Promise.resolve(null);
    if (this.errorScopes === 0) return Promise.reject(operationError('No error scopes to pop'));
    this.errorScopes--;
    const request = this.handles.allocate();
    this.commands.words(Opcode.POP_ERROR_SCOPE, [request]);
    return this.expect(request, true, resolve => resolve, null);
  }

  readBuffer(buffer, offset, size) {
    if (!(buffer instanceof RecordingBuffer) || buffer.device !== this || buffer.destroyed) throw new Error('Invalid buffer');
    const request = this.handles.allocate();
    this.commands.readBuffer(request, buffer.handle, offset, size);
    return this.expect(request, true, resolve => resolve);
  }

  // The promise of the response the executor sends for `request`, which settles with `lost` once the device is
  // lost, or rejects without one. A frame in which the page submits no stream hands its work to the host only while the page awaits one of
  // its responses, as Chrome flushes its GPU work for a pending callback, so errors with nothing waiting on them
  // arrive when the page next submits, as in Edge.
  expect(request, awaited, settle, ...lost) {
    this.unsent.add(request);
    if (awaited) this.awaited.add(request);
    return new Promise((resolve, reject) => this.pending.set(request, { resolve: settle(resolve), reject, ...(lost.length && { lost: lost[0] }) }));
  }

  // Whether the stream not yet taken holds a request the page awaits.
  get waiting() {
    for (const request of this.unsent) if (this.awaited.has(request)) return true;
    return false;
  }

  receiveResponses(responses) {
    for (const response of responses) {
      const pending = this.pending.get(response.request);
      if (pending) {
        this.pending.delete(response.request);
        this.awaited.delete(response.request);
        if (response.type === 'compilation') {
          const location = response.message?.match(/:(\d+):(\d+)/);
          pending.resolve({ messages: response.message == null ? [] : [{ type: 'error', message: response.message, lineNum: Number(location?.[1] ?? 0), linePos: Number(location?.[2] ?? 0) }] });
        } else if (response.type === 'scope') pending.resolve(response.filter == null ? null : new errorTypes[response.filter](response.message));
        else if (response.type === 'readback') pending.resolve(response.bytes instanceof ArrayBuffer ? response.bytes : Uint8Array.from(response.bytes).buffer);
        else pending.reject(new Error(response.message));
      } else if (response.type === 'error' && response.request == null) {
        // An error that no error scope captured, such as a shader module's that fails to compile.
        this.onuncapturederror?.({ error: new errorTypes[response.filter ?? 'validation'](response.message) });
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

  createBindGroupLayout(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const select = (map, value, fallback) => {
      const result = map[value ?? fallback];
      if (result === undefined) throw new Error('Unsupported bind group layout option');
      return result;
    };
    const entries = descriptor.entries.map(entry => {
      if (entry.count !== undefined) throw new Error('Binding arrays are not implemented');
      if (entry.storageTexture || entry.externalTexture) throw new Error('Storage and external texture bindings are not implemented on the native device');
      const kinds = ['buffer', 'sampler', 'texture'].filter(kind => entry[kind] !== undefined);
      if (kinds.length !== 1) throw new Error('Unsupported bind group layout entry');
      const kind = kinds[0];
      const options = entry[kind];
      const type = kind === 'buffer'
        ? select({ uniform: 0, storage: 1, 'read-only-storage': 2 }, options.type, 'uniform')
        : kind === 'sampler'
          ? select({ filtering: 0, 'non-filtering': 1, comparison: 2 }, options.type, 'filtering')
          : select({ float: 0, 'unfilterable-float': 1, depth: 2, sint: 3, uint: 4 }, options.sampleType, 'float');
      const dimension = kind === 'texture'
        ? select({ '1d': 0, '2d': 1, '2d-array': 2, cube: 3, 'cube-array': 4, '3d': 5 }, options.viewDimension, '2d')
        : 0;
      return {
        binding: entry.binding, visibility: entry.visibility,
        kind: { buffer: 1, sampler: 2, texture: 3 }[kind], type, dimension,
        flags: Number(kind === 'buffer' ? (options.hasDynamicOffset ?? false) : (options.multisampled ?? false)),
        minSize: kind === 'buffer' ? (options.minBindingSize ?? 0) : 0,
      };
    });
    const layout = { handle: this.handles.allocate() };
    this.commands.createBindGroupLayout(layout.handle, entries);
    this.bindGroupLayouts.add(layout);
    return layout;
  }

  releaseBindGroupLayout(layout) {
    if (!this.bindGroupLayouts.delete(layout)) return;
    this.commands.destroyResource(layout.handle);
  }

  createBindGroup(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    if (!this.bindGroupLayouts.has(descriptor.layout)) throw new Error('Invalid bind group layout');
    const entries = descriptor.entries.map(({ binding, resource }) => {
      if (resource.buffer instanceof RecordingBuffer && this.buffers.has(resource.buffer) && !resource.buffer.destroyed) {
        return { binding, kind: 1, handle: resource.buffer.handle, offset: resource.offset ?? 0, size: resource.size ?? 0 };
      }
      if (this.samplers.has(resource)) return { binding, kind: 2, handle: resource.handle, offset: 0, size: 0 };
      if (resource.texture instanceof RecordingTexture && this.textures.has(resource.texture) && !resource.texture.destroyed) {
        return { binding, kind: 3, handle: resource.handle, offset: 0, size: 0 };
      }
      throw new Error('Invalid bind group resource');
    });
    const group = { handle: this.handles.allocate() };
    this.commands.createBindGroup(group.handle, descriptor.layout.handle, entries);
    this.bindGroups.add(group);
    return group;
  }

  releaseBindGroup(group) {
    if (!this.bindGroups.delete(group)) return;
    this.commands.destroyResource(group.handle);
  }

  createPipelineLayout(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    if (!descriptor.bindGroupLayouts.every(layout => this.bindGroupLayouts.has(layout))) throw new Error('Invalid bind group layout');
    const layout = { handle: this.handles.allocate() };
    this.commands.createPipelineLayout(layout.handle, descriptor.bindGroupLayouts.map(item => item.handle));
    this.pipelineLayouts.add(layout);
    return layout;
  }

  releasePipelineLayout(layout) {
    if (!this.pipelineLayouts.delete(layout)) return;
    this.commands.destroyResource(layout.handle);
  }

  createRenderPipeline(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const autoLayout = descriptor.layout === 'auto';
    if (!autoLayout && !this.pipelineLayouts.has(descriptor.layout)) throw new Error('Invalid pipeline layout');
    const stage = value => {
      if (!value || !this.shaders.has(value.module)) throw new Error('Invalid shader module');
      if (value.constants && Object.keys(value.constants).length) throw new Error('Shader constants are not implemented');
      return { module: value.module.handle, entryPoint: value.entryPoint ?? null };
    };
    const face = (value = {}) => ({
      compare: value.compare ?? 'always', failOp: value.failOp ?? 'keep',
      depthFailOp: value.depthFailOp ?? 'keep', passOp: value.passOp ?? 'keep',
    });
    const component = (value = {}) => ({
      srcFactor: value.srcFactor ?? 'one', dstFactor: value.dstFactor ?? 'zero', operation: value.operation ?? 'add',
    });
    const primitive = descriptor.primitive ?? {};
    const samples = descriptor.multisample ?? {};
    const depth = descriptor.depthStencil;
    const spec = {
      label: descriptor.label ?? '', layout: autoLayout ? 0 : descriptor.layout.handle,
      vertex: stage(descriptor.vertex), fragment: descriptor.fragment ? stage(descriptor.fragment) : null,
      buffers: (descriptor.vertex.buffers ?? []).map(buffer => ({
        arrayStride: buffer.arrayStride, stepMode: buffer.stepMode ?? 'vertex',
        attributes: buffer.attributes.map(attribute => ({ format: attribute.format, offset: attribute.offset, shaderLocation: attribute.shaderLocation })),
      })),
      targets: (descriptor.fragment?.targets ?? []).map(target => target === null ? null : ({
        format: target.format, writeMask: target.writeMask ?? 15,
        blend: target.blend ? { color: component(target.blend.color), alpha: component(target.blend.alpha) } : null,
      })),
      primitive: {
        topology: primitive.topology ?? 'triangle-list', stripIndexFormat: primitive.stripIndexFormat ?? null,
        frontFace: primitive.frontFace ?? 'ccw', cullMode: !primitive.cullMode || primitive.cullMode === 'none' ? null : primitive.cullMode,
        unclippedDepth: primitive.unclippedDepth ?? false,
      },
      depth: depth ? {
        format: depth.format, depthWriteEnabled: depth.depthWriteEnabled ?? false, depthCompare: depth.depthCompare ?? 'always',
        stencilFront: face(depth.stencilFront), stencilBack: face(depth.stencilBack),
        stencilReadMask: depth.stencilReadMask ?? 0xffffffff, stencilWriteMask: depth.stencilWriteMask ?? 0xffffffff,
        depthBias: depth.depthBias ?? 0, depthBiasSlopeScale: depth.depthBiasSlopeScale ?? 0, depthBiasClamp: depth.depthBiasClamp ?? 0,
      } : null,
      samples: { count: samples.count ?? 1, mask: samples.mask ?? 0xffffffff, alphaToCoverageEnabled: samples.alphaToCoverageEnabled ?? false },
    };
    const pipeline = this.pipeline(descriptor.layout, this.renderPipelines, GPURenderPipeline);
    this.commands.createRenderPipeline(pipeline.handle, spec);
    return pipeline;
  }

  // A render or compute pipeline in `pipelines`, whose getBindGroupLayout() names the layouts wgpu derives for it.
  pipeline(layout, pipelines, Type) {
    const autoLayouts = new Map();
    const pipeline = Object.assign(new Type(), {
      handle: this.handles.allocate(), layout, autoLayouts,
      getBindGroupLayout: index => {
        if (!pipelines.has(pipeline)) throw new Error('Invalid pipeline');
        if (!autoLayouts.has(index)) {
          const layout = { handle: this.handles.allocate() };
          this.commands.words(Opcode.GET_BIND_GROUP_LAYOUT, [layout.handle, pipeline.handle, index]);
          this.bindGroupLayouts.add(layout);
          autoLayouts.set(index, layout);
        }
        return autoLayouts.get(index);
      },
    });
    pipelines.add(pipeline);
    return pipeline;
  }

  createComputePipeline(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const autoLayout = descriptor.layout === 'auto';
    if (!autoLayout && !this.pipelineLayouts.has(descriptor.layout)) throw new Error('Invalid pipeline layout');
    const { module, entryPoint, constants } = descriptor.compute ?? {};
    if (!this.shaders.has(module)) throw new Error('Invalid shader module');
    if (constants && Object.keys(constants).length) throw new Error('Shader constants are not implemented');
    const pipeline = this.pipeline(descriptor.layout, this.computePipelines, GPUComputePipeline);
    this.commands.createComputePipeline(pipeline.handle, {
      label: descriptor.label ?? '', layout: autoLayout ? 0 : descriptor.layout.handle, module: module.handle, entryPoint,
    });
    return pipeline;
  }

  // As in Edge, a pipeline that fails validation rejects with a GPUPipelineError, and an error scope that the device
  // pushes around its create keeps the error from the page's scopes. A lost device resolves with a pipeline that
  // dispatches nothing.
  createComputePipelineAsync(descriptor) {
    if (this.destroyed) return Promise.resolve(Object.assign(new GPUComputePipeline(), { handle: 0, getBindGroupLayout: () => ({ handle: 0 }) }));
    this.commands.words(Opcode.PUSH_ERROR_SCOPE, [errorFilters.validation]);
    const request = this.handles.allocate();
    let pipeline;
    try {
      pipeline = this.createComputePipeline(descriptor);
    } catch (error) {
      this.commands.words(Opcode.POP_ERROR_SCOPE, [request]);
      return Promise.reject(error);
    }
    this.commands.words(Opcode.POP_ERROR_SCOPE, [request]);
    return this.expect(request, true, resolve => resolve, null).then(error => {
      if (error) throw new GPUPipelineError(error.message, { reason: 'validation' });
      return pipeline;
    });
  }

  // Timestamp query sets need the timestamp-query feature, as WebGPU's createQuerySet() requires. A destroyed query set
  // stays usable in an encoder whose submit then fails, as a destroyed buffer does.
  createQuerySet(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    if (descriptor.type === 'occlusion') throw new Error('Occlusion query sets are not implemented on the native device');
    if (descriptor.type !== 'timestamp') throw new TypeError(`'${descriptor.type}' is not a valid GPUQueryType`);
    if (!this.features.has('timestamp-query')) throw new TypeError('Timestamp query sets need the timestamp-query feature');
    const querySet = {
      device: this, handle: this.handles.allocate(), type: descriptor.type, count: descriptor.count, label: descriptor.label ?? '',
      destroy: () => this.releaseQuerySet(querySet),
    };
    this.commands.createQuerySet(querySet.handle, 1, descriptor.count, querySet.label);
    this.querySets.add(querySet);
    return querySet;
  }

  // The device keeps the query sets it has not destroyed. A destroyed one still names its handle in later commands.
  releaseQuerySet(querySet) {
    if (!this.querySets.delete(querySet)) return;
    this.commands.destroyResource(querySet.handle);
  }

  // Validation errors reach the error scope around the call, as three's async path expects. A lost
  // device resolves with a pipeline that draws nothing, as WebGPU does.
  createRenderPipelineAsync(descriptor) {
    if (this.destroyed) return Promise.resolve({ handle: 0, getBindGroupLayout: () => ({ handle: 0 }) });
    try {
      return Promise.resolve(this.createRenderPipeline(descriptor));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  releasePipeline(pipeline) {
    if (!this.renderPipelines.delete(pipeline) && !this.computePipelines.delete(pipeline)) return;
    for (const layout of pipeline.autoLayouts.values()) this.releaseBindGroupLayout(layout);
    this.commands.destroyResource(pipeline.handle);
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

  // Records a resize when a script set the canvas size since the last acquire or frame, even to the
  // size it had, or when the size differs from the last one this stream recorded, as it does for a
  // renderer on another canvas. The resize discards the frame's canvas texture, as a browser does.
  resizeSurface(width, height, assigned = false) {
    const last = this.output.canvasSize;
    this.output.canvasSize = [width, height];
    if (!last || (!assigned && last[0] === width && last[1] === height)) return;
    this.surface?.destroy();
    this.surface = null;
    this.commands.words(Opcode.RESIZE_SURFACE, [width, height]);
  }

  // A configure or an unconfigure expires the canvas texture, so the next getCurrentTexture() returns a new one.
  expireSurface(opcode) {
    this.surface?.destroy();
    this.surface = null;
    this.commands.append(opcode);
  }

  surfaceTexture(width, height, { format, usage }) {
    if (this.destroyed) throw new Error('Device is destroyed');
    if (this.surface && (this.surface.width !== width || this.surface.height !== height)) {
      this.surface.destroy();
      this.surface = null;
    }
    if (!this.surface) {
      this.surface = new RecordingTexture(this, { size: [width, height], format, usage }, true);
      this.textures.add(this.surface);
    }
    return this.surface;
  }

  readTexture(texture, descriptor) {
    if (!(texture instanceof RecordingTexture) || texture.device !== this || texture.destroyed) throw new Error('Invalid texture');
    const request = this.handles.allocate();
    this.commands.readTexture(request, texture.handle, descriptor);
    return this.expect(request, true, resolve => resolve);
  }

  createBuffer(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    if (descriptor.mappedAtCreation && descriptor.size % 4 !== 0) {
      throw new RangeError(`createBuffer failed, size (${descriptor.size}) is not a multiple of 4 when mappedAtCreation`);
    }
    const buffer = new RecordingBuffer(this, descriptor);
    this.buffers.add(buffer);
    return buffer;
  }

  destroy() {
    if (this.destroyed) return;
    for (const buffer of this.buffers) buffer.destroy();
    for (const texture of this.textures) texture.destroy();
    for (const sampler of this.samplers) this.releaseSampler(sampler);
    for (const group of this.bindGroups) this.releaseBindGroup(group);
    for (const pipeline of [...this.renderPipelines, ...this.computePipelines]) this.releasePipeline(pipeline);
    for (const querySet of this.querySets) this.releaseQuerySet(querySet);
    for (const layout of this.pipelineLayouts) this.releasePipelineLayout(layout);
    for (const layout of this.bindGroupLayouts) this.releaseBindGroupLayout(layout);
    for (const shader of this.shaders) this.releaseShader(shader);
    this.destroyed = true;
    if (host.device === this) host.device = null;
    globalThis.removeEventListener?.('gpu-response', this.onResponse);
    // A lost WebGPU device resolves its error scopes with no error, its compilation information with
    // no message, and its work done, and it rejects its readbacks.
    for (const pending of this.pending.values()) {
      if ('lost' in pending) pending.resolve(pending.lost);
      else pending.reject(new Error('Device is destroyed'));
    }
    this.pending.clear();
    this.awaited.clear();
    this.resolveLost({ reason: 'destroyed', message: '' });
  }

  takeFrame() {
    if (this.destroyed) throw new Error('Device is destroyed');
    if (this.context) this.resizeSurface(...this.context.takeSize());
    this.surface?.destroy();
    this.surface = null;
    this.unsent.clear();
    return this.commands.finish(this.output.frame++);
  }
}

function assertSurfaceFree() {
  if (host.device && !host.device.destroyed) throw new Error('Only one live NativeBackend is supported, because the native host has one window surface. Dispose the current renderer first.');
}

export class NativeBackend extends WebGPUBackend {
  constructor(parameters = {}, capabilities = {}) {
    assertSurfaceFree();
    super({ outputType: UnsignedByteType, ...parameters, context: new RecordingCanvasContext(parameters.canvas) });
    this.capabilities = capabilities;
    this.recordingDevice = null;
    this.isNativeBackend = true;
  }

  // The backend takes the host's surface when its renderer initializes, so a renderer disposed before
  // init() holds nothing. Renderer.dispose() awaits before it reaches backend.dispose(), and games
  // often create the next renderer without awaiting it, so calling dispose() releases the surface.
  async init(renderer) {
    // WebGPURenderer retries a failed init() on WebGL, which the host does not have, and rejects with
    // that error in place of this one.
    renderer._getFallback = null;
    assertSurfaceFree();
    const { features, limits } = this.capabilities;
    // The host sets __gpuAdapterLimits to its adapter's limits before the game loads.
    const device = new RecordingDevice({ features, limits: { ...this.parameters.requiredLimits, ...limits } }, host, globalThis.__gpuAdapterLimits);
    host.device = this.recordingDevice = this.parameters.device = device;
    const dispose = renderer.dispose;
    renderer.dispose = function () {
      device.destroy();
      return dispose.call(this);
    };
    await super.init(renderer);
  }

  takeFrame() {
    return this.recordingDevice.takeFrame();
  }

  // three does not destroy a device it did not create; this backend created its device.
  async dispose() {
    await super.dispose();
    this.recordingDevice.destroy();
  }

  async copyTextureToBuffer(texture, x, y, width, height, faceIndex = 0) {
    const gpuTexture = this.get(texture).texture;
    const TypedArray = this.textureUtils._getTypedArrayType(gpuTexture.format);
    const bytes = await this.recordingDevice.readTexture(gpuTexture, { mip: 0, x, y, layer: faceIndex, width, height });
    return new TypedArray(bytes);
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

  updateBindings(bindGroup, bindings, cacheKey, version) {
    const data = this.get(bindGroup);
    const previous = new Set([data.group, ...Object.values(data.groups ?? {})]);
    super.updateBindings(bindGroup, bindings, cacheKey, version);
    const current = new Set([data.group, ...Object.values(data.groups ?? {})]);
    for (const group of previous) if (!current.has(group)) this.recordingDevice.releaseBindGroup(group);
  }

  deleteBindGroupData(bindGroup) {
    const data = this.get(bindGroup);
    const layout = data.layout;
    const groups = new Set([data.group, ...Object.values(data.groups ?? {})]);
    super.deleteBindGroupData(bindGroup);
    for (const group of groups) this.recordingDevice.releaseBindGroup(group);
    if (layout && layout.usedTimes === 0) this.recordingDevice.releaseBindGroupLayout(layout.layoutGPU);
  }

  destroyProgram(program) {
    const shader = this.get(program).module?.module;
    if (shader) this.recordingDevice.releaseShader(shader);
    super.destroyProgram(program);
  }

  destroyPipeline(pipeline) {
    const gpu = this.get(pipeline).pipeline;
    if (gpu) {
      this.recordingDevice.releasePipeline(gpu);
      this.recordingDevice.releasePipelineLayout(gpu.layout);
    }
    super.destroyPipeline(pipeline);
  }
}
