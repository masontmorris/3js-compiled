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

/// Runs the host in `dir` and fails the test if it does not exit within a minute, or five in a debug
/// build, which encodes the frames it records as PNGs several times slower: the canvas-size test's
/// 370 frames take 18 s in release and over a minute in debug.
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
    let limit = if cfg!(debug_assertions) { 300 } else { 60 };
    let status = wait(&mut child, Duration::from_secs(limit));
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
fn with_vsync_off_frames_are_not_paced_to_the_display() {
    // With vsync off the swap chain presents at once, so an acquire that waits does so for the
    // GPU, not for a display refresh. 881734c took such waits for refreshes and paced frames to
    // the display: 169 fps on a 169 Hz display, where 9638647 draws the 2,000-mesh scene at
    // 1,720 (C:\3jsc\swarm\e3-r18\kit\out\runs\perf). The counter page only sets the clear colour,
    // so the host outruns the display many times over and its swap chain's queue fills, which
    // makes acquires wait. (The canvas-size page, at 4.6 ms a frame, is too slow to tell.)
    let dir = workdir("vsync-off");
    let steps = serde_json::json!([{"type": "wait", "frames": 2000}, {"type": "close"}]);
    let (status, log) = host(&dir, &bundle("counter"), &steps, &["--vsync", "off"]);
    assert!(status.success(), "host exited with {status}\n{log}");
    let display: f64 = log
        .lines()
        .find_map(|line| {
            line.strip_prefix("display interval ")?
                .strip_suffix(" ms")?
                .parse()
                .ok()
        })
        .unwrap_or_else(|| panic!("no display interval in the log\n{log}"));
    let frames = std::fs::read_to_string(dir.join("frames.csv")).unwrap();
    let mut intervals: Vec<f64> = frames
        .lines()
        .skip(101)
        .filter_map(|line| line.split(',').nth(2)?.parse().ok())
        .collect();
    intervals.sort_by(f64::total_cmp);
    let median = intervals[intervals.len() / 2];
    assert!(
        median < 0.5 * display,
        "frames {median} ms apart with vsync off, on a display {display} ms apart"
    );
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
    assert!(log.contains("frame 25 ends"), "{mode}: {log}");
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

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_canvas_resize_in_a_frame_that_draws_nothing_keeps_the_last_image() {
    let shown = canvas_resize("resize-idle");
    assert_eq!(
        shown.get_pixel(640, 360).0,
        [255, 0, 0, 255],
        "Edge keeps the last red frame"
    );
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_canvas_resize_and_back_after_a_draw_discards_that_frame() {
    let shown = canvas_resize("draw-resize-back");
    assert_eq!(
        shown.get_pixel(640, 360).0,
        [255, 0, 0, 255],
        "Edge keeps the last red frame"
    );
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn setting_the_canvas_size_it_has_after_a_draw_discards_that_frame() {
    let shown = canvas_resize("draw-setsize-same");
    assert_eq!(
        shown.get_pixel(640, 360).0,
        [255, 0, 0, 255],
        "Edge keeps the last red frame"
    );
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_set_after_a_draw_keeps_the_last_image_unless_three_configured_the_canvas() {
    // Edge keeps the last red frame however many frames draw and then set the canvas size, and shows
    // a transparent canvas when the discarded texture was acquired after configure().
    for (mode, shown) in [
        ("twice-width", [255, 0, 0, 255]),
        ("width-draw-width", [255, 0, 0, 255]),
        ("twice-setsize", [0, 0, 0, 0]),
        ("setsize-draw-width", [0, 0, 0, 0]),
    ] {
        assert_eq!(
            canvas_resize(mode).get_pixel(640, 360).0,
            shown,
            "{mode}: as in Edge"
        );
    }
}

/// Runs `canvas-resize.js` in a zero-size `mode` and captures the window while the canvas has a
/// zero size and after it draws blue at 1280x720 again. `errors` holds the number of GPU errors in
/// each frame that raises any, and the run must raise no others.
fn canvas_zero(mode: &str, errors: &[usize]) -> (image::RgbaImage, image::RgbaImage) {
    let dir = workdir(mode);
    let (zero, back) = (dir.join("zero.png"), dir.join("back.png"));
    let steps = serde_json::json!([
        {"type": "wait", "frames": 32},
        {"type": "capture", "path": zero},
        {"type": "wait", "frames": 30},
        {"type": "capture", "path": back},
        {"type": "close"},
    ]);
    let (status, log) = host(&dir, &bundle("canvas-resize"), &steps, &["--scene", mode]);
    assert!(
        status.success(),
        "{mode}: host exited with {status}
{log}"
    );
    assert!(log.contains("frame 35 ends"), "{mode}: {log}");
    let mut frames = std::collections::BTreeMap::new();
    for line in log.lines() {
        if let Some(rest) = line.strip_prefix("GPU error: frame ") {
            let frame: u32 = rest.split(',').next().unwrap().parse().unwrap();
            *frames.entry(frame).or_insert(0) += 1;
        }
    }
    assert_eq!(
        frames.into_values().collect::<Vec<usize>>(),
        errors,
        "{mode} raises Edge's errors in each frame: {log}"
    );
    assert_eq!(
        log.matches("uncaptured in frame").count(),
        errors.iter().sum::<usize>(),
        "{mode}: three sees each error: {log}"
    );
    let open = |path: &Path| image::open(path).unwrap().to_rgba8();
    (open(&zero), open(&back))
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_canvas_resized_to_a_zero_size_after_a_resized_draw_is_transparent() {
    for size in ["0x0", "0x360", "640x0"] {
        let (zero, back) = canvas_zero(&format!("resized-zero-{size}"), &[]);
        assert_eq!(
            zero.get_pixel(640, 360).0,
            [0, 0, 0, 0],
            "{size}: Edge shows a transparent canvas"
        );
        assert_eq!(
            back.get_pixel(640, 360).0,
            [0, 0, 255, 255],
            "{size}: the canvas draws again"
        );
    }
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_zero_size_resize_otherwise_keeps_the_last_image() {
    for mode in ["drawn", "idle"] {
        for size in ["0x0", "0x360", "640x0"] {
            let (zero, back) = canvas_zero(&format!("{mode}-zero-{size}"), &[]);
            assert_eq!(
                zero.get_pixel(640, 360).0,
                [255, 0, 0, 255],
                "{mode} {size}: Edge keeps the last red frame"
            );
            assert_eq!(
                back.get_pixel(640, 360).0,
                [0, 0, 255, 255],
                "{mode} {size}: the canvas draws again"
            );
        }
    }
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn drawing_at_a_zero_size_shows_a_cleared_canvas_with_edges_errors() {
    // Edge raises 8 errors in the first frame that draws at the zero size and 5 in each later one.
    // The first acquire after three's configure raises the empty size error twice.
    for (mode, frames) in [("sized", 20), ("drawn", 19)] {
        let mut errors = vec![5; frames];
        errors[0] = 8;
        for size in ["0x0", "0x720", "1280x0"] {
            let (zero, back) = canvas_zero(&format!("{mode}-zero-{size}-draw"), &errors);
            assert_eq!(
                zero.get_pixel(640, 360).0,
                [0, 0, 0, 0],
                "{mode} {size}: Edge shows a cleared canvas"
            );
            assert_eq!(
                back.get_pixel(640, 360).0,
                [0, 0, 255, 255],
                "{mode} {size}: the canvas draws again"
            );
        }
    }
}

/// Runs the test page `page` in `mode`, captures the window at frames 40 and 70, and returns both
/// captures, the number of GPU errors in each frame that raises any, by frame, and the host log.
fn edge_case(
    page: &str,
    mode: &str,
) -> (
    image::RgbaImage,
    image::RgbaImage,
    Vec<(u32, usize)>,
    String,
) {
    let dir = workdir(mode);
    let (f40, f70) = (dir.join("f40.png"), dir.join("f70.png"));
    let steps = serde_json::json!([
        {"type": "wait", "frames": 40},
        {"type": "capture", "path": f40},
        {"type": "wait", "frames": 30},
        {"type": "capture", "path": f70},
        {"type": "close"},
    ]);
    let (status, log) = host(&dir, &bundle(page), &steps, &["--scene", mode]);
    assert!(status.success(), "{mode}: host exited with {status}\n{log}");
    let mut frames = std::collections::BTreeMap::new();
    for line in log.lines() {
        if let Some(rest) = line.strip_prefix("GPU error: frame ") {
            let frame: u32 = rest.split(',').next().unwrap().parse().unwrap();
            *frames.entry(frame).or_insert(0) += 1;
        }
    }
    let open = |path: &Path| image::open(path).unwrap().to_rgba8();
    (open(&f40), open(&f70), frames.into_iter().collect(), log)
}

/// The errors of a mode that raises `first` in frame 20 and `each` in frames 21 to 59.
fn edge_errors(first: usize, each: usize) -> Vec<(u32, usize)> {
    std::iter::once((20, first))
        .chain((21..60).map(|frame| (frame, each)))
        .filter(|&(_, count)| count > 0)
        .collect()
}

const TRANSPARENT: [u8; 4] = [0, 0, 0, 0];
const YELLOW: [u8; 4] = [255, 255, 0, 255];
const GREEN: [u8; 4] = [0, 255, 0, 255];
const BLUE: [u8; 4] = [0, 0, 255, 255];
const MAGENTA: [u8; 4] = [255, 0, 255, 255];
const RED: [u8; 4] = [255, 0, 0, 255];

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn configure_and_unconfigure_leave_the_canvas_transparent_as_in_edge() {
    // canvas-cases.js against Edge: each mode shows a transparent canvas at frame 40, except
    // configure-redraw, which draws again after its configure, and draws blue again by frame 70.
    for (mode, corner, center) in [
        ("configure-after-draw", TRANSPARENT, TRANSPARENT),
        ("configure-idle", TRANSPARENT, TRANSPARENT),
        ("configure-redraw", YELLOW, GREEN),
        ("unconfigure", TRANSPARENT, TRANSPARENT),
        ("unconfigure-idle", TRANSPARENT, TRANSPARENT),
    ] {
        let (f40, f70, errors, _) = edge_case("canvas-cases", mode);
        assert_eq!(errors, [], "{mode} raises no error, as in Edge");
        assert_eq!(f40.get_pixel(8, 8).0, corner, "{mode} at frame 40");
        assert_eq!(f40.get_pixel(640, 360).0, center, "{mode} at frame 40");
        assert_eq!(f70.get_pixel(8, 8).0, BLUE, "{mode} draws again");
    }
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_canvas_over_the_default_texture_limit_fails_as_in_edge_unless_three_asks_for_more() {
    // Edge raises 16 errors in the first frame at 16400x64 or 9000x64, over WebGPU's default
    // maxTextureDimension2D of 8192, and 7 in each later one, and shows a transparent canvas.
    for mode in ["oversize-16400", "oversize-9000"] {
        let (f40, f70, errors, _) = edge_case("canvas-cases", mode);
        assert_eq!(errors, edge_errors(16, 7), "{mode} raises Edge's errors");
        assert_eq!(f40.get_pixel(8, 8).0, TRANSPARENT, "{mode} at frame 40");
        assert_eq!(
            f70.get_pixel(8, 8).0,
            BLUE,
            "{mode} draws again at 1280x720"
        );
    }
    let (f40, _, errors, _) = edge_case("canvas-cases", "oversize-9000-limits");
    assert_eq!(
        errors,
        [],
        "a device that requires maxTextureDimension2D 16384 draws 9000x64"
    );
    assert_eq!(f40.get_pixel(8, 8).0, YELLOW);
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_limit_worse_than_the_default_gives_the_default_and_one_past_the_adapter_rejects_init() {
    // canvas-cases.js against Edge (C:\3jsc\swarm\e3-r12\kit\out\edge\cases-limits-*): Edge's
    // device has the default maxTextureDimension2D of 8192 for a request of 4096, so a 6000x64
    // render target draws with no error, and its init() rejects a request for 2^20.
    let (f40, f70, errors, log) = edge_case("canvas-cases", "limits-worse");
    assert_eq!(errors, [], "{log}");
    assert!(log.contains("maxTextureDimension2D: 8192"), "{log}");
    assert_eq!(
        [f40.get_pixel(8, 8).0, f70.get_pixel(8, 8).0],
        [YELLOW, BLUE]
    );
    let (_, _, errors, log) = edge_case("canvas-cases", "limits-over");
    assert_eq!(errors, [], "{log}");
    assert!(
        log.contains("init: rejected OperationError: Required limit (1048576) is greater than the supported limit")
            && log.contains("maxTextureDimension2D: undefined"),
        "{log}"
    );
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn a_renderer_recreated_with_higher_limits_keeps_the_window_presenting() {
    // recreate.js against Edge (C:\3jsc\swarm\e3-r12\kit\out\edge\lc-limits-recreate*): Edge
    // draws red until frame 20 and green from the new renderer, with no error, whether its device
    // has higher limits than the one that presented or the same.
    for (mode, limits) in [
        (
            "higher",
            "limits: maxTextureDimension2D 16384 maxBufferSize 536870912",
        ),
        (
            "equal",
            "limits: maxTextureDimension2D 8192 maxBufferSize 268435456",
        ),
    ] {
        let (f40, f70, errors, log) = edge_case("recreate", mode);
        assert_eq!(errors, [], "{mode}\n{log}");
        assert!(
            log.contains(limits) && log.contains("frame 40: 0 uncaptured errors so far"),
            "{mode}\n{log}"
        );
        assert_eq!(
            [f40.get_pixel(8, 8).0, f70.get_pixel(8, 8).0],
            [GREEN, GREEN],
            "{mode}"
        );
    }
}

#[test]
#[ignore = "opens a window on the hardware GPU and starts ui-host.exe; build ui-host.exe into the same target directory and run under the GPU lease"]
fn a_replaced_device_keeps_the_huds_last_patch_and_appends_to_the_ui_host_log() {
    // hud-replace.js sends its only HUD patch, magenta, before frame 30 and replaces the device at
    // frame 600. The UI on the new device must show that patch rather than the page's initial blue,
    // and the relaunched ui-host must append to ui-host.log, as docs/testing.md says.
    let host_exe = PathBuf::from(env!("CARGO_BIN_EXE_host"));
    assert!(
        host_exe.with_file_name("ui-host.exe").exists(),
        "build ui-host.exe beside {}",
        host_exe.display()
    );
    let dir = workdir("hud-replace");
    std::fs::copy(
        Path::new(ROOT).join("crates/host/tests/fixtures/hud-replace.html"),
        dir.join("hud-replace.html"),
    )
    .unwrap();
    let (before, after) = (dir.join("before.png"), dir.join("after.png"));
    let steps = serde_json::json!([
        {"type": "wait", "frames": 560},
        {"type": "capture", "path": before},
        {"type": "wait", "frames": 360},
        {"type": "capture", "path": after},
        {"type": "close"},
    ]);
    let (status, log) = host(&dir, &bundle("hud-replace"), &steps, &[]);
    assert!(status.success(), "host exited with {status}\n{log}");
    assert!(
        log.contains("UI restarts on the device the game requested")
            && log.contains("frame 900: 0 uncaptured errors so far"),
        "{log}"
    );
    let pixels = |path: &Path| {
        let image = image::open(path).unwrap().to_rgba8();
        [image.get_pixel(60, 60).0, image.get_pixel(640, 360).0]
    };
    assert_eq!(pixels(&before), [MAGENTA, RED], "before the replacement");
    assert_eq!(pixels(&after), [MAGENTA, GREEN], "after the replacement");
    let ui_log = std::fs::read_to_string(dir.join("ui-host.log")).unwrap();
    assert!(
        ui_log.contains("[host] ui-host launch 2 after: the GPU device was replaced"),
        "{ui_log}"
    );
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn compile_async_settles_before_the_first_frame_and_while_drawing_as_in_edge() {
    // compile.js against Edge (C:\3jsc\swarm\e3-r13\kit\out\edge\compile-host-*): compileAsync
    // resolves at the top level, before the loop and while drawing, with no error, and the box draws.
    for (mode, line) in [
        ("top-level", "compileAsync at the top level: resolved"),
        ("before-loop", "compileAsync before the loop: resolved"),
        ("mid-run", "compileAsync mid-run: resolved"),
    ] {
        let (_, f70, errors, log) = edge_case("compile", mode);
        assert_eq!(errors, [], "{mode}\n{log}");
        assert!(
            log.contains(line) && log.contains("frame 60: 0 uncaptured errors so far"),
            "{mode}\n{log}"
        );
        assert_eq!(
            [f70.get_pixel(8, 8).0, f70.get_pixel(640, 360).0],
            [[255, 0, 0, 255], GREEN],
            "{mode}"
        );
    }
}

/// What error-rules.js logged in one mode: its `R <name>: <value>` results, with any message in
/// parentheses, its `case <name>: <n> errors` counts, and the whole host log.
struct Rules {
    results: Vec<(String, String)>,
    cases: Vec<(String, usize)>,
    log: String,
}

fn rules(mode: &str) -> Rules {
    page_rules("error-rules", mode, 95)
}

/// What the rules page `page` logged in one mode after `frames` frames.
fn page_rules(page: &str, mode: &str, frames: u32) -> Rules {
    let dir = workdir(&format!("{page}-{mode}"));
    let steps = serde_json::json!([{"type": "wait", "frames": frames}, {"type": "close"}]);
    let (status, log) = host(&dir, &bundle(page), &steps, &["--scene", mode]);
    assert!(status.success(), "{mode}: host exited with {status}\n{log}");
    let mut results = Vec::new();
    let mut cases = Vec::new();
    for line in log.lines() {
        if let Some((name, value)) = line
            .strip_prefix("R ")
            .and_then(|rest| rest.split_once(": "))
        {
            results.push((name.to_owned(), value.to_owned()));
        } else if let Some((name, count)) = line
            .strip_prefix("case ")
            .and_then(|rest| rest.strip_suffix(" errors"))
            .and_then(|rest| rest.split_once(": "))
        {
            cases.push((name.to_owned(), count.parse().unwrap()));
        }
    }
    Rules {
        results,
        cases,
        log,
    }
}

fn result<'a>(results: &'a [(String, String)], name: &str) -> &'a str {
    results
        .iter()
        .find(|(found, _)| found == name)
        .map_or("", |(_, value)| value)
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn error_scopes_copies_and_a_lost_device_answer_as_edge_does() {
    // error-rules.js against Edge (C:\3jsc\swarm\e3-r12\kit\out\edge\rules-*\console.txt).
    // Edge's messages differ from wgpu's, so each result is compared up to its message.
    let Rules {
        results,
        cases,
        log,
    } = rules("scopes");
    for (name, edge) in [
        ("nested-same inner", "resolved GPUValidationError"),
        ("nested-same outer", "resolved null"),
        ("oom-inside-validation oom", "resolved null"),
        (
            "oom-inside-validation validation",
            "resolved GPUValidationError",
        ),
        ("internal-inside-validation internal", "resolved null"),
        (
            "internal-inside-validation validation",
            "resolved GPUValidationError",
        ),
        ("oom-only oom", "resolved null"),
        (
            "first-error-kept",
            "resolved GPUValidationError (shader first:",
        ),
        ("empty-stack", "rejected OperationError"),
        ("bad-filter push", "threw TypeError"),
        ("submit-in-scope", "resolved GPUValidationError"),
        ("valid-in-scope", "resolved null"),
    ] {
        assert!(result(&results, name).starts_with(edge), "{name}\n{log}");
    }
    // finish-in-scope pops its scope between finish() and submit(), which the stream cannot
    // record, so it is left out.
    let edge = [
        ("nested-same", 0),
        ("oom-inside-validation", 0),
        ("internal-inside-validation", 0),
        ("oom-only", 1),
        ("first-error-kept", 0),
        ("empty-stack", 0),
        ("bad-filter", 0),
        ("submit-in-scope", 0),
        ("valid-in-scope", 0),
        ("after", 0),
    ];
    for (name, count) in edge {
        assert!(
            cases.contains(&(name.to_owned(), count)),
            "{name}: {cases:?}\n{log}"
        );
    }
    let Rules {
        results,
        cases,
        log,
    } = rules("copies");
    assert!(
        results
            .iter()
            .filter(|(name, _)| name != "init")
            .all(|(_, value)| value.starts_with("ok")),
        "Edge throws for none of the copies: {results:?}"
    );
    let edge: Vec<_> = [
        ("unaligned-offset", 2),
        ("unaligned-size", 2),
        ("out-of-range", 2),
        ("clear-unaligned", 2),
        ("bytes-per-row", 2),
        ("texture-bounds", 2),
        ("destroyed-before-submit", 1),
        ("destroyed-earlier-frame", 1),
        ("attachment-destroyed", 1),
        ("attachment-destroyed-earlier", 1),
        ("bind-group-destroyed", 1),
        ("bind-group-destroyed-earlier", 1),
        ("vertex-destroyed", 1),
        ("vertex-destroyed-earlier", 1),
        ("size-and-destroyed", 2),
        ("write-destroyed", 1),
        ("write-texture-destroyed", 1),
        ("valid-copy", 0),
        ("after", 0),
    ]
    .into_iter()
    .map(|(name, count)| (name.to_owned(), count))
    .collect();
    assert_eq!(cases, edge, "{log}");
    let Rules { cases, log, .. } = rules("buffers");
    let edge: Vec<_> = [
        ("map-read", 0),
        ("map-write", 0),
        ("map-read-copy-src", 1),
        ("map-write-mapped", 0),
        ("map-read-copied", 0),
        ("map-async", 0),
        ("after", 0),
    ]
    .into_iter()
    .map(|(name, count)| (name.to_owned(), count))
    .collect();
    assert_eq!(cases, edge, "{log}");
    let Rules { results, log, .. } = rules("destroyed");
    for (name, edge) in [
        ("popErrorScope pending at destroy", "resolved null"),
        (
            "onSubmittedWorkDone pending at destroy",
            "resolved undefined",
        ),
        ("getCompilationInfo pending at destroy", "resolved Number 0"),
        (
            "popErrorScope of a scope pushed before destroy",
            "resolved null",
        ),
        ("popErrorScope with an empty stack", "resolved null"),
        ("popErrorScope after a push after destroy", "resolved null"),
        ("onSubmittedWorkDone after destroy", "resolved undefined"),
        ("getCompilationInfo after destroy", "resolved Number 0"),
        ("createRenderPipelineAsync after destroy", "resolved"),
    ] {
        assert!(result(&results, name).starts_with(edge), "{name}\n{log}");
    }
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn an_empty_vertex_buffer_draws_with_no_error_as_in_edge() {
    let (f40, f70, errors, _) = edge_case("canvas-cases", "empty-geometry");
    assert_eq!(errors, []);
    assert_eq!(
        [f40.get_pixel(8, 8).0, f40.get_pixel(640, 360).0],
        [YELLOW, GREEN]
    );
    assert_eq!(f70.get_pixel(8, 8).0, BLUE);
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn invalid_objects_of_every_type_raise_edges_errors() {
    // invalid-objects.js against Edge: the errors each mode's creates raise in frame 20, and those
    // each frame's use raises until frame 60 releases the objects, which raises nothing.
    for (mode, creates, uses) in [
        ("valid", 0, 0),
        ("buffer", 2, 3),
        ("sampler", 2, 2),
        ("layout", 4, 2),
        ("group", 3, 2),
        ("pipeline-layout", 2, 2),
        ("pipeline", 2, 2),
        ("bundle", 3, 2),
    ] {
        let (f40, f70, errors, _) = edge_case("invalid-objects", mode);
        assert_eq!(
            errors,
            edge_errors(creates + uses, uses),
            "{mode} raises Edge's errors"
        );
        let invalid = if uses == 0 { BLUE } else { YELLOW };
        assert_eq!(
            f40.get_pixel(8, 8).0,
            invalid,
            "{mode} draws nothing with an invalid object"
        );
        assert_eq!(
            f70.get_pixel(8, 8).0,
            BLUE,
            "{mode} draws with the valid objects"
        );
    }
}

/// `value` without the messages in parentheses, which differ between Edge and wgpu.
fn unmessaged(value: &str) -> String {
    let mut depth = 0;
    let mut kept = String::new();
    for character in value.chars() {
        match character {
            '(' => {
                if depth == 0 {
                    kept.truncate(kept.trim_end().len());
                }
                depth += 1;
            }
            ')' if depth > 0 => depth -= 1,
            _ if depth == 0 => kept.push(character),
            _ => {}
        }
    }
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Checks a compute-rules.js mode against Edge's results and error counts, up to each message.
fn compute_rules(mode: &str, frames: u32, results: &[(&str, &str)], cases: &[(&str, usize)]) {
    let Rules {
        results: native,
        cases: counted,
        log,
    } = page_rules("compute-rules", mode, frames);
    for (name, edge) in results {
        assert_eq!(
            unmessaged(result(&native, name)),
            unmessaged(edge),
            "{mode} {name}\n{log}"
        );
    }
    let edge: Vec<_> = cases
        .iter()
        .map(|(name, count)| (name.to_string(), *count))
        .collect();
    assert_eq!(counted, edge, "{mode}\n{log}");
}

#[test]
#[ignore = "opens a window on the hardware GPU; run under the GPU lease"]
fn maps_compute_passes_and_timestamp_queries_answer_as_edge_does() {
    // compute-rules.js against Edge (C:\3jsc\swarm\e4\owner\kit\out\edge\compute-rules-*\console.txt).
    compute_rules(
        "map",
        130,
        &[
            ("read before", "unmapped"),
            (
                "read",
                "pending resolved undefined 11,22,33,44 then unmapped",
            ),
            ("read-range first", "2,3"),
            ("read-range second", "4,5"),
            ("read-range overlap", "threw OperationError"),
            ("read-range before", "threw OperationError"),
            ("read-range past", "threw OperationError"),
            ("read-range unaligned offset", "threw OperationError"),
            ("read-range unaligned size", "threw OperationError"),
            ("read-range detached", "0"),
            ("write initial", "0,0,0,0"),
            (
                "write",
                "pending resolved undefined 0,0,0,0,5,6,7,8,0,0,0,0,0,0,0,0 then unmapped",
            ),
            ("no-usage", "pending rejected OperationError then unmapped"),
            ("wrong-mode", "rejected OperationError"),
            ("both-modes", "rejected OperationError"),
            (
                "unaligned-offset",
                "pending rejected OperationError then unmapped",
            ),
            (
                "unaligned-size",
                "pending rejected OperationError then unmapped",
            ),
            (
                "out-of-range",
                "pending rejected OperationError then unmapped",
            ),
            (
                "empty-range",
                "pending resolved undefined bytes 0 then unmapped",
            ),
            (
                "pending-twice",
                "first resolved undefined, second rejected OperationError, mapped",
            ),
            ("unmap-pending state", "unmapped"),
            ("unmap-pending", "rejected AbortError, unmapped"),
            ("destroy-pending", "rejected AbortError, unmapped"),
            ("destroyed", "pending rejected OperationError then unmapped"),
            ("mapped-again", "rejected OperationError, mapped"),
            ("mapped-submit state", "mapped"),
            ("pending-submit", "resolved undefined"),
            ("remap", "pending resolved undefined 9,8,7,6 then unmapped"),
            ("mapped-at-creation-range overlap", "threw OperationError"),
            (
                "mapped-at-creation-range",
                "pending resolved undefined 1,2,3,4,0,0,0,0 then unmapped",
            ),
        ],
        &[
            ("read", 0),
            ("read-range", 0),
            ("write", 0),
            ("no-usage", 1),
            ("wrong-mode", 1),
            ("both-modes", 1),
            ("unaligned-offset", 1),
            ("unaligned-size", 1),
            ("out-of-range", 1),
            ("empty-range", 0),
            ("pending-twice", 0),
            ("unmap-pending", 0),
            ("destroy-pending", 0),
            ("destroyed", 1),
            ("mapped-again", 1),
            ("mapped-submit", 1),
            ("pending-submit", 1),
            ("remap", 0),
            ("mapped-at-creation-range", 0),
            ("after", 0),
        ],
    );
    compute_rules(
        "compute",
        120,
        &[
            (
                "dispatch",
                "pending resolved undefined 1,4,766 sum 98176 then unmapped",
            ),
            (
                "indirect",
                "pending resolved undefined 1,382,385 then unmapped",
            ),
            ("async", "resolved GPUComputePipeline"),
            ("async-invalid", "rejected GPUPipelineError"),
            ("async-invalid scope", "resolved null"),
            ("wrong-usage group", "ok undefined"),
            ("render-pipeline-in-compute encode", "threw TypeError"),
            (
                "storage-vertex",
                "pending resolved undefined row 3 yellow 4 of 16 then unmapped",
            ),
        ],
        &[
            ("dispatch", 0),
            ("indirect", 2),
            ("async", 0),
            ("async-invalid", 0),
            ("bad-shader", 4),
            ("bad-entry", 3),
            ("no-pipeline", 2),
            ("too-many-groups", 2),
            ("missing-group", 2),
            ("wrong-usage", 3),
            ("destroyed-storage", 1),
            ("destroyed-storage-earlier", 1),
            ("destroyed-indirect", 1),
            ("render-pipeline-in-compute", 0),
            ("storage-vertex", 0),
            ("after", 0),
        ],
    );
    compute_rules(
        "queries",
        110,
        &[
            ("timestamp-query", "true"),
            ("create", "timestamp 8 times"),
            (
                "render",
                "pending resolved undefined ordered true then unmapped",
            ),
            (
                "compute",
                "pending resolved undefined ordered true then unmapped",
            ),
            (
                "end-only",
                "pending resolved undefined ordered then unmapped",
            ),
            ("too-many", "ok undefined"),
        ],
        &[
            ("create", 0),
            ("render", 0),
            ("compute", 0),
            ("end-only", 0),
            ("same-index", 2),
            ("index-past-count", 2),
            ("resolve-unaligned", 2),
            ("resolve-usage", 2),
            ("resolve-past-count", 2),
            ("resolve-past-buffer", 2),
            ("too-many", 3),
            ("destroyed", 1),
            ("destroyed-earlier", 1),
            ("after", 0),
        ],
    );
    compute_rules(
        "queries-nofeature",
        40,
        &[("timestamp-query", "false"), ("create", "threw TypeError")],
        &[("create", 0), ("after", 0)],
    );
    compute_rules(
        "lost",
        40,
        &[
            (
                "mapAsync pending at destroy",
                "rejected AbortError, unmapped",
            ),
            (
                "createComputePipelineAsync pending at destroy",
                "resolved GPUComputePipeline",
            ),
            ("mapAsync after destroy", "rejected AbortError"),
            (
                "createComputePipelineAsync after destroy",
                "resolved GPUComputePipeline",
            ),
        ],
        &[("destroy", 0), ("after", 0)],
    );
}
