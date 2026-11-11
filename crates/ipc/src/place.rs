// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::VecDeque;

/// The ids of the elements a rect names: first the element it names, then up to three more
/// elements whose box it is, or 0. ui-host gives each element one id for the page's lifetime, so
/// an id names the same element in every reply, whatever the page does to the order of its rects.
/// 0 names no element.
pub type Ids = [u32; 4];

/// One of the rects a page reply lists, `[x, y, width, height]` in window pixels, with the ids of
/// the elements whose border box it is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub ids: Ids,
    pub bounds: [f64; 4],
}

/// Where the host saw a page pointer event, relative to one of the page's rects, named by its
/// ids.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum At {
    /// Over the rect, `offset` from its top-left corner in the frame on screen.
    Rect { ids: Ids, offset: (f32, f32) },
    /// Over no rect, during a press whose down was over the rect: `offset` from the corner
    /// where the frame then on screen drew the rect.
    Beside { ids: Ids, offset: (f32, f32) },
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
/// rect with its id in the page's latest layout. An event over a rect that has shrunk past the
/// offset goes to the rect's centre instead. An event for an id the latest layout lacks keeps
/// its window point. Every point is clamped into the viewport, because Servo drops input
/// outside its scene. While a resize waits for the page's layout at the new size, events wait
/// with it, in order.
#[derive(Debug)]
pub struct Placer {
    size: (u32, u32),
    /// The rects the page listed last.
    rects: Vec<Rect>,
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
    pub fn replied(&mut self, rects: Option<Vec<Rect>>) {
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
        let rect = |ids: Ids| {
            self.rects
                .iter()
                .find(|rect| ids[0] != 0 && rect.ids[0] == ids[0])
                .map(|rect| rect.bounds)
        };
        let (x, y) = match pointer.at {
            _ if pointer.size == self.size => (pointer.x, pointer.y),
            At::Rect { ids, offset } if let Some(r) = rect(ids) => {
                let (dx, dy) = if f64::from(offset.0) < r[2] && f64::from(offset.1) < r[3] {
                    (f64::from(offset.0), f64::from(offset.1))
                } else {
                    (r[2] / 2.0, r[3] / 2.0)
                };
                ((r[0] + dx) as f32, (r[1] + dy) as f32)
            }
            At::Beside { ids, offset } if let Some(r) = rect(ids) => {
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

    /// An event over a rect whose named element is gone goes to the first rect in the latest
    /// layout that has one of the event's more ids, taken in the event's order.
    #[test]
    fn an_event_whose_element_is_gone_goes_to_a_rect_with_one_of_its_more_ids() {
        let mut placer = Placer::new((1680, 720));
        let rect = |ids, x| Rect {
            ids,
            bounds: [x, 20.0, 200.0, 80.0],
        };
        placer.replied(Some(vec![
            rect([8, 4, 0, 0], 40.0),
            rect([9, 3, 0, 0], 440.0),
            rect([3, 0, 0, 0], 840.0),
        ]));
        let on = |ids| Pointer {
            action: 1,
            x: 10.0,
            y: 30.0,
            button: 0,
            size: (1280, 720),
            at: At::Rect {
                ids,
                offset: (10.0, 10.0),
            },
        };
        let placed = [[5, 4, 3, 0], [5, 3, 4, 0], [3, 4, 0, 0], [5, 6, 0, 0]]
            .map(|ids| placer.pointer(on(ids)).map(|p| p.x));
        assert_eq!(placed, [Some(50.0), Some(850.0), Some(850.0), Some(10.0)]);
    }

    #[test]
    fn every_point_is_inside_the_viewport() {
        let mut placer = Placer::new((1280, 720));
        placer.replied(Some(vec![Rect {
            ids: [1, 0, 0, 0],
            bounds: [1500.0, -40.0, 200.0, 80.0],
        }]));
        let up = |x, y, at| Pointer {
            action: 2,
            x,
            y,
            button: 0,
            size: (1680, 720),
            at,
        };
        let on = At::Rect {
            ids: [1, 0, 0, 0],
            offset: (100.0, 10.0),
        };
        let beside = At::Beside {
            ids: [1, 0, 0, 0],
            offset: (-300.0, 900.0),
        };
        let missing = |id| At::Rect {
            ids: [id, 0, 0, 0],
            offset: (0.0, 0.0),
        };
        let placed = [
            up(1560.0, 900.0, missing(2)),
            up(-5.0, 60.0, missing(0)),
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
