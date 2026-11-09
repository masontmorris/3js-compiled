# Spike 1b results (2026-11-09, Ryzen 5 5600X, RTX 3060 driver 32.0.16.1062, Windows 11, 1920x1080, ~170 Hz display)

Raw logs: `run-*.log` in this folder (`build-*.log` for builds). All numbers below are measured
unless marked otherwise. "UI frame" = one Servo frame published by ui-host.

## What worked

- **Two exes, two Cargo graphs.** `xproc-game` resolves deno_core **0.413.0 / V8 150.4.0**,
  `icu_calendar 2.4.0`; `ui-host` resolves Servo 0.7.0 / mozjs, `icu_calendar 2.1.1`. `cargo tree`:
  no mozjs/servo in the game graph, no v8/deno_core in the ui-host graph. No `/FORCE:MULTIPLE`,
  no duplicate symbols.
- **Cross-process texture handoff:** NT handles (`D3D11_RESOURCE_MISC_SHARED_NTHANDLE`), duplicated
  by the parent from the child's handle table (`DuplicateHandle`), opened with
  `ID3D12Device::OpenSharedHandle`. Ring of 3 slots, imported once per ui-host instance.
- **GPU sync:** shared D3D12 fences created by the game, opened in ANGLE's D3D11 device with
  `ID3D11Device5::OpenSharedFence`; ui-host `ID3D11DeviceContext4::Signal` after the blit, no
  `glFinish`. Works on NVIDIA. Both consumer modes work: CPU poll of `GetCompletedValue`
  (default) and `ID3D12CommandQueue::Wait` before submit.
- **Pixels correct** (probes on the imported slot): `rgba(255,0,0,0.5)` → `[128,0,0,128]`
  (premultiplied), opaque green exact, empty area `[0,0,0,0]`; orientation correct with the flip
  done in the composite shader (no extra pass).

## Game-side cost (per game frame)

| Run | frame interval avg / p50 / p95 (ms) | render+composite+present p50 | pipe drain p95 | fence poll p95 |
|---|---|---|---|---|
| uncapped, no UI process (`run-novsync-noui`) | 0.733 / 0.655 / 1.272 | 0.582 | 0.000 | 0.000 |
| uncapped, UI, poll (`run-novsync-poll-b`) | 0.759 / 0.678 / 1.424 | 0.596 | 0.001 | 0.000 |
| uncapped, UI, gpuwait (`run-novsync-gpuwait`) | 0.758 / 0.685 / 1.282 | 0.608 | — | 0.000 |
| vsync, no UI (`run-vsync-noui`) | 5.885 / 5.883 / 6.205 | 5.782 | 0.000 | 0.000 |
| vsync, UI, poll (`run-vsync-poll-every`) | 5.885 / 5.877 / 6.264 | 5.750 | 0.002 | 0.001 |
| vsync, UI, gpuwait (`run-vsync-gpuwait`) | 5.895 / 5.881 / 6.343 | 5.752 | — | 0.000 |

So importing + compositing the UI costs the game ≈0.02–0.03 ms/frame. (In spike 2, in-process,
Servo paint + import ran on the game thread: 1.0–1.5 ms per UI frame.) GPU wait: not
measurable as a frame-time change in gpuwait mode. In poll mode the newest UI frame was sampled
0 frames after its `FrameReady` at vsync (avg 0.05) and ~1 frame later uncapped (avg 0.6, i.e.
<1 ms), because the blit hadn't finished on the GPU yet.

## ui-host cost (per UI frame, its main thread)

- `WebView::paint` p50 0.69–0.79 ms, p95 1.0–1.25 ms; first paint 220–254 ms (now only stalls ui-host).
- export (pbuffer blit + glFlush + D3D11 Signal + Flush) p50 0.55–0.62 ms, p95 0.81–1.20 ms.
- swap (no `glFinish`) p50 0.06 ms. Total p50 1.31–1.49 ms.
- UI frames published: 53–59/s (Servo's ~60 Hz cadence).
- Whole-process CPU: 26–42 % of one core with a bridge patch every game frame (170/s vsync,
  ~1,200/s uncapped); 15–23 % with `--patch-hz 60`.
- Ring slots: skips for lack of a free slot per ~870 UI frames at vsync: ring 2 → 11, ring 3 → 0–6,
  ring 4 → 0 (slot release waits for the game's `done` fence, which trails by the swapchain depth).

## Latency

| Run | bridge RTT game JS→page→game JS | patch → HUD pixels (in the game frame that sampled them) |
|---|---|---|
| vsync, patch every frame | p50 5.82 ms, p95 6.2–6.6; exactly 1 frame (max 1) | p50 29.3 ms (4 frames), p95 29.8–34.8 |
| vsync, gpuwait | p50 5.83, 1 frame | p50 29.3 (4 frames), p95 29.6 |
| uncapped, patch every frame | p50 0.65 ms, p95 1.2–1.4; avg 1.02 frames, max 4–5 | p50 19.2 ms (24–25 frames), p95 20.5–21.3 |
| vsync, `--patch-hz 60` | p50 5.84, 1 frame | p50 35.1 (5 frames), p95 41.1 |
| uncapped, `--patch-hz 60` | p50 0.60, avg 1.15 frames | p50 27.1, p95 34.5 |

Pixel latency excludes swapchain present latency (not measured). It is dominated by Servo's own
script → layout → paint cadence, not by the IPC (the bridge round trip is ≤1 game frame).
Max values (~230–290 ms) are the first patch after page load.

## Startup and crash isolation

- `spawn_ui` (2 pipes + CreateProcess + 2 handle dups) on the render thread: 8.0–8.7 ms when timed
  (6 spawns); 2 of 8 relaunches showed a 43–46 ms frame instead (one confirmed as the relaunch
  frame's spawn step, cause inside CreateProcess not identified). Should move off the render thread.
- ui-host start → slots 223–332 ms, first `FrameReady` 250–353 ms, first composited 250–355 ms.
  The game kept rendering throughout (46–350 frames); max frame interval during startup 10–18 ms,
  same as the no-UI baseline's first-frame 17.5 ms. Servo's first paint no longer blocks the game.
- External `Stop-Process -Force` on ui-host, 8 runs (poll vsync ×4, gpuwait vsync ×3, poll
  uncapped ×1; `run-kill*.log`): the game saw pipe EOF on its next frame, kept rendering without
  HUD, relaunched after 500 ms, gen 2 composited 250–301 ms after relaunch. Max frame interval in the
  3 s after a kill: 10.1–13.5 ms, except the two 43–46 ms relaunch frames above. No game hang in
  gpuwait mode (3 tries), no orphaned processes (ui-host exits on pipe EOF).
- Two 34.6/43.0 ms interval hitches in other runs were the measurement-only synchronous pixel
  probes at t=4 s (3 blocking readbacks), not the UI.

## Memory, binaries, shipping

- Game: working set 238–244 MB without UI, 240–260 MB with (3 imported slots add GPU memory, ~24 MB VRAM).
- ui-host: working set 98–102 MB; private 173–266 MB (one ring-2 run 421 MB).
  Total ≈ 340–360 MB WS vs 307–330 MB for spike 2's single process.
- `xproc-game.exe` 51.2 MB; `ui-host.exe` 110.0 MB + `libEGL.dll` 51 KB + `libGLESv2.dll` 6.9 MB
  (loaded at runtime, must sit next to ui-host.exe). VC++ runtime: game needs `VCRUNTIME140(_1)`;
  ui-host also `MSVCP140`.
- Build: ui-host 9 m 10 s (partial Servo rebuild reusing the warm cache, features differ from
  spike 2); game 1 m 15 s (cold V8 150.4 download + deno_core); relink 4.5–5.5 s.

## Findings that change or refine the plan

- deno_core 0.413 **aborts** (`0xC0000409`) unless a tokio runtime context is entered before
  creating `JsRuntime` ("V8 posted a delayed task … outside of a tokio runtime context"); fixed by
  entering a current-thread runtime in `main`.
- `LNK4098 libcmt` (CRT mix) appears in the game build with V8 alone, so it comes from rusty_v8's
  prebuilt, not from the V8 + SpiderMonkey combination (spike 2 attributed it to the mix).
- Poll mode should be the default: a queue `Wait` on a value a dead producer never signals would
  stall the game's queue forever (not reproduced in 2 kill tests, but not excluded).
- Spawn/relaunch ui-host off the render thread; ring of 4 if zero skips matter.
- Send bridge patches once per UI frame rather than once per game frame (cuts ui-host CPU ~10–20
  points); a naive 60 Hz timer adds ~8 ms average pixel latency because it is not aligned to Servo's frames.

## Not verified

AMD/Intel GPUs, hybrid-GPU laptops (LUID selection is implemented, only one real GPU here), resize,
DPI scaling, input forwarding into the page, swapchain present latency, Linux/macOS paths.
