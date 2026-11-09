//! These tests run the release host on the hardware GPU and open a window, so run them under the GPU lease:
//! `cargo test -p threejsc-host --release --test gpu -- --ignored --test-threads 1`.

use std::{
    path::{Path, PathBuf},
    process::Command,
};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

struct Run {
    log: String,
    capture: image::RgbaImage,
}

fn run(name: &str, entry: &Path, steps: serde_json::Value) -> Run {
    let dir = std::env::temp_dir().join(format!("threejsc-gpu-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut steps = steps.as_array().unwrap().clone();
    let capture = dir.join("capture.png");
    steps.push(serde_json::json!({"type": "capture", "path": capture}));
    steps.push(serde_json::json!({"type": "close"}));
    std::fs::write(
        dir.join("steps.json"),
        serde_json::to_string(&steps).unwrap(),
    )
    .unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_host"))
        .current_dir(&dir)
        .arg("--entry")
        .arg(entry)
        .args(["--script", "steps.json"])
        .status()
        .unwrap();
    let log = std::fs::read_to_string(dir.join("host.log")).unwrap_or_default();
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
    let bundle = std::env::temp_dir().join(format!("threejsc-resize-{}.js", std::process::id()));
    let built = Command::new("node")
        .current_dir(ROOT)
        .env("OUT", &bundle)
        .args(["-e", "import('esbuild').then(({ build }) => build({ entryPoints: ['crates/host/tests/resize.js'], outfile: process.env.OUT, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' }))"])
        .status()
        .unwrap();
    assert!(built.success(), "resize bundle build failed");
    let run = run(
        "resize",
        &bundle,
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
