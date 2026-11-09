use sdl3::{
    keyboard::{Mod, Scancode},
    mouse::MouseButton,
};
use serde_json::{Value, json};

const KEYS: &[(Scancode, &str, &str)] = &[
    (Scancode::A, "KeyA", "a"),
    (Scancode::B, "KeyB", "b"),
    (Scancode::C, "KeyC", "c"),
    (Scancode::D, "KeyD", "d"),
    (Scancode::E, "KeyE", "e"),
    (Scancode::F, "KeyF", "f"),
    (Scancode::G, "KeyG", "g"),
    (Scancode::H, "KeyH", "h"),
    (Scancode::I, "KeyI", "i"),
    (Scancode::J, "KeyJ", "j"),
    (Scancode::K, "KeyK", "k"),
    (Scancode::L, "KeyL", "l"),
    (Scancode::M, "KeyM", "m"),
    (Scancode::N, "KeyN", "n"),
    (Scancode::O, "KeyO", "o"),
    (Scancode::P, "KeyP", "p"),
    (Scancode::Q, "KeyQ", "q"),
    (Scancode::R, "KeyR", "r"),
    (Scancode::S, "KeyS", "s"),
    (Scancode::T, "KeyT", "t"),
    (Scancode::U, "KeyU", "u"),
    (Scancode::V, "KeyV", "v"),
    (Scancode::W, "KeyW", "w"),
    (Scancode::X, "KeyX", "x"),
    (Scancode::Y, "KeyY", "y"),
    (Scancode::Z, "KeyZ", "z"),
    (Scancode::_0, "Digit0", "0"),
    (Scancode::_1, "Digit1", "1"),
    (Scancode::_2, "Digit2", "2"),
    (Scancode::_3, "Digit3", "3"),
    (Scancode::_4, "Digit4", "4"),
    (Scancode::_5, "Digit5", "5"),
    (Scancode::_6, "Digit6", "6"),
    (Scancode::_7, "Digit7", "7"),
    (Scancode::_8, "Digit8", "8"),
    (Scancode::_9, "Digit9", "9"),
    (Scancode::Return, "Enter", "Enter"),
    (Scancode::Escape, "Escape", "Escape"),
    (Scancode::Backspace, "Backspace", "Backspace"),
    (Scancode::Tab, "Tab", "Tab"),
    (Scancode::Space, "Space", " "),
    (Scancode::Minus, "Minus", "-"),
    (Scancode::Equals, "Equal", "="),
    (Scancode::LeftBracket, "BracketLeft", "["),
    (Scancode::RightBracket, "BracketRight", "]"),
    (Scancode::Backslash, "Backslash", "\\"),
    (Scancode::NonUsHash, "IntlHash", "#"),
    (Scancode::Semicolon, "Semicolon", ";"),
    (Scancode::Apostrophe, "Quote", "'"),
    (Scancode::Grave, "Backquote", "`"),
    (Scancode::Comma, "Comma", ","),
    (Scancode::Period, "Period", "."),
    (Scancode::Slash, "Slash", "/"),
    (Scancode::CapsLock, "CapsLock", "CapsLock"),
    (Scancode::PrintScreen, "PrintScreen", "PrintScreen"),
    (Scancode::ScrollLock, "ScrollLock", "ScrollLock"),
    (Scancode::Pause, "Pause", "Pause"),
    (Scancode::Insert, "Insert", "Insert"),
    (Scancode::Home, "Home", "Home"),
    (Scancode::PageUp, "PageUp", "PageUp"),
    (Scancode::Delete, "Delete", "Delete"),
    (Scancode::End, "End", "End"),
    (Scancode::PageDown, "PageDown", "PageDown"),
    (Scancode::Right, "ArrowRight", "ArrowRight"),
    (Scancode::Left, "ArrowLeft", "ArrowLeft"),
    (Scancode::Down, "ArrowDown", "ArrowDown"),
    (Scancode::Up, "ArrowUp", "ArrowUp"),
    (Scancode::NumLockClear, "NumLock", "NumLock"),
    (Scancode::KpDivide, "NumpadDivide", "/"),
    (Scancode::KpMultiply, "NumpadMultiply", "*"),
    (Scancode::KpMinus, "NumpadSubtract", "-"),
    (Scancode::KpPlus, "NumpadAdd", "+"),
    (Scancode::KpEnter, "NumpadEnter", "Enter"),
    (Scancode::KpPeriod, "NumpadDecimal", "."),
    (Scancode::KpEquals, "NumpadEqual", "="),
    (Scancode::KpComma, "NumpadComma", ","),
    (Scancode::NonUsBackslash, "IntlBackslash", "\\"),
    (Scancode::Application, "ContextMenu", "ContextMenu"),
    (Scancode::Power, "Power", "Power"),
    (Scancode::LCtrl, "ControlLeft", "Control"),
    (Scancode::LShift, "ShiftLeft", "Shift"),
    (Scancode::LAlt, "AltLeft", "Alt"),
    (Scancode::LGui, "MetaLeft", "Meta"),
    (Scancode::RCtrl, "ControlRight", "Control"),
    (Scancode::RShift, "ShiftRight", "Shift"),
    (Scancode::RAlt, "AltRight", "Alt"),
    (Scancode::RGui, "MetaRight", "Meta"),
    (Scancode::Mute, "AudioVolumeMute", "AudioVolumeMute"),
    (Scancode::VolumeUp, "AudioVolumeUp", "AudioVolumeUp"),
    (Scancode::VolumeDown, "AudioVolumeDown", "AudioVolumeDown"),
    (Scancode::MediaNextTrack, "MediaTrackNext", "MediaTrackNext"),
    (
        Scancode::MediaPreviousTrack,
        "MediaTrackPrevious",
        "MediaTrackPrevious",
    ),
    (Scancode::MediaStop, "MediaStop", "MediaStop"),
    (Scancode::MediaPlayPause, "MediaPlayPause", "MediaPlayPause"),
    (Scancode::AcBack, "BrowserBack", "BrowserBack"),
    (Scancode::AcForward, "BrowserForward", "BrowserForward"),
    (Scancode::AcRefresh, "BrowserRefresh", "BrowserRefresh"),
    (Scancode::AcHome, "BrowserHome", "BrowserHome"),
    (Scancode::AcSearch, "BrowserSearch", "BrowserSearch"),
    (Scancode::Kp0, "Numpad0", "0"),
    (Scancode::Kp1, "Numpad1", "1"),
    (Scancode::Kp2, "Numpad2", "2"),
    (Scancode::Kp3, "Numpad3", "3"),
    (Scancode::Kp4, "Numpad4", "4"),
    (Scancode::Kp5, "Numpad5", "5"),
    (Scancode::Kp6, "Numpad6", "6"),
    (Scancode::Kp7, "Numpad7", "7"),
    (Scancode::Kp8, "Numpad8", "8"),
    (Scancode::Kp9, "Numpad9", "9"),
    (Scancode::F1, "F1", "F1"),
    (Scancode::F2, "F2", "F2"),
    (Scancode::F3, "F3", "F3"),
    (Scancode::F4, "F4", "F4"),
    (Scancode::F5, "F5", "F5"),
    (Scancode::F6, "F6", "F6"),
    (Scancode::F7, "F7", "F7"),
    (Scancode::F8, "F8", "F8"),
    (Scancode::F9, "F9", "F9"),
    (Scancode::F10, "F10", "F10"),
    (Scancode::F11, "F11", "F11"),
    (Scancode::F12, "F12", "F12"),
    (Scancode::F13, "F13", "F13"),
    (Scancode::F14, "F14", "F14"),
    (Scancode::F15, "F15", "F15"),
    (Scancode::F16, "F16", "F16"),
    (Scancode::F17, "F17", "F17"),
    (Scancode::F18, "F18", "F18"),
    (Scancode::F19, "F19", "F19"),
    (Scancode::F20, "F20", "F20"),
    (Scancode::F21, "F21", "F21"),
    (Scancode::F22, "F22", "F22"),
    (Scancode::F23, "F23", "F23"),
    (Scancode::F24, "F24", "F24"),
];

pub fn keyboard(code: &str, down: bool, repeat: bool, modifiers: Mod) -> Value {
    let key = KEYS
        .iter()
        .find(|(_, name, _)| *name == code)
        .map_or("Unidentified", |(_, _, key)| *key);
    let shifted = modifiers.intersects(Mod::LSHIFTMOD | Mod::RSHIFTMOD);
    let caps = modifiers.contains(Mod::CAPSMOD);
    let key = if key.len() == 1 && key.as_bytes()[0].is_ascii_lowercase() && code.starts_with("Key")
    {
        if shifted ^ caps {
            key.to_ascii_uppercase()
        } else {
            key.to_owned()
        }
    } else if shifted && !code.starts_with("Numpad") {
        match key {
            "1" => "!",
            "2" => "@",
            "3" => "#",
            "4" => "$",
            "5" => "%",
            "6" => "^",
            "7" => "&",
            "8" => "*",
            "9" => "(",
            "0" => ")",
            "-" => "_",
            "=" => "+",
            "[" => "{",
            "]" => "}",
            "\\" => "|",
            ";" => ":",
            "'" => "\"",
            "`" => "~",
            "," => "<",
            "." => ">",
            "/" => "?",
            _ => key,
        }
        .to_owned()
    } else {
        key.to_owned()
    };
    json!({"type": if down { "keydown" } else { "keyup" }, "code": code, "key": key, "repeat": repeat})
}

pub fn scancode_code(code: Scancode) -> &'static str {
    KEYS.iter()
        .find(|(scan, _, _)| *scan == code)
        .map_or("Unidentified", |(_, name, _)| *name)
}

pub fn mouse_button(button: MouseButton) -> i16 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::X1 => 3,
        MouseButton::X2 => 4,
        MouseButton::Unknown => -1,
    }
}

pub fn wheel(x: f32, y: f32) -> (f32, f32) {
    (x, -y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_and_scripted_keys_share_dom_values() {
        use Scancode::*;
        for (scan, code, key) in [
            (W, "KeyW", "w"),
            (Space, "Space", " "),
            (_1, "Digit1", "1"),
            (Left, "ArrowLeft", "ArrowLeft"),
            (LShift, "ShiftLeft", "Shift"),
            (Return, "Enter", "Enter"),
            (Escape, "Escape", "Escape"),
            (Kp1, "Numpad1", "1"),
            (F12, "F12", "F12"),
            (Semicolon, "Semicolon", ";"),
        ] {
            let actual = scancode_code(scan);
            assert_eq!(actual, code);
            assert_eq!(
                keyboard(actual, true, false, Mod::NOMOD),
                keyboard(code, true, false, Mod::NOMOD)
            );
            assert_eq!(keyboard(code, true, false, Mod::NOMOD)["key"], key);
        }
    }

    #[test]
    fn modifiers_change_printable_keys() {
        assert_eq!(keyboard("KeyW", true, false, Mod::LSHIFTMOD)["key"], "W");
        assert_eq!(
            keyboard("KeyW", true, false, Mod::LSHIFTMOD | Mod::CAPSMOD)["key"],
            "w"
        );
        assert_eq!(keyboard("Digit1", true, false, Mod::LSHIFTMOD)["key"], "!");
        assert_eq!(
            keyboard("ShiftLeft", true, true, Mod::LSHIFTMOD)["repeat"],
            true
        );
    }

    #[test]
    fn mouse_buttons_use_dom_order() {
        for (button, expected) in [
            (MouseButton::Left, 0),
            (MouseButton::Middle, 1),
            (MouseButton::Right, 2),
            (MouseButton::X1, 3),
            (MouseButton::X2, 4),
        ] {
            assert_eq!(mouse_button(button), expected);
        }
    }

    #[test]
    fn wheel_axes_use_dom_directions() {
        assert_eq!(wheel(2.0, 3.0), (2.0, -3.0));
        assert_eq!(wheel(-2.0, -3.0), (-2.0, 3.0));
    }
}
