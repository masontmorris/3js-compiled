mod game;
mod input;
mod renderer;

use anyhow::{Context, Result, bail};
use game::{Game, Log};
use renderer::{Frame, Rendered, Renderer, Target};
use sdl3::event::Event;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    fs::File,
    io::{BufWriter, Write},
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant},
};
use threejsc_host::{
    script::{PointerAction, Step},
    worker::Worker,
};

struct Options {
    entry: String,
    scene: Option<String>,
    script: Option<PathBuf>,
    record: Option<PathBuf>,
    vsync: bool,
}
fn options() -> Result<Options> {
    let mut args = std::env::args().skip(1);
    let mut entry = None;
    let mut scene = None;
    let mut script = None;
    let mut record = None;
    let mut vsync = true;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--entry" => entry = Some(args.next().context("--entry needs a path")?),
            "--scene" => scene = Some(args.next().context("--scene needs a name")?),
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
            _ => bail!("unknown argument: {arg}"),
        }
    }
    Ok(Options {
        entry: entry.context("--entry is required")?,
        scene,
        script,
        record,
        vsync,
    })
}
fn log(log: &Log, message: &str) -> Result<()> {
    writeln!(log.borrow_mut(), "{message}")?;
    println!("{message}");
    Ok(())
}
fn pointer(action: PointerAction, x: f64, y: f64, button: i16) -> Value {
    json!({"type": match action { PointerAction::Move => "pointermove", PointerAction::Down => "pointerdown", PointerAction::Up => "pointerup" }, "clientX": x, "clientY": y, "button": button})
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
                    threejsc_gpu::Response::Validation { request } => json!({"type": "validation", "request": request}),
                    threejsc_gpu::Response::Readback { request, bytes } => {
                        readbacks.insert(request, bytes);
                        json!({"type": "readback", "request": request})
                    }
                    threejsc_gpu::Response::Error { frame, command, request, label, message } => {
                        let request_text = request.map_or("none".into(), |request| request.to_string());
                        log(log_file, &format!("GPU error: frame {frame}, command {command}, label {}, request {request_text}: {message}", label.as_deref().unwrap_or("none")))?;
                        json!({"type": "error", "frame": frame, "command": command, "request": request, "label": label, "message": message})
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
fn main() -> Result<()> {
    let options = options()?;
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
    let mut game = Game::new(
        &options.entry,
        log_file.clone(),
        &runtime,
        options.scene.as_deref(),
        size,
    )?;
    let mut render = Worker::spawn("render", || Ok(Renderer::new(target)), Renderer::frame)?;
    let mut events = sdl.event_pump().map_err(anyhow::Error::msg)?;
    let mut index = 0;
    let mut wait = 0u64;
    let mut frame = 0u64;
    let mut last = Instant::now();
    let mut row = None;
    'running: loop {
        let started = Instant::now();
        for event in events.poll_iter() {
            match event {
                Event::Quit { .. }
                | Event::Window {
                    win_event: sdl3::event::WindowEvent::CloseRequested,
                    ..
                } => break 'running,
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
                    game.event(&pointer(PointerAction::Move, x.into(), y.into(), 0))?
                }
                Event::MouseButtonDown {
                    x, y, mouse_btn, ..
                } => game.event(&pointer(
                    PointerAction::Down,
                    x.into(),
                    y.into(),
                    input::mouse_button(mouse_btn),
                ))?,
                Event::MouseButtonUp {
                    x, y, mouse_btn, ..
                } => game.event(&pointer(
                    PointerAction::Up,
                    x.into(),
                    y.into(),
                    input::mouse_button(mouse_btn),
                ))?,
                Event::MouseWheel { x, y, .. } => {
                    let (x, y) = input::wheel(x, y);
                    game.event(&json!({"type":"wheel", "deltaX":x, "deltaY":y}))?
                }
                _ => {}
            }
        }
        let mut capture = None;
        if wait == 0 {
            while let Some(step) = steps.get(index) {
                index += 1;
                match step {
                    Step::Wait { frames } if *frames > 0 => { wait = *frames; break; }
                    Step::Wait { .. } => {},
                    Step::Key { code, down } => game.event(&input::keyboard(code, *down, false, sdl3::keyboard::Mod::NOMOD))?,
                    Step::Pointer { action, x, y, button } => game.event(&pointer(*action, *x, *y, i16::from(*button)))?,
                    Step::Wheel { x, y } => game.event(&json!({"type":"wheel", "deltaX":x, "deltaY":y}))?,
                    Step::Gamepad { button, down, index } => game.event(&json!({"type":"gamepadbutton", "button":button, "down":down, "index":index}))?,
                    Step::Resize { width, height } => { if *width == 0 || *height == 0 { bail!("resize dimensions must be nonzero"); } window.set_size(*width, *height)?; },
                    Step::Capture { path } => { capture = Some(path.clone()); break; },
                    Step::Close => break 'running,
                }
            }
        }
        let (width, height) = window.size_in_pixels();
        if width > 0 && height > 0 && (width, height) != size {
            size = (width, height);
            game.event(&json!({"type": "resize", "width": width, "height": height}))?;
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
