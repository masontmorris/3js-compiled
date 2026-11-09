use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    Wait {
        frames: u64,
    },
    Key {
        code: String,
        down: bool,
    },
    Pointer {
        action: PointerAction,
        x: f64,
        y: f64,
        #[serde(default)]
        button: u8,
    },
    Wheel {
        x: f64,
        y: f64,
    },
    Gamepad {
        button: u8,
        down: bool,
        #[serde(default)]
        index: u8,
    },
    Resize {
        width: u32,
        height: u32,
    },
    Capture {
        path: PathBuf,
    },
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerAction {
    Move,
    Down,
    Up,
}

pub fn parse(input: &str) -> Result<Vec<Step>, serde_json::Error> {
    serde_json::from_str(input)
}
