# Spike 3: three.js r187 WGSL on naga 30 (wgpu 30)

Does the WGSL that three.js `WebGPURenderer` generates pass wgpu's shader
pipeline (naga frontend + validator, then HLSL for DX12 / SPIR-V for Vulkan)?

## How it works

1. `dump.mjs` runs three.js `WebGPURenderer` (`three@0.187.0`) headlessly on
   Dawn via the `webgpu@0.6.2` Node package (D3D12, NVIDIA RTX 3060). A stub
   canvas returns a fake `GPUCanvasContext` backed by a plain texture.
   `GPUDevice.prototype.createShaderModule` is wrapped so every unique WGSL
   module is written to `wgsl/<sha1-12>.<stage>.wgsl`, and `manifest.json`
   records which scenes produced each one plus Dawn/Tint compile errors.
2. `scenes.mjs` holds one small scene per feature (51 scenes: material family,
   PMREM, fog, alpha modes, all light types incl. RectArea, shadows, instanced /
   batched / skinned / morph meshes, clipping, custom TSL material, TSL compute
   with storage buffers, atomics and storage textures, and TSL post-processing:
   tone mapping, bloom, FXAA, SMAA, GTAO, DOF, motion blur, afterimage, outline,
   TRAA, SSR, gaussian blur).
3. `validate.mjs` runs naga 30.0.1 on every shader: validation, SPIR-V output,
   HLSL output at SM 5.1 and 6.0, then compiles each entry point with FXC
   (SM 5.1) and DXC (SM 6.0) from the Windows SDK. Results go to `report.json`.

## Rerun

```sh
npm install                      # three@0.187.0, webgpu@0.6.2 (exact pins)
cargo install naga-cli --version 30.0.1 --locked
node dump.mjs                    # optional filter: node dump.mjs post/
node validate.mjs                # needs Windows SDK dxc.exe / fxc.exe (WINSDK_BIN to override)
```

Env knobs for `dump.mjs`: `DAWN_ADAPTER` (adapter name), `DUMP_OUT` (output
folder; non-default folders get `<name>.manifest.json`), `DUMP_HIDE_FEATURES`
(comma list of WebGPU features to leave off the device, e.g.
`subgroups,subgroup-size-control`; `subgroup-size-control` implies `subgroups`
on Dawn).

## Results (2026-11-08)

- 51/51 scenes rendered; 165 unique shader modules; 0 Tint errors, 0 device errors.
- naga validate: 163/165 as emitted, 165/165 with one patch (below).
- SPIR-V generation: 165/165 (not checked with `spirv-val`; no Vulkan SDK here).
- HLSL generation: 165/165 at SM 5.1 and SM 6.0.
- DXC (SM 6.0): 165/165 compile. FXC (SM 5.1): 162/165.

Failures:

1. `enable subgroups;` (2 compute shaders). naga 30's WGSL frontend rejects the
   standard enable-extension ("not yet supported", gfx-rs/wgpu#5555) even
   though it supports the subgroup builtins. three's `WGSLNodeBuilder` adds the
   directive plus `@builtin(subgroup_size)` to *every* compute shader whenever
   the device reports the `subgroups` feature. Workarounds, both verified:
   don't report `subgroups` to three from the native device (three then emits
   no subgroup code; naga passes), or strip the directive line before handing
   the source to naga.
2. FXC only: the same two shaders use `WaveGetLaneCount` (SM 6 only), and the
   SSR fragment shader fails with X3511 (gradient sample inside a loop FXC
   can't unroll). DXC compiles all of them. wgpu 30's default
   `Dx12Compiler::Auto` picks static DXC (`static-dxc` cargo feature), then
   `dxcompiler.dll`, then FXC, so ship with `static-dxc`.

Not covered: real wgpu pipeline creation (naga CLI's default HLSL register
mapping differs from wgpu's DX12 binding map/sampler heap), SPIR-V validation,
MSAA, compressed/array/3D textures, glTF-loaded content (same materials though).
