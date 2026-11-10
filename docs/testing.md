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

The host sends key, wheel, and gamepad events to `addEventListener` on the global object. Pointer events inside a UI interactive rectangle of the HUD frame on screen go to the page; other pointer events go to the game. Real and scripted key events use DOM `code` values and the same event fields. Printable `key` values use a US keyboard layout; real keys account for Shift and Caps Lock. Scripted keys use the unmodified values. Real wheel deltas use DOM directions, with positive X to the right and positive Y down. Gamepad button 0 is A. `navigator.getGamepads()` exposes the injected button state. `setClearColor(r, g, b, a)` sets the next frame's color with normalized values. `requestAnimationFrame`, `cancelAnimationFrame`, `performance.now()`, and `console` are available to entry modules. A frame callback error is logged and does not stop later callbacks. After each frame callback batch and event dispatch, the host runs promise jobs and polls ready asynchronous operations without waiting for pending operations.

`--record <directory>` saves every rendered frame as a PNG, starting at `000000.png`. The directory must be empty. `--vsync on` is the default. Use `--vsync off` or its alias `--novsync` for uncapped runs. The host writes `host.log` and `frames.csv` in the working directory. When a page is open, it also writes `ui-host.log`. A relaunched ui-host appends to it after a `[host] ui-host launch` line that names the previous failure. Use `--no-ui` to run the game without starting the UI process. The CSV contains the zero-based frame number, CPU-side frame duration in milliseconds, and frame-start interval in milliseconds. CPU-side duration uses a monotonic clock from the start of the frame through submission and any capture, before presentation. It excludes the wait to acquire a surface frame. It includes scheduling delays and waits during the remaining operations.

## UI checks

Run these from the repository root with a release build. Each tool starts its own host and finds that host's ui-host by parent process ID, so runs from other folders on the same PC are not affected. Wrap each command that starts a host in the GPU lease.

| Tool | What it checks |
| --- | --- |
| `tools/run-ui-preempt.ps1 -HostExe <host.exe> -Out <dir> [-Script <steps>]` | Runs `examples/hud` uncapped while `tools/ui-repro/preempt.py <host PID>` suspends that host's ui-host for 8 ms of every 20 ms, then runs `tools/check-ui-resize-captures.py` on the captures. The default steps, `tools/ui-repro/resize-aba.json`, resize away and back 25 times and capture the HUD twice after each. |
| `python tools/check-ui-resize-captures.py <dir>` | Every `*.png` in the folder shows the HUD (red at 60, 50). |
| `python tools/check-ui-storm.py <record dir> [share]` | For a `--record` run of `tools/ui-repro/resize-storm.json`: once the HUD appears, it is on at least `share` of the frames (default 0.95) and no frame shows a stretched HUD. |
| `python tools/check-ui-kept-hit.py tools/ui-repro/out <console log>` | For `host --entry tools/ui-repro/kept-hit.js --script tools/ui-repro/kept-hit.json` with its console output saved: each of the 24 clicks right after a resize reaches the page when the capture before it shows the button at the click point, and reaches the game otherwise. |
| `tools/soak-ui.ps1 -HostExe <host.exe> -Out <dir> [-Seconds 600] [-ResizeEvery 2]` | Runs a soak at vsync and samples handles, private bytes, dedicated GPU memory and the window size of the host and its ui-host every 10 seconds. `-ResizeEvery` resizes between 1920x1080 and 1280x720 at that period. |
| `python tools/check-ui-soak.py <dir> [Hz]` | For a `soak-ui.ps1` folder: one ui-host for the whole run, frames at vsync, and private bytes, handles and dedicated GPU memory of both processes grow less than 5 percent. It measures from the first sample after the HUD appears, or after the 10th resize, to the last sample at the same window size. Skipped ring slots stay under 1 percent, or at 0 when the soak resizes. |
| `tools/check-ui-startup-runs.ps1 -HostExe <host.exe> -Out <dir> -Hz <refresh>` | Interleaves 30 UI and 30 `--no-ui` runs of 300 frames and applies plan lane 8's pooled rule with `tools/check-ui-startup.py`. |
| `python tools/check-ui-startup.py <run dir> <Hz> [--no-ui]` | Counts intervals over twice the refresh interval in the first second and, for UI runs, from the HUD's first frame through 30 frames after it. A UI run fails when such an interval falls on the HUD's first frame or the next one. |

## GPU lease

On the shared Windows machine, wrap every host run with the GPU lease. Do not hold a lease while waiting for review.

```powershell
python C:\Users\mason\.gpu\gpu_lease.py run --holder 3jsc-e1 --purpose "scripted host test" -- C:\3jsc\target\debug\host.exe --entry examples/input.js --script path/to/steps.json
```
