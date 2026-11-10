// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::sync::Arc;

#[cfg_attr(test, derive(Clone, PartialEq, Eq, Hash))]
struct Published {
    slot: usize,
    id: u64,
    ready: u64,
}

/// The rings of shared textures ui-host announced, and the frame the game draws.
///
/// ui-host publishes every frame into its newest ring and may create no ring for a resize
/// (see `threejsc_ipc::next_ring_size`), so frames belong to the newest announced ring
/// whatever size the host last asked for. The shown frame stays until a frame of that ring
/// is ready, which keeps the HUD on screen while a resize is pending.
#[cfg_attr(test, derive(Clone, PartialEq, Eq, Hash))]
pub(crate) struct Rings<S> {
    /// The newest ring's generation and, once opened, its slots.
    newest: Option<(u64, Option<Arc<[S]>>)>,
    published: Vec<Published>,
    shown: Option<(Arc<[S]>, usize)>,
}

impl<S> Default for Rings<S> {
    fn default() -> Self {
        Self {
            newest: None,
            published: Vec::new(),
            shown: None,
        }
    }
}

impl<S> Rings<S> {
    /// ui-host announced ring `generation`; frames published from now on live in it.
    pub fn announced(&mut self, generation: u64) {
        self.newest = Some((generation, None));
        self.published.clear();
    }
    pub fn opened(&mut self, generation: u64, slots: Vec<S>) {
        if let Some((newest, ring)) = &mut self.newest
            && *newest == generation
        {
            *ring = Some(slots.into());
        }
    }
    pub fn published(&mut self, slot: usize, id: u64, ready: u64) {
        self.published.push(Published { slot, id, ready });
    }
    /// Shows the newest frame whose ready fence value is at most `ready`, and returns its id.
    pub fn pick(&mut self, ready: u64) -> Option<u64> {
        let ring = self.newest.as_ref()?.1.as_ref()?;
        let frame = self
            .published
            .iter()
            .filter(|p| p.ready <= ready && p.slot < ring.len())
            .max_by_key(|p| p.id)?;
        let (slot, id) = (frame.slot, frame.id);
        self.shown = Some((ring.clone(), slot));
        self.published.retain(|p| p.id > id);
        Some(id)
    }
    pub fn shown(&self) -> Option<&S> {
        self.shown.as_ref().map(|(ring, slot)| &ring[*slot])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashSet, VecDeque};
    use threejsc_ipc::next_ring_size;

    type Size = (u32, u32);
    const A: Size = (1280, 720);
    const B: Size = (1296, 728);
    const C: Size = (1280, 736);
    const RING: usize = 4;
    const PUBLISHES: u64 = 4;

    #[derive(Clone, PartialEq, Eq, Hash)]
    enum Up {
        Slots(u64),
        Frame(usize, u64),
    }

    /// The host and ui-host sides of the resize protocol, with both pipes. Each model slot
    /// holds its ring's generation, so a shown slot names the ring it came from.
    #[derive(Clone, PartialEq, Eq, Hash)]
    struct Model {
        frame: usize,
        requested: Size,
        rings: Rings<u64>,
        /// The ring the host is opening, and whether the worker has finished.
        opening: Option<(u64, bool)>,
        hud_appeared: bool,
        down: VecDeque<Size>,
        up: VecDeque<Up>,
        /// ui-host's ring sizes, indexed by generation - 1.
        ring_sizes: Vec<Size>,
        /// The generation each published frame was written into, indexed by id - 1.
        frame_rings: Vec<u64>,
    }

    impl Model {
        fn new(size: Size) -> Self {
            Self {
                frame: 0,
                requested: size,
                rings: Rings::default(),
                opening: None,
                hud_appeared: false,
                down: VecDeque::new(),
                up: VecDeque::from([Up::Slots(1)]),
                ring_sizes: vec![size],
                frame_rings: Vec::new(),
            }
        }
        /// One game frame of `Ui::update` at window size `size`.
        fn host_frame(&mut self, size: Size) -> Result<(), String> {
            self.frame += 1;
            if self.requested != size {
                self.down.push_back(size);
                self.requested = size;
            }
            while let Some(message) = self.up.pop_front() {
                match message {
                    Up::Slots(generation) => {
                        self.opening = Some((generation, false));
                        self.rings.announced(generation);
                    }
                    Up::Frame(slot, id) => self.rings.published(slot, id, id),
                }
            }
            if let Some((generation, true)) = self.opening {
                self.rings.opened(generation, vec![generation; RING]);
                self.opening = None;
            }
            if let Some(id) = self.rings.pick(u64::MAX) {
                let shown = *self.rings.shown().unwrap();
                let written = self.frame_rings[id as usize - 1];
                if shown != written {
                    return Err(format!(
                        "frame {id} was written into ring {written}, shown from ring {shown}"
                    ));
                }
            }
            if self.hud_appeared && self.rings.shown().is_none() {
                return Err(format!("HUD hidden at host frame {}", self.frame));
            }
            self.hud_appeared |= self.rings.shown().is_some();
            Ok(())
        }
        /// ui-host reads the first `n` waiting resizes in one batch.
        fn ui_host_reads(&mut self, n: usize) {
            let batch: Vec<_> = self.down.drain(..n).collect();
            let current = *self.ring_sizes.last().unwrap();
            if let Some(size) = next_ring_size(current, batch) {
                self.ring_sizes.push(size);
                self.up.push_back(Up::Slots(self.ring_sizes.len() as u64));
            }
        }
        fn ui_host_publishes(&mut self) {
            self.frame_rings.push(self.ring_sizes.len() as u64);
            let id = self.frame_rings.len() as u64;
            self.up.push_back(Up::Frame(id as usize % RING, id));
        }
        fn shown_size(&self) -> Option<Size> {
            self.rings
                .shown()
                .map(|&generation| self.ring_sizes[generation as usize - 1])
        }
    }

    /// Explores every order of game frames, ui-host batches of any length, ui-host frames
    /// and ring imports while the window takes the sizes in `script`, one per game frame.
    /// From each state after the last size change, one more round of each actor must show
    /// a frame at the final size.
    fn check(script: &[Size]) -> usize {
        let last = *script.last().unwrap();
        let mut seen = HashSet::new();
        let mut stack = vec![Model::new(script[0])];
        while let Some(model) = stack.pop() {
            if !seen.insert(model.clone()) {
                continue;
            }
            let mut next = Vec::new();
            if model.frame <= script.len() {
                let mut m = model.clone();
                let size = script[model.frame.min(script.len() - 1)];
                m.host_frame(size)
                    .unwrap_or_else(|error| panic!("{script:?}: {error}"));
                next.push(m);
            }
            for n in 1..=model.down.len() {
                let mut m = model.clone();
                m.ui_host_reads(n);
                next.push(m);
            }
            if (model.frame_rings.len() as u64) < PUBLISHES {
                let mut m = model.clone();
                m.ui_host_publishes();
                next.push(m);
            }
            if let Some((generation, false)) = model.opening {
                let mut m = model.clone();
                m.opening = Some((generation, true));
                next.push(m);
            }
            if model.frame >= script.len() {
                let mut m = model.clone();
                let settle =
                    |m: &mut Model| m.host_frame(last).map_err(|e| format!("{script:?}: {e}"));
                settle(&mut m).unwrap();
                m.ui_host_reads(m.down.len());
                m.ui_host_publishes();
                settle(&mut m).unwrap();
                if let Some((generation, false)) = m.opening {
                    m.opening = Some((generation, true));
                }
                settle(&mut m).unwrap();
                assert_eq!(
                    m.shown_size(),
                    Some(last),
                    "{script:?}: HUD not shown at the final size after one round"
                );
            }
            stack.extend(next);
        }
        seen.len()
    }

    #[test]
    fn every_resize_order_ends_with_the_hud_at_the_final_size() {
        let mut states = 0;
        for script in [
            vec![A],
            vec![A, B],
            vec![A, B, A],
            vec![A, A, B, A],
            vec![A, B, B, A],
            vec![A, B, A, B],
            vec![A, B, C, A],
            vec![A, B, C, B],
            vec![A, B, A, B, A],
        ] {
            states += check(&script);
        }
        assert!(states > 10_000, "explored {states} states");
    }

    #[test]
    fn the_hud_stays_on_screen_through_a_resize_on_every_frame() {
        let mut model = Model::new(A);
        model.host_frame(A).unwrap();
        model.ui_host_publishes();
        model.opening = Some((1, true));
        model.host_frame(A).unwrap();
        assert_eq!(model.shown_size(), Some(A));
        for frame in 0..200 {
            let size = if frame % 2 == 0 { B } else { C };
            model.host_frame(size).unwrap();
            model.ui_host_reads(model.down.len());
            if frame % 3 == 0 {
                model.ui_host_publishes();
            }
            if let Some((generation, false)) = model.opening {
                model.opening = Some((generation, frame % 5 == 0));
            }
        }
        model.host_frame(A).unwrap();
        model.ui_host_reads(model.down.len());
        model.ui_host_publishes();
        model.host_frame(A).unwrap();
        model.opening = model.opening.map(|(generation, _)| (generation, true));
        model.host_frame(A).unwrap();
        assert_eq!(model.shown_size(), Some(A));
    }
}
