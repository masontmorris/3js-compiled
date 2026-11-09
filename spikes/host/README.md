# Spike 2: one binary with V8 + Servo + wgpu

`spike-host` is a single Windows executable that runs:

- **V8** via `deno_core` executing `game.js` (the stand-in "game"),
- **wgpu 30 on DX12** drawing an animated clear + spinning triangle (the "game render"),
- **Servo 0.7.0** rendering `hud.html` offscreen with a transparent page background,
  imported each frame through grafting's ANGLE-D3D11 → DX12 shared-texture path (spike 1)
  and alpha-composited (premultiplied) over the game,
- the **bridge**: once per frame JS calls `op_send_patch(json)`; the host passes it to
  `WebView::evaluate_javascript("__bridge.tick(patch)")`; the page applies it and returns its
  queued UI events as a JSON string; the callback stores them; next frame JS reads them via
  `op_take_events()`.

`grafting-servo/` is a vendored copy of wgpu-graft's `servo-wgpu-interop-adapter` (MPL-2.0)
whose only change is depending on the crates.io `servo = "=0.7.0"` instead of the git rev
(patching Servo's git source with the registry crate made Cargo hang for 9+ minutes).

## Dependency pins that matter

- `deno_core = "=0.398.0"` and `v8 = "=147.0.0"`. Newer V8 (147.1+, all of deno_core 0.399+)
  uses `temporal_capi ^0.2.3` → `icu_calendar ^2.2.1`, while SpiderMonkey's `mozjs_sys` (every
  release through 153.6.0-2, i.e. Servo 0.7 and 0.8) pins `icu_capi =2.1.2` →
  `icu_calendar ~2.1.1`. Cargo cannot unify them. V8 147.0.0 uses `temporal_capi ^0.1.2`,
  which accepts ICU4X 2.1.

- `build.rs` links with `/FORCE:MULTIPLE`: V8 and SpiderMonkey's bundled irregexp both define
  three `v8::internal` symbols (see `results.md`). Spike-only workaround.
- `SPIKE_NO_NORMALIZE=1` (env) makes the vendored adapter skip grafting's flip/copy pass and the
  host flip in its composite shader instead.

## Reproduce

```powershell
cd spikes
. .\env.ps1
cd host
cargo build --release -j 10
copy C:\Users\mason\st\build\release\build\mozangle-*\out\*.dll C:\Users\mason\st\release\
C:\Users\mason\st\release\spike-host.exe --frames 1200              # vsync
C:\Users\mason\st\release\spike-host.exe --frames 1200 --novsync    # uncapped
C:\Users\mason\st\release\spike-host.exe --frames 1200 --novsync --paint-every-frame
```

Results: see `results.md`.
