// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::VecDeque;

pub(crate) type Size = (u32, u32);
type Rect = [f64; 4];

/// Viewport sizes whose layout the host keeps: enough for the shown frame and Servo's newest.
const LAYOUTS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Pointer {
    pub action: u8,
    pub x: f64,
    pub y: f64,
    pub button: i16,
}

/// Input for the page, recorded as a point inside one of its rects.
struct Held {
    pointer: Pointer,
    rect: usize,
    offset: (f64, f64),
}

/// Routes pointer input by the HUD frame on screen. After a resize the host may show a frame
/// laid out at the old size while Servo already lays the page out at the new one, so input is
/// hit-tested against the rects measured at the shown frame's size, then held until the page
/// has been measured at Servo's size and moved to the same point of the same rect there.
#[derive(Default)]
pub(crate) struct Pointers {
    layouts: VecDeque<(Size, Vec<Rect>)>,
    held: VecDeque<Held>,
}

impl Pointers {
    /// The page listed `rects` while laid out at `size`.
    pub fn measured(&mut self, size: Size, rects: Vec<Rect>) {
        self.layouts.retain(|(at, _)| *at != size);
        if self.layouts.len() == LAYOUTS {
            self.layouts.pop_front();
        }
        self.layouts.push_back((size, rects));
    }
    fn layout(&self, size: Size) -> Option<&[Rect]> {
        self.layouts
            .iter()
            .find(|(at, _)| *at == size)
            .map(|(_, rects)| rects.as_slice())
    }
    /// Whether `pointer` lands on a rect of the frame on screen, laid out at `shown`. Input that
    /// does waits for `release`; the rest belongs to the game.
    pub fn aim(&mut self, shown: Size, pointer: Pointer) -> bool {
        let Some((rect, r)) = self.layout(shown).and_then(|rects| {
            rects.iter().enumerate().find(|(_, r)| {
                pointer.x >= r[0]
                    && pointer.y >= r[1]
                    && pointer.x < r[0] + r[2]
                    && pointer.y < r[1] + r[3]
            })
        }) else {
            return false;
        };
        let offset = (pointer.x - r[0], pointer.y - r[1]);
        self.held.push_back(Held {
            pointer,
            rect,
            offset,
        });
        true
    }
    /// The held input, in order, placed on the layout Servo has at `servo`, once the page has
    /// been measured at that size. A rect the new layout lacks keeps the input's own point.
    pub fn release(&mut self, servo: Size) -> Vec<Pointer> {
        let Some((_, rects)) = self.layouts.iter().find(|(at, _)| *at == servo) else {
            return Vec::new();
        };
        self.held
            .drain(..)
            .map(|held| match rects.get(held.rect) {
                Some(r) => {
                    let (dx, dy) = if held.offset.0 < r[2] && held.offset.1 < r[3] {
                        held.offset
                    } else {
                        (r[2] / 2.0, r[3] / 2.0)
                    };
                    Pointer {
                        x: r[0] + dx,
                        y: r[1] + dy,
                        ..held.pointer
                    }
                }
                None => held.pointer,
            })
            .collect()
    }
    pub fn clear(&mut self) {
        self.layouts.clear();
        self.held.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: Size = (1280, 720);
    const NEW: Size = (1680, 720);

    fn click(x: f64) -> Pointer {
        Pointer {
            action: 1,
            x,
            y: 60.0,
            button: 0,
        }
    }

    /// The kept-hit page: a 200x80 button 20 px from the right edge.
    fn right_button(width: u32) -> Vec<Rect> {
        vec![[width as f64 - 220.0, 20.0, 200.0, 80.0]]
    }

    #[test]
    fn a_click_on_the_kept_frame_presses_the_button_drawn_there() {
        let mut pointers = Pointers::default();
        pointers.measured(OLD, right_button(1280));
        assert!(pointers.aim(OLD, click(1160.0)), "drawn at x=1060..1260");
        assert_eq!(
            pointers.release(NEW),
            vec![],
            "not measured at the new size yet"
        );
        pointers.measured(NEW, right_button(1680));
        assert_eq!(pointers.release(NEW), vec![click(1560.0)]);
        assert_eq!(pointers.release(NEW), vec![]);
    }

    #[test]
    fn a_click_where_the_kept_frame_draws_nothing_goes_to_the_game() {
        let mut pointers = Pointers::default();
        pointers.measured(OLD, right_button(1280));
        pointers.measured(NEW, right_button(1680));
        assert!(
            !pointers.aim(OLD, click(1560.0)),
            "the new button is not drawn yet"
        );
        assert!(pointers.aim(NEW, click(1560.0)));
        assert!(!pointers.aim(NEW, click(1160.0)));
        assert_eq!(pointers.release(NEW), vec![click(1560.0)]);
    }

    #[test]
    fn held_input_keeps_its_order_and_its_point_without_a_matching_rect() {
        let mut pointers = Pointers::default();
        pointers.measured(OLD, right_button(1280));
        let down = click(1100.0);
        let up = Pointer { action: 2, ..down };
        assert!(pointers.aim(OLD, down) && pointers.aim(OLD, up));
        pointers.measured(NEW, vec![]);
        assert_eq!(pointers.release(NEW), vec![down, up]);
    }

    #[test]
    fn keeps_a_bounded_number_of_layouts() {
        let mut pointers = Pointers::default();
        for width in 0..10 {
            pointers.measured((width, 720), right_button(width));
        }
        assert_eq!(pointers.layouts.len(), LAYOUTS);
        assert!(pointers.layout((9, 720)).is_some() && pointers.layout((0, 720)).is_none());
    }
}
