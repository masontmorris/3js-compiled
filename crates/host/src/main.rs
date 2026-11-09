use sdl3::event::Event;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sdl = sdl3::init()?;
    let video = sdl.video()?;
    let _window = video.window("threejsc", 1280, 720).resizable().build()?;
    let mut events = sdl.event_pump()?;
    'running: loop {
        for event in events.poll_iter() {
            if matches!(event, Event::Quit { .. }) {
                break 'running;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Ok(())
}
