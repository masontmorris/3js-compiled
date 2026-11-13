//! SDL gamepads in the W3C standard mapping, with the ids Edge gives them on Windows, and virtual Xbox pads that
//! scripts drive through the same SDL path as real ones.

use anyhow::{Result, anyhow};
use sdl3::{
    GamepadSubsystem, JoystickSubsystem,
    gamepad::{Axis, Button, Gamepad, GamepadType},
    joystick::{Joystick, JoystickId},
    sys,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const SLOTS: usize = 8;

/// The standard mapping's 17 buttons in order. Buttons 6 and 7 are the analog triggers.
const BUTTONS: [Option<Button>; 17] = [
    Some(Button::South),
    Some(Button::East),
    Some(Button::West),
    Some(Button::North),
    Some(Button::LeftShoulder),
    Some(Button::RightShoulder),
    None,
    None,
    Some(Button::Back),
    Some(Button::Start),
    Some(Button::LeftStick),
    Some(Button::RightStick),
    Some(Button::DPadUp),
    Some(Button::DPadDown),
    Some(Button::DPadLeft),
    Some(Button::DPadRight),
    Some(Button::Guide),
];
const AXES: [Axis; 4] = [Axis::LeftX, Axis::LeftY, Axis::RightX, Axis::RightY];

/// A stick axis in -1 to 1, as Edge normalizes XInput's: SDL already points Y down, as the standard mapping does.
pub fn stick(value: i16) -> f64 {
    (f64::from(value) + 32768.0) / 32767.5 - 1.0
}
/// A trigger in 0 to 1.
pub fn trigger(value: i16) -> f64 {
    f64::from(value.max(0)) / 32767.0
}

/// Edge's id: every XInput pad reads as an Xbox 360 controller, and other pads carry their USB ids.
pub fn id(kind: GamepadType, name: &str, vendor: u16, product: u16) -> String {
    match kind {
        GamepadType::Xbox360 | GamepadType::XboxOne => {
            "Xbox 360 Controller (XInput STANDARD GAMEPAD)".into()
        }
        _ => format!("{name} (STANDARD GAMEPAD Vendor: {vendor:04x} Product: {product:04x})"),
    }
}

struct Pad {
    slot: usize,
    gamepad: Gamepad,
}

/// A scripted pad, which SDL reports as a real one until it is dropped. Its axes and buttons are kept so a gamepad
/// opened after they were set can be given the same state.
struct Virtual {
    joystick: Joystick,
    axes: Vec<i16>,
    buttons: u32,
}
impl Drop for Virtual {
    fn drop(&mut self) {
        unsafe { sys::joystick::SDL_DetachVirtualJoystick(self.joystick.id().into()) };
    }
}

pub struct Gamepads {
    subsystem: GamepadSubsystem,
    joysticks: JoystickSubsystem,
    pads: BTreeMap<u32, Pad>,
    virtuals: BTreeMap<u8, Virtual>,
    last: Value,
}

impl Gamepads {
    pub fn new(subsystem: GamepadSubsystem, joysticks: JoystickSubsystem) -> Self {
        Self {
            subsystem,
            joysticks,
            pads: BTreeMap::new(),
            virtuals: BTreeMap::new(),
            last: json!([]),
        }
    }

    /// Opens a gamepad SDL reports, in the lowest free slot. A scripted pad's axes and buttons are re-sent, because
    /// a value set before its gamepad opened never reaches the gamepad otherwise, then SDL updates the gamepads so
    /// the pad's first snapshot carries them.
    pub fn added(&mut self, id: u32) -> Result<()> {
        if self.pads.contains_key(&id) {
            return Ok(());
        }
        let Some(slot) = (0..SLOTS).find(|slot| self.pads.values().all(|pad| pad.slot != *slot))
        else {
            return Ok(());
        };
        let gamepad = self.subsystem.open(JoystickId::new(id))?;
        self.pads.insert(id, Pad { slot, gamepad });
        if let Some(pad) = self
            .virtuals
            .values()
            .find(|pad| pad.joystick.id().raw() == id)
        {
            for (axis, value) in pad.axes.iter().enumerate() {
                pad.joystick.set_virtual_axis(axis as u32, *value)?;
            }
            for button in 0..u32::BITS {
                if pad.buttons & (1 << button) != 0 {
                    pad.joystick.set_virtual_button(button, true)?;
                }
            }
            unsafe { sys::joystick::SDL_UpdateJoysticks() };
        }
        Ok(())
    }

    pub fn removed(&mut self, id: u32) {
        self.pads.remove(&id);
    }

    /// The `gamepads` input fact when any pad changed since the last one.
    pub fn snapshot(&mut self) -> Option<Value> {
        let pads: Vec<Value> = self
            .pads
            .values()
            .map(|Pad { slot, gamepad }| {
                let buttons: Vec<f64> = BUTTONS
                    .iter()
                    .enumerate()
                    .map(|(index, button)| match (index, button) {
                        (6, _) => trigger(gamepad.axis(Axis::TriggerLeft)),
                        (7, _) => trigger(gamepad.axis(Axis::TriggerRight)),
                        (_, Some(button)) => f64::from(u8::from(gamepad.button(*button))),
                        (_, None) => 0.0,
                    })
                    .collect();
                let axes: Vec<f64> = AXES.iter().map(|axis| stick(gamepad.axis(*axis))).collect();
                let name = gamepad.name().unwrap_or_default();
                let id = id(
                    gamepad.r#type(),
                    &name,
                    gamepad.vendor_id().unwrap_or(0),
                    gamepad.product_id().unwrap_or(0),
                );
                json!({"index": slot, "id": id, "buttons": buttons, "axes": axes})
            })
            .collect();
        let pads = Value::Array(pads);
        if pads == self.last {
            return None;
        }
        self.last = pads.clone();
        Some(json!({"type": "gamepads", "pads": pads}))
    }

    /// The virtual Xbox 360 pad for script index `index`, attached on first use.
    fn virtual_pad(&mut self, index: u8) -> Result<&Joystick> {
        if !self.virtuals.contains_key(&index) {
            let name = c"Xbox 360 Controller";
            let mut desc = sys::joystick::SDL_VirtualJoystickDesc::new();
            desc.r#type = sys::joystick::SDL_JOYSTICK_TYPE_GAMEPAD.0 as u16;
            desc.vendor_id = 0x045e;
            desc.product_id = 0x028e;
            desc.naxes = sys::gamepad::SDL_GAMEPAD_AXIS_COUNT.0 as u16;
            desc.nbuttons = sys::gamepad::SDL_GAMEPAD_BUTTON_DPAD_RIGHT.0 as u16 + 1;
            desc.axis_mask = (1 << desc.naxes) - 1;
            desc.button_mask = (1 << desc.nbuttons) - 1;
            desc.name = name.as_ptr();
            let id = unsafe { sys::joystick::SDL_AttachVirtualJoystick(&desc) };
            if id.0 == 0 {
                return Err(anyhow!("attach a virtual gamepad: {}", sdl3::get_error()));
            }
            let joystick = self.joysticks.open(id.into())?;
            let axes = vec![0; sys::gamepad::SDL_GAMEPAD_AXIS_COUNT.0 as usize];
            self.virtuals.insert(
                index,
                Virtual {
                    joystick,
                    axes,
                    buttons: 0,
                },
            );
        }
        Ok(&self.virtuals[&index].joystick)
    }

    /// Presses or releases standard button `button` on virtual pad `index`. Buttons 6 and 7 move its triggers.
    pub fn press(&mut self, index: u8, button: u8, down: bool) -> Result<()> {
        self.virtual_pad(index)?;
        let pad = self.virtuals.get_mut(&index).expect("the pad was attached");
        match button {
            6 | 7 => {
                let (axis, slot) = if button == 6 {
                    (Axis::TriggerLeft, 4)
                } else {
                    (Axis::TriggerRight, 5)
                };
                let raw = if down { i16::MAX } else { i16::MIN };
                pad.joystick.set_virtual_axis(axis.to_ll().0 as u32, raw)?;
                pad.axes[slot] = raw;
            }
            _ => {
                let Some(Some(sdl)) = BUTTONS.get(usize::from(button)) else {
                    return Err(anyhow!("the standard mapping has no button {button}"));
                };
                let bit = sdl.to_ll().0 as u32;
                pad.joystick.set_virtual_button(bit, down)?;
                if down {
                    pad.buttons |= 1 << bit;
                } else {
                    pad.buttons &= !(1 << bit);
                }
            }
        }
        Ok(())
    }

    /// Moves axis `axis` of virtual pad `index` to `value`: standard axes 0 to 3 take -1 to 1, and 4 and 5 are
    /// the left and right triggers, which take 0 to 1. SDL reads a virtual trigger over the axis's whole range.
    pub fn tilt(&mut self, index: u8, axis: u8, value: f64) -> Result<()> {
        self.virtual_pad(index)?;
        let (sdl_axis, raw) = match axis {
            0..=3 => (
                AXES[usize::from(axis)],
                (value.clamp(-1.0, 1.0) * 32767.5 - 0.5).round() as i16,
            ),
            4 | 5 => (
                if axis == 4 {
                    Axis::TriggerLeft
                } else {
                    Axis::TriggerRight
                },
                (value.clamp(0.0, 1.0) * 65535.0 - 32768.0).round() as i16,
            ),
            _ => return Err(anyhow!("a gamepad has no axis {axis}")),
        };
        let pad = self.virtuals.get_mut(&index).expect("the pad was attached");
        pad.axes[usize::from(axis)] = raw;
        pad.joystick
            .set_virtual_axis(sdl_axis.to_ll().0 as u32, raw)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axes_and_triggers_normalize_as_edge_does() {
        assert_eq!(stick(i16::MIN), -1.0);
        assert_eq!(stick(i16::MAX), 1.0);
        assert!(stick(0).abs() < 0.0001);
        assert_eq!(trigger(0), 0.0);
        assert_eq!(trigger(i16::MAX), 1.0);
    }

    #[test]
    fn ids_follow_edges_windows_names() {
        assert_eq!(
            id(
                GamepadType::XboxOne,
                "Xbox Series X Controller",
                0x045e,
                0x0b12
            ),
            "Xbox 360 Controller (XInput STANDARD GAMEPAD)"
        );
        assert_eq!(
            id(
                GamepadType::PS5,
                "DualSense Wireless Controller",
                0x054c,
                0x0ce6
            ),
            "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"
        );
    }

    #[test]
    fn a_virtual_pad_reports_in_the_standard_mapping() -> Result<()> {
        let sdl = sdl3::init()?;
        let mut pads = Gamepads::new(sdl.gamepad()?, sdl.joystick()?);
        let mut events = sdl.event_pump()?;
        let mut poll = |pads: &mut Gamepads| -> Result<()> {
            for event in events.poll_iter() {
                if let sdl3::event::Event::GamepadAdded { which, .. } = event {
                    pads.added(which.raw())?;
                }
            }
            Ok(())
        };
        // A fresh pad reports both triggers released, not half pressed.
        pads.press(0, 0, false)?;
        poll(&mut pads)?;
        let fact = pads.snapshot().expect("the pad connects");
        let fresh = &fact["pads"][0];
        assert_eq!(
            fresh["buttons"][6], 0.0,
            "a fresh pad's left trigger is released: {fact}"
        );
        assert_eq!(
            fresh["buttons"][7], 0.0,
            "a fresh pad's right trigger is released: {fact}"
        );
        // A trigger as a second pad's first input exposes it with buttons[7] already pressed, as Edge does.
        pads.tilt(1, 5, 1.0)?;
        poll(&mut pads)?;
        let fact = pads.snapshot().expect("the trigger connects the second pad");
        let triggered = &fact["pads"][1];
        assert_eq!(
            triggered["buttons"][7], 1.0,
            "the first snapshot of the pad carries the trigger: {fact}"
        );
        assert_eq!(triggered["buttons"][6], 0.0, "{fact}");
        pads.press(1, 0, true)?;
        pads.tilt(1, 4, 0.5)?;
        pads.tilt(1, 1, -1.0)?;
        poll(&mut pads)?;
        let fact = pads.snapshot().expect("the pad changed");
        let pad = &fact["pads"][1];
        assert_eq!(pad["id"], "Xbox 360 Controller (XInput STANDARD GAMEPAD)");
        assert_eq!(pad["buttons"][0], 1.0);
        assert_eq!(pad["buttons"][1], 0.0);
        assert_eq!(pad["buttons"][7], 1.0);
        assert!((pad["buttons"][6].as_f64().unwrap_or(0.0) - 0.5).abs() < 0.001);
        assert_eq!(pad["axes"][1], -1.0);
        pads.press(1, 7, false)?;
        poll(&mut pads)?;
        let fact = pads.snapshot().expect("the pad changed");
        assert_eq!(fact["pads"][1]["buttons"][7], 0.0);
        Ok(())
    }
}
