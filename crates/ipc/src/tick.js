// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ui-host calls this in the page with a function that calls `__bridge.tick`. It returns the
// viewport size, the page's reply, and for each item of the reply's `rects` an id that stays the
// same while any element whose border box the item is (to within 1 px, when the tick returns)
// stays in the page. All such elements carry the id, so a rect keeps it when one of them is
// replaced, such as a label that fills its button, or stops sharing the box, such as a column the
// button fills at one width only.
//
// The elements are found by what costs least first: elements whose last `getBoundingClientRect`
// during the tick gave the item's box, so an element the page moved and measured again no longer
// counts for its old box; the elements the same box, then the rect
// at the same index, named in the last reply; and last a scan of the document shared by every rect
// still unnamed, which stops after 1 ms and goes on in the next evaluation. A box a whole scan
// finds no element for is named 0 and not looked for again for 60 evaluations. A second item with
// the same box gets its elements' second id.
(tick => {
  const state = (globalThis[Symbol.for("threejsc.rect-ids")] ??= (() => {
    const state = {
      next: 1, measured: null, evaluation: 0,
      byBox: new Map(), byIndex: [], absent: new Map(), pending: new Map(), scanAt: 0,
    };
    const measure = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const box = measure.call(this);
      state.measured?.set(this, `${box.x},${box.y},${box.width},${box.height}`);
      return box;
    };
    return state;
  })());
  const lastBox = (state.measured = new Map());
  let json;
  try {
    json = tick();
  } finally {
    state.measured = null;
  }
  const measured = new Map();
  for (const [element, key] of lastBox) {
    const elements = measured.get(key);
    if (elements) elements.push(element);
    else measured.set(key, [element]);
  }
  state.evaluation += 1;
  let rects;
  if (typeof json === "string" && json.includes('"rects"')) {
    try { rects = JSON.parse(json).rects; } catch {}
  }
  if (!Array.isArray(rects)) return [innerWidth, innerHeight, json, []];

  const near = (box, rect) =>
    Math.abs(box.x - rect[0]) <= 1 && Math.abs(box.y - rect[1]) <= 1 &&
    Math.abs(box.width - rect[2]) <= 1 && Math.abs(box.height - rect[3]) <= 1;
  const outlining = (elements, rect) =>
    elements ? elements.filter(element => near(element.getBoundingClientRect(), rect)) : [];
  const valid = rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite);
  const keys = rects.map(rect => (valid(rect) ? rect.join(",") : null));

  const found = rects.map((rect, i) => {
    const key = keys[i];
    if (key === null || state.pending.has(key)) return [];
    let elements = measured.get(key) ?? [];
    if (!elements.length) elements = outlining(state.byBox.get(key), rect);
    if (!elements.length) elements = outlining(state.byIndex[i], rect);
    if (!elements.length && !(state.evaluation - (state.absent.get(key) ?? -Infinity) < 60)) {
      state.pending.set(key, { rect, elements: [], covered: 0 });
    }
    return elements;
  });

  const listed = new Set(keys);
  for (const key of state.pending.keys()) {
    if (!listed.has(key)) state.pending.delete(key);
  }
  if (state.pending.size) {
    const corner = (x, y) => `${Math.round(x)},${Math.round(y)}`;
    const buckets = new Map();
    for (const wanted of state.pending.values()) {
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          const at = corner(wanted.rect[0] + dx, wanted.rect[1] + dy);
          const list = buckets.get(at);
          if (list) list.push(wanted);
          else buckets.set(at, [wanted]);
        }
      }
    }
    const every = document.querySelectorAll("*");
    const count = every.length;
    const deadline = performance.now() + 1;
    let scanned = 0;
    for (; scanned < count; scanned++) {
      if ((scanned & 15) === 15 && performance.now() > deadline) break;
      const element = every[(state.scanAt + scanned) % count];
      const box = element.getBoundingClientRect();
      for (const wanted of buckets.get(corner(box.x, box.y)) ?? []) {
        if (near(box, wanted.rect) && !wanted.elements.includes(element)) wanted.elements.push(element);
      }
    }
    state.scanAt = count ? (state.scanAt + scanned) % count : 0;
    const at = new Map();
    keys.forEach((key, i) => {
      if (key !== null && !found[i].length) at.set(key, [...(at.get(key) ?? []), i]);
    });
    for (const [key, wanted] of state.pending) {
      wanted.covered += scanned;
      const elements = outlining(wanted.elements, wanted.rect);
      for (const i of at.get(key) ?? []) found[i] = elements;
      if (wanted.covered < count) continue;
      state.pending.delete(key);
      if (!wanted.elements.length) state.absent.set(key, state.evaluation);
    }
  }

  const ID = Symbol.for("threejsc.rect-id"), MORE = Symbol.for("threejsc.rect-more-ids");
  const get = (element, n) => (n === 0 ? element[ID] : element[MORE]?.[n - 1]);
  const set = (element, n, id) => {
    if (n === 0) element[ID] = id;
    else (element[MORE] ??= [])[n - 1] = id;
  };
  const seen = new Map();
  const byBox = new Map();
  const ids = found.map((elements, i) => {
    if (!elements.length) return 0;
    const n = seen.get(keys[i]) ?? 0;
    seen.set(keys[i], n + 1);
    let id = 0;
    for (const element of elements) {
      id = get(element, n);
      if (id) break;
    }
    id ||= state.next++;
    for (const element of elements) set(element, n, id);
    byBox.set(keys[i], elements);
    return id;
  });
  state.byBox = byBox;
  state.byIndex = found;
  return [innerWidth, innerHeight, json, ids];
})
