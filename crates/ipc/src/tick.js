// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ui-host calls this in the page with the page's reply to `__bridge.tick`. It returns the
// viewport size, the reply, and for each item of the reply's `rects` the id of the element whose
// border box the item is: the lowest element in paint order at the item's centre whose box
// matches it to 1 px, or, when none does, the outermost matching element of the document. Each
// element keeps its ids in a WeakMap for the page's lifetime. A second item for one element gets
// the element's second id. 0 names no element.
(json => {
  const ids = (globalThis[Symbol.for("threejsc.rect-ids")] ??= { of: new WeakMap(), next: 1 });
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
  const seen = new Map();
  const id = rect => {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return 0;
    const element = outlined(rect);
    if (!element) return 0;
    const n = seen.get(element) ?? 0;
    seen.set(element, n + 1);
    let list = ids.of.get(element);
    if (!list) ids.of.set(element, (list = []));
    return (list[n] ??= ids.next++);
  };
  return [innerWidth, innerHeight, json, Array.isArray(rects) ? rects.map(id) : []];
})
