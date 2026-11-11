// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `TICK` in V8 against a page model: elements with border boxes, hit-tested front to back as
//! Servo's layout does, which also hits boxes with no background. Each case runs twice: with the
//! page measuring its rects with `getBoundingClientRect` during the tick, and with rects the page
//! computed some other way, which `TICK` finds by hit test and document scan.

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
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  contains(other) {
    for (let element = other; element; element = element.parent) if (element === this) return true;
    return false;
  }
};
let reads = 0, clock = 0, READ_MS = 0;
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
  querySelectorAll: () => tree(),
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
const ids = (...elements) =>
  tick(() => JSON.stringify({ events: [], rects: elements.map(box) }))[3];
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

#[test]
fn a_rect_keeps_its_id_when_the_page_rebuilds_the_label_that_fills_it() {
    run(r#"
const c = new Element("div#c", [1060, 20, 200, 80], body);
let label = new Element("span", [1060, 20, 200, 80], c);
const first = ids(c);
label.remove();
label = new Element("span", [1060, 20, 200, 80], c);
same(ids(c), first, "a new label at 1280");
resize(1680);
c.box = label.box = [1460, 20, 200, 80];
label.remove();
new Element("span", [1460, 20, 200, 80], c);
same(ids(c), first, "a new label at 1680");
"#);
}

#[test]
fn a_rect_keeps_its_id_while_an_overlay_at_its_centre_comes_and_goes() {
    run(r#"
const c = new Element("div#c", [1060, 20, 200, 80], body);
const first = ids(c);
const sweep = new Element("div.sweep", [1140, 40, 40, 40], body);
same(ids(c), first, "a sweep over the centre");
sweep.remove();
const cover = new Element("div.cover", [1060, 20, 200, 80], body);
same(ids(c), first, "a cover the size of the button");
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
new Element("span", [1600, 20, 200, 80], c);
same(ids(c), first, "at 1680");
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
