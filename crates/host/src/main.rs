mod game;
mod input;
mod renderer;
mod ui;

use anyhow::{Context, Result, bail};
use game::{Game, Log};
use renderer::Renderer;
use sdl3::event::Event;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    fs::File,
    io::{BufWriter, Write},
    path::PathBuf,
    rc::Rc,
    time::Instant,
};
use threejsc_host::script::{PointerAction, Step};

struct Options {
    entry: String,
    script: Option<PathBuf>,
    record: Option<PathBuf>,
    vsync: bool,
    no_ui: bool,
}
fn options() -> Result<Options> {
    let mut args = std::env::args().skip(1);
    let mut entry = None;
    let mut script = None;
    let mut record = None;
    let mut vsync = true;
    let mut no_ui = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--entry" => entry = Some(args.next().context("--entry needs a path")?),
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
            "--no-ui" => no_ui = true,
            _ => bail!("unknown argument: {arg}"),
        }
    }
    Ok(Options {
        entry: entry.context("--entry is required")?,
        script,
        record,
        vsync,
        no_ui,
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
fn route_pointer(
    game: &mut Game<'_>,
    ui: Option<&ui::Ui>,
    action: PointerAction,
    x: f64,
    y: f64,
    button: i16,
) -> Result<()> {
    let code = match action {
        PointerAction::Move => 0,
        PointerAction::Down => 1,
        PointerAction::Up => 2,
    };
    if !ui.is_some_and(|ui| ui.pointer(code, x, y, button)) {
        game.event(&pointer(action, x, y, button))?;
    }
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
    let mut csv = BufWriter::new(File::create("frames.csv")?);
    writeln!(csv, "frame,cpu_ms,interval_ms")?;
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
    let (mut renderer, adapter) = pollster::block_on(Renderer::new(&window, options.vsync))?;
    log(&log_file, &adapter)?;
    let mut game = Game::new(&options.entry, log_file.clone(), &runtime)?;
    let mut ui = if options.no_ui {
        None
    } else if let Some(page) = game.page() {
        let page = std::fs::canonicalize(page)?.to_string_lossy().into_owned();
        Some(ui::Ui::new(
            &renderer.device,
            &renderer.queue,
            renderer.config.format,
            page,
            window.size_in_pixels(),
        )?)
    } else {
        None
    };
    let mut events = sdl.event_pump().map_err(anyhow::Error::msg)?;
    let mut index = 0;
    let mut wait = 0u64;
    let mut frame = 0u64;
    let mut last = Instant::now();
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
                Event::MouseMotion { x, y, .. } => route_pointer(
                    &mut game,
                    ui.as_ref(),
                    PointerAction::Move,
                    x.into(),
                    y.into(),
                    0,
                )?,
                Event::MouseButtonDown {
                    x, y, mouse_btn, ..
                } => route_pointer(
                    &mut game,
                    ui.as_ref(),
                    PointerAction::Down,
                    x.into(),
                    y.into(),
                    input::mouse_button(mouse_btn),
                )?,
                Event::MouseButtonUp {
                    x, y, mouse_btn, ..
                } => route_pointer(
                    &mut game,
                    ui.as_ref(),
                    PointerAction::Up,
                    x.into(),
                    y.into(),
                    input::mouse_button(mouse_btn),
                )?,
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
                    Step::Pointer { action, x, y, button } => route_pointer(&mut game, ui.as_ref(), *action, *x, *y, i16::from(*button))?,
                    Step::Wheel { x, y } => game.event(&json!({"type":"wheel", "deltaX":x, "deltaY":y}))?,
                    Step::Gamepad { button, down, index } => game.event(&json!({"type":"gamepadbutton", "button":button, "down":down, "index":index}))?,
                    Step::Resize { width, height } => { if *width == 0 || *height == 0 { bail!("resize dimensions must be nonzero"); } window.set_size(*width, *height)?; },
                    Step::Capture { path } => { capture = Some(path.clone()); break; },
                    Step::Close => break 'running,
                }
            }
        }
        let (width, height) = window.size_in_pixels();
        renderer.resize(width, height);
        let color = game.frame()?;
        let patch = game.patch();
        if let Some(ui) = &mut ui {
            for event in ui.update(&renderer.device, frame + 1, (width, height), patch)? {
                game.ui_event(&event)?;
            }
        }
        let record = options
            .record
            .as_ref()
            .map(|dir| dir.join(format!("{frame:06}.png")));
        let captures: Vec<_> = capture
            .as_deref()
            .into_iter()
            .chain(record.as_deref())
            .collect();
        let preparation = started.elapsed();
        let surface_frame = renderer.acquire()?;
        let render_started = Instant::now();
        let surface_frame =
            renderer.render(surface_frame, color, &captures, ui.as_ref(), frame + 1)?;
        let elapsed_cpu = (preparation + render_started.elapsed()).as_secs_f64() * 1000.0;
        renderer.present(surface_frame);
        let interval = started.duration_since(last).as_secs_f64() * 1000.0;
        writeln!(csv, "{frame},{elapsed_cpu:.4},{interval:.4}")?;
        last = started;
        frame += 1;
        wait = wait.saturating_sub(1);
    }
    csv.flush()?;
    log(&log_file, &format!("closed after {frame} frames"))?;
    Ok(())
}
