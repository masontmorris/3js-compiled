# Native GPU command stream design

## Problem

The host runs game JavaScript in deno_core and owns the wgpu device and surface. Three.js builds shader programs, resources, and render passes in JavaScript. It currently has no path to the host's device. E3 must carry the ordered work to Rust without a native call for every draw. Resources persist between frames, and JavaScript owns their identifiers.

## Existing flow

`Game::frame` runs animation callbacks and promise jobs. It currently returns a clear color to `Renderer::render`, which clears and presents the acquired surface texture. The three.js `Renderer` calls `Backend` methods for render contexts, programs, bindings, pipelines, textures, and attributes. The pinned `WebGPUBackend` already translates those calls and its helper modules produce WebGPU descriptors. A render may contain several passes and queue submissions, including shadow and render-target passes. A frame boundary is therefore the host animation tick, not a single render pass or queue submission.

## Shape

`NativeBackend` derives from three's `WebGPUBackend`, which derives from `Backend`. It supplies a recording device to the existing translation code and hides `subgroups` from three. The recording device allocates nonzero monotonically increasing 32-bit handles in JavaScript and copies data at the time it is recorded. The host drains one stream after the callbacks and promise jobs for each frame. Commands issued during initialization or between frames remain queued for that next drain. A surface texture is supplied by the host for each frame and is never retained under a normal resource handle.

The stream is little-endian. Its header identifies the format version and total byte count. Each command has an opcode and a byte length, followed by its payload. Variable byte data is length-prefixed. Descriptor fields and resource references have explicit types. A decoder rejects truncated input, unknown versions and opcodes, invalid lengths, invalid state transitions, and missing or wrong-kind handles. Rust keeps persistent typed resource tables, and a render pass has an explicit begin and end. The executor preserves command order, including writes and submissions. A frame does not promise transactional rollback after a GPU operation fails.

Errors and readbacks use a separate response channel. A readback request has a JavaScript-allocated request identifier; its result includes that identifier and either bytes or an error. An error carries the frame, command index, resource label, and available shader diagnostics. A bad shader or pipeline must not stop unrelated draws. Rust must never invent a resource handle or write responses into the command stream.

The executor accepts a wgpu device, queue, and current frame view. It does not create an OS window or select a Windows backend. The host owns the surface and calls it. Replay tests can therefore use a Vulkan llvmpipe adapter and offscreen textures on Linux.

## Alternatives

A direct `Backend` implementation would translate every three render object, binding, texture, and pipeline itself. It has a narrower device interface, but it duplicates the pinned WebGPU backend and its helpers. Each three upgrade would require comparing both translations.

The selected recording device reuses that translation. It must implement the WebGPU operations used by the E3 scenes, including descriptor defaults, queue order, and texture uploads. This is an internal adapter, not a browser WebGPU implementation. The implementation must fail explicitly for unsupported operations instead of silently dropping them. The adapter and executor must share a documented opcode schema and behavior tests.

## Risks to test

A shared descriptor format can drift between JavaScript and Rust. Round trips alone do not prove replay, so the same recorded streams need GPU readback tests. Shader compilation diagnostics and asynchronous readbacks need tests that correlate responses to requests. Queue writes around render submissions must preserve order. The 2,000-mesh performance lane must measure the cost of recording and decoding, including descriptor serialization. The format is not stable until the root's independent review and the live lanes pass.

## Version 1 envelope

The first 16 bytes are the ASCII magic `3JSC`, a little-endian `u16` version, a zero `u16` flags field, a `u32` total length, and a `u32` record count. Each record starts with a `u16` opcode, a zero `u16` flags field, and a `u32` payload length. The payload immediately follows with no padding. The opcode numbers are in `packages/three-native/src/commands.js`. Payload schemas for the remaining opcodes still need specification and replay tests. The envelope alone is not a rendering protocol.

Buffer commands use the following version 1 payloads. Integers are little-endian, and `handle` and `request` are nonzero JavaScript-allocated `u32` values. `usage` uses WebGPU buffer usage bits. Buffer sizes and offsets use `u64`. A write carries the remaining payload bytes as data.

| Opcode | Payload in order |
| --- | --- |
| `CREATE_BUFFER` | handle `u32`, size `u64`, usage `u32` |
| `WRITE_BUFFER` | handle `u32`, offset `u64`, bytes |
| `DESTROY_BUFFER` | handle `u32` |
| `READ_BUFFER` | request `u32`, handle `u32`, offset `u64`, size `u64` |

Shader creation uses a `u32` handle, a `u32` UTF-8 label length, a `u32` UTF-8 source length, the label bytes, and the source bytes. `DESTROY_RESOURCE` currently releases a shader handle and takes that handle as a `u32`. Shader validation errors return the command index and diagnostic text in the response channel.

Texture records currently support two-dimensional textures. `CREATE_TEXTURE` stores the handle, width, height, layer count, mip count, sample count, usage, and format-string byte length as eight `u32` values, followed by the ASCII WebGPU format string. `WRITE_TEXTURE` stores ten `u32` values for the handle, mip, X, Y, layer, bytes per row, rows per image, width, height, and layer count, followed by the source bytes. `READ_TEXTURE` stores eight `u32` values for the request, handle, mip, X, Y, layer, width, and height. `DESTROY_TEXTURE` stores the handle as a `u32`. A zero row stride or rows-per-image value means that the field is unspecified. The readback removes row padding from its response.

`CREATE_TEXTURE_VIEW` stores nine `u32` values for the view handle, texture handle, base mip, mip count, base layer, layer count, dimension, aspect, and usage. Zero counts and usage mean unspecified. Dimension values are zero for the default, one for 2D, two for 2D array, three for cube, and four for cube array. Aspect values are zero for all, one for depth only, and two for stencil only. A texture destruction releases its views.

`CREATE_SAMPLER` stores the handle, U/V/W address modes, and magnification, minification, and mipmap filters as seven `u32` values. Address values are zero for clamp, one for repeat, and two for mirror repeat. Filter values are zero for nearest and one for linear. Two `f32` values give the minimum and maximum LOD. The final two `u32` values give the comparison function and maximum anisotropy. Comparison zero means no comparison. Values one through eight follow the WebGPU order from never through always.

`CREATE_BIND_GROUP_LAYOUT` stores a handle and entry count as two `u32` values, followed by 32 bytes per entry. An entry holds six `u32` values for binding, shader visibility bits, kind, type, view dimension, and flags, then a `u64` minimum binding size. Kinds one, two, and three mean buffer, sampler, and sampled texture. Buffer types zero through two are uniform, storage, and read-only storage. Sampler types zero through two are filtering, non-filtering, and comparison. Texture types zero through four are filterable float, unfilterable float, depth, signed integer, and unsigned integer. Texture dimensions zero through five are 1D, 2D, 2D array, cube, cube array, and 3D. The flag is a dynamic offset for buffers or multisampling for textures. A zero minimum size means unspecified. `DESTROY_RESOURCE` releases layouts when three's layout cache no longer shares them.

`CREATE_BIND_GROUP` stores the group handle, layout handle, and entry count as three `u32` values. Each entry stores the binding, kind, and resource handle as three `u32` values, followed by `u64` buffer offset and size. Kinds one, two, and three reference a buffer, sampler, and texture view. A zero buffer size means the rest of the buffer. Sampler and texture entries have zero offset and size. `DESTROY_RESOURCE` releases a group after three discards it from its binding cache.
