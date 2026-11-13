// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use threejsc_ipc::place::{At, Ids, Rect};

pub(crate) type Size = (u32, u32);

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
}

/// Where a pointer event goes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Route {
    Game,
    /// To the page, for ui-host to place by `At` in the layout the page processes it in.
    Page(At),
    /// To neither side: the rest of a press whose ui-host has stopped.
    Neither,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Owner {
    /// The page's, begun over the rect with ids `ids`, drawn with its corner at `corner`.
    Page {
        ids: Ids,
        corner: (f64, f64),
    },
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

/// Routes pointer input by the HUD frame on screen. After a resize the host may show a frame
/// laid out at the old size while Servo already lays the page out at the new one, so input is
/// hit-tested against the rects measured at the shown frame's size and sent with the ids of the
/// rect it was made over. ui-host places it on the rect with those ids in the page's current
/// layout.
#[derive(Default)]
pub(crate) struct Pointers {
    /// The rects the page listed at the sizes of the shown frame, of Servo and of its latest
    /// reply, with the number of the reply each layout is from.
    layouts: Vec<(Size, u64, Vec<Rect>)>,
    /// The page's replies so far; ui-host numbers its replies the same way.
    replies: u64,
    /// The rects the page listed last.
    last: Vec<Rect>,
    press: Option<Press>,
}

impl Pointers {
    /// The page replied while laid out at `size`, listing `rects` when they changed since the
    /// rects it listed last.
    pub fn measured(&mut self, view: View, size: Size, rects: Option<Vec<Rect>>) {
        if let Some(rects) = rects {
            self.last = rects;
        }
        self.replies += 1;
        self.layouts.retain(|(at, _, _)| {
            *at != size && (Some(*at) == view.shown || Some(*at) == view.servo)
        });
        self.layouts.push((size, self.replies, self.last.clone()));
    }
    /// The number of the reply whose rects a pointer in the frame on screen is hit-tested on.
    pub fn reply_at(&self, shown: Option<Size>) -> Option<u64> {
        let (_, reply, _) = self.layouts.iter().find(|(at, _, _)| Some(*at) == shown)?;
        Some(*reply)
    }
    /// The ids and corner of the rect under `pointer` in the frame on screen.
    fn hit(&self, shown: Option<Size>, pointer: Pointer) -> Option<(Ids, (f64, f64))> {
        let (_, _, rects) = self.layouts.iter().find(|(at, _, _)| Some(*at) == shown)?;
        rects.iter().find_map(|&Rect { ids, bounds: r }| {
            (pointer.x >= r[0]
                && pointer.y >= r[1]
                && pointer.x < r[0] + r[2]
                && pointer.y < r[1] + r[3])
                .then_some((ids, (r[0], r[1])))
        })
    }
    /// Where `pointer` goes: during a press, where the press's down went; otherwise to the
    /// page when it lands on a rect of the frame on screen. Page input is placed on the rect it
    /// was made over, or, during a press and over no rect, beside the rect the down was over.
    pub fn pointer(&mut self, shown: Option<Size>, pointer: Pointer) -> Route {
        let hit = self.hit(shown, pointer);
        let offset =
            |corner: (f64, f64)| ((pointer.x - corner.0) as f32, (pointer.y - corner.1) as f32);
        let on = hit.map(|(ids, corner)| At::Rect {
            ids,
            offset: offset(corner),
        });
        let owner = if let Some(press) = &mut self.press {
            match pointer.action {
                1 if !press.buttons.contains(&pointer.button) => press.buttons.push(pointer.button),
                2 => press.buttons.retain(|button| *button != pointer.button),
                _ => {}
            }
            let owner = press.owner;
            if press.buttons.is_empty() {
                self.press = None;
            }
            owner
        } else {
            // An up with no press open ends a press whose down went to the game before this UI
            // existed, so it goes to the game wherever it lands.
            let owner = match hit {
                Some((ids, corner)) if pointer.action != 2 => Owner::Page { ids, corner },
                _ => Owner::Game,
            };
            if pointer.action == 1 {
                self.press = Some(Press {
                    owner,
                    buttons: vec![pointer.button],
                });
            }
            owner
        };
        match owner {
            Owner::Page { ids, corner } => Route::Page(on.unwrap_or(At::Beside {
                ids,
                offset: offset(corner),
            })),
            Owner::Game => Route::Game,
            Owner::Neither => Route::Neither,
        }
    }
    /// ui-host stopped: its layouts go, and the rest of a press it received goes to neither
    /// side.
    pub fn clear(&mut self) {
        self.layouts.clear();
        self.last.clear();
        if let Some(press) = &mut self.press
            && let Owner::Page { .. } = press.owner
        {
            press.owner = Owner::Neither;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rings::Rings;
    use threejsc_ipc::place::{self, Placer};

    const OLD: Size = (1280, 720);
    const NEW: Size = (1680, 720);
    /// The ids ui-host gives the elements of the test pages.
    const BUTTON: u32 = 1;
    const WARNING: u32 = 2;
    const OTHER: u32 = 3;

    fn rect(id: u32, bounds: [f64; 4]) -> Rect {
        Rect {
            ids: [id, 0, 0, 0],
            bounds,
        }
    }

    /// The kept-hit page: a 200x80 button 20 px from the right edge.
    fn right_button(width: u32) -> Vec<Rect> {
        vec![rect(BUTTON, [width as f64 - 220.0, 20.0, 200.0, 80.0])]
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

    /// `Ui` and ui-host without the pipe, D3D and Servo: the real `Rings`, `Pointers` and
    /// `Placer`, given ui-host's messages and the game's input as `Ui::update` and `Ui::pointer`
    /// give them. `Page` holds each point as ui-host gives it to Servo.
    struct Host {
        rings: Rings<()>,
        pointers: Pointers,
        /// The size ui-host lays the page out at.
        servo: Size,
        placer: Placer,
        generation: u64,
        pub_id: u64,
        out: Vec<To>,
    }

    impl Host {
        /// A page laid out at `size` with `rects`, its first frame on screen.
        fn new(size: Size, rects: Vec<Rect>) -> Self {
            let mut host = Host {
                rings: Rings::default(),
                pointers: Pointers::default(),
                servo: size,
                placer: Placer::new(size),
                generation: 0,
                pub_id: 0,
                out: Vec::new(),
            };
            host.resize(size);
            host.reply(size, Some(rects));
            host.publish();
            host
        }
        fn view(&self) -> View {
            self.rings.view()
        }
        /// ui-host applies a resize and announces a ring at that size.
        fn resize(&mut self, size: Size) {
            self.servo = size;
            self.placer.resized(size);
            self.generation += 1;
            self.rings.announced(self.generation, size);
            self.rings.opened(self.generation, vec![(), (), ()]);
        }
        /// A page reply while laid out at `size`. A reply at ui-host's size ends its relayout.
        fn reply(&mut self, size: Size, rects: Option<Vec<Rect>>) {
            self.pointers.measured(self.view(), size, rects.clone());
            self.placer.replied(rects);
            if size == self.servo {
                self.relaid();
            }
        }
        /// ui-host's relayout ends, with or without a reply at its size.
        fn relaid(&mut self) {
            let placed = self.placer.relaid();
            self.page(placed);
        }
        fn page(&mut self, placed: impl IntoIterator<Item = place::Placed>) {
            self.out.extend(placed.into_iter().map(|p| {
                Page(Pointer {
                    action: p.action,
                    x: p.x.into(),
                    y: p.y.into(),
                    button: p.button,
                })
            }));
        }
        /// ui-host publishes a frame into its newest ring and the host shows it.
        fn publish(&mut self) {
            self.pub_id += 1;
            self.rings
                .published((self.pub_id % 3) as usize, self.pub_id, self.pub_id);
            assert_eq!(self.rings.pick(self.pub_id), Some(self.pub_id));
        }
        fn pointer(&mut self, action: u8, x: f64) {
            self.send(at(action, x));
        }
        fn send(&mut self, pointer: Pointer) {
            let shown = self.view().shown;
            match self.pointers.pointer(shown, pointer) {
                Route::Game => self.out.push(Game(pointer)),
                Route::Page(at) => {
                    let placed = self.placer.pointer(place::Pointer {
                        action: pointer.action,
                        x: pointer.x as f32,
                        y: pointer.y as f32,
                        button: pointer.button,
                        size: shown.unwrap_or_default(),
                        at,
                    });
                    self.page(placed);
                }
                Route::Neither => {}
            }
        }
        fn click(&mut self, x: f64) {
            self.pointer(1, x);
            self.pointer(2, x);
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
            "drawn at x=1060..1260; not laid out at 1680 yet"
        );
        host.reply(NEW, Some(right_button(1680)));
        assert_eq!(host.take(), [Page(at(1, 1560.0)), Page(at(2, 1560.0))]);
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
        let mut host = Host::new(OLD, vec![rect(BUTTON, [1060.0, 20.0, 200.0, 80.0])]);
        host.resize(NEW);
        host.click(1240.0);
        host.reply(NEW, Some(vec![rect(BUTTON, [1460.0, 20.0, 100.0, 80.0])]));
        assert_eq!(host.take(), [Page(at(1, 1510.0)), Page(at(2, 1510.0))]);
    }

    /// Adversary round 4: a press that starts on the button drawn in the kept old-size frame
    /// and ends, at the same window point, after the new-size frame reaches the screen.
    #[test]
    fn a_press_held_across_the_frame_switch_ends_where_the_pointer_is() {
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
                Page(at(0, 1170.0)),
                Page(at(2, 1160.0))
            ],
            "the down is on the drawn button; the frame on screen then draws nothing at 1160"
        );
    }

    #[test]
    fn a_press_dragged_off_its_button_ends_off_it() {
        let mut host = Host::new(OLD, right_button(1280));
        host.pointer(1, 1160.0);
        host.pointer(0, 900.0);
        host.pointer(2, 900.0);
        assert_eq!(
            host.take(),
            [Page(at(1, 1160.0)), Page(at(0, 900.0)), Page(at(2, 900.0))]
        );
    }

    #[test]
    fn a_release_with_no_press_goes_to_the_game() {
        // The down went to the game before this UI existed, or before a device replacement
        // started it again, so its up belongs to the game too.
        let mut host = Host::new(OLD, right_button(1280));
        host.pointer(2, 1160.0);
        assert_eq!(
            host.take(),
            [Game(at(2, 1160.0))],
            "the up lands on the button"
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
        let left = vec![rect(BUTTON, [40.0, 20.0, 200.0, 80.0])];
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
        assert_eq!(host.take(), []);
        host.relaid();
        assert_eq!(
            host.take(),
            [Page(at(1, 1160.0)), Page(at(2, 1160.0))],
            "placed on the rects the page listed last"
        );
    }

    /// Adversary round 5: a press whose down reached the page before a resize, released on the
    /// button still drawn in the kept old-size frame.
    #[test]
    fn an_up_on_the_kept_frame_after_a_resize_mid_press_lands_on_the_button() {
        let mut host = Host::new(OLD, right_button(1280));
        host.pointer(1, 1160.0);
        assert_eq!(host.take(), [Page(at(1, 1160.0))], "down delivered at once");
        host.resize(NEW);
        assert_eq!(host.view().shown, Some(OLD));
        host.pointer(2, 1160.0);
        host.reply(NEW, Some(right_button(1680)));
        assert_eq!(
            host.take(),
            [Page(at(2, 1560.0))],
            "the up is on the drawn button; at 1680 the button is at 1460..1660"
        );
    }

    /// Adversary round 5: a press that begins on the kept frame during a resize and ends after
    /// a resize back, on the button drawn in the old-size frame.
    #[test]
    fn a_press_spanning_two_resizes_ends_on_the_drawn_button() {
        let mut host = Host::new(OLD, right_button(1280));
        host.resize(NEW);
        host.pointer(1, 1160.0);
        host.reply(NEW, Some(right_button(1680)));
        host.publish();
        host.resize(OLD);
        host.reply(OLD, Some(right_button(1280)));
        host.publish();
        assert_eq!(host.view().shown, Some(OLD));
        host.pointer(2, 1160.0);
        host.click(1160.0);
        assert_eq!(
            host.take(),
            [
                Page(at(1, 1560.0)),
                Page(at(2, 1160.0)),
                Page(at(1, 1160.0)),
                Page(at(2, 1160.0)),
            ],
            "the up is on the button drawn at 1060..1260 in a 1280 px page, and the next click \
             reaches the page"
        );
    }

    /// Adversary round 5: during a drag the host has asked for a newer size than Servo's, and a
    /// click on the frame on screen waits for the page's layout at Servo's size.
    #[test]
    fn a_click_during_a_drag_lands_on_the_button_at_servos_size() {
        const S1: Size = (1380, 720);
        const S2: Size = (1480, 720);
        let mut host = Host::new(OLD, right_button(1280));
        host.resize(S1);
        host.reply(S1, Some(right_button(S1.0)));
        host.publish();
        host.resize(S2);
        assert_eq!(host.view().shown, Some(S1), "button drawn at 1160..1360");
        assert_eq!(
            host.view().servo,
            Some(S2),
            "Servo lays it out at 1260..1460"
        );
        host.click(1170.0);
        host.reply(S2, Some(right_button(S2.0)));
        assert_eq!(host.take(), [Page(at(1, 1270.0)), Page(at(2, 1270.0))]);
    }

    /// Adversary round 6: a page whose warning, listed before its button, has just appeared.
    /// ui-host has the reply that lists it; the host has not read that reply yet. Nothing
    /// resizes.
    #[test]
    fn a_click_on_a_fixed_button_lands_on_it_when_a_rect_appears_before_it() {
        let warning = rect(WARNING, [40.0, 20.0, 200.0, 80.0]);
        let mut host = Host::new(OLD, right_button(1280));
        host.placer
            .replied(Some(vec![warning, right_button(1280)[0]]));
        host.click(1160.0);
        assert_eq!(
            host.take(),
            [Page(at(1, 1160.0)), Page(at(2, 1160.0))],
            "the button did not move; the click is at 1160 on it"
        );
    }

    /// Adversary round 6: the same page when the warning has just gone. ui-host's latest reply
    /// lacks it; the host's latest does not. A rect after the button takes the button's place
    /// in ui-host's list.
    #[test]
    fn a_click_on_a_fixed_button_lands_on_it_when_a_rect_before_it_goes() {
        let warning = rect(WARNING, [40.0, 20.0, 200.0, 80.0]);
        let other = rect(OTHER, [40.0, 140.0, 200.0, 80.0]);
        let mut host = Host::new(OLD, vec![warning, right_button(1280)[0], other]);
        host.placer
            .replied(Some(vec![right_button(1280)[0], other]));
        host.click(1160.0);
        assert_eq!(host.take(), [Page(at(1, 1160.0)), Page(at(2, 1160.0))]);
    }

    /// Adversary round 6: two right-anchored buttons, A 20 px from the right edge and B 420 px
    /// from it. A press on A held still at 1160 while the window grows to 1680, where B is
    /// drawn at 1060..1260, ends on B, as in a browser.
    #[test]
    fn a_press_held_still_while_a_resize_moves_another_button_under_it_ends_on_that_button() {
        let two = |w: u32| {
            vec![
                rect(BUTTON, [w as f64 - 220.0, 20.0, 200.0, 80.0]),
                rect(OTHER, [w as f64 - 620.0, 20.0, 200.0, 80.0]),
            ]
        };
        let mut host = Host::new(OLD, two(1280));
        host.pointer(1, 1160.0);
        host.resize(NEW);
        host.reply(NEW, Some(two(1680)));
        host.publish();
        host.pointer(2, 1160.0);
        assert_eq!(host.take(), [Page(at(1, 1160.0)), Page(at(2, 1160.0))]);
    }

    /// Adversary round 7: the round-6 blink page during a resize. The host hit-tests the frame
    /// at 1280, whose reply listed the warning before the button; the page's reply at 1680 does
    /// not.
    #[test]
    fn a_click_on_the_kept_frame_lands_on_its_button_when_a_rect_before_it_goes() {
        let warning = rect(WARNING, [40.0, 20.0, 200.0, 80.0]);
        let mut host = Host::new(OLD, vec![warning, right_button(1280)[0]]);
        host.resize(NEW);
        host.reply(NEW, Some(right_button(1680)));
        host.click(1160.0);
        assert_eq!(
            host.take(),
            [Page(at(1, 1560.0)), Page(at(2, 1560.0))],
            "drawn at 1060..1260; at 1680 the button is at 1460..1660"
        );
    }

    /// Adversary round 7: the same when the warning appears in the reply at 1680.
    #[test]
    fn a_click_on_the_kept_frame_lands_on_its_button_when_a_rect_appears_before_it() {
        let warning = rect(WARNING, [40.0, 20.0, 200.0, 80.0]);
        let mut host = Host::new(OLD, right_button(1280));
        host.resize(NEW);
        host.reply(NEW, Some(vec![warning, right_button(1680)[0]]));
        host.click(1160.0);
        assert_eq!(host.take(), [Page(at(1, 1560.0)), Page(at(2, 1560.0))]);
    }

    #[test]
    fn a_click_on_the_kept_frame_lands_on_its_button_when_the_page_reorders_its_rects() {
        let other = rect(OTHER, [40.0, 140.0, 200.0, 80.0]);
        let mut host = Host::new(OLD, vec![right_button(1280)[0], other]);
        host.resize(NEW);
        host.reply(NEW, Some(vec![other, right_button(1680)[0]]));
        host.click(1160.0);
        assert_eq!(host.take(), [Page(at(1, 1560.0)), Page(at(2, 1560.0))]);
    }

    /// Adversary round 8: a button whose centre lies outside the window at 1280 (drawn at
    /// 1180..1380, visible at 1180..1280). `tick.js` names it by its box, so it has an id.
    #[test]
    fn a_click_on_the_kept_frame_lands_on_a_button_whose_centre_is_outside_the_window() {
        let button = |w: u32| vec![rect(BUTTON, [w as f64 - 100.0, 20.0, 200.0, 80.0])];
        let mut host = Host::new(OLD, button(1280));
        host.resize(NEW);
        host.reply(NEW, Some(button(1680)));
        host.click(1230.0);
        assert_eq!(
            host.take(),
            [Page(at(1, 1630.0)), Page(at(2, 1630.0))],
            "drawn at 1180..1380; at 1680 the button is at 1580..1780"
        );
    }

    /// kit9's relabel page during a resize: the rect names the label span the page rebuilds
    /// every tick, and lists the button `c` among its more ids. At 1680 the label is a new
    /// element, so only `c`'s id is in both replies.
    #[test]
    fn a_click_on_the_kept_frame_lands_on_its_button_when_the_page_rebuilt_its_label() {
        let labelled = |label: u32, w: u32| Rect {
            ids: [label, BUTTON, 0, 0],
            bounds: [w as f64 - 220.0, 20.0, 200.0, 80.0],
        };
        let mut host = Host::new(OLD, vec![labelled(10, 1280)]);
        host.resize(NEW);
        host.reply(NEW, Some(vec![labelled(11, 1680)]));
        host.click(1160.0);
        assert_eq!(host.take(), [Page(at(1, 1560.0)), Page(at(2, 1560.0))]);
    }

    /// The adversary's equip page: buttons `a` and `c` filled one slot in turn. The frame at 1280
    /// drew `c` in the slot, and the slot is among the more ids of whichever button fills it. At
    /// 1680 `c` is still in the slot, now listed after `a`, which lists the slot no more.
    #[test]
    fn a_click_on_the_kept_frame_goes_to_the_rect_naming_its_element_before_one_listing_it() {
        const A: u32 = 4;
        const SLOT: u32 = 5;
        let bag = |ids| Rect {
            ids,
            bounds: [40.0, 20.0, 200.0, 80.0],
        };
        let slot = |w: u32| Rect {
            ids: [BUTTON, SLOT, 0, 0],
            bounds: [w as f64 - 220.0, 20.0, 200.0, 80.0],
        };
        let mut host = Host::new(OLD, vec![bag([A, 0, 0, 0]), slot(1280)]);
        host.resize(NEW);
        host.reply(NEW, Some(vec![bag([A, BUTTON, 0, 0]), slot(1680)]));
        host.click(1160.0);
        assert_eq!(host.take(), [Page(at(1, 1560.0)), Page(at(2, 1560.0))]);
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
