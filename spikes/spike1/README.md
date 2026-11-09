# Spike 1: Servo → wgpu zero-copy texture import on Windows

Uses [mark-ik/wgpu-graft](https://github.com/mark-ik/wgpu-graft) (MPL-2.0), cloned into
`../wgpu-graft` at `d903cfa` (2026-11-04). Its `demo-servo-winit` is the test subject; the
per-frame measurements at 1920x1080 come from `../host` (same import path, instrumented).

## How the Windows path works (read from source)

- Servo renders through **ANGLE (GLES on D3D11)**: the demo enables Servo's `no-wgl` feature,
  which builds mozangle's `libEGL.dll`/`libGLESv2.dll` and selects surfman's ANGLE backend.
- The host wgpu device is forced to **DX12**. The adapter LUID-matches ANGLE's adapter to the
  wgpu adapter (cross-GPU sharing garbles).
- `grafting/src/surfman_gl/windows_dx12_shared.rs`: once per size, allocate an
  `ID3D11Texture2D` (`R8G8B8A8_UNORM`, `SHARED | SHARED_NTHANDLE`) on ANGLE's own D3D11
  device, export an NT handle, `ID3D12Device::OpenSharedHandle` it on wgpu's device and wrap it
  as a `wgpu::Texture` (`texture_from_raw` + `create_texture_from_hal`). Cached across frames.
- Every frame, inside the `RenderingContext::present()` hook (before Servo's swap): wrap the
  shared texture as a transient EGL pbuffer, `glBlitFramebuffer` Servo's back buffer into it,
  `glFlush`. Then the importer runs a wgpu render pass that Y-flips it into a **newly allocated**
  `Rgba8Unorm` texture (default `ImportOptions::normalize_origin = true`).
- Net: no CPU readback. Two GPU copies per Servo frame (ANGLE blit on D3D11, flip pass on
  D3D12) plus one texture allocation per frame. Cross-API ordering relies on `glFlush` only
  (`SyncMechanism::ImplicitGlFlush`): no keyed mutex or shared fence.

## Reproduce

Prereqs (user-scope, no admin): Rust 1.99.1, VS Build Tools 2026 (MSVC 14.51 + Win SDK
26100), LLVM `libclang.dll` + clang resource headers in `%USERPROFILE%\tools\llvm`, NASM 3.02
in `%USERPROFILE%\tools\nasm-3.02`, `git config --global core.longpaths true`.

```powershell
cd spikes
. .\env.ps1                      # vcvars64 + LIBCLANG_PATH + CARGO_TARGET_DIR=C:\Users\mason\st
cd wgpu-graft
# Spike-only edit already applied to Cargo.toml: [patch."https://github.com/servo/servo"]
# servo = "=0.7.0" (crates.io release of the pinned rev).
cargo build --release -p demo-servo-winit -j 10
copy C:\Users\mason\st\build\release\build\mozangle-*\out\*.dll C:\Users\mason\st\release\
C:\Users\mason\st\release\demo-servo-winit.exe --smoke
```

Expected: `GRAFT DEMO SMOKE PASS path=GPU-import ...` (the smoke gate rejects the CPU fallback).
Result on this machine (RTX 3060): **PASS** on DX12 (`smoke.log`), including click input and
resize.

## Measured (via `../host`, same import path, 1920x1080)

- Import+swap per Servo frame: p50 1.0–1.5 ms, p95 1.7–2.4 ms CPU on the host thread; with the
  flip/copy pass disabled (`normalize_origin = false`, flip in the composite shader instead):
  p50 0.77 ms, p95 1.26 ms. Occasional 7–19 ms spikes.
- Paint+import every frame still runs at ~417 fps (~500 fps without the copy).
- Premultiplied alpha confirmed; transparent page background works.

## Caveats

- Color: the shared texture is `Rgba8Unorm` holding sRGB-encoded values. The demo samples it
  into an sRGB swapchain without decoding (washed-out colors on its GPU path); the host decodes
  in its composite shader. Blending then happens in linear space, unlike a browser.
- Sync is `glFlush` only (no keyed mutex/fence between ANGLE's D3D11 and wgpu's D3D12 queues);
  no torn frames seen in pixel probes, but not verified visually or under load.
- The default path allocates a new texture every frame for the flip copy.
- Servo's first paint blocks the calling thread ~250–310 ms.
