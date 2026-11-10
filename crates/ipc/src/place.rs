// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::VecDeque;

/// Where the host saw a page pointer event, relative to one of the page's rects, named by its
/// index in the page's `rects`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum At {
    /// Over the rect, `offset` from its top-left corner in the frame on screen.
    Rect { rect: u32, offset: (f32, f32) },
    /// Over no rect, during a press whose down was over the rect: `offset` from the corner
    /// where the frame then on screen drew the rect.
    Beside { rect: u32, offset: (f32, f32) },
}

/// A pointer event the host sends to the page, at its window point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pointer {
    pub action: u8,
    pub x: f32,
    pub y: f32,
    pub button: i16,
    /// The size of the frame on screen the host hit-tested the event in.
    pub size: (u32, u32),
    pub at: At,
}

/// A pointer event at the point ui-host gives Servo.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placed {
    pub action: u8,
    pub x: f32,
    pub y: f32,
    pub button: i16,
}

/// Places the host's pointer events in the layout the page processes them in. An event the host
/// hit-tested in a frame at the size Servo lays the page out at keeps its window point, as in a
/// browser, whatever the page has since done to its rects. The frame on screen can be laid out
/// at an older size than Servo's, so an event hit-tested in it goes to the same offset from the
/// rect at its index in the page's latest layout. An event over a rect that has shrunk past the
/// offset goes to the rect's centre instead. An event for an index the latest layout lacks keeps
/// its window point. Every point is clamped into the viewport, because Servo drops input
/// outside its scene. While a resize waits for the page's layout at the new size, events wait
/// with it, in order.
#[derive(Debug)]
pub struct Placer {
    size: (u32, u32),
    /// The rects the page listed last.
    rects: Vec<[f64; 4]>,
    relaying: bool,
    waiting: VecDeque<Pointer>,
}

impl Placer {
    pub fn new(size: (u32, u32)) -> Self {
        Self {
            size,
            rects: Vec::new(),
            relaying: false,
            waiting: VecDeque::new(),
        }
    }
    /// Servo now lays the page out at `size`. Events wait until `relaid`.
    pub fn resized(&mut self, size: (u32, u32)) {
        self.size = size;
        self.relaying = true;
    }
    /// The page replied, listing `rects` when they changed since the rects it listed last.
    pub fn replied(&mut self, rects: Option<Vec<[f64; 4]>>) {
        if let Some(rects) = rects {
            self.rects = rects;
        }
    }
    /// The page is laid out at the size of the latest resize, or has stopped answering. Returns
    /// the waiting events, placed.
    pub fn relaid(&mut self) -> Vec<Placed> {
        self.relaying = false;
        let waiting = std::mem::take(&mut self.waiting);
        waiting.into_iter().map(|p| self.place(p)).collect()
    }
    /// The event placed now, or `None` while it waits for `relaid`.
    pub fn pointer(&mut self, pointer: Pointer) -> Option<Placed> {
        if self.relaying {
            self.waiting.push_back(pointer);
            return None;
        }
        Some(self.place(pointer))
    }
    fn place(&self, pointer: Pointer) -> Placed {
        let rect = |rect: u32| self.rects.get(rect as usize);
        let (x, y) = match pointer.at {
            _ if pointer.size == self.size => (pointer.x, pointer.y),
            At::Rect { rect: i, offset } if let Some(r) = rect(i) => {
                let (dx, dy) = if f64::from(offset.0) < r[2] && f64::from(offset.1) < r[3] {
                    (f64::from(offset.0), f64::from(offset.1))
                } else {
                    (r[2] / 2.0, r[3] / 2.0)
                };
                ((r[0] + dx) as f32, (r[1] + dy) as f32)
            }
            At::Beside { rect: i, offset } if let Some(r) = rect(i) => {
                (r[0] as f32 + offset.0, r[1] as f32 + offset.1)
            }
            _ => (pointer.x, pointer.y),
        };
        let max = |extent: u32| (extent as f32 - 1.0).max(0.0);
        Placed {
            action: pointer.action,
            x: x.clamp(0.0, max(self.size.0)),
            y: y.clamp(0.0, max(self.size.1)),
            button: pointer.button,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_point_is_inside_the_viewport() {
        let mut placer = Placer::new((1280, 720));
        placer.replied(Some(vec![[1500.0, -40.0, 200.0, 80.0]]));
        let up = |x, y, at| Pointer {
            action: 2,
            x,
            y,
            button: 0,
            size: (1680, 720),
            at,
        };
        let on = At::Rect {
            rect: 0,
            offset: (100.0, 10.0),
        };
        let beside = At::Beside {
            rect: 0,
            offset: (-300.0, 900.0),
        };
        let missing = |rect| At::Rect {
            rect,
            offset: (0.0, 0.0),
        };
        let placed = [
            up(1560.0, 900.0, missing(1)),
            up(-5.0, 60.0, missing(2)),
            up(0.0, 0.0, on),
            up(0.0, 0.0, beside),
        ]
        .map(|p| placer.pointer(p).map(|p| (p.x, p.y)));
        assert_eq!(
            placed,
            [
                Some((1279.0, 719.0)),
                Some((0.0, 60.0)),
                Some((1279.0, 0.0)),
                Some((1200.0, 719.0))
            ]
        );
    }
}
