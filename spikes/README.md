# Spikes

Each spike answered one question before the real code started. The code is throwaway. Each folder has a `README.md` with the commands to rerun it.

All spikes ran on Windows 11 with an NVIDIA RTX 3060, three.js 0.187.0, and wgpu 30.

| Folder | Question | Answer |
|---|---|---|
| `wgsl-naga` | Does naga, the shader translator in wgpu, accept the WGSL that three.js generates? | Yes, for 165 of 165 shaders once the `enable subgroups;` line is removed. FXC fails 3 of them, so Windows builds use DXC. |
| `folio-2025-wgsl` | Does that result hold for a real game? | Yes, for 233 of 233 shaders captured from folio-2025, with the same fix. |
| `spike1` | Can Servo frames reach wgpu on Windows without a CPU copy? | Yes. Servo renders through ANGLE on D3D11, and wgpu-graft shares the texture with wgpu on DX12. |
| `host` | Can V8, Servo, and wgpu share one executable? | It runs, but only with a V8 version pin and `/FORCE:MULTIPLE` for 3 duplicate symbols. That build can't ship. |
| `xproc` | Can Servo run in its own process instead? | Yes. The processes share textures through NT handles, sync with two shared fences, and talk over named pipes. The game pays about 0.03 ms per frame. |

`folio-2025-assessment.md` lists the work needed to port folio-2025. `env.ps1` loads the MSVC build environment that the Servo builds need.

The Servo spikes used wgpu-graft at commit `d903cfacf6ee663ddcc31e14539448dae3794c48`, with a `[patch]` entry added to its root `Cargo.toml`.

The `spikes/xproc/ui-host` crate needs `wgpu-graft` cloned into `spikes/wgpu-graft` at commit `d903cfacf6ee663ddcc31e14539448dae3794c48`.
