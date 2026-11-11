// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ui-host calls this in the page with a function that calls `__bridge.tick`. It returns the
// viewport size, the page's reply, and for each item of the reply's `rects` the id of the
// element whose border box the item is. While the tick runs, every `getBoundingClientRect` call
// is recorded, so an item equal to a box the page measured is named by the element it measured
// (the outermost, when several had that box). Any other item is named by the lowest element in
// paint order at its centre whose box matches it to 1 px or, when none does, by the outermost
// matching element of the document; both cost a hit test or a document scan per item. Each
// element keeps its ids for its lifetime in symbol-keyed properties, which no page enumeration or
// `JSON.stringify` sees. A second item for one element gets the element's second id. 0 names no
// element.
(tick => {
  const state = (globalThis[Symbol.for("threejsc.rect-ids")] ??= (() => {
    const state = { next: 1, measured: null };
    const measure = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const box = measure.call(this);
      if (state.measured) {
        const key = `${box.x},${box.y},${box.width},${box.height}`;
        const elements = state.measured.get(key);
        if (!elements) state.measured.set(key, [this]);
        else if (!elements.includes(this)) elements.push(this);
      }
      return box;
    };
    return state;
  })());
  const measured = (state.measured = new Map());
  let json;
  try {
    json = tick();
  } finally {
    state.measured = null;
  }
  let rects;
  if (typeof json === "string" && json.includes('"rects"')) {
    try { rects = JSON.parse(json).rects; } catch {}
  }
  const outlines = (element, rect) => {
    const box = element.getBoundingClientRect();
    return Math.abs(box.x - rect[0]) <= 1 && Math.abs(box.y - rect[1]) <= 1 &&
      Math.abs(box.width - rect[2]) <= 1 && Math.abs(box.height - rect[3]) <= 1;
  };
  let every;
  const outlined = rect => {
    const same = measured.get(rect.join(","));
    if (same?.length === 1) return same[0];
    if (same) return same.find(element => same.every(other => element.contains(other))) ?? same[0];
    const under = document.elementsFromPoint(rect[0] + rect[2] / 2, rect[1] + rect[3] / 2);
    for (let i = under.length - 1; i >= 0; i--) {
      if (outlines(under[i], rect)) return under[i];
    }
    every ??= document.querySelectorAll("*");
    for (const element of every) {
      if (outlines(element, rect)) return element;
    }
    return null;
  };
  const ID = Symbol.for("threejsc.rect-id"), MORE = Symbol.for("threejsc.rect-more-ids");
  const seen = new Map();
  const id = rect => {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return 0;
    const element = outlined(rect);
    if (!element) return 0;
    const n = seen.get(element) ?? 0;
    seen.set(element, n + 1);
    if (n === 0) return (element[ID] ??= state.next++);
    const more = (element[MORE] ??= []);
    return (more[n - 1] ??= state.next++);
  };
  return [innerWidth, innerHeight, json, Array.isArray(rects) ? rects.map(id) : []];
})
