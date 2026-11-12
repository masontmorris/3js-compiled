// F1's gaps G10 to G13 as scenarios that run unchanged in headless Edge 157 (tools/platform/dom-reference.mjs writes
// its results to dom-edge.js), in the host (crates/host/tests/observers.js) and in Node (test/observers.test.js).
// Each takes the window's globals as `env` and returns plain data to compare with Edge's.

const name = node => node === null ? 'null' : node.nodeType === 3 ? `"${node.data}"` : node.nodeType === 11 ? (node.label ?? '#fragment') : (node.id || node.localName);
const records = list => list.map(r => `${r.type} ${name(r.target)}${r.attributeName ? ` ${r.attributeNamespace ?? ''}|${r.attributeName} old=${r.oldValue}` : ''}${r.type === 'characterData' ? ` old=${r.oldValue}` : ''} +[${[...r.addedNodes].map(name)}] -[${[...r.removedNodes].map(name)}] prev=${name(r.previousSibling)} next=${name(r.nextSibling)}`);
const failure = (call) => { try { return `ok ${call()}`; } catch (e) { return `${e.constructor.name} ${e.name}: ${e.message}`; } };

// G10: moving a fragment's children, with each method's return value and the mutation records it queues. One
// observer watches the root's subtree and every fragment, so takeRecords() gives the queue in order.
export function mutations({ document, MutationObserver }) {
  const el = id => Object.assign(document.createElement('div'), { id });
  const frag = (label, ...ids) => { const f = document.createDocumentFragment(); f.label = label; f.append(...ids.map(el)); return f; };
  const root = el('root');
  document.body.append(root);
  const observer = new MutationObserver(() => {});
  observer.observe(root, { childList: true, subtree: true });
  const watch = f => { observer.observe(f, { childList: true }); return f; };
  const state = (f, ret, expected) => ({
    ret: ret === undefined ? 'undefined' : ret === expected ? 'same' : name(ret),
    root: [...root.childNodes].map(name).join(','),
    fragment: f ? f.childNodes.length : null,
    parents: [...root.childNodes].every(n => n.parentNode === root) && (!f || [...root.childNodes].every(n => n.parentNode !== f)),
    records: records(observer.takeRecords()),
  });
  const out = {};
  root.append(el('x'));
  observer.takeRecords();
  let f = watch(frag('F1', 'a', 'b'));
  out.appendChild = state(f, root.appendChild(f), f);
  f = watch(frag('F2', 'c', 'd'));
  out.insertBefore = state(f, root.insertBefore(f, root.querySelector('#x')), f);
  f = watch(frag('F3', 'e', 'f'));
  out.append = state(f, root.append(f, 'text', el('g')));
  f = watch(frag('F4', 'h', 'i'));
  out.prepend = state(f, root.prepend(f));
  f = watch(frag('F5', 'j', 'k'));
  const x = root.querySelector('#x');
  out.replaceChild = state(f, root.replaceChild(f, x), x);
  f = watch(frag('F6', 'l', 'm'));
  out.replaceChildren = state(f, root.replaceChildren(f, el('n')));
  f = watch(frag('F7'));
  out.emptyAppendChild = state(f, root.appendChild(f), f);
  f = watch(frag('F8'));
  out.emptyInsertBefore = state(f, root.insertBefore(f, root.firstChild), f);
  f = watch(frag('F9'));
  out.emptyReplaceChildren = state(f, root.replaceChildren(f));
  root.append(el('l'), el('m'), el('n'));
  observer.takeRecords();
  const outer = watch(frag('OUT', 'p'));
  const inner = watch(frag('IN', 'q', 'r'));
  const nested = outer.appendChild(inner);
  out.nestedInner = { ret: nested === inner ? 'same' : name(nested), outer: [...outer.childNodes].map(name).join(','), inner: inner.childNodes.length, parents: [...outer.childNodes].every(n => n.parentNode === outer), records: records(observer.takeRecords()) };
  out.nestedOuter = state(outer, root.appendChild(outer), outer);
  out.moveExisting = state(null, root.appendChild(root.firstChild), undefined);
  const m = root.querySelector('#m');
  f = watch(frag('FB', 's', 't'));
  out.before = state(f, m.before(f, 'u'));
  f = watch(frag('FA', 'v', 'w'));
  out.after = state(f, m.after(f));
  f = watch(frag('FR', 'y'));
  out.replaceWith = state(f, m.replaceWith(f, 'z'));
  out.replaceChildrenEmpty = state(null, root.replaceChildren());
  out.selfInsert = failure(() => root.appendChild(root));
  out.notChild = failure(() => root.insertBefore(el('o'), el('o2')));
  out.notNode = failure(() => root.appendChild({}));

  // Attribute and character data records, which tweakpane's essentials plugin also observes.
  const attrs = new MutationObserver(() => {});
  const target = el('t');
  root.append(target);
  attrs.observe(root, { attributes: true, attributeOldValue: true, subtree: true });
  target.setAttribute('data-a', '1');
  target.setAttribute('data-a', '2');
  target.removeAttribute('data-a');
  target.removeAttribute('data-missing');
  target.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#a');
  target.style.width = '1px';
  target.classList.add('k');
  out.attributes = records(attrs.takeRecords());
  const filtered = new MutationObserver(() => {});
  filtered.observe(target, { attributeFilter: ['data-b'] });
  target.setAttribute('data-c', '1');
  target.setAttribute('data-b', '1');
  out.attributeFilter = records(filtered.takeRecords());
  const implied = new MutationObserver(() => {});
  implied.observe(target, { attributeOldValue: true });
  target.setAttribute('k', '1');
  target.setAttribute('k', '2');
  out.implied = records(implied.takeRecords());
  const host = el('host');
  for (const [key, options] of [['emptyOptions', {}], ['oldValueOff', { attributes: false, attributeOldValue: true }], ['filterOff', { attributes: false, attributeFilter: ['a'] }], ['characterOff', { characterData: false, characterDataOldValue: true }]]) {
    out[key] = failure(() => new MutationObserver(() => {}).observe(host, options));
  }
  out.noTarget = failure(() => new MutationObserver(() => {}).observe({}, { childList: true }));
  out.noCallback = failure(() => new MutationObserver());
  const text = document.createTextNode('a');
  host.append(text);
  const characters = new MutationObserver(() => {});
  characters.observe(host, { characterData: true, characterDataOldValue: true, subtree: true, childList: true });
  text.data = 'b';
  text.nodeValue = 'c';
  text.textContent = 'd';
  host.textContent = 'e';
  const list = characters.takeRecords();
  out.characterData = records(list);
  out.types = [list[0].constructor.name, typeof list[0].addedNodes.item, list[0].addedNodes.length, Object.prototype.toString.call(characters)];
  const disconnected = new MutationObserver(() => {});
  disconnected.observe(host, { childList: true });
  host.append(el('d1'));
  disconnected.disconnect();
  out.disconnect = disconnected.takeRecords().length;
  root.remove();
  return out;
}

// G10: records reach the callback in a microtask, after the script that queued them.
export async function delivery({ document, MutationObserver }) {
  const root = document.createElement('div');
  document.body.append(root);
  const order = [];
  const first = new MutationObserver((list, self) => order.push(`first ${list.length} ${self === first} ${list.map(r => r.type)}`));
  const second = new MutationObserver(list => order.push(`second ${list.length}`));
  second.observe(root, { attributes: true });
  first.observe(root, { childList: true });
  root.append(document.createElement('p'));
  root.setAttribute('a', '1');
  root.append(document.createElement('p'));
  order.push('sync');
  await Promise.resolve();
  order.push('after one microtask');
  root.remove();
  return order;
}

// G11: a script's DOMException has no stack in Edge; one the platform throws has its own.
export function exceptions({ document, DOMException }) {
  const describe = e => ({ type: typeof e.stack, own: Object.hasOwn(e, 'stack'), first: String(e.stack).split('\n')[0], frames: String(e.stack).split('\n').length > 1, name: e.name, code: e.code, message: e.message, error: e instanceof Error, string: String(e), tag: Object.prototype.toString.call(e) });
  const out = { constructed: describe(new DOMException('m', 'NotFoundError')), empty: describe(new DOMException()) };
  try { document.body.removeChild(document.createElement('p')); } catch (e) { out.thrown = describe(e); }
  try { document.querySelector('!!'); } catch (e) { out.selector = describe(e); }
  return out;
}

// G12: the constructor's options and errors.
export function observerOptions({ IntersectionObserver }) {
  const io = new IntersectionObserver(() => {});
  const out = {
    defaults: { root: io.root, rootMargin: io.rootMargin, thresholds: io.thresholds, scrollMargin: io.scrollMargin, delay: io.delay, trackVisibility: io.trackVisibility, tag: Object.prototype.toString.call(io) },
    thresholds: new IntersectionObserver(() => {}, { threshold: [0, 0.5, 1] }).thresholds,
    single: new IntersectionObserver(() => {}, { threshold: 0.25 }).thresholds,
    emptyThresholds: new IntersectionObserver(() => {}, { threshold: [] }).thresholds,
    unsortedThresholds: new IntersectionObserver(() => {}, { threshold: [1, 0, 0.5, 0.5] }).thresholds,
    badThreshold: failure(() => new IntersectionObserver(() => {}, { threshold: 2 })),
    noCallback: failure(() => new IntersectionObserver()),
    observeBad: failure(() => io.observe({})),
  };
  for (const margin of ['10px', '10px 5%', '0', '0px', '-10px 2.5px', '10px 5% 1px', '1px 2px 3px 4px 5px', '', 'calc(1px)', '10em']) {
    out[`margin ${JSON.stringify(margin)}`] = failure(() => new IntersectionObserver(() => {}, { rootMargin: margin }).rootMargin);
  }
  return out;
}

// G12: entries for fixed boxes against the 1280 x 720 viewport, the first callback's timing, threshold crossings,
// root margins and element roots. Needs frames, so it runs in Edge and the host only.
export async function intersections({ document, IntersectionObserver, requestAnimationFrame, setTimeout }) {
  const el = id => Object.assign(document.createElement('div'), { id });
  const box = (id, style) => { const e = el(id); e.style.cssText = `position: fixed; ${style}`; return e; };
  const entry = e => ({
    target: e.target.id, isIntersecting: e.isIntersecting, ratio: e.intersectionRatio, isVisible: e.isVisible,
    bounds: JSON.stringify(e.boundingClientRect), intersection: JSON.stringify(e.intersectionRect),
    root: e.rootBounds === null ? null : JSON.stringify(e.rootBounds), time: typeof e.time,
    types: [e.constructor.name, e.boundingClientRect.constructor.name, e.rootBounds?.constructor.name ?? null].join(','),
  });
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))));
  const onscreen = box('on', 'left: 10px; top: 20px; width: 100px; height: 50px');
  const offscreen = box('off', 'left: 10px; top: 2000px; width: 100px; height: 50px');
  const detached = box('detached', 'left: 10px; top: 20px; width: 100px; height: 50px');
  const zero = box('zero', 'left: 10px; top: 10px; width: 0px; height: 0px');
  const half = box('half', 'left: -50px; top: 10px; width: 100px; height: 50px');
  document.body.append(onscreen, offscreen, zero, half);
  const out = {};
  // The first callback against frames and timers, from an observe() in a frame callback.
  const timeline = [];
  let frames = 0;
  const tick = () => { timeline.push(`raf ${++frames}`); if (frames < 3) requestAnimationFrame(tick); };
  out.first = await new Promise(resolve => {
    requestAnimationFrame(() => {
      timeline.push('observe');
      const watcher = new IntersectionObserver((list, self) => { timeline.push(`callback ${list.length} ${self === watcher}`); resolve(list.map(entry)); watcher.disconnect(); });
      for (const target of [onscreen, offscreen, detached, zero, half]) watcher.observe(target);
      timeline.push(`takeRecords ${watcher.takeRecords().length}`);
      setTimeout(() => timeline.push('timeout 0'), 0);
      Promise.resolve().then(() => timeline.push('microtask'));
      requestAnimationFrame(tick);
    });
  });
  await settle();
  out.timeline = timeline;
  // Threshold crossings: the half box moves fully on screen, partly off, all the way off, is observed again while
  // observed, and moves back on after unobserve().
  const crossings = [];
  const crossing = new IntersectionObserver(list => crossings.push(...list.map(e => `${e.target.id} ${e.isIntersecting} ${e.intersectionRatio}`)), { threshold: [0, 0.5, 1] });
  crossing.observe(half);
  await settle();
  for (const left of ['10px', '-80px', '-2000px']) {
    half.style.left = left;
    await settle();
  }
  crossing.observe(half);
  await settle();
  crossing.unobserve(half);
  half.style.left = '10px';
  await settle();
  crossings.push(`takeRecords ${crossing.takeRecords().length}`);
  out.crossings = crossings;
  // A box that moves within one threshold band gets no new entry.
  const band = [];
  const steady = new IntersectionObserver(list => band.push(...list.map(e => `${e.target.id} ${e.intersectionRatio}`)));
  steady.observe(onscreen);
  await settle();
  onscreen.style.left = '200px';
  await settle();
  steady.disconnect();
  out.sameBand = band;
  // A margin grows the root: a box 30px below the viewport intersects with a 40px margin.
  const near = box('near', 'left: 10px; top: 750px; width: 100px; height: 50px');
  document.body.append(near);
  const margins = [];
  const grown = new IntersectionObserver(list => margins.push(...list.map(entry)), { rootMargin: '40px' });
  grown.observe(near);
  await settle();
  grown.disconnect();
  out.rootMargin = margins;
  // An element root: a fixed descendant leaves its containing block chain, as does an element outside it; an
  // absolute descendant of a fixed root is clipped to the root.
  const holder = box('holder', 'left: 0px; top: 0px; width: 50px; height: 50px');
  const inside = box('inside', 'left: 25px; top: 25px; width: 50px; height: 50px');
  const absolute = box('absolute', 'left: 40px; top: 20px; width: 20px; height: 10px');
  absolute.style.position = 'absolute';
  holder.append(inside, absolute);
  document.body.append(holder);
  const rooted = [];
  const clipped = new IntersectionObserver(list => rooted.push(...list.map(entry)), { root: holder });
  for (const target of [inside, onscreen, absolute]) clipped.observe(target);
  await settle();
  clipped.disconnect();
  out.elementRoot = rooted;
  // Edge-adjacent, partly outside the bottom edge, and larger than the viewport.
  const edge = box('edge', 'left: 10px; top: 720px; width: 100px; height: 50px');
  const bottom = box('bottom', 'left: 10px; top: 700px; width: 100px; height: 50px');
  const wide = box('wide', 'left: -100px; top: -100px; width: 2000px; height: 1000px');
  document.body.append(edge, bottom, wide);
  const edges = [];
  const edged = new IntersectionObserver(list => edges.push(...list.map(entry)), { threshold: [0, 1] });
  for (const target of [edge, bottom, wide]) edged.observe(target);
  await settle();
  edged.disconnect();
  out.edges = edges;
  // One threshold of 0.5: a box that comes 20% on screen starts intersecting without crossing the threshold.
  const late = box('late', 'left: 10px; top: 2000px; width: 100px; height: 50px');
  document.body.append(late);
  const single = [];
  const halfway = new IntersectionObserver(list => single.push(...list.map(e => `${e.target.id} ${e.isIntersecting} ${e.intersectionRatio}`)), { threshold: 0.5 });
  halfway.observe(late);
  await settle();
  for (const top of ['710px', '600px', '715px']) {
    late.style.top = top;
    await settle();
  }
  halfway.disconnect();
  out.singleThreshold = single;
  for (const node of [onscreen, offscreen, zero, half, near, holder, edge, bottom, wide, late]) node.remove();
  return out;
}

// G13: the namespaced attribute methods on SVG and HTML elements.
export function namespaces({ document }) {
  const SVG = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttributeNS(null, 'viewBox', '0 0 10 10');
  svg.setAttribute('preserveAspectRatio', 'none');
  const use = document.createElementNS(SVG, 'use');
  use.setAttributeNS(XLINK, 'xlink:href', '#a');
  const path = document.createElementNS(SVG, 'path');
  path.setAttributeNS(null, 'd', 'M0 0');
  svg.append(use, path);
  const div = document.createElement('div');
  div.setAttributeNS(null, 'Data-X', '1');
  const htmlNs = document.createElementNS('http://www.w3.org/1999/xhtml', 'DIV');
  const foreign = document.createElementNS(SVG, 'foreignObject');
  const out = {
    svg: [svg.tagName, svg.localName, svg.nodeName, svg.namespaceURI, svg.constructor.name, svg.prefix],
    foreign: [foreign.tagName, foreign.localName, foreign.constructor.name],
    path: [path.constructor.name, path.getAttribute('d'), path.getAttributeNS(null, 'd')],
    htmlNs: [htmlNs.tagName, htmlNs.localName, htmlNs.namespaceURI],
    viewBox: [svg.getAttribute('viewBox'), svg.getAttribute('viewbox'), svg.getAttributeNS(null, 'viewBox'), svg.getAttributeNS(null, 'viewbox'), svg.hasAttributeNS(null, 'viewBox'), svg.hasAttribute('viewBox')],
    preserve: [svg.getAttributeNS(null, 'preserveAspectRatio'), svg.getAttribute('preserveaspectratio')],
    names: svg.getAttributeNames(),
    xlink: [use.getAttribute('xlink:href'), use.getAttributeNS(XLINK, 'href'), use.hasAttributeNS(XLINK, 'href'), use.getAttributeNS(null, 'href'), use.getAttributeNS(XLINK, 'xlink:href'), use.getAttributeNames().join(',')],
    selector: [svg.querySelector('[d]') === path, svg.querySelector('use') === use],
    outer: svg.outerHTML,
    htmlCase: [div.getAttribute('data-x'), div.getAttribute('Data-X'), div.getAttributeNS(null, 'Data-X'), div.getAttributeNS(null, 'data-x'), div.hasAttribute('data-x'), div.getAttributeNames().join(',')],
  };
  use.setAttributeNS(XLINK, 'other:href', '#b');
  out.overwrite = [use.getAttribute('xlink:href'), use.getAttribute('other:href'), use.getAttributeNS(XLINK, 'href'), use.getAttributeNames().join(',')];
  out.removeNS = [use.removeAttributeNS(XLINK, 'href'), use.hasAttribute('xlink:href'), use.getAttributeNames().join(','), use.removeAttributeNS(XLINK, 'missing')];
  use.setAttributeNS(null, 'href', '#c');
  use.setAttributeNS(XLINK, 'xlink:href', '#d');
  out.both = [use.getAttribute('href'), use.getAttributeNS(null, 'href'), use.getAttributeNS(XLINK, 'href'), use.getAttributeNames().join(','), use.outerHTML];
  use.removeAttribute('href');
  out.removeAttribute = [use.getAttributeNames().join(','), use.getAttributeNS(XLINK, 'href')];
  const clone = svg.cloneNode(true);
  out.clone = [clone.namespaceURI, clone.constructor.name, clone.getAttribute('viewBox'), clone.lastChild.getAttributeNS(null, 'd'), clone.firstChild.getAttributeNS(XLINK, 'href')];
  out.nullPrefix = failure(() => svg.setAttributeNS(null, 'x:y', '1'));
  out.xmlns = failure(() => svg.setAttributeNS(null, 'xmlns', '1'));
  out.emptyNs = failure(() => { svg.setAttributeNS('', 'w', '5'); return svg.getAttributeNS(null, 'w'); });
  out.args = failure(() => svg.setAttributeNS(null, 'q'));
  return out;
}
