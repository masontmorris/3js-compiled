// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `TICK` in V8 against a page model: elements with border boxes, in a tree, with
//! `pointer-events: none` where `hit` is false. Each case runs twice: with the page measuring its
//! rects with `getBoundingClientRect` during the tick, and with rects the page computed some other
//! way, which `TICK` finds in its caches and by document scan. Box reads and walking the document
//! with `querySelectorAll` advance the page's clock.

use deno_core::{JsRuntime, RuntimeOptions};

const PAGE: &str = r#"
globalThis.Element = class Element {
  constructor(name, box, parent, hit = true) {
    Object.assign(this, { name, box, parent, hit, children: [] });
    parent?.children.push(this);
  }
  getBoundingClientRect() {
    reads += 1;
    clock += READ_MS;
    let element = this;
    while (element.parent) element = element.parent;
    const [x, y, width, height] = element === html ? this.box : [0, 0, 0, 0];
    return { x, y, width, height };
  }
  remove() {
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  get offsetWidth() { return this.box[2]; }
  get parentElement() { return this.parent; }
  get nextElementSibling() {
    const siblings = this.parent?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get isConnected() { return html.contains(this); }
  compareDocumentPosition(other) {
    const order = tree();
    return order.indexOf(other) > order.indexOf(this) ? Node.DOCUMENT_POSITION_FOLLOWING : 2;
  }
  contains(other) {
    for (let element = other; element; element = element.parent) if (element === this) return true;
    return false;
  }
};
globalThis.HTMLElement = Element;
let reads = 0, clock = 0, READ_MS = 0;
globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
globalThis.NodeFilter = { SHOW_ELEMENT: 1 };
globalThis.getComputedStyle = element => ({ pointerEvents: element.hit ? "auto" : "none" });
globalThis.performance = { now: () => clock };
const html = new Element("html", [0, 0, 1280, 720], null);
const body = new Element("body", [0, 0, 1280, 720], html);
const resize = width => {
  globalThis.innerWidth = width;
  html.box = body.box = [0, 0, width, 720];
};
resize(1280);
globalThis.innerHeight = 720;
const tree = () => {
  const out = [], stack = [html];
  while (stack.length) {
    const element = stack.pop();
    out.push(element);
    for (let i = element.children.length - 1; i >= 0; i--) stack.push(element.children[i]);
  }
  return out;
};
globalThis.document = {
  documentElement: html,
  querySelectorAll() {
    const all = tree();
    clock += READ_MS * all.length;
    return all;
  },
  createTreeWalker(root) {
    return {
      currentNode: root,
      nextNode() {
        let element = this.currentNode;
        if (element.children.length) return (this.currentNode = element.children[0]);
        for (; element && element !== root; element = element.parent) {
          const next = element.nextElementSibling;
          if (next) return (this.currentNode = next);
        }
        return null;
      },
    };
  },
  elementsFromPoint(x, y) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return [];
    const [inside] = [([ex, ey, w, h]) => x >= ex && y >= ey && x < ex + w && y < ey + h];
    return tree().filter(element => element.hit && inside(element.box)).reverse();
  },
  elementFromPoint(x, y) { return this.elementsFromPoint(x, y)[0] ?? null; },
};
const box = element => {
  if (!MEASURED || !(element instanceof Element)) return element.box;
  const { x, y, width, height } = element.getBoundingClientRect();
  return [x, y, width, height];
};
const named = (...elements) => {
  const [, , , ids, also, missing] = tick(() => JSON.stringify({ events: [], rects: elements.map(box) }));
  return { ids, also, missing };
};
const ids = (...elements) => named(...elements).ids;
const same = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
"#;

fn run(case: &str) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let _entered = runtime.enter();
    for measured in [true, false] {
        let mut js = JsRuntime::new(RuntimeOptions::default());
        let script = format!(
            "const MEASURED = {measured};\nconst tick = {};\n{PAGE}\n{case}",
            threejsc_ipc::TICK
        );
        if let Err(error) = js.execute_script("test:tick", script) {
            panic!("measured by the page: {measured}: {error}");
        }
    }
}

/// The rect names the label, which is on top, and lists `c` among its more ids, so it shares an
/// id with the rect it was however often the page rebuilds the label.
#[test]
fn a_rect_names_the_label_that_fills_it_and_keeps_its_button_among_its_more_ids() {
    run(r#"
const c = new Element("div#c", [1060, 20, 200, 80], body);
let label = new Element("span", [1060, 20, 200, 80], c);
const first = named(c);
same(first.ids[0] > 0 && first.also[0] > 0 && first.ids[0] !== first.also[0], true, `two ids: ${JSON.stringify(first)}`);
same(first.also, [first.also[0], 0, 0], "one more id");
label.remove();
label = new Element("span", [1060, 20, 200, 80], c);
const next = named(c);
same(next.ids[0] !== first.ids[0], true, "the new label has its own id");
same(next.also, first.also, "c among the more ids at 1280");
resize(1680);
c.box = label.box = [1460, 20, 200, 80];
label.remove();
new Element("span", [1460, 20, 200, 80], c);
same(named(c).also, first.also, "c among the more ids at 1680");
"#);
}

#[test]
fn a_rect_keeps_its_id_while_an_overlay_comes_and_goes() {
    run(r#"
const c = new Element("div#c", [1060, 20, 200, 80], body);
const first = ids(c);
const sweep = new Element("div.sweep", [1140, 40, 40, 40], body);
same(ids(c), first, "a sweep over the centre");
sweep.remove();
const cover = new Element("div.cover", [1060, 20, 200, 80], body);
const covered = named(c);
same([covered.ids[0] !== first[0], covered.also[0]], [true, first[0]], "a cover the size of the button, on top");
cover.remove();
same(ids(c), first, "with the overlays gone");
"#);
}

#[test]
fn a_rect_whose_centre_falls_in_a_gap_of_its_element_is_named_by_that_element() {
    run(r#"
const l = new Element("div#l", [1060, 20, 200, 80], body, false);
new Element("div.down", [1060, 20, 40, 80], l);
new Element("div.across", [1060, 80, 200, 20], l);
const first = ids(l);
same(first.length === 1 && first[0] > 0, true, "named");
same(ids(body)[0] !== first[0], true, "named by the L, not by what lies under its centre");
resize(1680);
l.box = [1460, 20, 200, 80];
same(ids(l), first, "at 1680");
"#);
}

#[test]
fn two_rects_whose_centres_hit_one_element_keep_their_own_ids_in_any_order() {
    run(r#"
const a = new Element("div#a", [1060, 20, 200, 80], body);
const b = new Element("div#b", [660, 20, 200, 80], body);
new Element("div.banner", [600, 50, 700, 20], body);
const [idA, idB] = ids(a, b);
same(idA !== idB && idA > 0 && idB > 0, true, "two ids");
same(ids(b, a), [idB, idA], "listed the other way round");
"#);
}

#[test]
fn a_rect_whose_centre_is_outside_the_window_keeps_its_id_across_a_resize() {
    run(r#"
const c = new Element("div#c", [1200, 20, 200, 80], body);
const first = ids(c);
same(first[0] > 0, true, "named");
resize(1680);
c.box = [1600, 20, 200, 80];
same(ids(c), first, "at 1680");
new Element("span", [1600, 20, 200, 80], c);
same(named(c).also[0], first[0], "under a new label that fills it");
"#);
}

#[test]
fn a_rect_that_outlines_no_element_is_named_0_and_two_rects_of_one_element_differ() {
    run(r#"
const c = new Element("div#c", [1060, 20, 200, 80], body);
const padded = { box: [1050, 10, 220, 100] };
const [one, two, none] = ids(c, c, padded);
same([one > 0, two > 0, one !== two, none], [true, true, true, 0], "ids");
same(ids(c, c, padded), [one, two, 0], "the next reply");
"#);
}

/// Adversary round 9: a button that fills its column up to a max width (`width: 100%;
/// max-width: 220px` in a `15vw` column). At 1280 the column and the button share one box; at
/// 1680 the column is 252 px and the button 220. The page measures the column too, as layout code
/// does, or measures nothing.
#[test]
fn a_rect_keeps_its_id_when_its_column_shares_its_box_at_one_size_only() {
    run(r#"
const column = new Element("div.column", [1068, 20, 192, 80], body);
const button = new Element("button#c", [1068, 20, 192, 80], column);
const reply = () => tick(() => {
  if (MEASURED) column.getBoundingClientRect();
  return JSON.stringify({ events: [], rects: [box(button)] });
})[3];
const first = reply();
resize(1680);
column.box = [1408, 20, 252, 80];
button.box = [1408, 20, 220, 80];
same(reply(), first, "the button at 1680");
resize(1280);
column.box = button.box = [1068, 20, 192, 80];
same(reply(), first, "the button back at 1280");
"#);
}

/// Adversary round 9: the page measures its list, swaps two items, measures them again and
/// reports the new boxes. The box `a` left is now `b`'s.
#[test]
fn a_rect_is_named_by_the_element_in_its_box_when_the_tick_returns() {
    run(r#"
const a = new Element("button#a", [1060, 20, 200, 80], body);
const b = new Element("button#b", [1060, 120, 200, 80], body);
const [idA, idB] = ids(a, b);
const got = tick(() => {
  if (MEASURED) { a.getBoundingClientRect(); b.getBoundingClientRect(); }
  [a.box, b.box] = [b.box, a.box];
  return JSON.stringify({ events: [], rects: [box(b), box(a)] });
})[3];
same(got, [idB, idA], "b now at the top, a below");
"#);
}

/// A page of 3,000 elements whose rects match no box it measured: the document scan reads at
/// most about 1 ms of boxes per evaluation and finds the last element in a later one.
#[test]
fn the_document_scan_stops_after_1_ms_and_goes_on_in_the_next_evaluation() {
    run(r#"
for (let i = 0; i < 3000; i++) new Element("div", [i % 1000, 400 + Math.floor(i / 1000), 1, 1], body);
const c = new Element("div#c", [1060, 20, 200, 80], body);
READ_MS = 0.001;
const computed = () => tick(() => JSON.stringify({ events: [], rects: [c.box] }))[3][0];
const got = [];
for (let n = 0; n < 6; n++) {
  reads = 0;
  got.push(computed());
  same(reads < 1100, true, `evaluation ${n} read ${reads} boxes`);
}
same(got.slice(0, 2), [0, 0], "not found yet");
same(got[5] > 0 && got.slice(3).every(id => id === got[5]), true, `found and kept: ${got}`);
"#);
}

/// Rects 3 px larger than every element: one scan finds nothing, and the next 60 evaluations
/// read no element's box for them.
#[test]
fn a_box_no_element_has_is_not_looked_for_again_for_60_evaluations() {
    run(r#"
const items = Array.from({ length: 200 }, (_, i) => new Element("div", [4 + (i % 20) * 54, 130 + Math.floor(i / 20) * 24, 50, 20], body));
for (let i = 0; i < 2000; i++) new Element("div", [0, 380 + (i % 160) * 2, 1280, 2], body);
const slop = ([x, y, w, h]) => [x - 3, y - 3, w + 6, h + 6];
const reply = () => tick(() => JSON.stringify({ events: [], rects: items.map(item => slop(item.box)) }))[3];
same(reply().every(id => id === 0), true, "named 0");
reads = 0;
for (let n = 0; n < 59; n++) same(reply().every(id => id === 0), true, "still 0");
same(reads, 0, "boxes read in 59 evaluations");
"#);
}

/// Adversary round 10: an element moves out of a slot that another element then fills, as an
/// inventory does when it equips `c` and puts `a` back in the bag. The page measures the slot
/// too, to anchor a tooltip, or measures nothing.
#[test]
fn adv12_two_buttons_that_filled_one_slot_in_turn_keep_two_ids() {
    run(r#"
const move = (element, parent, to) => {
  element.remove();
  element.parent = parent;
  parent.children.push(element);
  element.box = to;
};
const slot = new Element("div.slot", [1068, 20, 192, 80], body);
const bag = new Element("div.bag", [40, 20, 200, 80], body);
const a = new Element("button#a", [1068, 20, 192, 80], slot);
const c = new Element("button#c", [40, 20, 200, 80], bag);
const reply = () => tick(() => {
  if (MEASURED) slot.getBoundingClientRect();
  return JSON.stringify({ events: [], rects: [box(a), box(c)] });
})[3];
const [idA, idC] = reply();
same(idA > 0 && idC > 0 && idA !== idC, true, `two ids at first: ${[idA, idC]}`);
move(a, bag, [40, 20, 200, 80]);
move(c, slot, [1068, 20, 192, 80]);
const got = reply();
same(got[0] !== got[1], true, `a in the bag, c in the slot: ${got}`);
same(got, [idA, idC], "each button keeps its id");
"#);
}

/// Adversary round 10: a focus ring the size of the selected button (a persistent element before
/// the buttons, as menus driven by a gamepad have) once outlined `a`, then moved to `c`. At 1680
/// a button the page shows on wide windows only comes first in the list.
#[test]
fn adv12_a_focus_ring_does_not_carry_one_buttons_id_to_another() {
    run(r#"
const ring = new Element("div.ring", [40, 20, 200, 80], body, false);
const a = new Element("button#a", [40, 20, 200, 80], body);
const c = new Element("button#c", [1068, 20, 192, 80], body);
const x = new Element("button#x", [300, 20, 100, 80], body);
const reply = (...elements) => tick(() => JSON.stringify({ events: [], rects: elements.map(box) }))[3];
const [idA, idC] = reply(a, c);
ring.box = c.box.slice();
same(reply(a, c), [idA, idC], "the ring on c at 1280");
resize(1680);
ring.box = c.box = [1408, 20, 220, 80];
const wide = reply(x, a, c);
same([wide[1], wide[2]], [idA, idC], `at 1680 with x first (${wide})`);
resize(1280);
ring.box = c.box = [1068, 20, 192, 80];
same(reply(a, c), [idA, idC], "back at 1280");
"#);
}

// Lane G probes: cases the round-10 tests leave out. A page that follows docs/build.md
// lists element border boxes and lets its elements move; it may measure any of them.

#[test]
fn probe_two_rects_of_two_same_box_siblings_keep_distinct_ids_when_they_separate() {
    run(r#"
const s1 = new Element("div#s1", [100, 20, 200, 80], body);
const s2 = new Element("div#s2", [100, 20, 200, 80], body);
const first = ids(s1, s2);
same(first[0] > 0 && first[1] > 0 && first[0] !== first[1], true, "two ids while they share a box");
s2.box = [400, 20, 200, 80];
same(ids(s1, s2), first, "after they separate");
"#);
}

#[test]
fn probe_two_same_box_siblings_listed_as_one_rect_then_split() {
    run(r#"
const s1 = new Element("div#s1", [100, 20, 200, 80], body);
const s2 = new Element("div#s2", [100, 20, 200, 80], body);
const first = ids(s1);
s2.box = [400, 20, 200, 80];
same(ids(s2), first, "the element that moved still gets the id of the box it was");
"#);
}

#[test]
fn probe_measured_one_of_two_same_box_elements_across_a_split() {
    run(r#"
const column = new Element("div.column", [1068, 20, 192, 80], body);
const button = new Element("button#c", [1068, 20, 192, 80], column);
const first = tick(() => {
  column.getBoundingClientRect();
  return JSON.stringify({ events: [], rects: [button.box] });
})[3];
resize(1680);
column.box = [1408, 20, 252, 80];
button.box = [1408, 20, 220, 80];
const got = tick(() => {
  button.getBoundingClientRect();
  return JSON.stringify({ events: [], rects: [button.box] });
})[3];
same(got, first, "the button measured only, at 1680");
"#);
}

#[test]
fn probe_a_pending_box_that_the_page_then_measures() {
    run(r#"
for (let i = 0; i < 3000; i++) new Element("div", [i % 1000, 400 + Math.floor(i / 1000), 1, 1], body);
const c = new Element("div#c", [1060, 20, 200, 80], body);
READ_MS = 0.001;
const computed = () => tick(() => JSON.stringify({ events: [], rects: [c.box] }))[3][0];
same(computed(), 0, "first evaluation");
const measured = tick(() => {
  c.getBoundingClientRect();
  return JSON.stringify({ events: [], rects: [c.box] });
})[3][0];
same(measured > 0, true, "a box the page now measures is named at once");
"#);
}

/// Two elements with one box, neither hit-testable: the rect names the topmost, and lists no more
/// ids, as an outline drawn over a button names the outline only when nothing under it takes a
/// click either.
#[test]
fn a_rect_of_elements_none_of_which_is_hit_testable_names_the_topmost() {
    run(r#"
const under = new Element("div.under", [100, 20, 200, 80], body, false);
const over = new Element("div.over", [100, 20, 200, 80], body, false);
const both = named(under);
const alone = new Element("div.alone", [100, 120, 200, 80], body, false);
const [overId] = ids(over);
same(both.ids, [overId], "the rect names the one on top");
same(both.also, [0, 0, 0], "no more ids");
same(ids(alone)[0] > 0, true, "one element that takes no click is named too");
"#);
}

/// Only a rect a whole scan found nothing for is reported as outlining no element; a rect the scan
/// has not reached yet is named 0 but not reported.
#[test]
fn only_a_rect_a_whole_scan_found_nothing_for_is_reported_missing() {
    run(r#"
for (let i = 0; i < 3000; i++) new Element("div", [i % 1000, 400 + Math.floor(i / 1000), 1, 1], body);
const c = new Element("div#c", [1060, 20, 200, 80], body);
const padded = { box: [1050, 10, 220, 100] };
READ_MS = 0.001;
const first = named({ box: c.box }, padded);
same([first.ids, first.missing], [[0, 0], []], "the first evaluation, the scan unfinished");
let got;
for (let n = 0; n < 6; n++) got = named({ box: c.box }, padded);
same([got.ids[0] > 0, got.ids[1], got.missing], [true, 0, [1]], "the scan finished");
"#);
}

/// All of the wrapper's work after the tick is bounded: the document walk counts against the
/// scan's 1 ms, and box checks of 600 computed rects stop 2 ms into the evaluation, every rect
/// still named within a few evaluations.
#[test]
fn the_wrapper_stops_2_ms_into_an_evaluation_with_the_document_walk_included() {
    run(r#"
for (let i = 0; i < 3000; i++) new Element("div", [i % 1000, 400 + Math.floor(i / 1000), 1, 1], body);
const c = new Element("div#c", [1060, 20, 200, 80], body);
READ_MS = 0.001;
for (let n = 0; n < 3; n++) {
  const before = clock;
  ids({ box: c.box });
  same(clock - before < 1.1, true, `evaluation ${n} took ${clock - before} ms of model time`);
}
const items = Array.from({ length: 600 }, (_, i) => new Element("div", [(i % 30) * 40, 20 + Math.floor(i / 30) * 18, 30, 16], body));
READ_MS = 0;
ids(...items.map(item => ({ box: item.box })));
READ_MS = 0.01;
const seen = items.map(() => 0);
for (let n = 0; n < 8; n++) {
  const before = clock;
  const got = ids(...items.map(item => ({ box: item.box })));
  same(clock - before < 2.2, true, `evaluation ${n} of 600 rects took ${clock - before} ms`);
  got.forEach((id, i) => { if (id) seen[i] = id; });
}
same(seen.every(id => id > 0) && new Set(seen).size === 600, true, "every rect named with its own id");
"#);
}

/// The caches hold only the boxes of the latest reply.
#[test]
fn the_caches_hold_only_the_boxes_of_the_latest_reply() {
    run(r#"
for (let i = 0; i < 100; i++) named({ box: [i, 700, 3, 3] });
const S = globalThis[Symbol.for("threejsc.rect-ids")];
const c = new Element("div#c", [1060, 20, 200, 80], body);
ids(c);
const sizes = Object.values(S).filter(v => v instanceof Map).map(map => map.size);
same(sizes.every(size => size <= 1), true, `cache sizes ${sizes}`);
"#);
}

#[test]
fn offset_measured_rebuilt_elements_do_not_need_a_walk_past_unrelated_rows() {
    run(r#"
for (let i = 0; i < 2000; i++) new Element("row", [i, 600, 1, 1], body);
let items = [];
READ_MS = 0.001;
for (let n = 0; n < 3; n++) {
  for (const item of items) item.remove();
  items = Array.from({ length: 200 }, (_, i) => new Element("button", [i * 5, 20, 4, 10], body));
  const before = reads;
  const [, , , got] = tick(() => JSON.stringify({ rects: items.map(item => {
    same(item.offsetWidth, 4, "native offset width preserved");
    return item.box;
  }) }));
  same(got.every(id => id > 0) && new Set(got).size === 200, true, "rebuilt offset-measured rects named");
  same(reads - before < 450, true, `box reads ${reads - before} include no unrelated rows`);
}
"#);
}

#[test]
fn offset_reads_rotate_when_the_budget_expires() {
    run(r#"
const items = Array.from({ length: 8 }, (_, i) => new Element('button', [i * 10, 20, 5, 5], body));
READ_MS = 0.6;
const seen = new Set();
for (let n = 0; n < 4; n++) {
  const got = tick(() => JSON.stringify({ rects: items.map(item => { void item.offsetWidth; return item.box; }) }))[3];
  got.forEach((id, i) => { if (id) seen.add(i); });
}
same(seen.size, 8, 'all offset elements eventually measured');
"#);
}

#[test]
fn detached_measured_element_is_not_named() {
    run(r#"
const item = new Element('button', [10, 20, 5, 5], body);
const got = tick(() => {
  item.getBoundingClientRect();
  item.remove();
  return JSON.stringify({ rects: [[10, 20, 5, 5]] });
})[3];
same(got, [0], 'detached measured element');
"#);
}
