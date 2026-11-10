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

Pointer input goes by the HUD frame on screen. The host hit-tests each pointer event against the rectangles the page listed at the size of the shown frame. For a few frames after a resize, the host still shows the last frame at the old size while Servo lays the page out at the new size. During a continuous resize, ui-host applies the newest size only once the page has been laid out at the previous one and that frame is published, so the HUD shows a recent size at least every 250 ms. A pointer event on a rectangle drawn in that frame goes to the page. A pointer event where the shown frame draws no rectangle goes to the game at once. A press, from a button down to the last button up, goes entirely to the side its down went to, as with a browser's implicit pointer capture. The game never receives part of a press on a drawn HUD element, and the page never receives part of a press that began on the game. The host sends each page event to ui-host with the rectangle it was made over: the rectangle's index and the event's offset from its corner in the frame on screen. During a page press, an event over no rectangle goes with its offset from the corner where the frame then on screen drew the rectangle that the press's down was over. ui-host places each event when it gives it to Servo. An event the host hit-tested in a frame laid out at the size Servo lays the page out at keeps its window point, as in a browser. An event hit-tested in a frame at another size is placed on the rectangles of the page's latest reply at Servo's size. The event goes to the same offset from the rectangle at the same index, or to that rectangle's centre when it has shrunk past an event made over it. An event for an index the latest layout lacks keeps its window point. Every point is clamped into the page's viewport, because Servo drops input outside it. While a resize waits for the page's layout at the new size, ui-host holds page input in order. It applies no resize while Servo has page input it has not yet handled, so Servo hit-tests each event in the layout it was placed in. A reply that leaves out `rects` keeps the rectangles the page listed last. If the page reports no layout at the new size within 200 ms, ui-host places the held input on the rectangles the page listed last and counts it in its `pointer events placed without the page's layout at its size` log line.

A game therefore gets, at once and at its window point, every pointer event that is not the page's. A page gets every event of a press that began on a drawn element. An event over a drawn element reaches that element, at the same point of it in the page's current layout, even while the frame on screen is laid out at an older size. ui-host's vendored `servo-script` fires `click` as Chrome and Firefox do, on the nearest common ancestor of the elements the press's down and up were over, however far apart the two points are (`crates/ui-host/vendor/README.md`). A press whose down and up are both on one element clicks that element, even when a resize moved the element between them. A press released over another element clicks the common ancestor of the two, such as `body`, and one released over no element clicks `html`. Page input made during a resize reaches the page once it has laid out at the new size, a few frames later than usual.

A page may add, remove and reorder its `rects` between replies while the window keeps its size, because ui-host then keeps each event's window point. Across a resize, the index names the element: an event made over the frame at the old size goes to the rectangle at the same index at the new size. So a page keeps the order of its `rects` the same at every size.

The game receives at most 256 page events per frame, in one call. When more than 4,096 events wait, the host drops the newest and listeners receive `{ type: "bridge:dropped", count }`. The host writes each rejected reply or reply item to `host.log`.
