# 3js-compiled v1 plan

This plan takes 3js-compiled from an empty repo to folio-2025 running as a native Windows program. Players get the same game as the web build, with HTML menus drawn by Servo in its own process.
The rule the program enforces is that the web build of every game keeps working and native frames match the browser's frames.
Engine PRs land in `masontmorris/3js-compiled`. Port PRs land in the private `masontmorris/3js-compiled-folio`.
PR ids in order are E1, E2, E3, E4, E5, E6, F1, F2, F3, F4.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `~/.agents/skills/poteto-mode/playbooks/autopilot-stack.md`. The operator lands every PR. Every PR stops at merge-ready and waits for the operator.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these at program start. Re-read them at every tick. The pstack skills live on disk, not in a repo.
  - [ ] `git show origin/main:docs/plan.md`
  - [ ] `git show origin/main:docs/testing.md`, the host's scripted test mode, after E1 lands.
  - [ ] `C:\Users\mason\.agents\skills\poteto-mode\playbooks\autopilot-stack.md` and `autopilot-full.md` beside it.
  - [ ] `C:\Users\mason\.agents\skills\swarm\SKILL.md`
  - [ ] `C:\Users\mason\.agents\skills\poteto-mode\playbooks\opening-a-pr.md`
  - [ ] `C:\Users\mason\.agents\skills\how\SKILL.md`, `interrogate\SKILL.md`, and `show-me-your-work\SKILL.md` in the same folder.
- [ ] Install `ffmpeg` in user scope before the first review gate. The review videos need it.
- [ ] Install the Azure CLI, log in to the student subscription, and run `az vm list-usage` for NV-series and NGads V620 quota. Record the result in Appendix A. Azure lanes stay optional either way.
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] E1 is first. It branches from `main` in the engine repo.
  - [ ] E2 and E3 are independent of each other. Both stack on E1's branch.
  - [ ] E4 stacks on E3. E5 stacks on E3. E6 stacks on E5.
  - [ ] F1 starts after E4 and E6 merge. It branches from `main` in the port repo and pins the engine by SHA.
  - [ ] F2 stacks on F1. F3 stacks on F2 and starts after E2 merges. F4 stacks on F3.
- [ ] Hold the file boundaries. E PRs touch only the engine repo. F PRs touch only the port repo. An engine bug found during an F PR opens a new engine PR from `main`, and the F PR pins the fix by SHA.
- [ ] Hold the review gate. E2, F1, F2, F3, and F4 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use `gh pr create --base <base-branch>`. A stack child targets its parent branch.
- [ ] Run `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, and `npm run check` once before the PR-facing push. Push with hooks on.
- [ ] Reread the diff for AI slop before each commit, because `/deslop` is not installed here. Run `/no-comments` before review.
- [ ] Triage every review-bot comment per `../references/bugbot-triage.md`. Record "none configured" when no bot runs.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `C:\Users\mason\.agents\skills\swarm\SKILL.md`. One gates lane, which runs the Windows checks locally and the Modal lanes in parallel. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. Only a bug a user would hit, a failed gate, or a wrong shipped doc blocks. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Stop each PR at verified and green at its current head, then hand it to the operator. Nobody pushes after the handoff without the operator's go. A restack that leaves a PR's `git patch-id` unchanged keeps its verdict.

### Boot recipe, for every live lane

Each live lane runs on the operator's Windows 11 PC with the RTX 3060, one lane at a time, at the PR head. No control skill covers a native window, so the host's `--script` mode drives every lane.

Checks that need no GPU run on Modal in parallel. Modal containers are Linux, and their only working Vulkan device is Mesa llvmpipe, a CPU renderer. Modal runs the WGSL gate, the JS unit tests, and command-buffer replay tests, never a perf or GPU parity lane. Azure Windows GPU VMs are an optional extra once the quota check passes, and no verdict waits on them.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>` in a worktree under `C:\3jsc\worktrees\<pr-id>`.
- [ ] Set `CARGO_TARGET_DIR=C:\3jsc\target`. Run `cargo build --release -p threejsc-host -p threejsc-ui-host`, then `npm ci` and the PR's bundle build. Wait for both to finish.
- [ ] Deliver input only through `host --script <lane file>`. The read-only diagnostics are `frames.csv`, `host.log`, and `ui-host.log`.
- [ ] Save every screenshot to `C:\3jsc\swarm\<pr-id>\worker-<n>\<slug>.png` and return the paths with the report.
- [ ] Run Modal checks with `modal run tools/modal/lanes.py::<check>` and save their logs to `C:\3jsc\swarm\<pr-id>\modal\`.

## Create the native host with a JS runtime and a scripted test mode (E1)

**Depends on.** None. E1 branches from `main`.

**Files.**

- [ ] Create `Cargo.toml` as the workspace root and `rust-toolchain.toml`.
- [ ] Create `crates/host/` with package `threejsc-host` and binary `host`.
- [ ] Create `crates/host/src/script.rs` for the test mode.
- [ ] Create `examples/clear.js` and `examples/input.js`.
- [ ] Create `docs/testing.md` and `docs/build.md`.

**Build.**

- [ ] Open an SDL3 window and create a wgpu 30 device on DX12 with the `static-dxc` feature. Pick the high-performance hardware adapter and skip virtual and software adapters.
- [ ] Enter a tokio runtime, then create a deno_core 0.413 `JsRuntime` that loads one ES module bundle given by `--entry`.
- [ ] Drive `requestAnimationFrame` from the host frame loop and expose `performance.now` and `console`.
- [ ] Add `--script <file>`, a JSON list of steps that wait frames, inject key, pointer, wheel, and gamepad events, resize the window, and capture a PNG. Add `--record <dir>` for frame sequences.
- [ ] Write per-frame CPU time to `frames.csv`.

**You see.**

- [ ] `host --entry examples/clear.js` opens a window whose clear color changes every frame from JS.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `crates/host/tests/script.rs` parses every step type and rejects an unknown step. Run `cargo test -p threejsc-host`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opencode:opencode-go/deepseek-v4.1-flash max` at the PR head, run one after another per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no host, so record that and gate 300 frames of `examples/clear.js` at head. Save `e1-clear.png`. Pass when the captured pixel equals the color JS set for that frame and the exit code is 0.
- [ ] Lane 2. Resize the window to 1280x720, then 1920x1080. Save `e1-resize.png`. Pass when both captures have the new size and `host.log` has no device-lost line.
- [ ] Lane 3. Start with the virtual display adapter present. Save `e1-adapter.png`. Pass when `host.log` names the RTX 3060 on DX12.
- [ ] Lane 4. Inject `KeyW` down and up into `examples/input.js`. Save `e1-key.png`. Pass when the color changes on the frame after the key-down step.
- [ ] Lane 5. Inject a pointer move and click at 100,100. Save `e1-pointer.png`. Pass when the color encodes the pointer position.
- [ ] Lane 6. Inject gamepad button A from a virtual gamepad. Save `e1-gamepad.png`. Pass when the color changes on the next frame.
- [ ] Lane 7. Throw an error inside a frame callback. Save `e1-throw.png`. Pass when `host.log` has the stack with file and line and frames keep coming.
- [ ] Lane 8. Record 120 frames with `--record`. Save `e1-record.png`. Pass when 120 PNG files exist with consecutive frame numbers.
- [ ] Lane 9. Run with vsync on, then off. Save `e1-vsync.png`. Pass when the vsync p50 interval is within 5 percent of the display refresh and vsync off runs faster.
- [ ] Lane 10. Close the window from the script mid-run. Save `e1-close.png`. Pass when the host exits with code 0 within 1 second.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Host CPU time per frame for `examples/clear.js` at 1920x1080, p50 and p95, from `frames.csv`.
- [ ] Probe. Run `host --entry examples/clear.js --script lanes/e1/perf.json` three times for 1,000 frames each with vsync off.
- [ ] Baseline. Trunk has no host. Record that.
- [ ] Rule. E1 fails when the p95 CPU time exceeds 1.0 ms.

**Review gate.** None. E1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends E1 to the stack and the operator lands it bottom-up.

## Run the Servo UI process and composite its frames (E2)

**Depends on.** E1. E2 stacks on E1's branch.

**Files.**

- [ ] Create `crates/ui-host/` with package `threejsc-ui-host` and binary `ui-host`.
- [ ] Create `crates/ui-host/grafting-servo/` from `spikes/xproc/ui-host/grafting-servo/` and keep it MPL-2.0.
- [ ] Create `crates/ipc/` from `spikes/xproc/proto.rs`.
- [ ] Create `crates/host/src/ui.rs`.
- [ ] Create `packages/three-native/src/bridge.js`.
- [ ] Create `examples/hud/`.

**Build.**

- [ ] Port `spikes/xproc` into `crates/ui-host` and `crates/host/src/ui.rs`. Use a 4-slot ring of NT-handle textures, two shared fences, a non-blocking fence poll, and two named pipes.
- [ ] Launch `ui-host` off the render thread. Relaunch it after a broken pipe with a 500 ms backoff.
- [ ] Composite the UI texture with premultiplied alpha. Convert its sRGB values in the shader and flip it there.
- [ ] Forward a pointer event to `ui-host` when it lands inside an interactive rect the page reported. Send every other pointer event to the game.
- [ ] Expose `bridge.send(patch)` and `bridge.onEvent(fn)` in JS. Send at most one patch per Servo frame.

**You see.**

- [ ] `host --entry examples/hud/game.js` shows the HUD over the animated scene, and the HUD counter follows the game's frame counter.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `crates/ipc/tests/proto.rs` round-trips every message type and rejects a truncated frame. Run `cargo test -p threejsc-ipc`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opencode:opencode-go/deepseek-v4.1-flash max` at the PR head, run one after another per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `examples/clear.js` at trunk and head. Save `e2-regression.png`. Pass when both captures match and head's `frames.csv` shows no UI work without a UI page.
- [ ] Lane 2. Show a 50 percent red HUD box over a blue scene. Save `e2-alpha.png`. Pass when the captured pixel is within 2 of the premultiplied blend.
- [ ] Lane 3. Show a mid-gray swatch in the page. Save `e2-srgb.png`. Pass when the captured value is within 2 of the same page captured in Edge.
- [ ] Lane 4. Send a sequence number each Servo frame and detect it in the capture. Save `e2-latency.png`. Pass when state-to-pixels p50 is 5 frames or less at vsync.
- [ ] Lane 5. Click a page button with an injected pointer event. Save `e2-click.png`. Pass when the game receives the click event and the page shows the pressed state.
- [ ] Lane 6. Click outside every interactive rect. Save `e2-click-game.png`. Pass when the game's pointer handler fires and the page logs no click.
- [ ] Lane 7. Kill `ui-host` mid-run. Save `e2-crash.png`. Pass when no game frame interval exceeds 50 ms and the HUD returns within 1 second.
- [ ] Lane 8. Capture the first second after launch. Save `e2-startup.png`. Pass when the game's first frame precedes the HUD's first frame and no game frame interval exceeds twice the refresh interval.
- [ ] Lane 9. Resize the window during play. Save `e2-resize.png`. Pass when the HUD lays out at the new size within 3 Servo frames with no stretched texture.
- [ ] Lane 10. Run for 10 minutes. Save `e2-soak.png`. Pass when handle count and memory grow less than 5 percent and skipped ring slots stay under 1 percent.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Game-thread CPU time per frame with and without the HUD, p50, and state-to-pixels latency p50.
- [ ] Probe. Run `host --entry examples/hud/game.js --script lanes/e2/perf.json` with `--no-ui` and with the UI, interleaved, three runs each.
- [ ] Baseline. Record trunk's `examples/clear.js` frame time first.
- [ ] Rule. E2 fails when the UI adds more than 0.1 ms p50 to the game thread or state-to-pixels p50 exceeds 5 frames at vsync.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 5, and 7 screenshots into `C:\3jsc\review\e2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video with `--record` and `ffmpeg`. Save it as `C:\3jsc\review\e2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto E1's branch after the verdict, patch-id unchanged.
- [ ] The root appends E2 to the stack and the operator lands it bottom-up.

## Render three.js scenes through the native backend (E3)

**Depends on.** E1. E3 stacks on E1's branch.

**Files.**

- [ ] Create `packages/three-native/src/NativeBackend.js` and `packages/three-native/src/commands.js`.
- [ ] Create `packages/three-native/patches/three@0.187.0.patch`.
- [ ] Create `crates/gpu/` for the command executor, with no Windows-only code so it builds on Linux.
- [ ] Create `tools/parity/` from `spikes/folio-2025-wgsl/capture.mjs`.
- [ ] Create `tools/wgsl-gate/` from `spikes/wgsl-naga/`.
- [ ] Create `tools/modal/lanes.py`.
- [ ] Create `examples/scenes/`.

**Build.**

- [ ] Subclass three's `Backend` in `NativeBackend.js`. Record buffers, textures, samplers, bind groups, render pipelines, render passes, draws, render targets, MSAA resolves, and readbacks into one binary buffer per frame. JS allocates every handle.
- [ ] Execute the buffer in `crates/gpu/`. Return errors and readbacks on a separate channel.
- [ ] Remove `enable subgroups;` from WGSL and hide the `subgroups` feature from three.
- [ ] Pin `three` at exactly 0.187.0 and apply the patch at install.
- [ ] Make `tools/parity` capture the same scene in headless Edge and in the host and report the per-pixel difference.

**You see.**

- [ ] `host --entry examples/scenes/index.js --scene standard-shadow` renders the scene, and `tools/parity` reports a difference under the threshold.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/three-native/test/commands.test.js` encodes and decodes every opcode. Run `npm test -w packages/three-native`.
- [ ] `tools/wgsl-gate` validates every shader the scene set produces with naga 30 and DXC. Run `modal run tools/modal/lanes.py::wgsl_gate`.
- [ ] `crates/gpu/tests/replay.rs` replays recorded command buffers on llvmpipe and compares readbacks to stored references. Run `modal run tools/modal/lanes.py::gpu_replay`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opencode:opencode-go/deepseek-v4.1-flash max` at the PR head, run one after another per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no backend, so record that and gate the `basic-cube` scene at head. Save `e3-basic.png`. Pass when the mean pixel difference against Edge is 1 percent or less.
- [ ] Lane 2. Render standard and physical materials. Save `e3-materials.png`. Pass when the difference against Edge is 1.5 percent or less.
- [ ] Lane 3. Render textures with mipmaps, anisotropy, and normal maps. Save `e3-textures.png`. Pass when the difference against Edge is 1.5 percent or less.
- [ ] Lane 4. Render a directional light with PCF shadows. Save `e3-shadow.png`. Pass when the difference against Edge is 2 percent or less.
- [ ] Lane 5. Render 2,000 instanced and batched meshes. Save `e3-instancing.png`. Pass when the difference against Edge is 1 percent or less.
- [ ] Lane 6. Load a CC0 glTF model. Save `e3-gltf.png`. Pass when the difference against Edge is 1.5 percent or less.
- [ ] Lane 7. Render into an MSAA render target and resolve it. Save `e3-msaa.png`. Pass when edge pixels match Edge within 2 percent.
- [ ] Lane 8. Render transparency with `alphaTest` and `alphaHash`. Save `e3-alpha.png`. Pass when the difference against Edge is 2 percent or less.
- [ ] Lane 9. Resize mid-scene. Save `e3-resize.png`. Pass when attachments match the new size and `host.log` has no validation error.
- [ ] Lane 10. Inject a material with invalid WGSL. Save `e3-bad-shader.png`. Pass when `host.log` names the material and the error line and other objects keep rendering.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Uncapped presented frames per second, counted the same way on both sides by PresentMon, and total CPU time per frame summed over every process involved: `host.exe` natively, and every `msedge` process in Edge, including the GPU process, measured from process CPU counters over the run. The 2,000-mesh `instancing` scene at 1920x1080 with vsync off.
- [ ] Probe. `node tools/perf/frame-cost.mjs` under the GPU lease. Three counted runs each, interleaved. A run counts when its warm-up lasts at least 3 seconds and its measured frames at least 10 seconds (the defaults are 36,000 frames after a 12,000-frame warm-up, which Edge at about 2,800 fps needs), the GPU stays at P0 throughout its measured window, the rest of the machine's CPU load over it is at most one core above the run's baseline, and its PresentMon capture spans the window with no gap over 100 ms between presents. The GPU ramps from idle over about 2 seconds, so a shorter run measures the ramp. The baseline is 5 seconds of the machine's load measured before each run, with nothing measured running. The rest of the machine's load is its busy CPU time less its DPC and interrupt time and the measured processes' CPU time, both in the baseline and over the run. A run's own presents and GPU work raise DPC and interrupt time from about 0.04 cores to 0.35 to 0.39, so the tool reports it as its own column. When the baseline is over 3 cores, the machine is too busy to measure, and the tool waits and measures the baseline again.
  - PresentMon 2.6.0 counts presents. It needs administrator rights, so the tool runs it through the elevated `3jsc-presentmon` scheduled task with `C:\3jsc\tools\presentmon\capture.py`. One capture spans each run, and the tool counts the run's own process IDs between the start and end of the measured frames. Node's `process.hrtime` and PresentMon's `CPUStartQPCTimeInMs` both read `QueryPerformanceCounter`, so both use one clock. Captures share one request file, so take them only under the lease. When a capture is unavailable, the tool stops and reports INCONCLUSIVE. PresentMon can lose events without saying so. In fix round 8, five native captures had gaps of 107 to 800 ms while the host presented a frame at least every 11 ms, and they were short by up to 8 percent. Loss-free windows had no gap over 46 ms, so a run whose window has a gap over 100 ms does not count.
  - In Edge, the GPU process presents. For each run, the tool reports which processes presented and marks the GPU process of the Edge it launched. After the window, it stops the page's animation loop and counts presents for a second. If they fall to about zero, the window's presents came from the page's canvas and not from the browser's own frame.
- [ ] Baseline. Trunk has no backend. Record that, then use Edge as the baseline.
- [ ] Rule. E3 fails when native presents more than 10 percent fewer frames per second than Edge, or spends more than 10 percent more CPU time per frame than Edge. Displayed frames per second, the probe's frame rate (Edge's animation frames, the host's frames), and JavaScript render-call time stay in the report as information.
  - The rule counts presented frames and not displayed frames. A present is displayed when PresentMon gives it a `MsUntilDisplayed` value. While the desktop compositor composes a window, it shows at most one frame per refresh, 169 per second on this display, and the OS picks the present mode for each window. Displayed frames therefore measure the display and the compositor's choice more than the program. Presented frames count every frame a program finished and gave to the OS. Edge's animation-frame count overstates this, because a 2-second trace in fix round 7 showed Edge presented about 42 percent of its animation frames.

**Follow-up.** Native runs have an unexplained slow mode. After the first run of a series, the game thread's CPU p50 rises from 0.23 to 0.38 ms and the render thread's from 0.42 to 0.50 ms, and GPU clocks drop from 1,840 to 2,047 MHz to as low as 1,440 MHz. It costs about 13 percent of native fps. A present-thread prototype never entered it. Explain it in a follow-up PR. E3 records only whether its runs show it.

**Review gate.** None. E3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto E1's branch after the verdict, patch-id unchanged.
- [ ] The root appends E3 to the stack and the operator lands it bottom-up.

## Add compute, copies, and post-processing to the native backend (E4)

**Depends on.** E3. E4 stacks on E3's branch.

**Files.**

- [ ] Edit `packages/three-native/src/NativeBackend.js` and `packages/three-native/src/commands.js`.
- [ ] Edit `crates/gpu/`.
- [ ] Create the `compute`, `copy`, `post`, and `warmup` scenes in `examples/scenes/`.

**Build.**

- [ ] Record compute pipelines, storage buffers, and dispatches.
- [ ] Record `copyFramebufferToTexture`, `copyTextureToTexture`, and mipmap generation.
- [ ] Run `RenderPipeline` chains with `pass`, `mrt`, `bloom`, and a copy of folio's `cheapDOF` pass.
- [ ] Record timestamp queries for GPU timing.

**You see.**

- [ ] `host --entry examples/scenes/index.js --scene post` shows bloom and depth of field matching Edge.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/three-native/test/commands.test.js` gains the compute, copy, and timestamp opcodes. Run `npm test -w packages/three-native`.
- [ ] `crates/gpu/tests/replay.rs` gains a compute replay and a copy replay. Run `modal run tools/modal/lanes.py::gpu_replay`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opencode:opencode-go/deepseek-v4.1-flash max` at the PR head, run one after another per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the E3 scene set at trunk and head. Save `e4-regression.png`. Pass when every E3 scene keeps its difference against Edge under its E3 threshold.
- [ ] Lane 2. Update 100,000 particles with a compute shader every frame. Save `e4-compute.png`. Pass when the difference against Edge is 2 percent or less.
- [ ] Lane 3. Refract the scene through a framebuffer copy. Save `e4-copy.png`. Pass when the difference against Edge is 2 percent or less.
- [ ] Lane 4. Run bloom. Save `e4-bloom.png`. Pass when the difference against Edge is 2 percent or less.
- [ ] Lane 5. Run the `cheapDOF` pass with bloom. Save `e4-dof.png`. Pass when the difference against Edge is 2 percent or less.
- [ ] Lane 6. Write color and emissive with `mrt`. Save `e4-mrt.png`. Pass when both outputs match Edge within 2 percent.
- [ ] Lane 7. Generate a PMREM environment map. Save `e4-pmrem.png`. Pass when the difference against Edge is 2 percent or less.
- [ ] Lane 8. Draw into two render targets per frame, like folio's tracks and snow. Save `e4-targets.png`. Pass when both targets match Edge within 2 percent.
- [ ] Lane 9. Run a hidden six-sided warm-up pass before the first visible frame. Save `e4-warmup.png`. Pass when the first visible frame compiles no new pipeline.
- [ ] Lane 10. Toggle quality so the post chain rebuilds 20 times. Save `e4-rebuild.png`. Pass when GPU memory returns to within 5 percent of its start value.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. GPU time of the bloom and depth-of-field chain at 1920x1080 from timestamp queries.
- [ ] Probe. Run the `post` scene in Edge and in the host, interleaved, three runs of 600 frames each.
- [ ] Baseline. Trunk has no post chain. Record that, then record Edge's p50 first.
- [ ] Rule. E4 fails when the native p50 exceeds Edge's p50 by more than 10 percent.

**Review gate.** None. E4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto E3's branch after the verdict, patch-id unchanged.
- [ ] The root appends E4 to the stack and the operator lands it bottom-up.

## Run browser game code on platform shims (E5)

**Depends on.** E3. E5 stacks on E3's branch.

**Files.**

- [ ] Create `packages/three-native/src/platform/` with `dom.js`, `events.js`, `gamepad.js`, `storage.js`, and `images.js`.
- [ ] Create `crates/host/src/platform/` for event, image, and storage ops.
- [ ] Create `examples/platform/`.

**Build.**

- [ ] Add a stand-in DOM. `document`, `window`, and inert elements support `classList`, `style`, `dataset`, `querySelector`, and listeners.
- [ ] Dispatch SDL3 keyboard, pointer, and wheel events to DOM listeners. Back `navigator.getGamepads()` with SDL3 gamepads in the standard mapping.
- [ ] Persist `localStorage` to one JSON file per game.
- [ ] Add `Image`, `createImageBitmap`, `Blob`, and `URL.createObjectURL`. Decode PNG, JPEG, and WebP in native code off the main thread.
- [ ] Add `fetch` for local files, `location.hash`, `matchMedia`, `devicePixelRatio`, and `resize` events.

**You see.**

- [ ] `host --entry examples/platform/index.js` shows a textured quad loaded with `TextureLoader` and logs every injected event.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/three-native/test/dom.test.js` covers `querySelector`, `classList`, and listener order. Run `npm test -w packages/three-native`.
- [ ] `crates/host/tests/images.rs` decodes a PNG with alpha to the reference bytes. Run `cargo test -p threejsc-host`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opencode:opencode-go/deepseek-v4.1-flash max` at the PR head, run one after another per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the E3 scene set at trunk and head. Save `e5-regression.png`. Pass when every scene keeps its E3 threshold.
- [ ] Lane 2. Inject keys with repeat. Save `e5-keys.png`. Pass when `key`, `code`, and `repeat` match Edge's values for the same keys.
- [ ] Lane 3. Inject pointer down, move, and up. Save `e5-pointer.png`. Pass when client coordinates match the window coordinates.
- [ ] Lane 4. Inject wheel events. Save `e5-wheel.png`. Pass when `deltaY` and `deltaMode` match Edge.
- [ ] Lane 5. Connect an Xbox-layout virtual gamepad. Save `e5-gamepad.png`. Pass when button and axis indices follow the standard mapping.
- [ ] Lane 6. Load a PNG with alpha through `TextureLoader`. Save `e5-texture.png`. Pass when the difference against Edge is 1 percent or less.
- [ ] Lane 7. Load an image from a blob URL with `createImageBitmap`. Save `e5-blob.png`. Pass when it matches lane 6.
- [ ] Lane 8. Write `localStorage`, restart the host, and read it back. Save `e5-storage.png`. Pass when the value survives the restart.
- [ ] Lane 9. Resize the window. Save `e5-resize.png`. Pass when `resize` fires once and `innerWidth` matches.
- [ ] Lane 10. Call a DOM method the shim lacks. Save `e5-missing.png`. Pass when `host.log` names the method once and frames keep coming.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Total decode time for folio's 20 largest PNG and JPEG textures.
- [ ] Probe. Decode the same files in Edge and in the host, interleaved, three runs each.
- [ ] Baseline. Trunk has no image decoding. Record that, then record Edge's time first.
- [ ] Rule. E5 fails when the native time exceeds Edge's time by more than 25 percent.

**Review gate.** None. E5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto E3's branch after the verdict, patch-id unchanged.
- [ ] The root appends E5 to the stack and the operator lands it bottom-up.

## Draw canvas 2D text with game fonts (E6)

**Depends on.** E5. E6 stacks on E5's branch.

**Files.**

- [x] Create `packages/three-native/src/platform/canvas2d.js`.
- [x] Create `crates/host/src/canvas2d/`.
- [x] Create `examples/canvas2d/` with copies of folio's label drawing code.

**Build.**

- [x] Prototype two rasterizers on folio's label canvases and diff each against Edge. Keep the closer one and record the result in Appendix A.
- [x] Implement the 2D context calls folio uses, listed in `spikes/folio-2025-assessment.md`.
- [x] Add `FontFace` and `document.fonts.add` for bundled TTF and WOFF2 files.
- [x] Upload canvases through `CanvasTexture`.

**You see.**

- [x] `host --entry examples/canvas2d/index.js` shows folio's labels in Pally, Amatic SC, and Nunito.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `packages/three-native/test/canvas2d.test.js` checks `measureText` widths against recorded Edge values. Run `npm test -w packages/three-native`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opencode:opencode-go/deepseek-v4.1-flash max` at the PR head, run one after another per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Run the E5 platform example at trunk and head. Save `e6-regression.png`. Pass when both captures match.
- [x] Lane 2. Draw text in Pally. Save `e6-pally.png`. Pass when the difference against Edge is 3 percent or less.
- [x] Lane 3. Draw text in Amatic SC. Save `e6-amatic.png`. Pass when the difference against Edge is 3 percent or less.
- [x] Lane 4. Draw text in Nunito at 12, 24, and 64 px. Save `e6-sizes.png`. Pass when the difference against Edge is 3 percent or less.
- [x] Lane 5. Draw every `textAlign` and `textBaseline` value. Save `e6-align.png`. Pass when glyph boxes sit within 1 px of Edge.
- [x] Lane 6. Draw text with an emoji. Save `e6-emoji.png`. Pass when the emoji draws from a fallback font with no missing-glyph box.
- [x] Lane 7. Draw an image with `drawImage` under text. Save `e6-image.png`. Pass when the difference against Edge is 2 percent or less.
- [x] Lane 8. Fill shapes with gradients and `globalAlpha`. Save `e6-fills.png`. Pass when the difference against Edge is 2 percent or less.
- [x] Lane 9. Resize a canvas and redraw. Save `e6-resize.png`. Pass when the texture size matches and no stale pixels remain.
- [x] Lane 10. Update a `CanvasTexture` every frame. Save `e6-dynamic.png`. Pass when the texture shows the current frame number.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Time to draw folio's 10 label canvases at load, and per-frame time for one dynamic canvas.
- [x] Probe. Run `examples/canvas2d` in Edge and in the host, interleaved, three runs each.
- [x] Baseline. Trunk has no canvas 2D. Record that, then record Edge's times first.
- [x] Rule. E6 fails when the load time exceeds 50 ms or the dynamic canvas takes more than 1 ms per frame.

**Review gate.** None. E6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto E5's branch after the verdict, patch-id unchanged.
- [ ] The root appends E6 to the stack and the operator lands it bottom-up.

## Boot folio-2025 natively (F1)

**Depends on.** E4 and E6 merged in the engine repo. F1 branches from `main` in the port repo.

**Files.**

- [ ] Create `sources/index.native.js`.
- [ ] Create `vite.config.native.js`.
- [ ] Edit `package.json` to pin the engine by SHA and add `build:native`.
- [ ] Edit `sources/Game/Audio.js` to do nothing in the native build.
- [ ] Edit `sources/Game/ResourcesLoader.js` to load uncompressed assets in the native build.

**Build.**

- [ ] Build a native bundle with Vite and load it with `host --entry dist-native/index.js`.
- [ ] Leave the web build unchanged.
- [ ] Turn off the server, audio, and the worker-based decoders in the native build.
- [ ] Keep vsync on so physics steps at the display rate, as in the browser.

**You see.**

- [ ] The native window plays the intro, then the car drives across the island under scripted input.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/native-boot.test.mjs` runs the native bundle for 600 frames and fails on any uncaught exception. Run `npm run test:native`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opencode:opencode-go/deepseek-v4.1-flash max` at the PR head, run one after another per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run one scripted route in Edge at trunk, in Edge at head, and natively at head. Save `f1-route.png`. Pass when the web head matches the web trunk at five checkpoints and the native run reaches all five.
- [ ] Lane 2. Play the intro. Save `f1-intro.png`. Pass when the intro ends and control passes to the player.
- [ ] Lane 3. Drive to the circuit area with the keyboard. Save `f1-keyboard.png`. Pass when the car enters the circuit zone.
- [ ] Lane 4. Drive with a virtual gamepad. Save `f1-gamepad.png`. Pass when the car moves and steers.
- [ ] Lane 5. Flip the car and respawn. Save `f1-respawn.png`. Pass when the car returns to the respawn point.
- [ ] Lane 6. Hit explosive crates. Save `f1-crates.png`. Pass when the crates explode and their debris settles.
- [ ] Lane 7. Switch quality from high to low and back. Save `f1-quality.png`. Pass when both modes render and `host.log` has no error.
- [ ] Lane 8. Advance the day cycle to night. Save `f1-night.png`. Pass when lights turn on.
- [ ] Lane 9. Turn on rain and snow through the debug hash. Save `f1-weather.png`. Pass when both effects draw.
- [ ] Lane 10. Change an option, restart, and check it. Save `f1-persist.png`. Pass when the option survives the restart.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Frame time p95 along the scripted route, and time from launch to the first interactive frame.
- [ ] Probe. Run the route in Edge at trunk and natively at head, interleaved, three runs each.
- [ ] Baseline. Record Edge's numbers at trunk first.
- [ ] Rule. F1 fails when the native frame time p95 exceeds Edge's p95 or the native launch takes longer than Edge's load.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, and 6 screenshots into `C:\3jsc\review\f1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the route with `--record` and `ffmpeg`. Save it as `C:\3jsc\review\f1-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends F1 to the stack and the operator lands it bottom-up.

## Match folio's native frames to the browser (F2)

**Depends on.** F1. F2 stacks on F1's branch.

**Files.**

- [ ] Create `tools/parity/viewpoints.json` with 12 camera poses.
- [ ] Create `tools/parity/run.mjs`.
- [ ] Edit the port files that cause a difference. Engine fixes go to new engine PRs.

**Build.**

- [ ] Freeze time, seed random numbers, and fix the day cycle so both runs draw the same frame.
- [ ] Capture each viewpoint in Edge and natively and diff the pairs.
- [ ] Fix each difference above its threshold at its first cause.

**You see.**

- [ ] `node tools/parity/run.mjs` prints 12 viewpoints, each under its threshold.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tools/parity/run.test.mjs` fails on a doctored capture and passes on an identical one. Run `node --test tools/parity`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opencode:opencode-go/deepseek-v4.1-flash max` at the PR head, run one after another per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture the 12 viewpoints from the web build at trunk and head. Save `f2-web.png`. Pass when the web head matches the web trunk at every viewpoint.
- [ ] Lane 2. Look through the water. Save `f2-water.png`. Pass when the difference against Edge is 3 percent or less.
- [ ] Lane 3. Watch falling leaves. Save `f2-leaves.png`. Pass when the difference against Edge is 3 percent or less.
- [ ] Lane 4. Drive to leave tyre tracks. Save `f2-tracks.png`. Pass when the difference against Edge is 3 percent or less.
- [ ] Lane 5. Drive through snow. Save `f2-snow.png`. Pass when the difference against Edge is 3 percent or less.
- [ ] Lane 6. Look at long shadows at sunset. Save `f2-shadows.png`. Pass when the difference against Edge is 3 percent or less.
- [ ] Lane 7. Look at lanterns at night with bloom. Save `f2-bloom.png`. Pass when the difference against Edge is 3 percent or less.
- [ ] Lane 8. Look at the depth-of-field pass at the landing area. Save `f2-dof.png`. Pass when the difference against Edge is 3 percent or less.
- [ ] Lane 9. Look across grass and foliage. Save `f2-foliage.png`. Pass when the difference against Edge is 3 percent or less.
- [ ] Lane 10. Watch the tornado and lightning. Save `f2-tornado.png`. Pass when the difference against Edge is 3 percent or less.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. GPU time per viewpoint from timestamp queries.
- [ ] Probe. Capture each viewpoint in Edge and natively, interleaved, three runs each.
- [ ] Baseline. Record Edge's numbers and F1's native numbers first.
- [ ] Rule. F2 fails when any viewpoint runs more than 10 percent slower than Edge or than F1.

**Review gate.** The operator reviews before merge.

- [ ] Copy every lane screenshot pair into `C:\3jsc\review\f2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video that cuts between Edge and native at each viewpoint. Save it as `C:\3jsc\review\f2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto F1's branch after the verdict, patch-id unchanged.
- [ ] The root appends F2 to the stack and the operator lands it bottom-up.

## Move folio's menus and HUD into Servo (F3)

**Depends on.** F2, and E2 merged in the engine repo. F3 stacks on F2's branch.

**Files.**

- [ ] Create `sources/ui/` with the page entry and the moved modules.
- [ ] Create `sources/Game/UiBridge.js`.
- [ ] Create `vite.config.ui.js`.
- [ ] Edit `Menu.js`, `Modals.js`, `Options.js`, `Notifications.js`, `Tabs.js`, `Map.js`, `Achievements.js`, and the circuit modules in `sources/Game/`.

**Build.**

- [ ] Bundle the UI modules into one page that `ui-host` loads.
- [ ] Define the bridge messages. The game sends one state patch per Servo frame, and the page sends commands back.
- [ ] Split `Achievements.js` into game logic that stays and a screen that moves.
- [ ] Mirror the root classes for input mode, gamepad type, and mute onto the page root.
- [ ] Send the car's position and heading while the map is open.
- [ ] Hide every server-dependent element.
- [ ] Run the same UI modules in the web build's DOM through an in-memory bridge.

**You see.**

- [ ] The menu opens over the running game natively, and a quality change from the options tab applies to the game.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/ui-bridge.test.mjs` applies a patch sequence to the UI store and checks the commands it emits. Run `npm test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opencode:opencode-go/deepseek-v4.1-flash max` at the PR head, run one after another per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open, use, and close every menu in Edge at trunk and at head. Save `f3-web.png`. Pass when the web head behaves like the web trunk at every step.
- [ ] Lane 2. Open and close the menu natively. Save `f3-menu.png`. Pass when it opens and closes within 6 frames of the click.
- [ ] Lane 3. Change quality from the options tab. Save `f3-options.png`. Pass when the game switches quality.
- [ ] Lane 4. Enter a new area. Save `f3-notification.png`. Pass when the notification appears and leaves on schedule.
- [ ] Lane 5. Open the map while driving. Save `f3-map.png`. Pass when the car marker moves with the car.
- [ ] Lane 6. Finish a circuit lap. Save `f3-circuit.png`. Pass when the timer counts and the end screen shows the lap time.
- [ ] Lane 7. Unlock an achievement. Save `f3-achievement.png`. Pass when the achievement screen and its notification both update.
- [ ] Lane 8. Switch every tab. Save `f3-tabs.png`. Pass when each tab's content shows.
- [ ] Lane 9. Close a modal by clicking outside it. Save `f3-modal.png`. Pass when the modal closes and the game gets no click.
- [ ] Lane 10. Connect a gamepad. Save `f3-root-class.png`. Pass when the page shows gamepad button icons.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Game-thread time p50 with the menu open and closed, and click-to-visible time.
- [ ] Probe. Run `lanes/f3/perf.json` at F2's head and at F3's head, interleaved, three runs each.
- [ ] Baseline. Record F2's game-thread time first.
- [ ] Rule. F3 fails when the menu adds more than 0.1 ms p50 to the game thread or click-to-visible exceeds 6 frames.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 5, and 7 screenshots into `C:\3jsc\review\f3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video that opens every menu while driving. Save it as `C:\3jsc\review\f3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto F2's branch after the verdict, patch-id unchanged.
- [ ] The root appends F3 to the stack and the operator lands it bottom-up.

## Route keyboard and gamepad input between the game and the UI (F4)

**Depends on.** F3. F4 stacks on F3's branch.

**Files.**

- [ ] Edit `sources/Game/Inputs/Inputs.js`, `Keyboard.js`, and `Gamepad.js`.
- [ ] Edit `sources/Game/UiBridge.js`.
- [ ] Edit `sources/ui/` focus handling.

**Build.**

- [ ] Send keystrokes to the page while a page text field has focus. Send them to the game otherwise.
- [ ] Move gamepad menu navigation through the game's input system and forward it to the page.
- [ ] Release every held key when the window loses focus.
- [ ] Keep a pointer drag that starts on the UI inside the UI.

**You see.**

- [ ] Typing in the country search fills the field while the car stays still, and WASD drives the car after the field loses focus.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/input-routing.test.mjs` routes a key sequence through each focus state. Run `npm test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opencode:opencode-go/deepseek-v4.1-flash max` at the PR head, run one after another per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the keyboard and gamepad route in Edge at trunk and head. Save `f4-web.png`. Pass when the web head behaves like the web trunk.
- [ ] Lane 2. Drive with WASD with no field focused. Save `f4-drive.png`. Pass when the car moves.
- [ ] Lane 3. Type in the country search. Save `f4-type.png`. Pass when the field shows the text and the car does not move.
- [ ] Lane 4. Press Escape with the menu open. Save `f4-escape.png`. Pass when the menu closes.
- [ ] Lane 5. Navigate the menu with the gamepad stick. Save `f4-pad-nav.png`. Pass when focus moves item by item.
- [ ] Lane 6. Press gamepad A on a menu item. Save `f4-pad-select.png`. Pass when the item activates.
- [ ] Lane 7. Drag on the open map. Save `f4-map-drag.png`. Pass when the map pans and the car does not steer.
- [ ] Lane 8. Lose window focus while holding W. Save `f4-blur.png`. Pass when the car stops.
- [ ] Lane 9. Toggle the menu 20 times while driving. Save `f4-toggle.png`. Pass when no key stays stuck.
- [ ] Lane 10. Hold a key in a text field. Save `f4-repeat.png`. Pass when the field receives repeats at the system rate.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Input-to-handler delay for game input and for page input, p95.
- [ ] Probe. Run `lanes/f4/perf.json` at F3's head and at F4's head, interleaved, three runs each.
- [ ] Baseline. Record F3's delays first.
- [ ] Rule. F4 fails when game input p95 exceeds 1 frame or page input p95 exceeds 3 frames.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3, 5, and 7 screenshots into `C:\3jsc\review\f4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video that switches between driving, typing, and gamepad menus. Save it as `C:\3jsc\review\f4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review-bot triage done.
- [ ] Rebased onto F3's branch after the verdict, patch-id unchanged.
- [ ] The root appends F4 to the stack and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

The spikes live in `spikes/` at commit `896e785` of the engine repo. Each folder has its own `README.md`.

- `spikes/wgsl-naga` shows that naga 30 accepts 165 of 165 three.js shaders once `enable subgroups;` is removed. FXC fails 3, so Windows uses DXC.
- `spikes/folio-2025-wgsl` shows the same result for 233 shaders captured from folio-2025.
- `spikes/spike1` shows Servo frames reaching wgpu on DX12 with no CPU copy.
- `spikes/host` shows that V8 and Servo in one executable need a V8 pin and a linker override, so that layout can't ship.
- `spikes/xproc` shows Servo in its own process. The game pays about 0.03 ms per frame, a round trip takes 1 frame, and state reaches HUD pixels in about 4 frames at vsync.
- `spikes/folio-2025-assessment.md` lists folio's renderer needs, platform gaps, and UI coupling.
- `spikes/canvas2d` compares two canvas 2D pipelines on folio's canvases against Edge 157. Both shape with harfrust 0.12.0, the Rust port of HarfBuzz. vello_cpu 0.2.0 drawing glyphs through glifo 0.3.0, hinted, differs from Edge's software canvas by 0.44% mean over folio's twelve text canvases, and skrifa 0.44.0 outlines filled by tiny-skia 0.11.4 by 0.52%. Both need Skia's glyph mask gamma (2.3) for that, and differ by 0.80% and 0.83% without it. E6 keeps vello_cpu with glifo.
- A Modal probe on a T4, run twice, found that the NVIDIA Vulkan driver fails at `vkCreateInstance`. The only working Vulkan device there is Mesa llvmpipe, so Modal lanes check correctness and never GPU parity or perf.

- The Azure for Students subscription allows 5 regions (Canada Central, Sweden Central, Norway East, Spain Central, Denmark East) and 6 vCPUs per region. Checked on 2026-11-09 with `az vm list-usage`. The only GPU families with quota are retired sizes and NVSv4 at 2 vCPUs, so no GPU VM can start until a quota request is approved. The smallest usable sizes are `Standard_NV6ads_A10_v5` at $0.821 per hour on Windows in Canada Central and `Standard_NG8ads_V620_v1` at $1.194 per hour on Windows in Sweden Central.
- Microsoft declined a request for 8 NGads V620 vCPUs in Sweden Central and a request for 6 NVads A10 v5 vCPUs in Canada Central on 2026-11-09. The Quotas page offered no way to raise the regional vCPU limit. Azure GPU lanes are unavailable, so every GPU lane runs on the operator's PC.

These questions stay unproven:

- Whether an Azure NGads V620 VM can cover the AMD path that `spikes/xproc` never tested.
- Servo on AMD and Intel GPUs, on two-GPU laptops, and at other DPI scales.
- Pointer forwarding into a Servo page. E2 lanes 5 and 6 settle it.
- The GPU import path on Linux and macOS.
- Whether the WGSL gate can run in CI on a runner with no GPU.

## Appendix B. Alternatives rejected

- Electron and NW.js ship a whole browser, so they keep the browser's GPU overhead.
- A WebGL polyfill keeps a JS-to-native call per GL call. The engine-level `Backend` cut makes far fewer calls.
- Servo in the game process needs a V8 pin and `/FORCE:MULTIPLE` for duplicate symbols, per `spikes/host`.
- SpiderMonkey for game JS loses deno_core modules, fast ops, snapshots, and the debugger.
- Blitz draws in-process on wgpu, but it is beta and has no JS bindings. The operator chose Servo.
- threepp and threers are ports of three.js, so existing games would not run on them unchanged.
- A three.js fork would turn every monthly release into a merge. A pinned version with a patch keeps upgrades deliberate.
- Vulkan on Windows is not used, because the Servo import path on Windows targets DX12.

## Appendix C. Risks

- The operator's RTX 3060 is the only GPU the program can count on. Every GPU live lane runs there, one after another, so a full swarm takes longer than ten parallel lanes would. Modal adds parallel lanes on llvmpipe but no GPU lanes. Azure GPU VMs stay optional until the quota check passes. Owners watch the wall-clock time in every verdict.
- No control skill drives a native window. The host's `--script` mode from E1 replaces `control-ui`. A bug in the script mode can hide a real bug, so E1's lanes test the script mode itself.
- The pstack skills live on disk at `C:\Users\mason\.agents\skills`, not on trunk. The tick re-reads them from disk and reads the plan with `git show origin/main:docs/plan.md`.
- Builds use `CARGO_TARGET_DIR=C:\3jsc\target` and worktrees under `C:\3jsc\worktrees`, on the NVMe drive. `C:` has about 47 GB free, and a full Servo build uses about 10 GB. Owners stop and report when `C:` drops under 15 GB.
- No review bot runs on these repos yet. Each Merge block records the triage as none configured until one is added.
- The review videos need `ffmpeg`, which is not installed yet.
- Folio's physics steps by frame time with a 1/30 s cap. F1 keeps vsync on, which matches the browser on the same display. Uncapped native frame rates could change how the car drives.
- three.js internals such as `RenderObject` and `Backend` change between releases. The pin holds them still. Every upgrade reruns the E3 and E4 parity sets.
- Servo makes breaking changes in its monthly releases. E2 pins 0.7.0, and each upgrade is its own PR.
- 85 folio sound effects and the Pally font ship without a license. They stay in the private port and never ship.
- Audio is off in v1, so the native build is silent until audio lands.

## Appendix D. Links and reading list

- `spikes/README.md`, `spikes/xproc/README.md`, `spikes/xproc/results.md`, and `spikes/folio-2025-assessment.md` before any E or F PR.
- E3 runs `C:\Users\mason\.agents\skills\how\SKILL.md` on the command-buffer format before it writes code, and `interrogate\SKILL.md` on the result before code-ready.
- E2 runs `how` on the bridge protocol. F4 runs `interrogate` on the input routing rules.
- The decision trail follows `C:\Users\mason\.agents\skills\show-me-your-work\SKILL.md` and stays local in `C:\3jsc\trail\decisions.tsv`.

## Appendix E. Later work

These items are out of v1 and get their own plan.

- Audio through a Web Audio implementation for Howler.
- Linux and Steam Deck with the DMA-BUF import path. Modal runs the Linux builds and CPU lanes. GPU lanes run on the operator's Steam Deck and Bazzite laptop.
- Native-retained rendering that promotes stable objects out of the per-frame JS path.
- Steamworks for achievements and cloud saves.
- Compressed textures and models through worker support.
