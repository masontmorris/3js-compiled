//! These tests run the release host on the hardware GPU and open a window, so run them under the GPU lease:
//! `cargo test -p threejsc-host --release --test gpu -- --ignored --test-threads 1`.

use std::{
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus},
    time::{Duration, Instant},
};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

struct Run {
    log: String,
    capture: image::RgbaImage,
}

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("threejsc-gpu-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Runs the host in `dir` and fails the test if it does not exit within a minute.
fn host(
    dir: &Path,
    entry: &Path,
    steps: &serde_json::Value,
    args: &[&str],
) -> (ExitStatus, String) {
    std::fs::write(dir.join("steps.json"), steps.to_string()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_host"))
        .current_dir(dir)
        .arg("--entry")
        .arg(entry)
        .args(["--script", "steps.json"])
        .args(args)
        .spawn()
        .unwrap();
    let status = wait(&mut child, Duration::from_secs(60));
    (
        status,
        std::fs::read_to_string(dir.join("host.log")).unwrap_or_default(),
    )
}

fn wait(child: &mut Child, timeout: Duration) -> ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("host did not exit within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn run(name: &str, entry: &Path, steps: serde_json::Value) -> Run {
    let dir = workdir(name);
    let mut steps = steps.as_array().unwrap().clone();
    let capture = dir.join("capture.png");
    steps.push(serde_json::json!({"type": "capture", "path": capture}));
    steps.push(serde_json::json!({"type": "close"}));
    let (status, log) = host(&dir, entry, &steps.into(), &[]);
    assert!(status.success(), "{name}: host exited with {status}\n{log}");
    Run {
        log,
        capture: image::open(&capture).unwrap().to_rgba8(),
    }
}

fn assert_near(run: &Run, (x, y): (u32, u32), expected: [u8; 3]) {
    let pixel = run.capture.get_pixel(x, y).0;
    assert!(
        (0..3).all(|c| pixel[c].abs_diff(expected[c]) <= 3),
        "pixel ({x}, {y}) is {pixel:?}, expected {expected:?}\n{}",
        run.log
    );
}

fn test_entry(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join(name)
}

/// Bundles the three.js test entry `name` from crates/host/tests.
fn bundle(name: &str) -> PathBuf {
    let bundle = std::env::temp_dir().join(format!("threejsc-{name}-{}.js", std::process::id()));
    let built = Command::new("node")
        .current_dir(ROOT)
        .env("ENTRY", format!("crates/host/tests/{name}.js"))
        .env("OUT", &bundle)
        .args(["-e", "import('esbuild').then(({ build }) => build({ entryPoints: [process.env.ENTRY], outfile: process.env.OUT, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' }))"])
        .status()
        .unwrap();
    assert!(built.success(), "{name} bundle build failed");
    bundle
}

fn red(path: &Path) -> (u8, (u32, u32)) {
    let image = image::open(path).unwrap().to_rgba8();
    (image.get_pixel(4, 4).0[0], image.dimensions())
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn readbacks_and_errors_cross_the_response_channel() {
    let run = run(
        "responses",
        &test_entry("gpu.js"),
        serde_json::json!([{"type": "wait", "frames": 3}]),
    );
    assert!(
        run.log
            .contains("GPU error: frame 7, command 0, label bad-material, request none"),
        "{}",
        run.log
    );
    println!("{}", run.log);
    assert_near(&run, (640, 360), [0, 255, 0]);
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_stream_cannot_destroy_the_surface() {
    let run = run(
        "destroy-surface",
        &test_entry("destroy-surface.js"),
        serde_json::json!([{"type": "wait", "frames": 3}]),
    );
    assert_near(&run, (640, 360), [0, 255, 0]);
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn the_first_frame_after_a_resize_draws_the_scene() {
    let run = run(
        "resize",
        &bundle("resize"),
        serde_json::json!([
            {"type": "wait", "frames": 3},
            {"type": "resize", "width": 800, "height": 600},
        ]),
    );
    assert_eq!(run.capture.dimensions(), (800, 600));
    assert!(!run.log.contains("GPU error"), "{}", run.log);
    assert_near(&run, (400, 300), [255, 136, 0]);
    assert_near(&run, (8, 8), [51, 102, 153]);
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_replaced_renderer_draws_its_scene() {
    let run = run(
        "replace",
        &bundle("replace"),
        serde_json::json!([{"type": "wait", "frames": 8}]),
    );
    assert!(!run.log.contains("GPU error"), "{}", run.log);
    assert_near(&run, (8, 8), [0, 255, 0]);
    assert_near(&run, (640, 360), [255, 255, 0]);
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_renderer_replaces_one_disposed_without_await_or_before_init() {
    let run = run(
        "handoff",
        &bundle("handoff"),
        serde_json::json!([{"type": "wait", "frames": 10}]),
    );
    for line in [
        "failed init: ",
        "late readback rejected: Device is destroyed",
        "a second live renderer was rejected: Only one live NativeBackend is supported",
    ] {
        assert!(run.log.contains(line), "missing {line:?}: {}", run.log);
    }
    assert!(!run.log.contains("GPU error"), "{}", run.log);
    assert!(!run.log.contains("new renderer error"), "{}", run.log);
    assert!(!run.log.contains("late readback resolved"), "{}", run.log);
    assert_near(&run, (8, 8), [0, 255, 0]);
    assert_near(&run, (640, 360), [255, 255, 0]);
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn idle_frames_show_the_last_frame_the_game_drew() {
    let run = run(
        "idle",
        &test_entry("idle.js"),
        serde_json::json!([{"type": "wait", "frames": 6}]),
    );
    assert_near(&run, (640, 360), [0, 255, 0]);
}

/// `image` scaled to `width` by `height` with bilinear filtering, sampling at pixel centers and
/// clamping at the edges, as a browser scales a canvas.
fn bilinear(image: &image::RgbaImage, width: u32, height: u32) -> image::RgbaImage {
    let (w, h) = image.dimensions();
    let axis = |out: u32, size: u32, from: u32| {
        let at = ((f64::from(out) + 0.5) * f64::from(from) / f64::from(size) - 0.5).max(0.0);
        let low = (at.floor() as u32).min(from - 1);
        (low, (low + 1).min(from - 1), at - at.floor())
    };
    image::RgbaImage::from_fn(width, height, |x, y| {
        let ((x0, x1, fx), (y0, y1, fy)) = (axis(x, width, w), axis(y, height, h));
        let texel = |x, y, c| f64::from(image.get_pixel(x, y)[c]);
        image::Rgba(std::array::from_fn(|c| {
            let top = texel(x0, y0, c) * (1.0 - fx) + texel(x1, y0, c) * fx;
            let bottom = texel(x0, y1, c) * (1.0 - fx) + texel(x1, y1, c) * fx;
            (top * (1.0 - fy) + bottom * fy).round() as u8
        }))
    })
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_resize_while_idle_stretches_the_last_frame_the_game_drew() {
    let dir = workdir("idle-resize");
    let steps = serde_json::json!([
        {"type": "wait", "frames": 6},
        {"type": "capture", "path": "before.png"},
        {"type": "resize", "width": 800, "height": 600},
        {"type": "wait", "frames": 2},
        {"type": "capture", "path": "after.png"},
        {"type": "resize", "width": 640, "height": 640},
        {"type": "wait", "frames": 2},
        {"type": "capture", "path": "again.png"},
        {"type": "close"},
    ]);
    let (status, log) = host(&dir, &bundle("idle-resize"), &steps, &[]);
    assert!(
        status.success(),
        "host exited with {status}
{log}"
    );
    let open = |name: &str| image::open(dir.join(name)).unwrap().to_rgba8();
    let before = open("before.png");
    for (name, (width, height)) in [("after.png", (800, 600)), ("again.png", (640, 640))] {
        let shown = open(name);
        assert_eq!(shown.dimensions(), (width, height));
        let expected = bilinear(&before, width, height);
        let (x, y, error) = shown
            .enumerate_pixels()
            .map(|(x, y, pixel)| {
                let error = (0..3).map(|c| pixel[c].abs_diff(expected.get_pixel(x, y)[c]));
                (x, y, error.max().unwrap())
            })
            .max_by_key(|(_, _, error)| *error)
            .unwrap();
        assert!(
            error <= 3,
            "{name} pixel ({x}, {y}) is {:?}, where the frame before the resize scaled bilinearly is {:?}",
            shown.get_pixel(x, y),
            expected.get_pixel(x, y)
        );
    }
}

/// The image canvas-size.js draws for `counter` on a `width` by `height` canvas.
fn canvas_pattern(width: u32, height: u32, counter: u32) -> image::RgbaImage {
    let on = |value: bool| if value { 255 } else { 0 };
    image::RgbaImage::from_fn(width, height, |x, y| {
        if y < height / 4 {
            let bit = on(counter >> (x * 12 / width) & 1 == 1);
            image::Rgba([bit, bit, bit, 255])
        } else {
            image::Rgba([
                on(x & 1 == 1),
                on(((x >> 1) ^ (y >> 1)) & 1 == 1),
                on(y & 1 == 1),
                255,
            ])
        }
    })
}

/// The counter canvas-size.js drew into `shown`, from the middle of each bit in the top quarter,
/// or `None` before the game first draws, while the window shows the magenta clear color.
fn shown_counter(shown: &image::RgbaImage) -> Option<u32> {
    let (width, height) = shown.dimensions();
    if shown.get_pixel(0, 0).0 == [255, 0, 255, 255] {
        return None;
    }
    Some((0..12).fold(0, |counter, bit| {
        let x = (2 * bit + 1) * width / 24;
        counter | u32::from(shown.get_pixel(x, height / 8)[0] > 127) << bit
    }))
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn the_window_shows_each_frame_scaled_from_the_canvas_size() {
    let dir = workdir("canvas-size");
    let steps = serde_json::json!([
        {"type": "wait", "frames": 340},
        {"type": "resize", "width": 800, "height": 600},
        {"type": "wait", "frames": 20},
        {"type": "key", "code": "KeyS", "down": true},
        {"type": "wait", "frames": 5},
        {"type": "resize", "width": 640, "height": 640},
        {"type": "wait", "frames": 5},
        {"type": "close"},
    ]);
    let (status, log) = host(
        &dir,
        &bundle("canvas-size"),
        &steps,
        &["--record", "frames"],
    );
    assert!(status.success(), "host exited with {status}\n{log}");
    let drawn: std::collections::HashMap<u32, (u32, u32)> = log
        .lines()
        .filter_map(|line| {
            let (counter, size) = line.strip_prefix("draw ")?.split_once(' ')?;
            let (width, height) = size.split_once('x')?;
            Some((
                counter.parse().ok()?,
                (width.parse().ok()?, height.parse().ok()?),
            ))
        })
        .collect();
    assert!(drawn.len() > 320, "{log}");
    let mut recorded: Vec<_> = std::fs::read_dir(dir.join("frames"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    recorded.sort();
    let mut shown = Vec::new();
    for path in &recorded {
        let image = image::open(path).unwrap().to_rgba8();
        let Some(counter) = shown_counter(&image) else {
            assert!(shown.is_empty(), "{} shows the clear color", path.display());
            continue;
        };
        let &(width, height) = drawn
            .get(&counter)
            .unwrap_or_else(|| panic!("{} shows undrawn frame {counter}", path.display()));
        let (window_width, window_height) = image.dimensions();
        let expected = bilinear(
            &canvas_pattern(width, height, counter),
            window_width,
            window_height,
        );
        let (x, y, error) = image
            .enumerate_pixels()
            .map(|(x, y, pixel)| {
                let error = (0..3).map(|c| pixel[c].abs_diff(expected.get_pixel(x, y)[c]));
                (x, y, error.max().unwrap())
            })
            .max_by_key(|(_, _, error)| *error)
            .unwrap();
        assert!(
            error <= 3,
            "{} pixel ({x}, {y}) is {:?}, where frame {counter}'s {width}x{height} canvas scaled bilinearly is {:?}",
            path.display(),
            image.get_pixel(x, y),
            expected.get_pixel(x, y)
        );
        shown.push((counter, (window_width, window_height)));
    }
    let last = *drawn.keys().max().unwrap();
    let stop = shown
        .iter()
        .position(|(counter, _)| *counter == last)
        .unwrap_or_else(|| {
            let mut counters: Vec<_> = shown.iter().map(|(counter, _)| *counter).collect();
            counters.dedup();
            panic!("frame {last} is never shown; the window shows frames {counters:?}")
        });
    for pair in shown[..=stop].windows(2) {
        assert_eq!(pair[1].0, pair[0].0 + 1, "every drawn frame is shown");
    }
    assert!(
        shown[stop..].iter().all(|(counter, _)| *counter == last),
        "idle frames keep the last image"
    );
    for window in [(800, 600), (640, 640)] {
        assert!(shown[stop..].iter().any(|(_, size)| *size == window));
    }
    assert!(
        shown[..stop]
            .iter()
            .any(|(counter, size)| *counter > 300 && *size == (800, 600)),
        "a fixed 1280x720 canvas keeps drawing after the window shrinks"
    );
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn responses_carry_the_frame_that_requested_them() {
    let run = run(
        "frames",
        &test_entry("frames.js"),
        serde_json::json!([{"type": "wait", "frames": 10}]),
    );
    println!("{}", run.log);
    assert!(
        run.log.contains("responses match their frames: true"),
        "{}",
        run.log
    );
    assert_near(&run, (640, 360), [0, 255, 0]);
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn captures_and_recordings_hold_the_frame_javascript_produced() {
    let dir = workdir("record");
    let steps = serde_json::json!([
        {"type": "wait", "frames": 3},
        {"type": "resize", "width": 800, "height": 600},
        {"type": "capture", "path": "resized.png"},
        {"type": "wait", "frames": 2},
        {"type": "close"},
    ]);
    let (status, log) = host(
        &dir,
        &test_entry("counter.js"),
        &steps,
        &["--record", "frames"],
    );
    assert!(status.success(), "host exited with {status}\n{log}");
    let mut recorded: Vec<_> = std::fs::read_dir(dir.join("frames"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    recorded.sort();
    let frames: Vec<_> = recorded.iter().map(|path| red(path)).collect();
    assert_eq!(
        frames,
        [
            (0, (1280, 720)),
            (1, (1280, 720)),
            (2, (1280, 720)),
            (3, (800, 600)),
            (4, (800, 600)),
            (5, (800, 600)),
        ]
    );
    assert_eq!(red(&dir.join("resized.png")), (3, (800, 600)));
    let rows = std::fs::read_to_string(dir.join("frames.csv")).unwrap();
    assert_eq!(rows.lines().count(), 7, "{rows}");
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn repeated_runs_capture_identical_frames() {
    let bundle = bundle("resize");
    let steps = serde_json::json!([
        {"type": "wait", "frames": 3},
        {"type": "resize", "width": 800, "height": 600},
        {"type": "wait", "frames": 2},
    ]);
    let first = run("repeat-1", &bundle, steps.clone());
    let second = run("repeat-2", &bundle, steps);
    assert_eq!(first.capture.dimensions(), (800, 600));
    assert!(first.capture == second.capture, "captures differ");
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_render_thread_failure_ends_the_host_with_a_logged_error() {
    let dir = workdir("render-failure");
    let steps = serde_json::json!([
        {"type": "wait", "frames": 2},
        {"type": "capture", "path": "host.log/capture.png"},
        {"type": "wait", "frames": 2},
        {"type": "close"},
    ]);
    let (status, log) = host(&dir, &test_entry("counter.js"), &steps, &[]);
    assert_eq!(status.code(), Some(1), "{log}");
    assert!(log.contains("host failed: render thread failed: "), "{log}");
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn closing_the_window_joins_every_thread() {
    let dir = workdir("close-window");
    let mut child = Command::new(env!("CARGO_BIN_EXE_host"))
        .current_dir(&dir)
        .arg("--entry")
        .arg(test_entry("counter.js"))
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_secs(3));
    let closed = Command::new("taskkill")
        .args(["/PID", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(closed.success(), "taskkill could not post WM_CLOSE");
    let status = wait(&mut child, Duration::from_secs(30));
    let log = std::fs::read_to_string(dir.join("host.log")).unwrap();
    assert!(status.success(), "host exited with {status}\n{log}");
    let frames: usize = log
        .lines()
        .find_map(|line| line.strip_prefix("closed after "))
        .and_then(|rest| rest.strip_suffix(" frames"))
        .unwrap_or_else(|| panic!("no close line\n{log}"))
        .parse()
        .unwrap();
    let rows = std::fs::read_to_string(dir.join("frames.csv")).unwrap();
    assert!(frames > 0, "{log}");
    assert_eq!(rows.lines().count(), frames + 1, "every frame has a row");
}

/// Runs `canvas-resize.js` in `mode` and captures the window 20 frames after its last draw.
fn canvas_resize(mode: &str) -> image::RgbaImage {
    let dir = workdir(mode);
    let capture = dir.join("capture.png");
    let steps = serde_json::json!([
        {"type": "wait", "frames": 40},
        {"type": "capture", "path": capture},
        {"type": "close"},
    ]);
    let (status, log) = host(&dir, &bundle("canvas-resize"), &steps, &["--scene", mode]);
    assert!(status.success(), "{mode}: host exited with {status}\n{log}");
    assert!(log.contains("frame 20 ends"), "{mode}: {log}");
    image::open(&capture).unwrap().to_rgba8()
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_canvas_resize_after_a_draw_discards_that_frame() {
    let shown = canvas_resize("draw-then-resize");
    assert_eq!(
        shown.get_pixel(640, 360).0,
        [255, 0, 0, 255],
        "Edge keeps the last red frame"
    );
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_canvas_resized_after_its_last_draw_is_transparent() {
    let shown = canvas_resize("resize-after-draw");
    assert_eq!(
        shown.get_pixel(640, 360).0,
        [0, 0, 0, 0],
        "Edge shows a transparent canvas"
    );
}
