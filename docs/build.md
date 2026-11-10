# Build the Windows host

Install Rust 1.99.1, MSVC Build Tools with the Windows SDK and the C++ ATL component, CMake, LLVM, and NASM. Static DXC links against ATL. The SDL3 bindings build and link SDL3 from source. The build does not need an SDL installation.

Load `vcvars64.bat` into the shell environment. Add the Cargo, LLVM `bin`, and NASM directories to `PATH`. Set `LIBCLANG_PATH` to LLVM's `bin` directory. Set `CARGO_TARGET_DIR` to `C:\3jsc\target` and clear `CARGO_BUILD_BUILD_DIR`. Set `CARGO_PROFILE_DEV_DEBUG=0` and `CARGO_PROFILE_RELEASE_DEBUG=0` to reduce build size.

```powershell
cargo build -p threejsc-host
```

Run `host --entry examples/clear.js` to open a window that changes color on each animation frame. Close the window to exit. On the shared Windows machine, use the GPU lease in [testing](testing.md).

The host and Servo use separate Cargo workspaces because their JavaScript engines require incompatible ICU versions. Build both before running a HUD example:

```powershell
cargo build --release --locked -p threejsc-host
cargo build --release --locked --manifest-path crates/ui-host/Cargo.toml
```

Copy ANGLE's DLLs next to `ui-host.exe`:

```powershell
$angle = Get-ChildItem "$env:CARGO_TARGET_DIR/release/build/mozangle-*/out/libEGL.dll" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item "$($angle.DirectoryName)/libEGL.dll", "$($angle.DirectoryName)/libGLESv2.dll" "$env:CARGO_TARGET_DIR/release/"
```

Run `host --entry examples/hud/game.js` from the repository root. Use `--no-ui` to run the game without starting Servo. The game calls `bridge.open(path)` during module load to select its page. `bridge.send(patch)` merges a patch into the UI state and sends the whole state. It throws a `RangeError` and keeps the previous state when the state's JSON exceeds 1,048,555 bytes. `bridge.onEvent(fn)` subscribes to page events.

The page implements `window.__bridge.tick(state)` and returns a JSON string with `events` and `rects`. Each rectangle is `[x, y, width, height]` in window pixels. ui-host calls `tick` at most once per Servo frame, always with the newest state. It also calls `tick` with the current state after pointer input and after 100 ms without a call, so page events reach the game when the game sends no new state. It makes no call before the game's first `bridge.send`.

Pointer input goes by the HUD frame on screen. The host hit-tests each pointer event against the rectangles the page listed at the size of the shown frame. For a few frames after a resize, the host still shows the last frame at the old size while Servo lays the page out at the new size. A pointer event on a rectangle drawn in that frame goes to the page. A pointer event where the shown frame draws no rectangle goes to the game at once. A press, from a button down to the last button up, goes entirely to the side its down went to, as with a browser's implicit pointer capture. The game never receives part of a press on a drawn HUD element, and the page never receives part of a press that began on the game. The host holds page input until the page has replied at the new size, then places it at the same offset from the corner of the rectangle at the same index, or at that rectangle's centre when it has shrunk past the offset. Input on an index the new layout lacks keeps its window point. The rest of a press moves by as much as its down did, so a press held still across the frame switch stays on the element it began on. A reply that leaves out `rects` keeps the rectangles the page listed last, at the reply's size too. If the page has not replied at the new size 250 ms after the first held event, the host sends the held input to the page anyway, placed on the rectangles the page listed last. A click on a drawn element therefore always reaches the page and never the game, and the page events of a held click reach the game a few frames later than usual. Keep the order of `rects` stable, because the index names the element at every size.

The game receives at most 256 page events per frame, in one call. When more than 4,096 events wait, the host drops the newest and listeners receive `{ type: "bridge:dropped", count }`. The host writes each rejected reply or reply item to `host.log`.
