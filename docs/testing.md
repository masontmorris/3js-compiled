# Scripted host tests

The host reads a JSON array with `--script <path>`. It processes steps in order before a frame. `wait` renders the given number of frames before the next step. `capture` saves the next rendered frame and then continues with the following step. `close` exits with code 0.

```json
[
  {"type":"wait","frames":2},
  {"type":"key","code":"KeyW","down":true},
  {"type":"capture","path":"out/key.png"},
  {"type":"key","code":"KeyW","down":false},
  {"type":"pointer","action":"move","x":100,"y":100},
  {"type":"pointer","action":"down","x":100,"y":100,"button":0},
  {"type":"pointer","action":"up","x":100,"y":100,"button":0},
  {"type":"wheel","x":0,"y":1},
  {"type":"gamepad","index":0,"button":0,"down":true},
  {"type":"resize","width":1280,"height":720},
  {"type":"capture","path":"out/input.png"},
  {"type":"close"}
]
```

The host sends key, pointer, wheel, and gamepad events to `addEventListener` on the global object. Real and scripted key events use DOM `code` values and the same event fields. Printable `key` values use a US keyboard layout; real keys account for Shift and Caps Lock. Scripted keys use the unmodified values. Real wheel deltas use DOM directions, with positive X to the right and positive Y down. Gamepad button 0 is A. `navigator.getGamepads()` exposes the injected button state. `setClearColor(r, g, b, a)` sets the next frame's color with normalized values. `requestAnimationFrame`, `cancelAnimationFrame`, `performance.now()`, and `console` are available to entry modules. A frame callback error is logged and does not stop later callbacks.

`--record <directory>` saves every rendered frame as a PNG, starting at `000000.png`. The directory must be empty. `--vsync on` is the default. Use `--vsync off` or its alias `--novsync` for uncapped runs. The host writes `host.log` and `frames.csv` in the working directory. The CSV contains the zero-based frame number, CPU-side frame duration in milliseconds, and frame-start interval in milliseconds. CPU-side duration uses a monotonic clock from the start of the frame through submission and any capture, before presentation. It excludes the wait to acquire a surface frame. It includes scheduling delays and waits during the remaining operations.

## GPU lease

On the shared Windows machine, wrap every host run with the GPU lease. Do not hold a lease while waiting for review.

```powershell
python C:\Users\mason\.gpu\gpu_lease.py run --holder 3jsc-e1 --purpose "scripted host test" -- C:\3jsc\target\debug\host.exe --entry examples/input.js --script path/to/steps.json
```
