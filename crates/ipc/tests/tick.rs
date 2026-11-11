// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `TICK` in V8 against a page model: elements with border boxes, hit-tested front to back as
//! Servo's layout does, which also hits boxes with no background.

use deno_core::{JsRuntime, RuntimeOptions};

const PAGE: &str = r#"
class Element {
  constructor(name, box, parent, hit = true) {
    Object.assign(this, { name, box, parent, hit, children: [] });
    parent?.children.push(this);
  }
  getBoundingClientRect() {
    const [x, y, width, height] = this.box;
    return { x, y, width, height };
  }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
}
const html = new Element("html", [0, 0, 1280, 720], null);
const body = new Element("body", [0, 0, 1280, 720], html);
const resize = width => {
  globalThis.innerWidth = width;
  html.box = body.box = [0, 0, width, 720];
};
resize(1280);
globalThis.innerHeight = 720;
const tree = (element = html) => [element, ...element.children.flatMap(child => tree(child))];
globalThis.document = {
  querySelectorAll: () => tree(),
  elementsFromPoint(x, y) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return [];
    const [inside] = [([ex, ey, w, h]) => x >= ex && y >= ey && x < ex + w && y < ey + h];
    return tree().filter(element => element.hit && inside(element.box)).reverse();
  },
  elementFromPoint(x, y) { return this.elementsFromPoint(x, y)[0] ?? null; },
};
const ids = (...elements) =>
  tick(JSON.stringify({ events: [], rects: elements.map(element => element.box) }))[3];
const same = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
"#;

fn run(case: &str) {
    let mut js = JsRuntime::new(RuntimeOptions::default());
    let script = format!("const tick = {};\n{PAGE}\n{case}", threejsc_ipc::TICK);
    if let Err(error) = js.execute_script("test:tick", script) {
        panic!("{error}");
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
