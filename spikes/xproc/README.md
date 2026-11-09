# Spike 1b: Servo out of process

Two executables with independent Cargo graphs (each crate is its own `[workspace]` root):

- `ui-host/` (`ui-host.exe`): Servo 0.7.0 (`no-wgl`, so ANGLE) + the vendored wgpu-graft
  adapter (`ui-host/grafting-servo`, MPL-2.0, patched: LUID constructor, public
  `present_without_wait`, `frame_context`). **No V8.** Renders `ui-host/hud.html`
  offscreen with a transparent background.
- `game/` (`xproc-game.exe`): **deno_core 0.413.0 / V8 150.4** (latest, no pin) + wgpu 30 on
  DX12. Spawns and owns ui-host, composites its UI texture over an animated triangle.
- `proto.rs`: the wire protocol, `#[path]`-included by both crates (no shared crate, so no
  shared dependency resolution).

## How the pieces connect

| Concern | Mechanism |
|---|---|
| Texture handoff | ui-host allocates a ring of 3 `R8G8B8A8_UNORM` D3D11 textures on ANGLE's device with `SHARED \| SHARED_NTHANDLE`, exports NT handles (`IDXGIResource1::CreateSharedHandle`), sends the handle *values*. The game (parent, holds the child's process handle) `DuplicateHandle`s them into its own table and opens them with `ID3D12Device::OpenSharedHandle` → `wgpu_hal` `texture_from_raw` → `create_texture_from_hal`. Opened once per ui-host instance, not per frame. |
| Producer → consumer sync | Game-owned shared D3D12 fence `ready`, duplicated into ui-host, opened with `ID3D11Device5::OpenSharedFence`. After Servo's paint, ui-host blits the back buffer into a free slot through a transient EGL pbuffer, `glFlush`, then `ID3D11DeviceContext4::Signal(ready, v)` + `Flush` on ANGLE's immediate context. No `glFinish`. The game either polls `GetCompletedValue() >= v` before sampling (`--sync poll`, default) or queues `ID3D12CommandQueue::Wait(ready, v)` before its submit (`--sync gpuwait`). |
| Consumer → producer sync | Game-owned shared fence `done`; the game signals its frame number on the raw D3D12 queue after every submit. ui-host only reuses a ring slot once the game has moved past it (`Picked` message) and `done` has reached the last frame that sampled it. |
| IPC | Two one-way byte-mode named pipes created by the game before spawning (`\\.\pipe\xproc-<pid>-<gen>-down/-up`). One-way pipes because Windows serializes a blocking read and a blocking write on one synchronous handle. Length-prefixed binary messages; each side has a reader thread feeding a channel. Pipe EOF doubles as crash detection. |
| Bridge | Game JS (V8) produces `{seq, hp}` each frame → `Patch` → ui-host coalesces to the newest patch per loop iteration → `WebView::evaluate_javascript("__bridge.tick(patch)")` → result (page events) → `Events` → next game frame's JS. |
| Crash isolation | Game kills/loses ui-host → keeps rendering without HUD → relaunches after a delay with a new pipe pair; fence values continue monotonically (`ready_base`). |

The HUD page draws the last applied patch `seq` as the RGB of a 32×32 square at the top-left.
The game copies that pixel out of the slot it samples (async readback ring, measurement only)
to measure patch → pixels latency.

## Reproduce

```powershell
cd spikes
. .\env.ps1                       # MSVC env, LLVM/NASM, CARGO_TARGET_DIR=C:\Users\mason\st
cd xproc\ui-host; cargo build --release -j 10
cd ..\game;       cargo build --release -j 10
copy C:\Users\mason\st\build\release\build\mozangle-*\out\*.dll C:\Users\mason\st\release\
$exe = "C:\Users\mason\st\release\xproc-game.exe"
& $exe --frames 1500                               # vsync, poll
& $exe --frames 3000 --novsync                     # uncapped, poll
& $exe --frames 1500 --sync gpuwait                # vsync, GPU queue wait
& $exe --frames 3000 --novsync --sync gpuwait      # uncapped, GPU queue wait
& $exe --frames 3000 --novsync --no-ui             # baseline without any UI process
& $exe --frames 1800 --patch-hz 60                 # rate-limit bridge patches
& $exe --frames 2400 --ring 4                      # ring size (default 3)
& $exe --frames 2400 --kill-ui-at 900 --relaunch-delay-ms 500   # crash isolation (internal kill)
# External crash: start the game, then `Get-Process ui-host | Stop-Process -Force` mid-run.
```

Frames whose CPU time or interval exceed 20 ms are printed as `hitch:` lines. The game enters a
tokio runtime before creating its `JsRuntime`: deno_core 0.413 aborts the process otherwise.

ui-host's own stdout/stderr go to `%TEMP%\xproc-ui-host-<gen>.log`; its timing report is sent
back over the pipe on shutdown and printed by the game.

Results: `results.md`.
