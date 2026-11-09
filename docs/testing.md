# Scripted host tests

The host reads a JSON array with `--script <path>`. It processes steps in order before a frame. `wait` renders the given number of frames before the next step. `capture` saves the next rendered frame and then continues with the following step. `close` exits with code 0.

```json
[
  {"type":"wait","frames":2},
  {"type":"key","code":"KeyW","down":true},
  {"type":"capture","path":"out/key.png"},
  {"type":"key","code":"KeyW","down":false},
  {"type":"pointer","action":"move","x":100,"y":100},
  {"type":"pointer","action":"down","x":100,"y":100,"button":0},
  {"type":"pointer","action":"up","x":100,"y":100,"button":0},
  {"type":"wheel","x":0,"y":1},
  {"type":"gamepad","index":0,"button":0,"down":true},
  {"type":"resize","width":1280,"height":720},
  {"type":"capture","path":"out/input.png"},
  {"type":"close"}
]
```

The host sends key, pointer, wheel, gamepad, and resize events to `addEventListener` on the global object. `innerWidth` and `innerHeight` hold the window size in pixels and change before each resize event. `self` and `window` refer to the global object, and `TextDecoder` decodes UTF-8. `AbortController` exists because three's loaders construct one. It only records the abort and cancels nothing. Real and scripted key events use DOM `code` values and the same event fields. Printable `key` values use a US keyboard layout; real keys account for Shift and Caps Lock. Scripted keys use the unmodified values. Real wheel deltas use DOM directions, with positive X to the right and positive Y down. Gamepad button 0 is A. `navigator.getGamepads()` exposes the injected button state. `setClearColor(r, g, b, a)` sets the next frame's color with normalized values. `requestAnimationFrame`, `cancelAnimationFrame`, `performance.now()`, and `console` are available to entry modules. A frame callback error is logged and does not stop later callbacks. After each frame callback batch and event dispatch, the host runs promise jobs and polls ready asynchronous operations without waiting for pending operations.

`--record <directory>` saves every rendered frame as a PNG, starting at `000000.png`. The directory must be empty. `--vsync on` is the default. Use `--vsync off` or its alias `--novsync` for uncapped runs. The host writes `host.log` and `frames.csv` in the working directory. The CSV contains the zero-based frame number, CPU-side frame duration in milliseconds, and frame-start interval in milliseconds. CPU-side duration uses a monotonic clock from the start of the frame through submission and any capture, before presentation. It excludes the wait to acquire a surface frame. It includes scheduling delays and waits during the remaining operations.

## GPU lease

On the shared Windows machine, wrap every host run with the GPU lease. Do not hold a lease while waiting for review.

```powershell
python C:\Users\mason\.gpu\gpu_lease.py run --holder 3jsc-e1 --purpose "scripted host test" -- C:\3jsc\target\debug\host.exe --entry examples/input.js --script path/to/steps.json
```

## GPU command responses

An entry module can call `submitGpuCommands(bytes)` once between host frames. The host copies the `Uint8Array`, replays it against that frame's surface texture, and dispatches one `gpu-response` event when the replay produced responses. The event's `responses` array holds three kinds of object:

- `{type: "validation", request}` reports that a shader or render pipeline created with a nonzero request ID compiled.
- `{type: "readback", request, bytes}` carries a buffer or texture readback. `bytes` is an `ArrayBuffer` that crosses from Rust as one binary buffer.
- `{type: "error", frame, command, request, label, message}` reports a failed command. `frame` is the stream's frame index, `command` its zero-based index in the stream, `request` the readback or validation ID or `null`, and `label` the label of the resource the command names or `null`.

A stream the host cannot decode produces one error with only a `message`, because no command or frame in it can be trusted. The host writes every error to `host.log` as `GPU error: frame <f>, command <c>, label <l>, request <r>: <message>`, and a stream it cannot decode as `GPU stream rejected in host frame <n>: <message>`. A second submission before the host consumes the first throws an error. The host clears the frame to the `setClearColor` color only when no command acquired the window surface at its current size.

`crates/host/tests/gpu.rs` runs the host on the hardware GPU: a binary 1280x720 readback with a shader error, a stream that tries to destroy the surface, and the first frame after a resize. Run it under the lease with `cargo test -p threejsc-host --release --test gpu -- --ignored --test-threads 1`.

## Example scenes

`examples/scenes` holds the scenes the E3 lanes name: `basic-cube`, `materials`, `textures`, `standard-shadow`, `instancing`, `gltf`, `msaa`, `alpha`, and `invalid-wgsl`. `npm run build:scenes` bundles them into `examples/scenes/scene-bundle.js`. The host runs one with `host --entry examples/scenes/index.js --scene <name>`, and a browser opens `examples/scenes/index.html?scene=<name>`.

`node tools/parity/capture.mjs --scene <name> --out <dir>` captures the scene in headless Edge and in the host at 1280x720. It prints the mean RGB difference and the share of pixels that differ, and it saves both captures and a difference image. Both captures use the GPU, so run it under the lease. `--host <path>` selects the host executable, and `--browser-only` skips the host.

`node tools/scenes/record.mjs <name> <dir> [frames]` runs a scene against the recording device in Node and saves each frame's command stream. It needs no GPU. `cargo run -p threejsc-gpu --features wgpu/static-dxc --example replay -- 1280 720 <out.png> <frames...>` replays those streams on a software adapter and saves the last frame. Set `WGPU_BACKEND=dx12` to use WARP on Windows.

`node tools/wgsl-gate/gate.mjs [dir]` records every scene, validates each unique shader with naga, and compiles each entry point's HLSL with DXC at shader model 6.0. It expects only the `invalid-wgsl` fragment shader to fail. `NAGA` and `DXC` name the executables. `modal run tools/modal/lanes.py::wgsl_gate` runs it on Linux, `modal run tools/modal/lanes.py::gpu_replay` runs the replay tests on llvmpipe, and `modal run tools/modal/lanes.py::js_tests` runs `npm test -w packages/three-native`. On Windows, set `PYTHONUTF8=1` before `modal run`, because the Modal CLI otherwise fails with a `UnicodeEncodeError` while it prints progress. Replay tests run locally with `WGPU_BACKEND=dx12 cargo test -p threejsc-gpu --test replay -- --ignored`. After a scene or recorder change, regenerate the replay fixtures with `node crates/gpu/tests/fixtures/generate.mjs` and `node crates/gpu/tests/fixtures/scenes.mjs`.

The replay parity test compares `basic-cube`, `standard-shadow`, and `invalid-wgsl` with their Edge captures as the mean RGB difference, a fraction of full scale. `standard-shadow` is also compared inside the cube's shadow, the pixel box from (557, 384) to (830, 465), because the shadow covers 3 percent of the frame. Each bound sits just above the difference both software adapters measured:

| Scene | llvmpipe | WARP | Bound |
| --- | --- | --- | --- |
| `basic-cube` | 0 | 0 | 0.00001 |
| `standard-shadow`, frame | 0.0000670 | 0.0000668 | 0.0001 |
| `standard-shadow`, shadow | 0.0000869 | 0.0000896 | 0.00015 |
| `invalid-wgsl` | 0 | 0 | 0.00001 |

`standard-shadow-off` records `standard-shadow` with the shadow map disabled (`tools/scenes/record.mjs --no-shadows`). It scores 0.00278 over the frame and 0.111 inside the shadow on both adapters, and the test asserts that it fails both bounds. Regenerate the Edge references with `tools/parity` after a scene change, and remeasure the bounds when the references or the software adapters change.
