import { UnsignedByteType, WebGPUBackend } from 'three/webgpu';
import { CommandEncoder, Handles, Opcode } from './commands.js';

globalThis.GPUBufferUsage ??= Object.freeze({ MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 });
globalThis.GPUTextureUsage ??= Object.freeze({ COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 });
globalThis.GPUShaderStage ??= Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
globalThis.GPUMapMode ??= Object.freeze({ READ: 1, WRITE: 2 });
globalThis.GPURenderBundleEncoder ??= class GPURenderBundleEncoder {};

class RecordingBuffer {
  constructor(device, descriptor) {
    this.device = device;
    this.handle = device.handles.allocate();
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.destroyed = false;
    this.mapped = descriptor.mappedAtCreation ? new ArrayBuffer(descriptor.size) : null;
    const usage = descriptor.mappedAtCreation ? descriptor.usage | 8 : descriptor.usage;
    device.commands.createBuffer(this.handle, descriptor.size, usage, descriptor.label ?? '');
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
  constructor(device, descriptor, surface = false) {
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

function drawCommands(device, commands, record) {
  const bufferHandle = buffer => {
    if (!(buffer instanceof RecordingBuffer) || !device.buffers.has(buffer) || buffer.destroyed) throw new Error('Invalid render buffer');
    return buffer.handle;
  };
  return {
    setPipeline: pipeline => {
      if (!device.renderPipelines.has(pipeline)) throw new Error('Invalid render pipeline');
      record(() => commands.words(Opcode.SET_PIPELINE, [pipeline.handle]));
    },
    setBindGroup: (index, group, offsets = []) => {
      if (!device.bindGroups.has(group)) throw new Error('Invalid bind group');
      record(() => commands.words(Opcode.SET_BIND_GROUP, [index, group.handle, offsets.length, ...offsets]));
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

// The executor has no bundles; a pass copies a bundle's commands when it executes the bundle.
class RecordingRenderBundleEncoder extends GPURenderBundleEncoder {
  constructor(device) {
    super();
    this.device = device;
    this.commands = new CommandEncoder();
    this.finished = false;
    Object.assign(this, drawCommands(device, this.commands, write => {
      if (this.finished) throw new Error('Render bundle is finished');
      write();
    }));
  }

  finish() {
    if (this.finished) throw new Error('Render bundle is finished');
    this.finished = true;
    return { device: this.device, commands: this.commands };
  }
}

class RecordingCommandEncoder {
  constructor(device) {
    this.device = device;
    this.commands = new CommandEncoder();
    this.activePass = null;
    this.finished = false;
  }

  beginRenderPass(descriptor) {
    if (this.finished || this.activePass) throw new Error('Command encoder is not available');
    if (descriptor.occlusionQuerySet || descriptor.timestampWrites) throw new Error('Render pass option is not implemented');
    const viewHandle = view => {
      if (!(view?.texture instanceof RecordingTexture) || !this.device.textures.has(view.texture) || view.texture.destroyed) throw new Error('Invalid render attachment');
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
    this.commands.beginRenderPass(colors, depth);
    const record = write => {
      if (this.activePass !== pass) throw new Error('Render pass has ended');
      write();
    };
    const pass = {
      ...drawCommands(this.device, this.commands, record),
      setViewport: (x, y, width, height, minDepth, maxDepth) => record(() => this.commands.floats(Opcode.SET_VIEWPORT, [x, y, width, height, minDepth, maxDepth], 4)),
      setScissorRect: (x, y, width, height) => record(() => this.commands.words(Opcode.SET_SCISSOR, [x, y, width, height])),
      setBlendConstant: color => record(() => this.commands.floats(Opcode.SET_BLEND_CONSTANT, Array.isArray(color) ? color : [color.r, color.g, color.b, color.a], 8)),
      setStencilReference: reference => record(() => this.commands.words(Opcode.SET_STENCIL_REFERENCE, [reference])),
      executeBundles: bundles => record(() => {
        for (const bundle of bundles) {
          if (bundle?.device !== this.device) throw new Error('Invalid render bundle');
          bundle.commands.copyTo(this.commands);
        }
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

  finish() {
    if (this.finished || this.activePass) throw new Error('Command encoder is not complete');
    this.finished = true;
    return { device: this.device, commands: this.commands, submitted: false };
  }
}

class RecordingCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.configuration = null;
  }

  configure(configuration) {
    if (!(configuration.device instanceof RecordingDevice)) throw new Error('Invalid canvas device');
    if (configuration.format !== 'bgra8unorm') throw new Error('The native surface format is bgra8unorm');
    this.configuration = configuration;
  }

  unconfigure() {
    this.configuration = null;
  }

  getConfiguration() {
    return this.configuration;
  }

  getCurrentTexture() {
    if (!this.configuration) throw new Error('Canvas context is not configured');
    return this.configuration.device.surfaceTexture(this.canvas.width, this.canvas.height, this.configuration);
  }
}

export class RecordingDevice {
  constructor({ features = [], limits = {} } = {}) {
    this.handles = new Handles();
    this.commands = new CommandEncoder();
    this.buffers = new Set();
    this.textures = new Set();
    this.shaders = new Set();
    this.samplers = new Set();
    this.bindGroupLayouts = new Set();
    this.bindGroups = new Set();
    this.pipelineLayouts = new Set();
    this.renderPipelines = new Set();
    this.surface = null;
    this.frame = 0;
    this.errorScopes = [];
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
    const compilationInfo = new Promise(resolve => {
      this.pending.set(request, { shader: true, resolve, reject: error => resolve({ messages: [{ type: 'error', message: error.message, lineNum: 0, linePos: 0 }] }) });
    });
    this.commands.createShader(handle, descriptor.label ?? '', code, request);
    const shader = { handle, label: descriptor.label ?? '', getCompilationInfo: () => compilationInfo };
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

  pushErrorScope(filter) {
    if (filter !== 'validation') throw new Error('Unsupported error scope');
    this.errorScopes.push([]);
  }

  popErrorScope() {
    const scope = this.errorScopes.pop();
    if (!scope) return Promise.reject(new Error('No error scope'));
    return Promise.all(scope).then(results => results.find(result => result !== null) ?? null);
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
        if (pending.shader) {
          const location = response.message?.match(/:(\d+):(\d+)/);
          pending.resolve({ messages: response.type === 'error' ? [{ type: 'error', message: response.message, lineNum: Number(location?.[1] ?? 0), linePos: Number(location?.[2] ?? 0) }] : [] });
        } else if (pending.validation) pending.resolve(response.type === 'error' ? { message: response.message } : null);
        else if (response.type === 'readback') pending.resolve(response.bytes instanceof ArrayBuffer ? response.bytes : Uint8Array.from(response.bytes).buffer);
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

  createBindGroupLayout(descriptor) {
    if (this.destroyed) throw new Error('Device is destroyed');
    const select = (map, value, fallback) => {
      const result = map[value ?? fallback];
      if (result === undefined) throw new Error('Unsupported bind group layout option');
      return result;
    };
    const entries = descriptor.entries.map(entry => {
      if (entry.count !== undefined) throw new Error('Binding arrays are not implemented');
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
    const autoLayouts = new Map();
    const pipeline = {
      handle: this.handles.allocate(), layout: descriptor.layout, autoLayouts,
      getBindGroupLayout: index => {
        if (!this.renderPipelines.has(pipeline)) throw new Error('Invalid render pipeline');
        if (!autoLayouts.has(index)) {
          const layout = { handle: this.handles.allocate() };
          this.commands.words(Opcode.GET_BIND_GROUP_LAYOUT, [layout.handle, pipeline.handle, index]);
          this.bindGroupLayouts.add(layout);
          autoLayouts.set(index, layout);
        }
        return autoLayouts.get(index);
      },
    };
    const scope = this.errorScopes.at(-1);
    const request = scope ? this.handles.allocate() : 0;
    if (scope) scope.push(new Promise((resolve, reject) => this.pending.set(request, { resolve, reject, validation: true })));
    this.commands.createRenderPipeline(pipeline.handle, request, spec);
    this.renderPipelines.add(pipeline);
    return pipeline;
  }

  releaseRenderPipeline(pipeline) {
    if (!this.renderPipelines.delete(pipeline)) return;
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
    for (const group of this.bindGroups) this.releaseBindGroup(group);
    for (const pipeline of this.renderPipelines) this.releaseRenderPipeline(pipeline);
    for (const layout of this.pipelineLayouts) this.releasePipelineLayout(layout);
    for (const layout of this.bindGroupLayouts) this.releaseBindGroupLayout(layout);
    for (const shader of this.shaders) this.releaseShader(shader);
    this.destroyed = true;
    globalThis.removeEventListener?.('gpu-response', this.onResponse);
    for (const pending of this.pending.values()) pending.reject(new Error('Device is destroyed'));
    this.pending.clear();
    this.resolveLost({ reason: 'destroyed', message: '' });
  }

  takeFrame() {
    this.surface?.destroy();
    this.surface = null;
    return this.commands.finish(this.frame++);
  }
}

export class NativeBackend extends WebGPUBackend {
  constructor(parameters = {}, capabilities = {}) {
    const device = new RecordingDevice(capabilities);
    super({ outputType: UnsignedByteType, ...parameters, device, context: new RecordingCanvasContext(parameters.canvas) });
    this.recordingDevice = device;
    this.isNativeBackend = true;
  }

  takeFrame() {
    return this.recordingDevice.takeFrame();
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
      this.recordingDevice.releaseRenderPipeline(gpu);
      this.recordingDevice.releasePipelineLayout(gpu.layout);
    }
    super.destroyPipeline(pipeline);
  }
}
