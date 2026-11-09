# Spike 2 results (2026-11-08, Ryzen 5 5600X, RTX 3060, Windows 11, 1920x1080 window)

All numbers are CPU wall time on the host (main) thread, measured in-process. Raw logs:
`run-vsync.log`, `run-novsync.log`, `run-novsync-paintall.log`,
`run-novsync-paintall-nonormalize.log`, `run-noangle.log`.

## Does it link and run?

- **Cargo resolution conflict (fixed):** V8 ≥147.1 (deno_core ≥0.399) needs ICU4X
  `icu_calendar ^2.2.1` (via Temporal); SpiderMonkey's `mozjs_sys` pins `icu_capi =2.1.2`
  (`icu_calendar ~2.1.1`) in every release through 153.6.0-2. Fix: `deno_core =0.398.0` +
  `v8 =147.0.0`. Patching Servo's git source with the registry crate made Cargo hang 9+ min;
  fix: vendor the adapter with a registry `servo` dependency.
- **Link conflict (worked around, not fixed):** `LNK2005` on exactly 3 symbols, all from
  SpiderMonkey's bundled irregexp shim (`Unified_cpp_js_src_irregexp0.obj`) colliding with V8:
  `v8::internal::PrintF(const char*, ...)`, `v8::internal::PrintF(FILE*, const char*, ...)`,
  `v8::internal::StdoutStream::StdoutStream()`. Linked with `/FORCE:MULTIPLE` (build.rs); the
  mozjs definitions win. Also `LNK4098` (libcmt vs dynamic CRT mix). Not shippable as-is.
- **Runtime:** both engines in one process, 1200 + 3x3000 frames, no crash.

## Measurements

| Run | frame interval avg / p95 (ms) | Servo frames imported |
|---|---|---|
| vsync (Fifo, ~162 Hz display) | 6.18 / 6.40 | 450 in ~7.4 s (Servo animates at ~60 fps) |
| no vsync, paint on Servo's notify | 1.04 / 2.67 (~960 fps) | 184 |
| no vsync, paint+import every frame | 2.40 / 3.36 (~417 fps) | 3000 |
| same, `SPIKE_NO_NORMALIZE=1` (no flip copy) | 1.99 / 2.70 (~500 fps) | 3000 |

Per Servo frame, 1920x1080:

- `WebView::paint`: p50 0.40–0.67 ms, p95 0.74–1.09 ms. **First paint blocks 250–311 ms.**
- import+swap (ANGLE blit, flush, DX12 flip pass, surfman swap): p50 1.02–1.49 ms,
  p95 1.69–2.35 ms, spikes to 7–19 ms. Without the flip/copy pass: p50 0.77 ms, p95 1.26 ms.
- Game + composite (incl. present, no vsync): p50 0.39–0.52 ms.
- First imported HUD frame: 1.0–1.9 s after process start. deno_core runtime init: 16.6 ms.
- JS tick (V8 game stub): p50 0.02–0.05 ms.

Bridge (JS → `evaluate_javascript("__bridge.tick(patch)")` → page → JSON result → JS):

- Round trip is **exactly 1 host frame** in every run (p95 1, max 2 frames): the result is
  delivered by the next frame's `spin_event_loop`. In ms it equals the frame time
  (p50 0.62 ms uncapped, 5.8 ms at 162 Hz). Patch→visible-pixels latency was not measured
  (Servo restyles/paints on its own ~60 Hz tick).

Pixel probes on the imported texture (all runs): `rgba(255,0,0,0.5)` → `[128,0,0,128]`
(**premultiplied**), opaque green exact, empty page area `[0,0,0,0]` (**transparent background
works** via `Preferences::shell_background_color_rgba = [0,0,0,0]`), orientation correct.

Memory (steady state during runs): working set 307–330 MB, private 531–547 MB.

## Build and ship

- Clean release build of Servo + adapter: ~26 min wall at `-j 10` (16.6 min to the mozangle
  failure + 9.8 min after fixing INCLUDE). Host build reusing part of that cache: 13.2 min
  (534 crates recompiled — feature unification with deno_core changes Servo's dep features).
  Edit-and-relink of the host crate: 12–35 s.
- `spike-host.exe`: 158 MB (no debug info). Must ship next to it: `libEGL.dll` (51 KB) and
  `libGLESv2.dll` (6.9 MB) from mozangle (without them: panic "egl function was not loaded").
  Also needs the VC++ runtime (`MSVCP140`, `VCRUNTIME140`, `VCRUNTIME140_1`).
- Disk: shared target dir 10.4 GB; Cargo also cloned Servo's git repo (1.7 GB) during the first
  wgpu-graft build despite the patch.
