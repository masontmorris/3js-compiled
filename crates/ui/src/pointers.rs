// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Longest the host holds input for the page while it waits for the page's layout at
/// Servo's size. Older held input goes to the page placed on the rects the page listed last.
pub(crate) const HOLD_LIMIT: Duration = Duration::from_millis(250);

pub(crate) type Size = (u32, u32);
type Rect = [f64; 4];

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

#[derive(Debug, Clone, Copy, PartialEq)]
enum Owner {
    Page,
    Game,
    /// The page's, but the ui-host that received its start has stopped.
    Neither,
}

/// A pointer sequence from its first button down to its last button up. As with a browser's
/// implicit pointer capture, all of it goes where its first down went.
struct Press {
    owner: Owner,
    buttons: Vec<i16>,
}

/// Where held input lands in the page's layout at Servo's size.
#[derive(Clone, Copy)]
enum Place {
    /// The same point of the rect at this index.
    Rect { rect: usize, offset: (f64, f64) },
    /// Moved as far as the down that began its press.
    Press,
}

struct Held {
    pointer: Pointer,
    place: Place,
    at: Instant,
}

/// Routes pointer input by the HUD frame on screen. After a resize the host may show a frame
/// laid out at the old size while Servo already lays the page out at the new one, so input is
/// hit-tested against the rects measured at the shown frame's size, then held until the page
/// has been measured at Servo's size and moved to the same point of the same rect there.
#[derive(Default)]
pub(crate) struct Pointers {
    /// The rects the page listed at the sizes of the shown frame, of Servo and of its latest
    /// reply.
    layouts: Vec<(Size, Vec<Rect>)>,
    /// The rects the page listed last.
    last: Vec<Rect>,
    held: VecDeque<Held>,
    press: Option<Press>,
    /// How far `release` moved the down of the page's latest press.
    shift: (f64, f64),
}

impl Pointers {
    /// The page replied while laid out at `size`, listing `rects` when they changed since the
    /// rects it listed last.
    pub fn measured(&mut self, view: View, size: Size, rects: Option<Vec<Rect>>) {
        if let Some(rects) = rects {
            self.last = rects;
        }
        self.layouts
            .retain(|(at, _)| *at != size && (Some(*at) == view.shown || Some(*at) == view.servo));
        self.layouts.push((size, self.last.clone()));
    }
    fn hit(&self, shown: Size, pointer: Pointer) -> Option<Place> {
        let (_, rects) = self.layouts.iter().find(|(at, _)| *at == shown)?;
        rects.iter().enumerate().find_map(|(rect, r)| {
            (pointer.x >= r[0]
                && pointer.y >= r[1]
                && pointer.x < r[0] + r[2]
                && pointer.y < r[1] + r[3])
                .then_some(Place::Rect {
                    rect,
                    offset: (pointer.x - r[0], pointer.y - r[1]),
                })
        })
    }
    /// Whether `pointer` belongs to the page: during a press, whether the press began on a
    /// rect of the frame then on screen; otherwise, whether it lands on a rect of the frame on
    /// screen. Input for the page waits for `release`.
    pub fn pointer(&mut self, view: View, pointer: Pointer, now: Instant) -> bool {
        let place = if let Some(press) = &mut self.press {
            match pointer.action {
                1 if !press.buttons.contains(&pointer.button) => press.buttons.push(pointer.button),
                2 => press.buttons.retain(|button| *button != pointer.button),
                _ => {}
            }
            let owner = press.owner;
            if press.buttons.is_empty() {
                self.press = None;
            }
            match owner {
                Owner::Page => Place::Press,
                Owner::Game => return false,
                Owner::Neither => return true,
            }
        } else {
            let hit = view.shown.and_then(|shown| self.hit(shown, pointer));
            if pointer.action == 1 {
                self.press = Some(Press {
                    owner: if hit.is_some() {
                        Owner::Page
                    } else {
                        Owner::Game
                    },
                    buttons: vec![pointer.button],
                });
            }
            let Some(place) = hit else {
                return false;
            };
            place
        };
        self.held.push_back(Held {
            pointer,
            place,
            at: now,
        });
        true
    }
    /// The held input, in order, placed on the page's layout at Servo's size once Servo lays
    /// the page out at the size the host asked for and the page has replied there, or on the
    /// rects the page listed last once the oldest has waited `HOLD_LIMIT`. Input on a rect
    /// goes to the same offset in the rect at the same index, or to its centre when the rect
    /// has shrunk past the offset, and keeps its own point when the layout lacks the rect. The
    /// rest of a press moves as far as its down. Also returns whether `HOLD_LIMIT` released it.
    pub fn release(&mut self, view: View, now: Instant) -> (Vec<Pointer>, bool) {
        let (rects, late) = match self
            .layouts
            .iter()
            .find(|(at, _)| view.servo == Some(view.requested) && *at == view.requested)
        {
            Some((_, rects)) => (rects, false),
            None if self
                .held
                .front()
                .is_some_and(|held| now.duration_since(held.at) >= HOLD_LIMIT) =>
            {
                (&self.last, true)
            }
            None => return (Vec::new(), false),
        };
        let mut out = Vec::with_capacity(self.held.len());
        for Held { pointer, place, .. } in self.held.drain(..) {
            let (x, y) = match place {
                Place::Rect { rect, offset } => match rects.get(rect) {
                    Some(r) => {
                        let (dx, dy) = if offset.0 < r[2] && offset.1 < r[3] {
                            offset
                        } else {
                            (r[2] / 2.0, r[3] / 2.0)
                        };
                        (r[0] + dx, r[1] + dy)
                    }
                    None => (pointer.x, pointer.y),
                },
                Place::Press => (pointer.x + self.shift.0, pointer.y + self.shift.1),
            };
            if let (Place::Rect { .. }, 1) = (place, pointer.action) {
                self.shift = (x - pointer.x, y - pointer.y);
            }
            out.push(Pointer { x, y, ..pointer });
        }
        (out, late)
    }
    /// ui-host stopped: its layouts and held input go, and the rest of a press it received
    /// goes to neither side.
    pub fn clear(&mut self) {
        self.layouts.clear();
        self.last.clear();
        self.held.clear();
        if let Some(press) = &mut self.press
            && press.owner == Owner::Page
        {
            press.owner = Owner::Neither;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rings::Rings;

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
        /// Releases by `HOLD_LIMIT`.
        late: usize,
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
                late: 0,
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
            self.send(at(action, x));
        }
        fn send(&mut self, pointer: Pointer) {
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
            let (pointers, late) = self.pointers.release(view, self.now);
            self.out.extend(pointers.into_iter().map(Page));
            self.late += usize::from(late);
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
        assert_eq!(host.late, 0);
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

    /// Adversary round 4: a press that starts on the button drawn in the kept old-size frame
    /// and ends, at the same window point, after the new-size frame reaches the screen.
    #[test]
    fn a_press_held_across_the_frame_switch_presses_the_drawn_button() {
        let mut host = Host::new(OLD, right_button(1280));
        host.resize(NEW);
        host.reply(NEW, Some(right_button(1680)));
        host.pointer(1, 1160.0);
        host.publish();
        host.pointer(0, 1170.0);
        host.pointer(2, 1160.0);
        assert_eq!(
            host.take(),
            [
                Page(at(1, 1560.0)),
                Page(at(0, 1570.0)),
                Page(at(2, 1560.0))
            ],
            "the page gets the whole press, moved with its down; the game gets none of it"
        );
    }

    #[test]
    fn a_press_that_began_on_the_game_stays_with_the_game() {
        let mut host = Host::new(OLD, right_button(1280));
        host.resize(NEW);
        host.reply(NEW, Some(right_button(1680)));
        host.pointer(1, 1560.0);
        host.publish();
        host.pointer(0, 1570.0);
        host.pointer(2, 1560.0);
        assert_eq!(
            host.take(),
            [
                Game(at(1, 1560.0)),
                Game(at(0, 1570.0)),
                Game(at(2, 1560.0))
            ],
            "the up lands on the button now drawn, but the press began where none was"
        );
    }

    #[test]
    fn a_second_button_joins_the_press_in_progress() {
        let mut host = Host::new(OLD, right_button(1280));
        host.pointer(1, 1160.0);
        host.pointer(0, 100.0);
        let right = Pointer {
            button: 2,
            ..at(1, 100.0)
        };
        host.send(right);
        host.pointer(2, 100.0);
        host.pointer(0, 100.0);
        let up = Pointer {
            button: 2,
            ..at(2, 100.0)
        };
        host.send(up);
        host.pointer(0, 100.0);
        assert_eq!(
            host.take(),
            [
                Page(at(1, 1160.0)),
                Page(at(0, 100.0)),
                Page(right),
                Page(at(2, 100.0)),
                Page(at(0, 100.0)),
                Page(up),
                Game(at(0, 100.0)),
            ],
            "the press ends at its last button up"
        );
    }

    #[test]
    fn the_rest_of_a_page_press_reaches_neither_side_after_ui_host_stops() {
        let mut host = Host::new(OLD, right_button(1280));
        host.pointer(1, 1160.0);
        host.rings = Rings::default();
        host.pointers.clear();
        host.pointer(0, 1170.0);
        host.pointer(2, 1160.0);
        host.click(1160.0);
        assert_eq!(
            host.take(),
            [
                Page(at(1, 1160.0)),
                Game(at(1, 1160.0)),
                Game(at(2, 1160.0))
            ]
        );
    }

    /// Adversary round 4: while the window is dragged larger, ui-host announces a ring per
    /// resize and the page reports a layout at each size before any frame of them is shown.
    #[test]
    fn a_click_on_the_kept_frame_during_a_drag_presses_the_drawn_button() {
        let mut host = Host::new(OLD, right_button(1280));
        for step in 1..=8 {
            let size = (1280 + 8 * step, 720);
            host.resize(size);
            host.reply(size, Some(right_button(size.0)));
        }
        assert_eq!(host.view().shown, Some(OLD));
        host.click(1160.0);
        assert_eq!(
            host.take(),
            [Page(at(1, 1224.0)), Page(at(2, 1224.0))],
            "drawn at x=1060..1260 on screen; at 1344 the button is at 1124..1324"
        );
    }

    /// Adversary round 4: a page whose replies leave out `rects` when they are unchanged. Its
    /// left-anchored button has the same rect at every width.
    #[test]
    fn a_page_that_lists_unchanged_rects_once_keeps_its_buttons_after_a_resize() {
        let left = vec![[40.0, 20.0, 200.0, 80.0]];
        let mut host = Host::new(OLD, left);
        host.resize(NEW);
        host.click(100.0);
        host.reply(NEW, None);
        host.publish();
        host.click(100.0);
        assert_eq!(
            host.take(),
            [
                Page(at(1, 100.0)),
                Page(at(2, 100.0)),
                Page(at(1, 100.0)),
                Page(at(2, 100.0)),
            ],
            "both clicks are on a drawn button"
        );
    }

    #[test]
    fn a_held_click_reaches_the_page_when_the_page_never_reports_the_new_size() {
        let mut host = Host::new(OLD, right_button(1280));
        host.resize(NEW);
        host.click(1160.0);
        host.wait(HOLD_LIMIT.as_millis() as u64 - 1);
        assert_eq!(host.take(), []);
        host.wait(1);
        assert_eq!(
            host.take(),
            [Page(at(1, 1160.0)), Page(at(2, 1160.0))],
            "placed on the rects the page listed last"
        );
        assert_eq!(host.late, 1);
    }

    #[test]
    fn keeps_a_bounded_number_of_layouts() {
        let mut host = Host::new(OLD, right_button(1280));
        for width in 1281..1400 {
            host.resize((width, 720));
            host.reply((width, 720), Some(right_button(width)));
            host.reply((width - 1, 720), Some(right_button(width - 1)));
        }
        assert!(host.pointers.layouts.len() <= 3);
    }
}
