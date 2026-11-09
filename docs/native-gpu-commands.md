# Native GPU command stream design

## Problem

The host runs game JavaScript in deno_core and owns the wgpu device and surface. Three.js builds shader programs, resources, and render passes in JavaScript. It currently has no path to the host's device. E3 must carry the ordered work to Rust without a native call for every draw. Resources persist between frames, and JavaScript owns their identifiers.

## Existing flow

`Game::frame` runs animation callbacks and promise jobs. It currently returns a clear color to `Renderer::render`, which clears and presents the acquired surface texture. The three.js `Renderer` calls `Backend` methods for render contexts, programs, bindings, pipelines, textures, and attributes. The pinned `WebGPUBackend` already translates those calls and its helper modules produce WebGPU descriptors. A render may contain several passes and queue submissions, including shadow and render-target passes. A frame boundary is therefore the host animation tick, not a single render pass or queue submission.

## Shape

`NativeBackend` derives from three's `WebGPUBackend`, which derives from `Backend`. It supplies a recording device to the existing translation code and hides `subgroups` from three. The recording device allocates nonzero monotonically increasing 32-bit handles in JavaScript and copies data at the time it is recorded. The host drains one stream after the callbacks and promise jobs for each frame. Commands issued during initialization or between frames remain queued for that next drain. A surface texture is supplied by the host for each frame and is never retained under a normal resource handle.

The stream is little-endian. Its header identifies the format version and total byte count. Each command has an opcode and a byte length, followed by its payload. Variable byte data is length-prefixed. Descriptor fields and resource references have explicit types. A decoder rejects truncated input, unknown versions and opcodes, invalid lengths, invalid state transitions, and missing or wrong-kind handles. Rust keeps persistent typed resource tables, and a render pass has an explicit begin and end. The executor preserves command order, including writes and submissions. A frame does not promise transactional rollback after a GPU operation fails.

Errors and readbacks use a separate response channel. A readback request has a JavaScript-allocated request identifier; its result includes that identifier and either bytes or an error. An error carries the stream's frame index, the command index, the label of the resource the command names, and the request identifier when the command has one. Shader and pipeline errors include wgpu's diagnostics with the line and column. A bad shader or pipeline must not stop unrelated draws. The executor replaces wgpu's uncaptured-error handler, whose default panics, and reports an error raised outside an error scope as an error on the command that raised it, so no stream can stop the host. Rust must never invent a resource handle or write responses into the command stream.

The executor accepts a wgpu device, queue, and current frame view. It does not create an OS window or select a Windows backend. The host owns the surface and calls it. Replay tests can therefore use a Vulkan llvmpipe adapter and offscreen textures on Linux.

## Alternatives

A direct `Backend` implementation would translate every three render object, binding, texture, and pipeline itself. It has a narrower device interface, but it duplicates the pinned WebGPU backend and its helpers. Each three upgrade would require comparing both translations.

The selected recording device reuses that translation. It must implement the WebGPU operations used by the E3 scenes, including descriptor defaults, queue order, and texture uploads. This is an internal adapter, not a browser WebGPU implementation. The implementation must fail explicitly for unsupported operations instead of silently dropping them. The adapter and executor must share a documented opcode schema and behavior tests.

## Risks to test

A shared descriptor format can drift between JavaScript and Rust. Round trips alone do not prove replay, so the same recorded streams need GPU readback tests. Shader compilation diagnostics and asynchronous readbacks need tests that correlate responses to requests. Queue writes around render submissions must preserve order. The 2,000-mesh performance lane must measure the cost of recording and decoding, including descriptor serialization. The format is not stable until the root's independent review and the live lanes pass.

## Version 2 envelope

The first 20 bytes are the ASCII magic `3JSC`, a little-endian `u16` version of 2, a zero `u16` flags field, a `u32` total length, a `u32` frame index, and a `u32` record count. The recording device numbers its frames from zero, one per `takeFrame()`. Each record starts with a `u16` opcode, a zero `u16` flags field, and a `u32` payload length. The payload immediately follows with no padding. The opcode numbers are in `packages/three-native/src/commands.js`.

Buffer commands use the following payloads. Integers are little-endian, and `handle` and `request` are nonzero JavaScript-allocated `u32` values. `usage` uses WebGPU buffer usage bits. Buffer sizes and offsets use `u64`. A write carries the remaining payload bytes as data.

| Opcode | Payload in order |
| --- | --- |
| `CREATE_BUFFER` | handle `u32`, size `u64`, usage `u32`, UTF-8 label length `u32`, label bytes |
| `WRITE_BUFFER` | handle `u32`, offset `u64`, bytes |
| `DESTROY_BUFFER` | handle `u32` |
| `READ_BUFFER` | request `u32`, handle `u32`, offset `u64`, size `u64` |

Shader creation uses a `u32` handle, a `u32` UTF-8 label length, a `u32` UTF-8 source length, a `u32` validation request ID, the label bytes, and the source bytes. A zero request ID omits the validation response. `DESTROY_RESOURCE` releases a shader handle and takes that handle as a `u32`. Shader validation returns the request ID and diagnostic text on the response channel, and `getCompilationInfo()` resolves from that response.

Texture records currently support two-dimensional textures. `CREATE_TEXTURE` stores the handle, width, height, layer count, mip count, sample count, usage, format-string byte length, and UTF-8 label byte length as nine `u32` values, followed by the ASCII WebGPU format string and the label. The executor accepts every format name that wgpu accepts. `WRITE_TEXTURE` stores ten `u32` values for the handle, mip, X, Y, layer, bytes per row, rows per image, width, height, and layer count, followed by the source bytes. `READ_TEXTURE` stores eight `u32` values for the request, handle, mip, X, Y, layer, width, and height. `DESTROY_TEXTURE` stores the handle as a `u32`. A zero row stride or rows-per-image value means that the field is unspecified. The readback removes row padding from its response.

`CREATE_TEXTURE_VIEW` stores nine `u32` values for the view handle, texture handle, base mip, mip count, base layer, layer count, dimension, aspect, and usage. Zero counts and usage mean unspecified. Dimension values are zero for the default, one for 2D, two for 2D array, three for cube, and four for cube array. Aspect values are zero for all, one for depth only, and two for stencil only. A texture destruction releases its views.

`CREATE_SAMPLER` stores the handle, U/V/W address modes, and magnification, minification, and mipmap filters as seven `u32` values. Address values are zero for clamp, one for repeat, and two for mirror repeat. Filter values are zero for nearest and one for linear. Two `f32` values give the minimum and maximum LOD. The final two `u32` values give the comparison function and maximum anisotropy. Comparison zero means no comparison. Values one through eight follow the WebGPU order from never through always.

`CREATE_BIND_GROUP_LAYOUT` stores a handle and entry count as two `u32` values, followed by 32 bytes per entry. An entry holds six `u32` values for binding, shader visibility bits, kind, type, view dimension, and flags, then a `u64` minimum binding size. Kinds one, two, and three mean buffer, sampler, and sampled texture. Buffer types zero through two are uniform, storage, and read-only storage. Sampler types zero through two are filtering, non-filtering, and comparison. Texture types zero through four are filterable float, unfilterable float, depth, signed integer, and unsigned integer. Texture dimensions zero through five are 1D, 2D, 2D array, cube, cube array, and 3D. The flag is a dynamic offset for buffers or multisampling for textures. A zero minimum size means unspecified. `DESTROY_RESOURCE` releases layouts when three's layout cache no longer shares them.

`CREATE_BIND_GROUP` stores the group handle, layout handle, and entry count as three `u32` values. Each entry stores the binding, kind, and resource handle as three `u32` values, followed by `u64` buffer offset and size. Kinds one, two, and three reference a buffer, sampler, and texture view. A zero buffer size means the rest of the buffer. Sampler and texture entries have zero offset and size. `DESTROY_RESOURCE` releases a group after three discards it from its binding cache.

`CREATE_PIPELINE_LAYOUT` stores its handle and layout count as two `u32` values, then the ordered bind group layout handles as `u32` values. `DESTROY_RESOURCE` releases a pipeline layout handle.

`CREATE_RENDER_PIPELINE` stores its handle and validation request ID as two `u32` values followed by a UTF-8 JSON descriptor. A zero request ID means no validation scope. A zero layout handle requests an automatic layout, and a null entry point selects the module's only entry point for that stage. The descriptor contains `label`, `layout`, `vertex`, `fragment`, `buffers`, `targets`, `primitive`, `depth`, and `samples`. The typed schema is in `crates/gpu/src/pipeline.rs`. Shader modules and the pipeline layout use handles; the remaining fields use WebGPU names and enum values. The executor validates the descriptor and returns a validation response or an error with the request ID on the separate response channel. A pipeline that refers to an invalid shader retains an invalid handle so later work can identify it without compiling that pipeline.

`BEGIN_RENDER_PASS` stores a `u32` color count followed by 52 bytes per color attachment. Each color attachment has five `u32` values for flags, view handle, resolve view handle, load operation, and store operation, then four `f64` clear-color components. Flag one marks a present attachment and flag two adds a resolve view. Load zero loads and one clears. Store zero discards and one stores. A 32-byte depth and stencil record follows the color attachments. It holds a view handle, flags, depth load and store operations, an `f32` depth clear value, and stencil load, store, and clear values. Those fields other than the depth clear value are `u32`. A zero view handle means no depth attachment. Flag one supplies depth operations and flag two supplies stencil operations. An absent operation makes that aspect read-only. `END_RENDER_PASS` and `SUBMIT` have empty payloads. The recorder copies a pass descriptor when the pass starts and adds its commands to the frame only when its command buffer is submitted. An unclosed pass or unsubmitted encoder is an error at the end of replay.

`SET_PIPELINE` stores the pipeline handle as a `u32`. `SET_BIND_GROUP` stores the group index, group handle, and dynamic offset count as `u32` values, followed by the `u32` offsets. `SET_VERTEX_BUFFER` and `SET_INDEX_BUFFER` store a `u32` slot or index format, a `u32` buffer handle, and a `u64` offset and size. Index format zero is `uint16` and one is `uint32`. A zero size means the rest of the buffer. `SET_VIEWPORT` stores six `f32` values for X, Y, width, height, minimum depth, and maximum depth. `SET_SCISSOR` stores four `u32` values for X, Y, width, and height. `SET_BLEND_CONSTANT` stores four `f64` color components, and `SET_STENCIL_REFERENCE` stores a `u32`. `DRAW` stores four `u32` values for the vertex count, instance count, first vertex, and first instance. `DRAW_INDEXED` stores five `u32` values for the index count, instance count, first index, base vertex as a two's-complement `i32`, and first instance. The executor skips a draw whose pipeline failed to compile, so the rest of the pass still renders. It reports validation errors from a pass when the pass ends.

`ACQUIRE_SURFACE` stores a texture handle, width, and height as three `u32` values. The executor binds that handle to the texture the host passes with the frame, which is the window's surface texture in the host and an offscreen texture in tests. The handle and its views last until the end of that replay. The host owns the texture, so `DESTROY_TEXTURE` on that handle is an error and leaves the surface in place. A missing surface or a size that differs from the surface is an error. The canvas context calls it from `getCurrentTexture()` once per frame, using the canvas width and height, and the surface format is always `bgra8unorm`.

`GET_BIND_GROUP_LAYOUT` stores a new layout handle, a render pipeline handle, and a group index as three `u32` values. It names the layout that wgpu derived for a pipeline created with an automatic layout. The recorder creates one handle per pipeline and index, and it releases them with the pipeline.

The executor has no render bundles. A bundle encoder records the same draw-state commands as a pass, and `executeBundles` copies them into the pass in order. A pass keeps the state that a bundle sets, which WebGPU would reset. three.js sets the state it needs in every bundle, so this difference is not observable in its output.

## Error labels

The executor keeps the labels of buffers, textures, shaders, and render pipelines, and passes them to wgpu so its own messages name the resource. A texture view takes its texture's label. An error's label comes from the handle its command names: the created or destroyed handle, the buffer or texture a write or readback uses, the bind group or buffer a pass binds, the pipeline a draw uses, and the first attachment of the pass that `END_RENDER_PASS` or `SUBMIT` closes. A command without a labeled subject has no label.
