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

Run `host --entry examples/hud/game.js` from the repository root. Use `--no-ui` to run the game without starting Servo. The game calls `bridge.open(path)` during module load to select its page. `bridge.send(patch)` merges a state patch, and `bridge.onEvent(fn)` subscribes to page events. The page implements `window.__bridge.tick(patch)` and returns a JSON string with `events` and `rects`. Each rectangle is `[x, y, width, height]` in window pixels.
