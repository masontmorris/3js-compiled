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

`--record <directory>` saves every rendered frame as a PNG, starting at `000000.png`. The directory must be empty. `--vsync on` is the default. Use `--vsync off` or its alias `--novsync` for uncapped runs. The host writes `host.log` and `frames.csv` in the working directory.

The host runs two threads. The game thread owns the window, input, the script, and JavaScript. The render thread owns the surface and the GPU device, and it replays, captures, and presents each frame. JavaScript records frame N+1 while the render thread draws frame N. Before the game thread hands frame N+1 over, it waits for frame N to finish, so at most one recorded frame is ahead of the screen. Input therefore reaches the screen one frame later than it would on a single thread. Each frame carries the window size JavaScript saw, and the render thread resizes the surface to it before drawing, so the first frame after a resize draws at the new size. `capture` and `--record` save exactly the frame JavaScript produced at that step, in order.

`frames.csv` has one row per frame with these columns, in milliseconds after the frame number:

- `frame` is the zero-based frame number.
- `cpu_ms` is the game thread's time for the frame: input, script steps, JavaScript, and dispatching the previous frame's GPU responses. It excludes the wait for the render thread to finish the previous frame. It includes scheduling delays.
- `interval_ms` is the time between the starts of this frame and the previous one on the game thread.
- `render_cpu_ms` is the render thread's time for the frame, through replay, any capture, and present. It excludes the wait to acquire a surface texture.
- `latency_ms` runs from the start of the frame, where the game thread polls input, to the return of the frame's present call. The swap chain can hold the frame for up to two more refreshes after that.

Closing the window or a `close` step finishes the frame on the render thread, writes its row, and joins the thread. When the render thread fails or panics, the host writes `host failed: render thread ...` to `host.log` and exits with code 1.

## Frame cost against Edge

`node tools/perf/frame-cost.mjs` measures E3's perf rule. It alternates Edge and native runs of the `instancing` scene at 1920x1080 with vsync off, three of each by default. Each run skips a 300-frame warm-up and measures the next 1,500 frames. For each run it reports uncapped frames per second and CPU milliseconds per frame. CPU time is summed over `host.exe` natively and over every `msedge` process in Edge, from the processes' CPU counters at the start and end of the measured frames. A probe script wraps `requestAnimationFrame` on both sides, counts frames by callback timestamp, and reports the JavaScript callback time per frame for information. Edge runs in a window by default, so both sides present every frame. `--edge headless` measures headless Edge instead. The tool prints the medians and the rule's verdict and writes `frame-cost.json` to `--out`. It drives the GPU, so run it under the lease after building the release host and the scene bundle.

## GPU lease

On the shared Windows machine, wrap every host run with the GPU lease. Do not hold a lease while waiting for review.

```powershell
python C:\Users\mason\.gpu\gpu_lease.py run --holder 3jsc-e1 --purpose "scripted host test" -- C:\3jsc\target\debug\host.exe --entry examples/input.js --script path/to/steps.json
```

## GPU command responses

An entry module can call `submitGpuCommands(bytes)` once between host frames. The host copies the `Uint8Array`, replays it on the render thread against that frame's surface texture, and dispatches one `gpu-response` event when the replay produced responses. The event for frame N arrives after JavaScript's frame N+1 callbacks run and before its frame N+2 callbacks. The event's `responses` array holds three kinds of object:

- `{type: "validation", request}` reports that a shader or render pipeline created with a nonzero request ID compiled.
- `{type: "readback", request, bytes}` carries a buffer or texture readback. `bytes` is an `ArrayBuffer` that crosses from Rust as one binary buffer.
- `{type: "error", frame, command, request, label, message}` reports a failed command. `frame` is the stream's frame index, `command` its zero-based index in the stream, `request` the readback or validation ID or `null`, and `label` the label of the resource the command names or `null`.

A stream the host cannot decode produces one error with only a `message`, because no command or frame in it can be trusted. The host writes every error to `host.log` as `GPU error: frame <f>, command <c>, label <l>, request <r>: <message>`, and a stream it cannot decode as `GPU stream rejected in host frame <n>: <message>`, where `<n>` is the host frame that submitted it. A second submission before the host consumes the first throws an error. The host clears the frame to the `setClearColor` color only when no command acquired the window surface at its current size.

`crates/host/tests/gpu.rs` runs the host on the hardware GPU: a binary 1280x720 readback with a shader error, a stream that tries to destroy the surface, a renderer that replaces a disposed one, the first frame after a resize, responses from six consecutive frames that each match the frame that requested them, recorded frames and a capture across a resize, identical captures from two runs, a render-thread failure that exits with code 1, and closing the window. Run it under the lease with `cargo test -p threejsc-host --release --test gpu -- --ignored --test-threads 1`.

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
