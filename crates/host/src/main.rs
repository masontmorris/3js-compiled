mod game;
mod renderer;

use anyhow::{Context, Result, bail};
use game::{Game, Log, Page, RenderProgress};
use renderer::{Frame, Rendered, Renderer, Target};
use sdl3::event::Event;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    fs::File,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use threejsc_host::{
    platform::{events as input, gamepads::Gamepads},
    script::{PointerAction, Step},
    worker::Worker,
};

/// The refresh interval in ms of the display the window is on, or 0 when SDL reports no rate.
fn display_interval(window: &sdl3::video::Window) -> f64 {
    window
        .get_display()
        .and_then(|display| display.get_mode())
        .map_or(0.0, |mode| 1000.0 / f64::from(mode.refresh_rate))
}

struct Options {
    entry: String,
    scene: Option<String>,
    script: Option<PathBuf>,
    record: Option<PathBuf>,
    storage: Option<PathBuf>,
    hash: String,
    vsync: bool,
    /// Runs the entry module with no window or GPU until its top level finishes, then this many frames.
    headless: Option<u32>,
}
fn options() -> Result<Options> {
    let mut args = std::env::args().skip(1);
    let mut entry = None;
    let mut scene = None;
    let mut script = None;
    let mut record = None;
    let mut storage = None;
    let mut hash = String::new();
    let mut vsync = true;
    let mut headless = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--entry" => entry = Some(args.next().context("--entry needs a path")?),
            "--scene" => scene = Some(args.next().context("--scene needs a name")?),
            "--storage" => storage = Some(args.next().context("--storage needs a file")?.into()),
            "--hash" => hash = args.next().context("--hash needs a fragment")?,
            "--script" => script = Some(args.next().context("--script needs a path")?.into()),
            "--record" => record = Some(args.next().context("--record needs a directory")?.into()),
            "--vsync" => {
                vsync = match args.next().as_deref() {
                    Some("on") => true,
                    Some("off") => false,
                    _ => bail!("--vsync needs on or off"),
                }
            }
            "--novsync" => vsync = false,
            "--headless" => {
                headless = Some(
                    args.next()
                        .context("--headless needs a frame count")?
                        .parse()?,
                )
            }
            _ => bail!("unknown argument: {arg}"),
        }
    }
    let entry: String = entry.context("--entry is required")?;
    let storage = storage.or_else(|| {
        std::env::var_os("LOCALAPPDATA").map(|home| {
            threejsc_host::platform::storage::default_path(Path::new(&entry), Path::new(&home))
        })
    });
    Ok(Options {
        entry,
        scene,
        script,
        record,
        storage,
        hash,
        vsync,
        headless,
    })
}
fn log(log: &Log, message: &str) -> Result<()> {
    writeln!(log.borrow_mut(), "{message}")?;
    println!("{message}");
    Ok(())
}
/// A pointer input fact at (`x`, `y`) in CSS pixels.
fn pointer(
    action: PointerAction,
    x: f64,
    y: f64,
    button: i16,
    clicks: u8,
    modifiers: &Value,
) -> Value {
    let mut fact = json!({"type": match action { PointerAction::Move => "pointermove", PointerAction::Down => "pointerdown", PointerAction::Up => "pointerup" }, "clientX": x, "clientY": y, "button": button, "clicks": clicks});
    input::merge(&mut fact, modifiers);
    fact
}
/// The window's device pixel ratio and its size in CSS pixels, as Edge rounds them.
fn css_size(window: &sdl3::video::Window) -> (f64, (u32, u32)) {
    css_pixels(window.size_in_pixels(), window.display_scale())
}
/// The device pixel ratio for display scale `scale`, and a size of `pixels` in CSS pixels.
fn css_pixels((width, height): (u32, u32), scale: f32) -> (f64, (u32, u32)) {
    let ratio = f64::from(scale).max(0.25);
    let css = |pixels: u32| ((f64::from(pixels) / ratio).round() as u32).max(1);
    (ratio, (css(width), css(height)))
}
/// CSS pixels per window coordinate, for a window of `pixel_density` pixels per coordinate at device pixel ratio
/// `ratio`.
fn css_scale(pixel_density: f32, ratio: f64) -> f64 {
    f64::from(pixel_density) / ratio
}
/// The GPUErrorFilter name of an error's filter.
fn filter_name(filter: wgpu::ErrorFilter) -> &'static str {
    match filter {
        wgpu::ErrorFilter::Validation => "validation",
        wgpu::ErrorFilter::OutOfMemory => "out-of-memory",
        wgpu::ErrorFilter::Internal => "internal",
    }
}
/// Sends the coalesced pointer motion and wheel facts.
fn flush(game: &mut Game<'_>, moved: &mut Option<Value>, wheel: &mut Option<Value>) -> Result<()> {
    for fact in [moved.take(), wheel.take()].into_iter().flatten() {
        game.event(&fact)?;
    }
    Ok(())
}
/// The game thread's share of a frame whose render-thread result has not arrived yet.
struct Row {
    cpu: Duration,
    interval: Duration,
}
/// Logs `rendered`'s errors, dispatches its responses to JavaScript, and writes its CSV row.
fn finish(
    game: &mut Game<'_>,
    log_file: &Log,
    csv: &mut impl Write,
    row: Row,
    rendered: Rendered,
) -> Result<()> {
    let mut readbacks = HashMap::new();
    let responses = match rendered.replay {
        None => Vec::new(),
        Some(Ok(responses)) => {
            let mut values = Vec::with_capacity(responses.len());
            for response in responses {
                values.push(match response {
                    threejsc_gpu::Response::Compilation { request, message } => json!({"type": "compilation", "request": request, "message": message}),
                    threejsc_gpu::Response::Readback { request, bytes } => {
                        readbacks.insert(request, bytes);
                        json!({"type": "readback", "request": request})
                    }
                    threejsc_gpu::Response::Scope { request, error } => {
                        let (filter, message) = error.map_or((None, None), |(filter, message)| (Some(filter_name(filter)), Some(message)));
                        json!({"type": "scope", "request": request, "filter": filter, "message": message})
                    }
                    threejsc_gpu::Response::Error { frame, command, request, label, filter, message } => {
                        let request_text = request.map_or("none".into(), |request| request.to_string());
                        log(log_file, &format!("GPU error: frame {frame}, command {command}, label {}, request {request_text}: {message}", label.as_deref().unwrap_or("none")))?;
                        json!({"type": "error", "frame": frame, "command": command, "request": request, "label": label, "filter": filter_name(filter), "message": message})
                    }
                });
            }
            values
        }
        Some(Err(error)) => {
            log(
                log_file,
                &format!(
                    "GPU stream rejected in host frame {}: {error}",
                    rendered.index
                ),
            )?;
            vec![json!({"type": "error", "message": error.to_string()})]
        }
    };
    if !responses.is_empty() {
        game.gpu_responses(responses, readbacks)?;
    }
    let ms = |duration: Duration| duration.as_secs_f64() * 1000.0;
    writeln!(
        csv,
        "{},{:.4},{:.4},{:.4},{:.4}",
        rendered.index,
        ms(row.cpu),
        ms(row.interval),
        ms(rendered.cpu),
        ms(rendered.latency)
    )?;
    Ok(())
}
/// Runs the entry module's script with no window, GPU or input until its top level finishes, for at most 30 seconds,
/// then `frames` more frames, for tests of the platform shims.
fn headless(options: &Options, frames: u32) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let _entered = runtime.enter();
    let log: Log = Rc::new(RefCell::new(File::create("host.log")?));
    let page = Page {
        hash: options.hash.clone(),
        ..Page::default()
    };
    let mut game = Game::open(
        &options.entry,
        log,
        &runtime,
        options.scene.as_deref(),
        (1280, 720),
        None,
        &page,
    )?;
    let start = Instant::now();
    while !game.evaluated() {
        if start.elapsed() > Duration::from_secs(30) {
            bail!("the entry module did not finish in 30 seconds");
        }
        game.frame()?;
        std::thread::sleep(Duration::from_millis(1));
    }
    for _ in 0..frames {
        game.frame()?;
    }
    Ok(())
}

fn main() -> Result<()> {
    let options = options()?;
    if let Some(frames) = options.headless {
        return headless(&options, frames);
    }
    let steps = if let Some(path) = &options.script {
        threejsc_host::script::parse(
            &std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?,
        )?
    } else {
        Vec::new()
    };
    if let Some(dir) = &options.record {
        std::fs::create_dir_all(dir)?;
        if std::fs::read_dir(dir)?.next().is_some() {
            bail!("record directory must be empty: {}", dir.display());
        }
    }
    let log_file = Rc::new(RefCell::new(File::create("host.log")?));
    run(&options, &steps, &log_file).inspect_err(|error| {
        let _ = log(&log_file, &format!("host failed: {error:#}"));
    })
}
fn run(options: &Options, steps: &[Step], log_file: &Log) -> Result<()> {
    let mut csv = BufWriter::new(File::create("frames.csv")?);
    writeln!(csv, "frame,cpu_ms,interval_ms,render_cpu_ms,latency_ms")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let _entered = runtime.enter();
    // Gamepads keep reporting while the window is in the background, as Edge reads them while the page is visible.
    sdl3::hint::set("SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", "1");
    let sdl = sdl3::init().map_err(anyhow::Error::msg)?;
    let video = sdl.video().map_err(anyhow::Error::msg)?;
    let mut window = video
        .window("threejsc", 1280, 720)
        .resizable()
        .position_centered()
        .build()?;
    let (target, adapter) = pollster::block_on(Target::new(&window, options.vsync))?;
    log(log_file, &adapter)?;
    let (width, height) = window.size_in_pixels();
    let mut size = (width.max(1), height.max(1));
    let (mut ratio, css) = css_size(&window);
    let screen = window
        .get_display()
        .and_then(|display| display.get_mode())
        .map_or((1920, 1080), |mode| (mode.w as u32, mode.h as u32));
    let page = Page {
        hash: options.hash.clone(),
        storage: options.storage.clone(),
        ratio,
        screen: (
            (f64::from(screen.0) / ratio) as u32,
            (f64::from(screen.1) / ratio) as u32,
        ),
    };
    let mut game = Game::open(
        &options.entry,
        log_file.clone(),
        &runtime,
        options.scene.as_deref(),
        css,
        Some(&target.adapter_limits()),
        &page,
    )?;
    let mut gamepads = Gamepads::new(
        sdl.gamepad().map_err(anyhow::Error::msg)?,
        sdl.joystick().map_err(anyhow::Error::msg)?,
    );
    let mut scripted = sdl3::keyboard::Mod::NOMOD;
    game.set_display_interval(display_interval(&window))?;
    let progress = Arc::new(RenderProgress::default());
    game.set_render_progress(progress.clone());
    let rendering = progress.clone();
    let mut render = Worker::spawn(
        "render",
        || Ok(Renderer::new(target)),
        move |renderer, frame| {
            let rendered = renderer.frame(frame);
            rendering.finished.fetch_add(1, Ordering::Release);
            rendered
        },
    )?;
    let mut events = sdl.event_pump().map_err(anyhow::Error::msg)?;
    let mut index = 0;
    let mut wait = 0u64;
    let mut frame = 0u64;
    let mut last = Instant::now();
    let mut row = None;
    'running: loop {
        let started = Instant::now();
        let scale = css_scale(window.pixel_density(), ratio);
        let keyboard = sdl.keyboard();
        // Motion and wheel events coalesce within a poll, as Edge aligns them to frames, and go out before any
        // other input, so discrete events keep their order.
        let mut moved: Option<Value> = None;
        let mut wheel: Option<Value> = None;
        for event in events.poll_iter() {
            let modifiers = input::modifiers(keyboard.mod_state());
            if !matches!(event, Event::MouseMotion { .. } | Event::MouseWheel { .. }) {
                flush(&mut game, &mut moved, &mut wheel)?;
            }
            match event {
                Event::Quit { .. }
                | Event::Window {
                    win_event: sdl3::event::WindowEvent::CloseRequested,
                    ..
                } => break 'running,
                // The window moved to another display, or a display's mode changed.
                Event::Window {
                    win_event: sdl3::event::WindowEvent::DisplayChanged(_),
                    ..
                }
                | Event::Display { .. } => game.set_display_interval(display_interval(&window))?,
                Event::Window {
                    win_event: sdl3::event::WindowEvent::FocusGained,
                    ..
                } => game.event(&json!({"type": "focus", "focused": true}))?,
                Event::Window {
                    win_event: sdl3::event::WindowEvent::FocusLost,
                    ..
                } => game.event(&json!({"type": "focus", "focused": false}))?,
                Event::Window {
                    win_event: sdl3::event::WindowEvent::MouseLeave,
                    ..
                } => game.event(&json!({"type": "pointerleave"}))?,
                Event::KeyDown {
                    scancode: Some(code),
                    keymod,
                    repeat,
                    ..
                } => game.event(&input::keyboard(
                    input::scancode_code(code),
                    true,
                    repeat,
                    keymod,
                ))?,
                Event::KeyUp {
                    scancode: Some(code),
                    keymod,
                    repeat,
                    ..
                } => game.event(&input::keyboard(
                    input::scancode_code(code),
                    false,
                    repeat,
                    keymod,
                ))?,
                Event::MouseMotion { x, y, .. } => {
                    moved = Some(pointer(
                        PointerAction::Move,
                        f64::from(x) * scale,
                        f64::from(y) * scale,
                        0,
                        0,
                        &modifiers,
                    ));
                }
                Event::MouseButtonDown {
                    x,
                    y,
                    mouse_btn,
                    clicks,
                    ..
                } => game.event(&pointer(
                    PointerAction::Down,
                    f64::from(x) * scale,
                    f64::from(y) * scale,
                    input::mouse_button(mouse_btn),
                    clicks,
                    &modifiers,
                ))?,
                Event::MouseButtonUp {
                    x,
                    y,
                    mouse_btn,
                    clicks,
                    ..
                } => game.event(&pointer(
                    PointerAction::Up,
                    f64::from(x) * scale,
                    f64::from(y) * scale,
                    input::mouse_button(mouse_btn),
                    clicks,
                    &modifiers,
                ))?,
                Event::MouseWheel {
                    x,
                    y,
                    mouse_x,
                    mouse_y,
                    ..
                } => {
                    let (x, y) = input::wheel(x, y);
                    let sum = |key: &str| {
                        wheel
                            .as_ref()
                            .and_then(|fact| fact[key].as_f64())
                            .unwrap_or(0.0)
                    };
                    let mut fact = json!({"type": "wheel", "deltaX": sum("deltaX") + x, "deltaY": sum("deltaY") + y, "clientX": f64::from(mouse_x) * scale, "clientY": f64::from(mouse_y) * scale});
                    input::merge(&mut fact, &modifiers);
                    wheel = Some(fact);
                }
                Event::GamepadAdded { which, .. } => gamepads.added(which.raw())?,
                Event::GamepadRemoved { which, .. } => gamepads.removed(which.raw()),
                _ => {}
            }
        }
        flush(&mut game, &mut moved, &mut wheel)?;
        let mut capture = None;
        if wait == 0 {
            while let Some(step) = steps.get(index) {
                index += 1;
                let modifiers = input::modifiers(scripted);
                match step {
                    Step::Wait { frames } if *frames > 0 => {
                        wait = *frames;
                        break;
                    }
                    Step::Wait { .. } => {}
                    Step::Key { code, down, repeat } => {
                        scripted = input::scripted_modifiers(scripted, code, *down);
                        game.event(&input::keyboard(code, *down, *repeat, scripted))?;
                    }
                    Step::Pointer {
                        action,
                        x,
                        y,
                        button,
                    } => {
                        game.event(&pointer(*action, *x, *y, i16::from(*button), 1, &modifiers))?
                    }
                    Step::Wheel { x, y } => {
                        let mut fact = json!({"type":"wheel", "deltaX":x, "deltaY":y});
                        input::merge(&mut fact, &modifiers);
                        game.event(&fact)?;
                    }
                    Step::Gamepad {
                        button,
                        down,
                        index,
                    } => gamepads.press(*index, *button, *down)?,
                    Step::GamepadAxis { axis, value, index } => {
                        gamepads.tilt(*index, *axis, *value)?
                    }
                    Step::Focus { focused } => {
                        game.event(&json!({"type": "focus", "focused": focused}))?
                    }
                    Step::Resize { width, height } => {
                        if *width == 0 || *height == 0 {
                            bail!("resize dimensions must be nonzero");
                        }
                        window.set_size(*width, *height)?;
                    }
                    Step::Capture { path } => {
                        capture = Some(path.clone());
                        break;
                    }
                    Step::Close => break 'running,
                }
            }
        }
        if let Some(fact) = gamepads.snapshot() {
            game.event(&fact)?;
        }
        let (width, height) = window.size_in_pixels();
        if width > 0 && height > 0 && (width, height) != size {
            size = (width, height);
            let (new_ratio, (css_width, css_height)) = css_size(&window);
            ratio = new_ratio;
            game.event(&json!({"type": "resize", "width": css_width, "height": css_height, "ratio": ratio}))?;
        }
        let clear = game.frame()?;
        let captures = capture
            .into_iter()
            .chain(
                options
                    .record
                    .as_ref()
                    .map(|dir| dir.join(format!("{frame:06}.png"))),
            )
            .collect();
        let submitted = Instant::now();
        let rendered = render.submit(Frame {
            index: frame,
            started,
            size,
            clear,
            commands: game.take_commands(),
            captures,
        })?;
        progress.submitted.fetch_add(1, Ordering::Release);
        let render_wait = submitted.elapsed();
        if let Some(rendered) = rendered {
            let row = row.take().expect("a rendered frame has a game-thread row");
            finish(&mut game, log_file, &mut csv, row, rendered)?;
        }
        row = Some(Row {
            cpu: started.elapsed() - render_wait,
            interval: started.duration_since(last),
        });
        last = started;
        frame += 1;
        wait = wait.saturating_sub(1);
    }
    if let Some(rendered) = render.close()? {
        let row = row.take().expect("a rendered frame has a game-thread row");
        finish(&mut game, log_file, &mut csv, row, rendered)?;
    }
    csv.flush()?;
    log(log_file, &format!("closed after {frame} frames"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_display_scale_of_one_and_a_half_divides_pixels_into_css_pixels() {
        // Office's display scale. Edge's window of 1920x1080 pixels there is 1280x720 CSS pixels at a device pixel
        // ratio of 1.5, and the pointer at window pixel (300, 150) is at client (200, 100).
        assert_eq!(css_pixels((1920, 1080), 1.5), (1.5, (1280, 720)));
        assert_eq!(css_pixels((1280, 720), 1.0), (1.0, (1280, 720)));
        assert_eq!(
            css_pixels((1, 1), 1.5),
            (1.5, (1, 1)),
            "a window keeps at least one CSS pixel"
        );
        let scale = css_scale(1.0, 1.5);
        assert_eq!((300.0 * scale, 150.0 * scale), (200.0, 100.0));
        assert_eq!(
            css_scale(2.0, 2.0),
            1.0,
            "a window whose coordinates are points has a pixel density"
        );
    }
}
