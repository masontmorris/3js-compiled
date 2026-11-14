// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ui-host calls this in the page with a function that calls `__bridge.tick`. It returns the
// viewport size, the page's reply, and three lists for the reply's `rects`: for each rect the id
// of the element it names, or 0; for each rect three more ids, of other elements whose box it is,
// or 0; and the index of each rect that no element's box is. Every element has its own id for as
// long as it is in the page, and no id ever passes to another element.
//
// A rect's candidates are the elements whose border box it is (to within 1 px) when the tick
// returns: those the page measured with that box during the tick (by their last
// `getBoundingClientRect`, or a viewport box read after an `offsetWidth` read), else those the
// same box, then the rect at the same index, named in the
// last reply, else those a document scan finds; with each, its ancestors, descendants and next
// siblings of the same box. The rect names the topmost hit-testable candidate, one whose
// `pointer-events` is not `none`, or the topmost candidate when none is hit-testable. The topmost
// is the last in document order, except that hit-testable candidates neither of which contains the
// other, such as siblings, go in the order the hit test at the rect's centre draws them, so
// `z-index` counts; candidates it does not reach follow in document order. When the bound below
// stops the hit test, they keep the order the rect's box last had. Its more ids are of the
// other hit-testable candidates, topmost first, so a rect whose named element the page rebuilds
// every tick, such as a label, still shares an id with the rect it was. Rects that share one box
// name its candidates from the bottom up, and a box with fewer candidates than rects gives the
// later rects further ids of the same elements.
//
// Work after the tick is bounded. It stops 2 ms into the evaluation, box reads included: a rect
// with no measured element left unchecked by then is named 0, and the next evaluation checks it
// first. The scan walks the document from where it stopped and stops 1 ms in, going on in the next
// evaluation until it has seen every element once. In every other evaluation, box reads of elements
// the page read `offsetWidth` of stop 1 ms in, checks of rects stop 1.5 ms in, and the scan may run
// 1 ms from where the checks leave off, so neither those reads nor the checks can starve the scan.
// Looking at a candidate's relatives stops after 16 elements per rect, and a rect has at most 8
// candidates. A box a whole scan finds no element for is not looked for again for 60 evaluations.
// Every cache holds only the boxes of the latest reply.
(tick => {
  const S = (globalThis[Symbol.for("threejsc.rect-ids")] ??= (() => {
    const S = {
      next: 1, evaluation: 0, from: 0, offsetFrom: 0, measured: null, offsets: null, walker: null,
      byBox: new Map(), byIndex: [], orders: new Map(), pending: new Map(), absent: new Map(),
    };
    const measure = Element.prototype.getBoundingClientRect;
    S.read = element => measure.call(element);
    Element.prototype.getBoundingClientRect = function () {
      const box = measure.call(this);
      S.measured?.set(this, box);
      return box;
    };
    const width = typeof HTMLElement === "undefined" ? null :
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    if (width?.get && width.configurable) {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        ...width,
        get() {
          const value = width.get.call(this);
          S.offsets?.add(this);
          return value;
        },
      });
    }
    return S;
  })());
  const lastBox = (S.measured = new Map());
  const offsetElements = (S.offsets = new Set());
  let json;
  try {
    json = tick();
  } finally {
    S.measured = null;
    S.offsets = null;
  }
  S.evaluation += 1;
  let rects;
  if (typeof json === "string" && json.includes('"rects"')) {
    try { rects = JSON.parse(json).rects; } catch {}
  }
  if (!Array.isArray(rects)) return [innerWidth, innerHeight, json, [], [], []];

  const started = performance.now();
  // Whether this evaluation keeps its second millisecond for rect checks and the scan.
  const split = S.evaluation % 2 === 0;
  const offsetsUntil = started + (split ? 1 : 2);
  const offsetStart = offsetElements.size ? S.offsetFrom % offsetElements.size : 0;
  let offsetRead = 0;
  for (let pass = 0; pass < (offsetStart ? 2 : 1); pass++) {
    let index = 0;
    for (const element of offsetElements) {
      if (pass === 0 ? index++ < offsetStart : index++ >= offsetStart) continue;
      if (performance.now() >= offsetsUntil) break;
      if (element.isConnected) lastBox.set(element, S.read(element));
      offsetRead++;
    }
    if (performance.now() >= offsetsUntil) break;
  }
  S.offsetFrom = offsetElements.size ? (offsetStart + offsetRead) % offsetElements.size : 0;
  const boxes = new Map(lastBox);
  const boxOf = element => {
    let box = boxes.get(element);
    if (!box) boxes.set(element, (box = S.read(element)));
    return box;
  };
  const near = (box, rect) =>
    Math.abs(box.x - rect[0]) <= 1 && Math.abs(box.y - rect[1]) <= 1 &&
    Math.abs(box.width - rect[2]) <= 1 && Math.abs(box.height - rect[3]) <= 1;
  const valid = rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite);
  const keys = rects.map(rect => (valid(rect) ? rect.join(",") : null));
  const listed = new Set(keys);
  for (const map of [S.pending, S.absent]) {
    for (const key of map.keys()) if (!listed.has(key)) map.delete(key);
  }

  const measuredBy = new Map();
  for (const [element, box] of lastBox) {
    if (!element.isConnected) continue;
    const key = `${box.x},${box.y},${box.width},${box.height}`;
    if (listed.has(key)) {
      if (!measuredBy.has(key)) measuredBy.set(key, []);
      measuredBy.get(key).push(element);
    }
  }
  const until = started + 2;
  const checksUntil = split ? started + 1.5 : until;
  const outlining = (elements, rect) =>
    (elements ?? []).filter(element => element.isConnected && near(boxOf(element), rect));
  const missing = [];
  // Each rect's elements found so far, or null for a rect not checked in this evaluation.
  const seeds = rects.map(() => null);
  let stopped = null;
  for (let j = 0; j < rects.length; j++) {
    const i = (j + S.from) % rects.length;
    const key = keys[i], rect = rects[i];
    if (key === null) {
      seeds[i] = [];
      continue;
    }
    let found = measuredBy.get(key) ?? [];
    if (!found.length) {
      if (performance.now() >= checksUntil) {
        stopped ??= i;
        continue;
      }
      found = outlining(S.byBox.get(key), rect);
      if (!found.length) found = outlining(S.byIndex[i], rect);
    }
    if (found.length) {
      S.pending.delete(key);
    } else if (S.evaluation - (S.absent.get(key) ?? -Infinity) < 60) {
      missing.push(i);
    } else if (!S.pending.has(key)) {
      S.absent.delete(key);
      S.pending.set(key, { rect, found: [], start: null, done: false });
    }
    seeds[i] = found;
  }
  S.from = stopped ?? 0;

  if (S.pending.size) {
    const root = document.documentElement;
    if (!S.walker || !S.walker.currentNode.isConnected) {
      S.walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    }
    const corner = (x, y) => `${Math.round(x)},${Math.round(y)}`;
    const buckets = new Map(), ends = new Map(), indices = new Map();
    keys.forEach((key, i) => {
      if (!indices.has(key)) indices.set(key, []);
      indices.get(key).push(i);
    });
    for (const wanted of S.pending.values()) {
      if (!wanted.start?.isConnected) wanted.start = S.walker.currentNode;
      if (!ends.has(wanted.start)) ends.set(wanted.start, []);
      ends.get(wanted.start).push(wanted);
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          const at = corner(wanted.rect[0] + dx, wanted.rect[1] + dy);
          if (!buckets.has(at)) buckets.set(at, []);
          buckets.get(at).push(wanted);
        }
      }
    }
    let left = S.pending.size;
    const scanUntil = split ? Math.min(until, performance.now() + 1) : started + 1;
    while (left && performance.now() < scanUntil) {
      const element = S.walker.currentNode;
      const box = boxOf(element);
      for (const wanted of buckets.get(corner(box.x, box.y)) ?? []) {
        if (near(box, wanted.rect) && !wanted.found.includes(element)) wanted.found.push(element);
      }
      if (!S.walker.nextNode()) S.walker.currentNode = root;
      for (const wanted of ends.get(S.walker.currentNode) ?? []) {
        if (!wanted.done) left -= 1;
        wanted.done = true;
      }
    }
    for (const [key, wanted] of [...S.pending]) {
      const found = outlining(wanted.found, wanted.rect);
      for (const i of indices.get(key) ?? []) {
        if (seeds[i]?.length) continue;
        seeds[i] = found;
        if (wanted.done && !found.length) missing.push(i);
      }
      if (!wanted.done) continue;
      S.pending.delete(key);
      if (!found.length) S.absent.set(key, S.evaluation);
    }
  }

  const relatives = (found, rect) => {
    const all = new Set(found);
    let visits = 0;
    const more = () => visits++ < 16 && all.size < 8 && performance.now() < until;
    for (const seed of found) {
      for (let up = seed.parentElement; up && more() && near(boxOf(up), rect); up = up.parentElement) {
        all.add(up);
      }
      for (let next = seed.nextElementSibling; next && more() && near(boxOf(next), rect);) {
        all.add(next);
        next = next.nextElementSibling;
      }
      const parents = [seed];
      for (let p = 0; p < parents.length; p++) {
        for (let child = parents[p].firstElementChild; child && more(); child = child.nextElementSibling) {
          if (near(boxOf(child), rect)) {
            all.add(child);
            parents.push(child);
          }
        }
      }
    }
    return [...all].slice(0, 8);
  };
  const hittable = new Map();
  const hit = element => {
    if (!hittable.has(element)) hittable.set(element, getComputedStyle(element).pointerEvents !== "none");
    return hittable.get(element);
  };
  const above = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1);
  // The candidates a rect can name, topmost first.
  const pool = (elements, rect, key) => {
    if (elements.length < 2) return elements;
    const sorted = [...elements].sort(above);
    const hits = sorted.filter(hit);
    if (!hits.length) return sorted.slice(0, 1);
    const nested = hits.every((a, i) => hits.every((b, j) => j <= i || a.contains(b) || b.contains(a)));
    if (nested) return hits;
    const drawn = performance.now() < until ?
      document.elementsFromPoint(rect[0] + rect[2] / 2, rect[1] + rect[3] / 2) : S.orders.get(key) ?? [];
    const depth = element => {
      const at = drawn.indexOf(element);
      return at < 0 ? drawn.length : at;
    };
    return hits.sort((a, b) => depth(a) - depth(b));
  };
  const ID = Symbol.for("threejsc.rect-id"), MORE = Symbol.for("threejsc.rect-more-ids");
  const idOf = (element, n = 0) => {
    if (n === 0) return (element[ID] ??= S.next++);
    const more = (element[MORE] ??= []);
    return (more[n - 1] ??= S.next++);
  };

  const shared = new Map();
  keys.forEach(key => key !== null && shared.set(key, (shared.get(key) ?? 0) + 1));
  const seen = new Map();
  const byBox = new Map();
  const byIndex = [];
  const orders = new Map();
  const ids = [], also = [];
  rects.forEach((rect, i) => {
    const key = keys[i];
    if (seeds[i] === null) {
      byIndex.push(S.byIndex[i]);
      if (S.byBox.has(key)) byBox.set(key, S.byBox.get(key));
      if (S.orders.has(key)) orders.set(key, S.orders.get(key));
      ids.push(0);
      also.push(0, 0, 0);
      return;
    }
    const all = seeds[i].length ? relatives(seeds[i], rect) : [];
    byIndex.push(all);
    if (!all.length) {
      ids.push(0);
      also.push(0, 0, 0);
      return;
    }
    byBox.set(key, all);
    const top = pool(all, rect, key);
    orders.set(key, top);
    let named = top[0], n = 0;
    if (shared.get(key) > 1) {
      const k = seen.get(key) ?? 0;
      seen.set(key, k + 1);
      const order = [...top].reverse();
      named = order[k % order.length];
      n = Math.floor(k / order.length);
    }
    ids.push(idOf(named, n));
    const others = top.filter(element => element !== named).slice(0, 3).map(element => idOf(element));
    also.push(...others, ...[0, 0, 0].slice(others.length));
  });
  S.byBox = byBox;
  S.byIndex = byIndex;
  S.orders = orders;
  return [innerWidth, innerHeight, json, ids, also, missing];
})
