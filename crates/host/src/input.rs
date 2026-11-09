use sdl3::{keyboard::Scancode, mouse::MouseButton};
use serde_json::{Value, json};

pub fn keyboard(code: &str, down: bool, repeat: bool) -> Value {
    json!({"type": if down { "keydown" } else { "keyup" }, "code": code, "key": code, "repeat": repeat})
}

pub fn scancode_code(code: Scancode) -> String {
    format!("Key{code:?}")
}

pub fn mouse_button(_button: MouseButton) -> u8 {
    0
}

pub fn wheel(x: f32, y: f32) -> (f32, f32) {
    (x, y)
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
            assert_eq!(keyboard(&actual, true, false), keyboard(code, true, false));
            assert_eq!(keyboard(code, true, false)["key"], key);
        }
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
