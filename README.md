# 3js-compiled

3js-compiled builds three.js games into native desktop programs. The same game code still builds for the web.

## How it works

The game's JavaScript runs in V8 inside a Rust host program. three.js keeps its `WebGPURenderer`, and a native backend sends the renderer's GPU work to wgpu on DirectX 12. HTML menus and HUDs render in Servo, which runs in its own process. Servo shares each frame with the game through a GPU texture, and the game and the Servo page exchange state over named pipes.

## Status

Nothing runs yet. Windows comes first. Linux and Steam Deck come after.

The `spikes` folder holds the experiments that chose this design, with their code and measurements. Start with `spikes/README.md`.

## License

You can use this project under either of these licenses, at your option:

- Apache License, Version 2.0 (`LICENSE-APACHE`)
- MIT license (`LICENSE-MIT`)

The spike crates in `spikes/host` and `spikes/xproc` contain code adapted from [wgpu-graft](https://github.com/mark-ik/wgpu-graft). Those crates are under the Mozilla Public License 2.0, as their `Cargo.toml` files state.

Unless you explicitly state otherwise, any contribution you intentionally submit for inclusion in this project, as defined in the Apache-2.0 license, is dual licensed as above, without any additional terms or conditions.

The ported bridge protocol in `crates/ipc`, the Servo process in `crates/ui-host`, and `crates/ui` contain code adapted from that spike and are under MPL-2.0. The vendored adapter in `crates/ui-host/grafting-servo` retains its MPL-2.0 headers. The patched copies of three Servo crates in `crates/ui-host/vendor` (`servo-script`, `servo-fonts` and `servo-layout`) are under MPL-2.0, as published by Servo.
