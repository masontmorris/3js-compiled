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
        assert!(run.log.contains(line), "missing {line:?}
{}", run.log);
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
