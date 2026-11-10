// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::VecDeque;
use std::time::Instant;

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

/// What the host knows of the HUD frames when it routes input.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct View {
    /// The size the frame on screen was laid out at.
    pub shown: Option<Size>,
    /// The size Servo lays the page out at.
    pub servo: Option<Size>,
    /// The size the host last asked ui-host for.
    pub requested: Size,
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
    /// The page replied while laid out at `size`, listing `rects` when they changed.
    pub fn measured(&mut self, _view: View, size: Size, rects: Option<Vec<Rect>>) {
        let Some(rects) = rects else {
            return;
        };
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
    /// Whether `pointer` lands on a rect of the frame on screen. Input that does waits for
    /// `release`; the rest belongs to the game.
    pub fn pointer(&mut self, view: View, pointer: Pointer, _now: Instant) -> bool {
        let Some((rect, r)) = view
            .shown
            .and_then(|shown| self.layout(shown))
            .and_then(|rects| {
                rects.iter().enumerate().find(|(_, r)| {
                    pointer.x >= r[0]
                        && pointer.y >= r[1]
                        && pointer.x < r[0] + r[2]
                        && pointer.y < r[1] + r[3]
                })
            })
        else {
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
    /// The held input, in order, placed on the page's layout at Servo's size once Servo lays
    /// the page out at the size the host asked for and the page has been measured there. A
    /// rect the new layout lacks keeps the input's own point.
    pub fn release(&mut self, view: View, _now: Instant) -> Vec<Pointer> {
        if view.servo != Some(view.requested) {
            return Vec::new();
        }
        let Some((_, rects)) = self.layouts.iter().find(|(at, _)| *at == view.requested) else {
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
    use crate::rings::Rings;
    use std::time::Duration;

    const OLD: Size = (1280, 720);
    const NEW: Size = (1680, 720);

    /// The kept-hit page: a 200x80 button 20 px from the right edge.
    fn right_button(width: u32) -> Vec<Rect> {
        vec![[width as f64 - 220.0, 20.0, 200.0, 80.0]]
    }

    fn at(action: u8, x: f64) -> Pointer {
        Pointer {
            action,
            x,
            y: 60.0,
            button: 0,
        }
    }

    #[derive(Debug, PartialEq)]
    enum To {
        Page(Pointer),
        Game(Pointer),
    }
    use To::{Game, Page};

    /// `Ui` without the pipe and D3D: the real `Rings` and `Pointers`, given ui-host's
    /// messages and the game's input as `Ui::update` and `Ui::pointer` give them.
    struct Host {
        rings: Rings<()>,
        pointers: Pointers,
        requested: Size,
        generation: u64,
        pub_id: u64,
        now: Instant,
        out: Vec<To>,
    }

    impl Host {
        /// A page laid out at `size` with `rects`, its first frame on screen.
        fn new(size: Size, rects: Vec<Rect>) -> Self {
            let mut host = Host {
                rings: Rings::default(),
                pointers: Pointers::default(),
                requested: size,
                generation: 0,
                pub_id: 0,
                now: Instant::now(),
                out: Vec::new(),
            };
            host.resize(size);
            host.reply(size, Some(rects));
            host.publish();
            host
        }
        fn view(&self) -> View {
            self.rings.view(self.requested)
        }
        /// The host sends Resize; ui-host resizes the page and announces a ring at that size.
        fn resize(&mut self, size: Size) {
            self.requested = size;
            self.generation += 1;
            self.rings.announced(self.generation, size);
            self.rings.opened(self.generation, vec![(), (), ()]);
        }
        /// A page reply from ui-host while the page is laid out at `size`.
        fn reply(&mut self, size: Size, rects: Option<Vec<Rect>>) {
            self.pointers.measured(self.view(), size, rects);
            self.update();
        }
        /// ui-host publishes a frame into its newest ring and the host shows it.
        fn publish(&mut self) {
            self.pub_id += 1;
            self.rings
                .published((self.pub_id % 3) as usize, self.pub_id, self.pub_id);
            assert_eq!(self.rings.pick(self.pub_id), Some(self.pub_id));
            self.update();
        }
        fn pointer(&mut self, action: u8, x: f64) {
            let pointer = at(action, x);
            if !self.pointers.pointer(self.view(), pointer, self.now) {
                self.out.push(Game(pointer));
            }
            self.update();
        }
        fn click(&mut self, x: f64) {
            self.pointer(1, x);
            self.pointer(2, x);
        }
        fn update(&mut self) {
            let view = self.view();
            for pointer in self.pointers.release(view, self.now) {
                self.out.push(Page(pointer));
            }
        }
        fn wait(&mut self, ms: u64) {
            self.now += Duration::from_millis(ms);
            self.update();
        }
        fn take(&mut self) -> Vec<To> {
            std::mem::take(&mut self.out)
        }
    }

    #[test]
    fn a_click_on_the_kept_frame_presses_the_button_drawn_there() {
        let mut host = Host::new(OLD, right_button(1280));
        host.resize(NEW);
        host.click(1160.0);
        assert_eq!(
            host.take(),
            [],
            "drawn at x=1060..1260; not measured at 1680 yet"
        );
        host.reply(NEW, Some(right_button(1680)));
        assert_eq!(host.take(), [Page(at(1, 1560.0)), Page(at(2, 1560.0))]);
        host.wait(1000);
        assert_eq!(host.take(), []);
    }

    #[test]
    fn a_click_where_the_kept_frame_draws_nothing_goes_to_the_game() {
        let mut host = Host::new(OLD, right_button(1280));
        host.resize(NEW);
        host.reply(NEW, Some(right_button(1680)));
        host.click(1560.0);
        assert_eq!(
            host.take(),
            [Game(at(1, 1560.0)), Game(at(2, 1560.0))],
            "the new button is not drawn yet"
        );
        host.publish();
        host.click(1560.0);
        host.click(1160.0);
        assert_eq!(
            host.take(),
            [
                Page(at(1, 1560.0)),
                Page(at(2, 1560.0)),
                Game(at(1, 1160.0)),
                Game(at(2, 1160.0)),
            ]
        );
    }

    #[test]
    fn held_input_keeps_its_order_and_its_point_without_a_matching_rect() {
        let mut host = Host::new(OLD, right_button(1280));
        host.resize(NEW);
        host.click(1100.0);
        host.reply(NEW, Some(vec![]));
        assert_eq!(host.take(), [Page(at(1, 1100.0)), Page(at(2, 1100.0))]);
    }

    #[test]
    fn a_held_click_outside_its_shrunk_rect_lands_at_the_rect_centre() {
        let mut host = Host::new(OLD, vec![[1060.0, 20.0, 200.0, 80.0]]);
        host.resize(NEW);
        host.click(1240.0);
        host.reply(NEW, Some(vec![[1460.0, 20.0, 100.0, 80.0]]));
        assert_eq!(host.take(), [Page(at(1, 1510.0)), Page(at(2, 1510.0))]);
    }

    #[test]
    fn keeps_a_bounded_number_of_layouts() {
        let mut pointers = Pointers::default();
        for width in 0..10 {
            let size = (width, 720);
            let view = View {
                shown: Some(OLD),
                servo: Some(size),
                requested: size,
            };
            pointers.measured(view, size, Some(right_button(width)));
        }
        assert!(pointers.layouts.len() <= LAYOUTS);
    }
}
