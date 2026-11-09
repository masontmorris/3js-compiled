# Porting assessment: brunosimon/folio-2025

Target stack: three.js `WebGPURenderer` in V8 (deno_core/deno_runtime) with a
`NativeBackend` on wgpu DX12; Servo UI in its own process over a JSON
state/event bridge; SDL3 for window, input and audio; Rapier etc. as wasm in V8.

Checkout: `spikes/folio-2025` (shallow clone of `main`, 2026-11-09). File
references below are relative to `spikes/folio-2025/sources/` unless noted.

## Build status

| Step | Result |
|---|---|
| `npm install --force` | OK, 14 s, 396 packages. npm blocked `sharp`'s install scripts (only used by `scripts/compress.js`, not runtime). |
| `npm run build` (Vite 8 / rolldown) | OK, 4 s. Warnings: Pally font URLs left for runtime; direct `eval` in `vm-browserify` (pulled in by `vite-plugin-node-polyfills`). |
| Output | `dist/` 210 MB: main bundle `index-*.js` 3.8 MB (957 kB gzip), Rapier wasm 1.6 MB, Draco and Basis decoders. |

Code base: 29.7 k lines of JS, 2.5 k lines of Stylus, a 59 kB `index.html`
(543 elements, 63 `js-*` hooks, 21 modals/menu sections).

## 1. three.js usage

**Renderer** (`Game/Rendering.js:40-68`): `new THREE.WebGPURenderer({ powerPreference: 'high-performance', forceWebGL: false, antialias: pixelRatio < 2 })`,
pixel ratio capped at 2 (`Game/Viewport.js:23-25`), `sortObjects = false` plus
custom `setOpaqueSort`/`setTransparentSort` comparators that sort by
`renderOrder` only (`:48-60`), `shadowMap.enabled = true` with the default
shadow type (`:51`), and `setAnimationLoop` drives the game ticker (`:68`).
No tone mapping or output colour-space changes. Backend checks:
`backend.isWebGPUBackend` gates a pre-render warm-up (`Game/Game.js:203`) and
`isWebGLBackend` shows a "WebGL" warning in Options (`Game/Options.js:66`), so
`NativeBackend` must report itself as the WebGPU backend.

**Post-processing** (`Game/Rendering.js:74-104`): `THREE.RenderPipeline` with
`pass(scene, camera)` → `getTextureNode('output')`, `bloom()` (5 mips on high
quality, 2 on low), and a custom `cheapDOF` node on high quality only. The quality
toggle swaps `outputNode` and sets `needsUpdate`, so both chains must compile.
`cheapDOF` (`Game/Passes/cheapDOF.js:5-57`) is a `Node` subclass wrapping
`hashBlur` over `convertToTexture(renderOutput(scenePass))`. `mrt`, `emissive` and
`output` are imported but unused.

**Custom materials:**
- `MeshDefaultMaterial` (`Game/Materials/MeshDefaultMaterial.js`), used in 37 places. It extends `MeshLambertNodeMaterial` and replaces `outputNode` entirely (`:67-134`):
  - Lighting is computed by hand from game-owned uniforms (`lighting.directionUniform`, `colorUniform`, `intensityUniform`, `shadowColor`).
  - Light bounce samples the terrain texture (`terrain.terrainNode`).
  - Water line, custom fog and a "reveal" discard.
  - A `receivedShadowNode` shadow catcher (`:57-62`) is the only use of three's shadow map.

  These shared `uniform()` nodes are set from JS every frame. That's friendly to a uniform arena, but every retained object depends on about 20 global uniforms (16 `this.game.*` references plus 5 `reveal` ones).
- `MeshGridMaterial` (`Game/Materials/MeshGridMaterial.js:82`), a `NodeMaterial` subclass with `outputNode = vec4(gridColor, 1)`.
- 67 more inline material constructions (mostly `MeshBasicNodeMaterial`, `MeshLambertNodeMaterial`, `SpriteNodeMaterial` and `PointsNodeMaterial`) with TSL `colorNode`/`positionNode`/`outputNode`.
- TSL features in use (union of imports): `Fn`, `If`, `Loop`, `uniform`, `uniformArray`, `attribute`, `varying`, `instancedArray`, `instanceIndex`, `instancedBufferAttribute`, `storage`, `texture`, `screenUV`, `viewportCoordinate`, `viewportSharedTexture`, `viewportLinearDepth`, `linearDepth`, `billboarding`, `matcapUV`, `rangeFogFactor`, `hash`, `rotateUV`, `blendOverlay`, `frontFacing`, `vertexIndex`, `convertToTexture`, `hashBlur`/`boxBlur`, and the usual math.

**Render targets and nested renders:**
- `Game/Noises.js:179-289`: three one-shot procedural noise RTs, each a `renderer.render` into an RT.
- `Game/Tracks.js:25,85-87`: tyre tracks rendered into an RT every tick, before the main pipeline. A nested `renderer.render(scene2, camera2)` runs each frame.
- `Game/World/Snow.js:127,465-467`: per-frame elevation RT while it's snowing.
- `Game/PreRenderer.js:12-29`: a `CubeRenderTarget(32)` plus `CubeCamera.update` over the whole scene with everything made visible. It's purely a pipeline/shader warm-up on high quality, and imports the internal `three/src/renderers/common/CubeRenderTarget.js`.

**Framebuffer read:** the water surface blurs `viewportSharedTexture(screenUV)` (`Game/World/WaterSurface.js:283`). That's a mid-frame copy of the colour buffer, which `NativeBackend` must implement as a copy-framebuffer-to-texture command.

**Compute and storage:**
- `Game/World/Leaves.js:166-168`: `computeAsync` init.
- `Game/World/Leaves.js:254,301`: per-frame `computeAsync(update)`.
- `Game/World/Whispers.js:60`: `storage(...).toAttribute()`.
- `instancedArray(...).toAttribute()` for particles in `AchievementsArea`, `AltarArea` and `CookieArea`.
- The two Leaves compute modules are the only ones that hit the `subgroups` issue.

**Instancing:** `Game/InstancedGroup.js:43` builds `InstancedMesh` for benches, bricks, fences, lanterns, trees, bushes and flowers from glTF "references", toggling `needsUpdate` on reset (`Game/Game.js:239-266`). Particle and instance meshes set `mesh.count` explicitly when they're created. There's no `BatchedMesh`, skinning, morph targets, animation mixer or clipping.

**Lights, shadows, fog, environment:**
- A single `DirectionalLight` with shadows (`Game/Ligthing.js:110-166`): orthographic shadow camera, `bias`/`normalBias`/`radius`, and `mapSize` 2048 or 512 by quality. There are no point lights; pole lights and lanterns are sprites and emissive meshes.
- Fog is custom: `scene.backgroundNode = fog.color` (`Game/Fog.js:18`), applied inside the materials.
- No PMREM, environment maps or HDRI.

**Lines and sprites:** `Line2NodeMaterial` (`Game/Tornado.js:99`) and `LineSegments` (`Game/Physics/PhysicsWireframe.js:17`) are debug previews only. Sprites are heavily used (`SpriteNodeMaterial` in 6 files, 9 call sites), plus one `PointsNodeMaterial` on a `Sprite` (`Game/World/Areas/BowlingArea.js:458-474`).

**Textures:**
- Per-frame `DataTexture` updates: `Tracks.js:123`, `Trails.js:78`, `BowlingArea.js:263`, `CareerArea.js:188`.
- Ten `THREE.Texture(canvas)` sources driven by Canvas 2D (section 2).
- KTX2 and Draco only when `VITE_COMPRESSED` is set (`Game/Game.js:97-100`, `Game/ResourcesLoader.js:25-47`). `KTX2Loader.detectSupport(renderer)` is always called once a glTF loads.

**Inspector and stats:** `three/addons/inspector` only with `#inspector` (`Game/Rendering.js:62-65`). `stats-gl` is only in `Monitoring`, which is commented out (`Game/Game.js:15,198`). Tweakpane is debug only (`#debug`).

**`threejs-override.js`:** replaces `Object3D.prototype.copy` with a version that drops the `userData` deep clone (`JSON.parse(JSON.stringify(userData))`, line 33 commented out). The game stores live references in `userData`, for example `preventPreRender` flags and physics links. Effects for us:
- `clone()` shares `userData` by reference.
- The promotion and sync layer must not rely on `userData` being copied or serializable.
- Any "copy scene to native" path (`toJSON`) would choke on it.
- The override must load before three's own modules use `copy`. It's imported first via `index.js`, so keep the same import order in the native entry.

**Shaders (measured, step 5):** 233 unique WGSL modules (111 vertex, 120 fragment, 2 compute) captured from the real build in headless Edge on the RTX 3060, with 0 Dawn errors.

| Check | Result |
|---|---|
| naga 30 | 231/233 as emitted; 233/233 after stripping `enable subgroups;` |
| SPIR-V generation | 233/233 |
| HLSL generation | 233/233 |
| DXC | 233/233 |
| FXC | 231/233; the 2 Leaves compute shaders use `WaveGetLaneCount` |

So spike 3's conclusion holds on real content: hide `subgroups` and ship `static-dxc`. Tooling is in `spikes/folio-2025-wgsl/`.

## 2. Browser and platform APIs → native coverage

| API | Where | Native answer |
|---|---|---|
| DOM queries and manipulation (96 `querySelector`, 104 `classList`, 43 `innerHTML`/`textContent`, 62 style writes, 16 `createElement`) | UI modules (section 3); also `Game/Game.js:73-75` (`.game`, `.js-canvas`, `is-started` class) | UI moves to Servo. Game side gets a headless DOM stand-in during migration (see order) |
| `getBoundingClientRect`, `devicePixelRatio`, `resize` | `Game/Viewport.js:17-31` | Polyfill from SDL3 window size and display scale |
| Keyboard `keydown`/`keyup` on window with `event.code`, `document.activeElement.matches('input, textarea, [contenteditable]')` guard | `Game/Inputs/Keyboard.js:21-32` | Synthesize from SDL3. `activeElement` comes from a "UI has text focus" flag sent over the bridge |
| Mouse, touch, `contextmenu` on canvas; `mouseup` on window | `Game/Inputs/Pointer.js:31-121` | Synthesize from SDL3 after UI hit-rect routing |
| `wheel` (via `normalize-wheel`) | `Game/Inputs/Wheel.js:10` | SDL3 wheel |
| `navigator.getGamepads()` polling, `mapping === 'standard'` plus Firefox PS5 id fallbacks, type detection for glyph classes | `Game/Inputs/Gamepad.js:28-95,207,245` | Gamepad polyfill over SDL3 with the standard mapping and SDL controller names as `id`; rumble later |
| Audio: Howler 2.2.4 with Web Audio (XHR load, `decodeAudioData` of 88 mp3, gain, `howl.pos` spatial panner, `howl.rate`, global mute), music pool 0 | `Game/Audio.js:75,172,657-704,755,759` | Not in deno_runtime (no Web Audio, no `XMLHttpRequest`). Either bind a Web Audio implementation (e.g. web-audio-api-rs) plus an XHR shim, or reimplement the small `Audio.register`/`groups` API on native audio (SDL3 plus a decoder) |
| `window` `blur`/`focus` (mute, key reset) | `Game/Audio.js:692-704`, `Game/Inputs/Keyboard.js:12` | SDL3 focus events |
| Canvas 2D: `fillText` (13), `font` (19, families `Amatic SC`, `Nunito`, Pally via CSS), `measureText`, `textAlign`/`Baseline`, `fillRect`, `createLinearGradient`, `strokeText`, `drawImage`, `clearRect` | `Game/TextCanvas.js:40`, `InteractivePoints.js:225`, `Materials.js:57`, `Terrain.js:43`, `World/Bubble.js:49`, `Areas/AltarArea.js:366`, `Areas/CircuitArea.js:171,806,999`, `Areas/CookieArea.js:318` | Native Canvas 2D subset with registered font files. Small API, but text metrics and appearance parity matter |
| Images: three `TextureLoader` → `ImageLoader` creates `<img>` (`node_modules/three/src/loaders/ImageLoader.js:88`); `GLTFLoader` uses `ImageBitmapLoader` plus `URL.createObjectURL(blob)` (`GLTFLoader.js:2707-2715,3445`); `new Image()` for country flags | `Game/World/Bubble.js:103`, `Areas/CircuitArea.js:938` (both server-fed) | Polyfill `HTMLImageElement` and `createImageBitmap` (PNG decode) plus `blob:` URLs. Confirm what deno_runtime provides before writing our own |
| `fetch` of relative asset URLs (three `FileLoader`) | everywhere via loaders | deno_runtime `fetch` with a base `location` (file or custom scheme) |
| Workers: Draco and KTX2 loaders spawn classic workers from `blob:` URLs (`DRACOLoader.js:430,444`; `KTX2Loader.js:342,347`) | compressed assets only | Deno supports module workers only. Ship uncompressed for v1; later a classic-worker shim or native decoders |
| WebAssembly (Rapier 0.19 via `vite-plugin-wasm`; Draco and Basis wasm) | `Game/Game.js:129` | V8 WebAssembly; verify the plugin's wasm fetch under file URLs |
| `WebSocket` and msgpack | `Game/Server.js:28,44` (only if `VITE_SERVER_URL`) | Leave disabled. The author's server isn't public |
| `localStorage` (achievements, sound toggle, country, distance driven, time played, uuid) | `Achievements.js:64-242`, `Audio.js:659-677`, `InputFlag.js:50-209`, `Player.js:333-664`, `Server.js:13-17` | deno_runtime `localStorage` (needs a stable origin/`--location`); Steam Cloud later |
| `requestAnimationFrame` (UI open/close transitions; gsap's ticker; three's animation loop) | `Menu.js:226-248`, `Modals.js:146-148`, `Notifications.js:112-114` | UI side: Servo has it. Game side: the host frame loop provides rAF and drives `setAnimationLoop` |
| `location.hash` flags (`#debug`, `#inspector`, `#stats`, `#skip`) | `Debug.js:11`, `Rendering.js:62,135`, `Reveal.js:48,100` | CLI args or env vars mapped onto a fake `location` |
| `window.open` for external links | `Areas/LabArea.js:737`, `Areas/ProjectsArea.js:1035`, `Areas/SocialArea.js:55`, `Areas/TimeMachineArea.js:27` | `SDL_OpenURL` (or the Steam overlay later) |
| `document.title` marquee driven by vehicle speed every tick | `Game/Title.js:88` | Drop, or throttle into the window title |
| `navigator.userAgent` mobile sniff | `Game/Quality.js:12` | Desktop UA string |
| `import.meta.env.*` | 7 files | Build-time Vite replacement; same for the native bundle |
| Date, Intl, `toLocaleString`, timers | various | V8 and deno_runtime built-ins |

## 3. UI coupling

**(a) Pure DOM UI. Moves to the Servo page and talks over the bridge with low-frequency events:**
- **`Menu.js` (284 lines) and `Modals.js` (204):** open/close and navigation.
  - They read input actions (`next`, `prev`, close) from the game's input system.
  - They play click sounds via `game.audio`.
  - They set `inputs.filters` (`menu`, `modal`).
  - Bridge: game → UI input actions; UI → game open/close state plus sound cues.
- **`Tabs.js` (105):** pure DOM.
- **`Options.js` (117):** buttons → commands (mute, quality, respawn, reset); displays quality level, renderer backend and server status as state.
- **`Notifications.js` (175):** toasts created by game events. The time bar can tick in Servo.
- **`InputFlag.js` (216):** country search and picker with a text input; the result is a command.
- **`Inputs/InteractiveButtons.js` (114):** touch buttons. The game decides which are visible (state) and clicks become actions. Low priority on desktop; relevant later for the Steam Deck touchscreen.
- **Circuit race menu, end modal and leaderboard** (DOM parts of `Areas/CircuitArea.js`, about 45 of 1,690 lines, `:1150-1614`): the game emits race results, and the UI sends restart/end commands plus the name entry. The leaderboard needs the server, so it's hidden.
- **`Map.js` (192):** a modal, but it ticks while open. It needs `player.position.x/z` and `physicalVehicle.yRotation` every frame (`:176-190`) and sends respawn-by-name commands (`:82`). It's a tiny state patch, not world-anchored.

**(b) Needs a model/view refactor:**
- **`Achievements.js` (630):** progress logic, persistence, rewards that change the vehicle, and DOM rendering of the list, progress bars and rewards, all in one class. It needs splitting into a game-side model and a UI view. That split is also the seam for Steam achievements.
- **`World/Whispers.js` (528):** 3D flames plus a menu with a text input. Everything is server data. Disable in v1.
- **Document-level classes:** `Inputs.js:27-37,60,322`, `Gamepad.js:207,311-312` and `Audio.js:660,672` toggle `documentElement` classes (`is-mode-*`, `is-gamepad-*`, `input-filter-*`, `is-audio-muted`). The CSS uses them to switch button glyphs and visibility, so they must be mirrored onto the Servo page's `<html>` through bridge state.

**(c) Not UI despite touching the DOM (stays in the game, needs native Canvas 2D and images):**
- Canvas text textures: `TextCanvas.js`, `InteractivePoints.js` labels, `Bubble.js`, the circuit timer digits and texts, the cookie counter and the altar text.
- One-shot gradient canvases: `Materials.js`, `Terrain.js`.
- `Overlay.js` is a full-screen three.js mesh with no DOM.
- `Title.js`, `Viewport.js` and the canvas element in `Rendering.js`.
- `Easter.js` and `BlackFriday/BlackFriday.js` are never instantiated (dead or seasonal code), so they can be skipped.

**World-anchored UI:** none in the DOM. Every world label (interactive points, speech bubbles, whisper flames, circuit timer) is already a three.js mesh or sprite with a canvas texture. The only 3D→screen projection (`World/VisualVehicle.js:542`) feeds a foliage see-through uniform (`World/Foliage.js:215`). Nothing has to move from the DOM into three.js.

**Summary:** about 1,500 lines of UI code (Menu, Modals, Tabs, Options, Notifications, InputFlag, InteractiveButtons, Map, circuit UI) move to Servo mostly as-is. Their `this.game.*` calls get replaced with bridge commands and state. About 630 lines (Achievements) need a real model/view split. Server-backed UI (Whispers, leaderboard) is disabled. The coupling is wide rather than deep: most modules touch `game.audio`, `game.inputs` and `game.menu`, which become a small, fixed bridge vocabulary.

## 4. Assets and build

- `dist/` is 210 MB because Vite copies all of `static/`:
  - 136 MB of WAV masters (`static/sounds/musics/*.wav`) that are never loaded; the playlist uses the `.mp3` files (`Game/Audio.js:152-160`).
  - Both compressed and uncompressed asset variants.
- The real runtime set (PNG or KTX textures, about 6 MB of glb, about 22 MB of mp3, the UI webp files, about 4 MB of wasm and JS) is roughly 70 MB.
- `resources/` (159 MB of `.blend`, `.psd`, `.pur`, `.exr`, `.wav`, `.mp4`) is source-only.
- Vite specifics:
  - `root: 'sources/'` with `publicDir: '../static/'` and `base: './'`.
  - `import.meta.env.VITE_*` flags.
  - `vite-plugin-wasm` for Rapier and `vite-plugin-node-polyfills`, for msgpack's Buffer.
  - No glob imports or `?url` imports.
  - `index.html` preloads `-compressed.glb` and `.ktx` assets even when `VITE_COMPRESSED` is off (wasted fetches).
- Google Fonts CDN (`Amatic SC`, `Nunito`) is linked from `index.html`, and the Canvas 2D text depends on those fonts having loaded. Native and offline builds must bundle them locally (OFL).

## Work items

| # | Subsystem | Item | Size | Risk |
|---|---|---|---|---|
| R1 | Renderer | `NativeBackend` reports `isWebGPUBackend`, hides `subgroups`, wgpu built with `static-dxc` | S | Low (measured) |
| R2 | Renderer | MSAA (antialias when pixel ratio < 2) | M | Med (untested so far) |
| R3 | Renderer | Render targets with nested `renderer.render` mid-frame (Tracks per tick, Snow, Noises) | M | Med |
| R4 | Renderer | `viewportSharedTexture` framebuffer copy (water) | M | Med |
| R5 | Renderer | Compute plus storage buffers as attributes (Leaves, Whispers, particle areas) | M | Med |
| R6 | Renderer | `RenderPipeline` bloom + cheapDOF parity, quality switch rebuild | M | Med |
| R7 | Renderer | Retained path: honour the `renderOrder`-only custom sorts, ~20 shared per-frame uniforms, per-frame DataTexture/CanvasTexture uploads, explicit instance counts | M | Med |
| R8 | Renderer | CubeCamera warm-up (`PreRenderer`): support it, or replace with `compileAsync` plus a pipeline cache | S | Low |
| P1 | Platform | Native Vite target: game entry without UI markup, same `import.meta.env`, override import order kept | S | Low |
| P2 | Platform | Headless DOM stand-in in the game isolate (e.g. linkedom loaded with `index.html`) so unported UI modules boot; real `.game` rect from SDL3 | M | Med |
| P3 | Platform | Keyboard, mouse, touch and wheel events from SDL3; text-focus flag from the bridge | M | Med |
| P4 | Platform | Gamepad API polyfill over SDL3 (standard mapping, ids for glyph type) | M | Low |
| P5 | Platform | Canvas 2D subset plus font registration (Pally, Amatic SC, Nunito) | M–L | Med–High (text parity) |
| P6 | Platform | `HTMLImageElement`, `createImageBitmap` and `blob:` URLs for TextureLoader and GLTFLoader | M | Med |
| P7 | Platform | `fetch` base URL, `localStorage` origin, location-hash flags → CLI, `window.open` → `SDL_OpenURL`, focus/blur, `navigator.userAgent`, `document.title` | S | Low |
| P8 | Platform | Audio: Web Audio plus XHR for Howler, or a native backend behind `Audio.js` | L | High |
| P9 | Platform | Compressed assets: classic blob workers for Draco/KTX2, or native decoders | M | Med (post-v1) |
| U1 | UI | Servo UI page: `index.html` and Stylus CSS minus the canvas, transparent background, local fonts | S–M | Low |
| U2 | UI | Bridge vocabulary: state (input mode/gamepad/filter classes, mute, quality, backend, map pose, achievements, notifications, race result) and commands (menu/modal state, options actions, respawn/reset, map respawn, reward select, sound cues) | M | Med |
| U3 | UI | Move Menu, Modals, Tabs, Options, Notifications, InputFlag, Map and circuit UI into the page | M–L | Med |
| U4 | UI | Achievements model/view split | M | Med |
| U5 | UI | Input routing: game input system stays authoritative for keyboard and gamepad (menu navigation via actions); mouse by UI hit-rects; keyboard to Servo while a text field is focused | M | High |
| U6 | UI | Disable server UI (Whispers, leaderboard, Easter), debug UI (Tweakpane, Inspector, stats) and touch buttons on desktop | S | Low |
| A1 | Assets | Package only runtime assets (~70 MB): drop WAV masters and duplicate variants | S | Low |
| A2 | Assets | Bundle Google Fonts locally; remove compressed preloads when uncompressed | S | Low |

## v1 subset (Windows, NativeBackend, Servo HUD/menus, post-processing)

**In:** R1–R7, R8 (either option), P1–P7, U1–U6, A1–A2.

**Out:**
- **P9:** ship uncompressed PNG and glb.
- **P8:** audio. I'd recommend v1 runs with a no-op `Howl` stub and audio becomes v1.1, because it's the single largest platform shim and isn't in the agreed v1 list.
- Server features, Steam Deck/touch, Steam achievements.

## Recommended order

1. **P1 + P2 + P7 + R1:** boot the unmodified game in the native host on the immediate path (Cut B) with the headless DOM stand-in. The UI is invisible but nothing crashes, and you get the first native frame.
2. **P5 + P6:** Canvas 2D, images and fonts. These are needed before world labels, terrain gradient and materials look right.
3. **P3 + P4:** keyboard, mouse and gamepad. The game is now playable without UI.
4. **R2–R6:** water, tracks, snow, leaves and post-processing parity, checked with screenshot diffs against browser three.js at fixed seeds and times (`VITE_DAY_CYCLE_PROGRESS` and `VITE_YEAR_CYCLE_PROGRESS` pin the cycles).
5. **U1 + U2 + U5,** then **U3** module by module (Options → Menu/Modals/Tabs → Notifications → Map → circuit UI), then **U4 + U6**. Each move deletes that module's DOM from the stand-in.
6. **R7:** retained-path promotion, once the immediate path is correct.
7. **A1 + A2** packaging. Audio (P8) and compression (P9) after v1.

## Biggest risks

1. **Audio:** Howler needs XHR and Web Audio, including spatial panning, and deno_runtime has neither.
2. **Canvas 2D text parity:** fonts, metrics and baseline for the many world labels.
3. **Input arbitration between the game's input system and Servo:** gamepad menu navigation runs through game actions, text fields need keyboard capture, and click-through needs UI hit-rects.
4. **UI modules are built eagerly and cross-reference each other and `game`:** Achievements, Whispers and Circuit all use `game.menu`. The headless DOM stand-in de-risks migration but hides breakage until each module moves.
5. **Variable physics timestep:** `world.timestep = ticker.deltaScaled`, clamped at 1/30 (`Physics/Physics.js:243`, `Ticker.js:14,32`). At uncapped native frame rates the vehicle may feel different from 60 Hz browsers. Consider capping, or a fixed step.
6. **Retained-path assumptions:** custom sort comparators, nested renders and mid-frame framebuffer copies.

## Licensing caveats

- **Code:** MIT (`license.md`). `package.json` says "ISC" but the license file governs.
- **Music:** CC0 (`static/sounds/musics/license.md`).
- **Sound effects:** the other 85 mp3 in `static/sounds/*` have no license or credit. Provenance is unknown, so treat them as dev-only until confirmed.
- **Pally font:** the files in `static/fonts/` (Indian Type Foundry / Fontshare family) ship without a license file. Check the ITF Free Font License terms before redistributing them in a binary.
- **Amatic SC and Nunito:** loaded from Google Fonts (OFL), fine to bundle.
- **Draco and Basis decoders:** Apache-2.0 (`static/draco/README.md`, `static/basis/README.md`).
- **Content is Bruno Simon's portfolio:** his name, projects, client and company logos in `static/career`, `static/projects`, `static/social`. Whether MIT covers those images is ambiguous, and they carry trademark and likeness concerns. That's consistent with treating the port as an internal proving ground, not something to publish.
