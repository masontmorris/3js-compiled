# folio-2025 WGSL capture

Captures every WGSL module the real folio-2025 build creates, then runs the
spike 3 validator (naga 30 + subgroups patch, SPIR-V, HLSL SM 5.1/6.0, FXC, DXC)
over them.

```sh
npm install                                   # playwright-core only, no browser download
# needs ../folio-2025/dist (npm run build there) and installed Microsoft Edge
DRIVE_SECONDS=45 node capture.mjs             # BROWSER_CHANNEL=chrome to use Chrome instead
node validate.mjs                             # copy of ../wgsl-naga/validate.mjs
```

`capture.mjs` serves `dist/` on localhost, loads `/#skip` in headless Edge with
`--enable-unsafe-webgpu`, wraps `GPUDevice.prototype.createShaderModule`, presses
Enter to start, drives the car, visits every map respawn and toggles quality
(both post-processing chains). Output: `wgsl/`, `manifest.json`; validation
writes `out/` and `report.json`.

Result (2026-11-09, RTX 3060 via Edge/Dawn D3D12): 233 unique modules
(111 vertex, 120 fragment, 2 compute), 0 Dawn errors. naga 231/233 raw,
233/233 with the subgroups patch; SPIR-V 233; HLSL 233; DXC 233; FXC 231
(the two Leaves compute shaders use `WaveGetLaneCount`).
