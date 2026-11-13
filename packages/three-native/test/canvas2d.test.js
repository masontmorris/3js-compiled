import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasGradient, FontFace, FontFaceSet, FontFaceSetLoadEvent, ImageData, OffscreenCanvas, Path2D, parseColor, parseFont, serializeColor, serializeFont, setCanvasHost } from '../src/platform/canvas2d.js';
import { Document } from '../src/platform/dom.js';
import { DOMMatrix } from '../src/platform/geometry.js';

const edge = JSON.parse(readFileSync(new URL('./fixtures/canvas2d-edge.json', import.meta.url), 'utf8'));
const cases = kind => edge.lines.filter(line => line.kind === kind);

// A host that records each draw and fills whole-pixel rectangles with the fill color, enough to see what the
// context sends and what its pixels hold.
const calls = [];
const canvasHost = {
  fontLoad: () => 1,
  fillRect: (pixels, width, height, draw) => {
    calls.push(['fillRect', draw]);
    const [x, y, w, h] = draw.rect;
    const rgba = draw.style.paint.rgba.map(v => Math.round(v * 255));
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
      for (let column = Math.max(0, x); column < Math.min(width, x + w); column++) pixels.set(rgba, (row * width + column) * 4);
    }
  },
  clearRect: (...args) => calls.push(['clearRect', args[3]]),
  drawImage: (...args) => calls.push(['drawImage', args[4]]),
  text: (...args) => calls.push(['text', args[3]]),
  measure: request => ({ width: request.text.length }),
  unpremultiply: (from, to) => to.set(from),
};
setCanvasHost(canvasHost);
const context = () => new Document({}).createElement('canvas').getContext('2d');

test('fillStyle keeps and serializes colors as Edge does', () => {
  const ctx = context();
  for (const { input, value } of cases('fillStyle')) {
    ctx.fillStyle = '#123456';
    ctx.fillStyle = input;
    assert.equal(ctx.fillStyle, value, input);
  }
  assert.deepEqual(parseColor('rgb(10 20 30 / 25%)'), [10, 20, 30, 64]);
  assert.equal(serializeColor([255, 0, 0, 128]), 'rgba(255, 0, 0, 0.5)');
});

test('font keeps and serializes values as Edge does', () => {
  const ctx = context();
  for (const { input, value } of cases('font')) {
    ctx.font = '10px sans-serif';
    ctx.font = input;
    assert.equal(ctx.font, value, input);
  }
  assert.equal(serializeFont(parseFont('700 36.571428px Nunito')), 'bold 36.5714px Nunito');
});

test('setting the canvas size clears its pixels and resets the state, even to the same size', () => {
  const canvas = new Document({}).createElement('canvas');
  canvas.width = 4;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.font = '700 20px Nunito';
  ctx.fillRect(0, 0, 4, 2);
  assert.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [255, 0, 0, 255]);
  canvas.width = 4;
  assert.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [0, 0, 0, 0]);
  assert.equal(ctx.fillStyle, '#000000');
  assert.equal(ctx.font, '10px sans-serif');
  canvas.height = 3;
  const pixels = canvas[Symbol.for('threejsc.pixels')];
  assert.deepEqual([pixels.width, pixels.height, pixels.data.length], [4, 3, 48]);
});

test('drawImage draws only the part of the source rectangle inside the image, into the matching destination', () => {
  const ctx = context();
  const image = { localName: 'img', [Symbol.for('threejsc.pixels')]: { width: 10, height: 10, data: new Uint8Array(400), premultiplied: false } };
  calls.length = 0;
  ctx.drawImage(image, -5, 0, 10, 10, 100, 0, 20, 20);
  assert.deepEqual(calls[0][1].source, [0, 0, 5, 10]);
  assert.deepEqual(calls[0][1].dest, [110, 0, 10, 20]);
  assert.throws(() => ctx.drawImage(image, 0), TypeError);
});

test('text draws send the resolved font list, alignment and baseline', () => {
  const doc = new Document({});
  const ctx = doc.createElement('canvas').getContext('2d');
  const face = new FontFace('Amatic SC', new Uint8Array(4), { weight: '700' });
  doc.fonts.add(face);
  return face.loaded.then(() => {
    calls.length = 0;
    ctx.font = '700 64px "Amatic SC", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('a\tb', 10, 20, 50);
    const draw = calls[0][1];
    assert.deepEqual(draw.font, { families: [{ face: { id: 1, weight: [700, 700] } }, { system: 'arial' }, { generic: 'sans-serif' }], size: 64, weight: 700, italic: false });
    assert.deepEqual([draw.text, draw.align, draw.baseline, draw.maxWidth, draw.stroke], ['a b', 'center', 'middle', 50, null]);
    ctx.fillText('skipped', 0, 0, 0);
    assert.equal(calls.length, 1);
  });
});

test('font matching picks the face CSS picks for a weight', () => {
  const set = new FontFaceSet();
  const faces = Object.fromEntries(['300', '400', '600', '700', '200 1000'].map(weight => [weight, new FontFace('F', 'url(x)', { weight })]));
  for (const weight of ['300', '400', '600', '700']) set.add(faces[weight]);
  const pick = weight => set.matching('f', { style: 'normal', weight })[0].weight;
  assert.equal(pick(450), '400');
  assert.equal(pick(500), '400');
  assert.equal(pick(650), '700');
  assert.equal(pick(200), '300');
  assert.equal(pick(350), '300');
  set.add(faces['200 1000']);
  set.delete(faces['400']);
  assert.equal(pick(450), '200 1000');
});

test('a FontFace from bytes is loaded and draws on the same tick', () => {
  const doc = new Document({});
  const ctx = doc.createElement('canvas').getContext('2d');
  const face = new FontFace('Bytes', new Uint8Array(4), { weight: '700' });
  assert.equal(face.status, 'loaded');
  doc.fonts.add(face);
  assert.equal(doc.fonts.check('700 64px Bytes'), true);
  calls.length = 0;
  ctx.font = '700 64px Bytes';
  ctx.fillText('a', 0, 0);
  assert.deepEqual(calls[0][1].font.families, [{ face: { id: 1, weight: [700, 700] } }]);
});

test('document.fonts.ready resolves with an unloaded URL face and stays one promise until the set changes', async () => {
  const set = new FontFaceSet();
  set.add(new FontFace('Lazy', 'url(missing.ttf)'));
  const first = set.ready;
  assert.equal(set.ready, first);
  await first;
  set.add(new FontFace('Other', 'url(other.ttf)'));
  assert.notEqual(set.ready, first);
});

test('canvas state saves, restores and resets as Edge does, and ignores a bad composite operation', () => {
  const ctx = context();
  ctx.save();
  ctx.shadowBlur = 5;
  ctx.letterSpacing = '3px';
  ctx.restore();
  assert.equal(ctx.shadowBlur, 0);
  assert.equal(ctx.letterSpacing, '0px');
  ctx.shadowBlur = 7;
  ctx.canvas.width = 10;
  assert.equal(ctx.shadowBlur, 0);
  ctx.globalCompositeOperation = 'bogus';
  assert.equal(ctx.globalCompositeOperation, 'source-over');
  ctx.globalCompositeOperation = 'multiply';
  assert.equal(ctx.globalCompositeOperation, 'multiply');
});

test('setAttribute width resizes and resets the canvas as the property does', () => {
  const canvas = new Document({}).createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = '700 20px Nunito';
  canvas.setAttribute('width', '12');
  assert.equal(canvas.width, 12);
  assert.equal(ctx.font, '10px sans-serif');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 12, 10);
  assert.deepEqual([...ctx.getImageData(11, 0, 1, 1).data], [255, 0, 0, 255]);
});

test('the out-of-scope canvas calls return inert values instead of throwing', () => {
  const ctx = context();
  const gradient = ctx.createConicGradient(0, 5, 5);
  gradient.addColorStop(0, 'red');
  assert.equal(typeof gradient, 'object');
  assert.deepEqual(ctx.getContextAttributes(), { alpha: true, colorSpace: 'srgb', colorType: 'unorm8', desynchronized: false, toneMapping: { mode: 'standard' }, willReadFrequently: false });
  assert.equal(ctx.isContextLost(), false);
  assert.equal(typeof new Path2D(), 'object');
  assert.equal(typeof new OffscreenCanvas(4, 4).getContext('2d').fillRect, 'function');
  assert.ok(ctx.canvas.toDataURL().startsWith('data:image/png;base64,'));
});

test('gradients reject offsets outside 0 to 1 and colors that do not parse', () => {
  const gradient = context().createLinearGradient(0, 0, 1, 0);
  assert.ok(gradient instanceof CanvasGradient);
  assert.throws(() => gradient.addColorStop(1.5, 'red'), { name: 'IndexSizeError' });
  assert.throws(() => gradient.addColorStop(0.5, 'nope'), { name: 'SyntaxError' });
  gradient.addColorStop(0.5, 'blue');
  gradient.addColorStop(0.5, 'red');
  assert.deepEqual(gradient.stops.map(stop => stop.rgba), [[0, 0, 1, 1], [1, 0, 0, 1]]);
});

// measureText runs in the host, whose ops shape and measure the text, headless so it needs no GPU. Set
// THREEJSC_HOST to the host executable; the test is skipped when none is built.
const root = fileURLToPath(new URL('../../../', import.meta.url));
// A THREEJSC_HOST that is set is used even when it names no file, so a wrong setting fails instead of skipping.
const hostPath = process.env.THREEJSC_HOST ? resolve(root, process.env.THREEJSC_HOST) : [join(root, 'target/release/host.exe')].find(path => existsSync(path));

test('measureText matches Edge for folio\'s fonts, Windows fonts and every alignment and baseline', { skip: !hostPath && 'no host executable; set THREEJSC_HOST' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejsc-canvas2d-'));
  try {
    const run = spawnSync(hostPath, ['--headless', '3', '--entry', fileURLToPath(new URL('./canvas2d-measure.js', import.meta.url))], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const ours = readFileSync(join(dir, 'host.log'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('M ')).map(line => JSON.parse(line.slice(2)));
    assert.equal(ours.length, edge.lines.length);
    const failures = [];
    ours.forEach((line, i) => {
      const expected = edge.lines[i];
      if (expected.kind === 'context') {
        for (const key of Object.keys(expected)) {
          if (key === 'kind') continue;
          if (JSON.stringify(line[key]) !== JSON.stringify(expected[key])) failures.push(`context ${key}: ${JSON.stringify(line[key])} != Edge ${JSON.stringify(expected[key])}`);
        }
        return;
      }
      const label = `${expected.font} ${JSON.stringify(expected.text ?? expected.input)} ${expected.align ?? ''} ${expected.baseline ?? ''}`;
      if (expected.kind === 'fillStyle' || expected.kind === 'font') {
        if (line.value !== expected.value) failures.push(`${expected.kind} ${label}: ${line.value} != ${expected.value}`);
        return;
      }
      const near = (key, tolerance) => {
        if (!(Math.abs(line[key] - expected[key]) <= tolerance)) failures.push(`${label} ${key}: ${line[key]} != Edge ${expected[key]}`);
      };
      near('width', 0.01);
      for (const key of ['fontBoundingBoxAscent', 'fontBoundingBoxDescent', 'hangingBaseline', 'alphabeticBaseline', 'ideographicBaseline']) near(key, 0.01);
      // Ink boxes come from the outlines. Characters in a script the web font lacks draw from a Windows fallback,
      // whose ink Edge measures through DirectWrite's hinted outlines, and a synthetic-bold face extends Edge's ink
      // past the plain outline, so those rows are checked on width and font boxes only.
      const latin = [...(expected.text ?? '')].every(c => c.codePointAt(0) < 0x0250);
      const syntheticBold = expected.font.includes('Nunito Plain') && /^(700|900|bold) /.test(expected.font);
      if (/Amatic SC|Nunito/.test(expected.font) && latin && !syntheticBold) for (const key of ['actualBoundingBoxLeft', 'actualBoundingBoxRight', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent']) near(key, 1.001);
    });
    assert.deepEqual(failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The pixel records that differ from Edge or lack a measurement: no size or another size, coverage more than 2% off,
// or a mean difference over 2%.
const pixelFailures = lines => lines.filter(line => !/^[1-9]\d*x[1-9]\d*$/.test(line.size) || line.size !== line.edgeSize
  || !Number.isFinite(line.coverage) || !Number.isFinite(line.mean) || Math.abs(line.coverage - 1) > 0.02 || Math.abs(line.mean) > 0.02)
  .map(line => `${line.name}: ${line.size} vs Edge ${line.edgeSize}, coverage ${Number(line.coverage).toFixed(4)} of Edge's, mean difference ${(Number(line.mean) * 100).toFixed(3)}%`);

test('the pixel check fails records that lack a size, coverage or mean', () => {
  const good = { name: 'a', size: '2x2', edgeSize: '2x2', coverage: 1, mean: 0 };
  assert.deepEqual(pixelFailures([good]), []);
  for (const missing of ['size', 'edgeSize', 'coverage', 'mean']) {
    const { [missing]: _, ...line } = good;
    assert.equal(pixelFailures([line]).length, 1, missing);
  }
  assert.equal(pixelFailures([{ ...good, size: '0x2', edgeSize: '0x2' }]).length, 1);
  assert.equal(pixelFailures([{ ...good, mean: -0.5 }]).length, 1);
});

test('canvases match Edge\'s pixels: folio\'s labels, scripts no requested font covers, named Windows fonts', { skip: !hostPath && 'no host executable; set THREEJSC_HOST' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejsc-canvas2d-'));
  try {
    const run = spawnSync(hostPath, ['--headless', '1', '--entry', fileURLToPath(new URL('./canvas2d-pixels.js', import.meta.url))], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr);
    const lines = readFileSync(join(dir, 'host.log'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('P ')).map(line => JSON.parse(line.slice(2)));
    assert.equal(lines.length, 25);
    assert.deepEqual(pixelFailures(lines), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ImageData rejects empty and inconsistent pixel arrays', () => {
  assert.throws(() => new ImageData(new Uint8ClampedArray(0), 1), { name: 'IndexSizeError' });
  assert.throws(() => new ImageData(new Uint8ClampedArray(8), 1, 1), { name: 'IndexSizeError' });
  assert.equal(new ImageData(new Uint8ClampedArray(8), 1).height, 2);
});

test('removing or setting a canvas dimension via namespace resets its context', () => {
  const canvas = new Document({}).createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 12;
  ctx.font = '20px serif';
  canvas.removeAttribute('width');
  assert.equal(canvas.width, 300);
  assert.equal(ctx.font, '10px sans-serif');
  ctx.font = '20px serif';
  canvas.setAttributeNS(null, 'height', '20');
  assert.equal(canvas.height, 20);
  assert.equal(ctx.font, '10px sans-serif');
});

test('a pending fonts.ready waits for faces that begin loading later', async () => {
  const originalFetch = globalThis.fetch;
  const pending = new Map();
  globalThis.fetch = url => new Promise(resolve => pending.set(url, resolve));
  try {
    const first = new FontFace('First', 'url(https://example.test/first)');
    const second = new FontFace('Second', 'url(https://example.test/second)');
    const set = new FontFaceSet();
    set.add(first); set.add(second);
    first.load();
    let resolved = false;
    const ready = set.ready.then(() => { resolved = true; });
    second.load();
    pending.get('https://example.test/first')({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    await first.loaded;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolved, false);
    pending.get('https://example.test/second')({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    await ready;
    assert.equal(second.status, 'loaded');
  } finally { globalThis.fetch = originalFetch; }
});

test('a face that failed to load makes fonts.load reject and fonts.check return false', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    const set = new FontFaceSet();
    const face = new FontFace('Gone', 'url(https://example.test/gone)');
    set.add(face);
    await assert.rejects(face.load(), { name: 'NetworkError' });
    await assert.rejects(set.load('16px Gone'), { name: 'NetworkError' });
    assert.equal(set.check('16px Gone'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('a failed face beside a loaded face with the same descriptors makes fonts.check false and fonts.load reject in either order, as in Edge', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => (url.includes('gone') ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  try {
    for (const order of ['failed first', 'loaded first']) {
      const set = new FontFaceSet();
      const bad = new FontFace('Twin', 'url(https://example.test/gone)');
      const good = new FontFace('Twin', 'url(https://example.test/twin)');
      for (const face of order === 'failed first' ? [bad, good] : [good, bad]) set.add(face);
      await Promise.allSettled([bad.load(), good.load()]);
      assert.deepEqual([bad.status, good.status], ['error', 'loaded'], order);
      assert.equal(set.check('16px Twin', 'a'), false, order);
      await assert.rejects(set.load('16px Twin', 'a'), { name: 'NetworkError' }, order);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('getTransform returns a DOMMatrix of the current transform', () => {
  const ctx = context();
  ctx.setTransform(2, 0, 0, 4, 10, 20);
  const matrix = ctx.getTransform();
  assert.ok(matrix instanceof DOMMatrix);
  assert.equal(String(matrix), 'matrix(2, 0, 0, 4, 10, 20)');
  const point = matrix.inverse().transformPoint({ x: 12, y: 24 });
  assert.deepEqual([point.x, point.y], [1, 1]);
  matrix.a = 5;
  assert.equal(ctx.getTransform().a, 2);
});

test('getImageData and putImageData truncate their arguments toward zero', () => {
  const canvas = new Document({}).createElement('canvas');
  canvas.width = 2;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 1, 1);
  assert.deepEqual([...ctx.getImageData(-0.5, 0, 1, 1).data], [255, 0, 0, 255]);
  assert.throws(() => ctx.getImageData(0, 0, 0.5, 1), { name: 'IndexSizeError' });
  assert.throws(() => ctx.getImageData(0, 0, 1, -0.5), { name: 'IndexSizeError' });
  const blue = new ImageData(new Uint8ClampedArray([0, 0, 255, 255]), 1);
  ctx.putImageData(blue, 1.5, -0.5);
  assert.deepEqual([...ctx.getImageData(0, 0, 2, 1).data], [255, 0, 0, 255, 0, 0, 255, 255]);
  ctx.putImageData(blue, -0.5, 0, -0.5, 0, 1.5, 1);
  assert.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [0, 0, 255, 255]);
});

test('drawImage keeps a fractional source rectangle', () => {
  const ctx = context();
  const image = { localName: 'img', [Symbol.for('threejsc.pixels')]: { width: 10, height: 10, data: new Uint8Array(400), premultiplied: false } };
  calls.length = 0;
  ctx.drawImage(image, 0.5, 0.25, 1, 2, 0, 0, 4, 4);
  assert.deepEqual(calls[0][1].source, [0.5, 0.25, 1, 2]);
  assert.deepEqual(calls[0][1].dest, [0, 0, 4, 4]);
  ctx.drawImage(image, -0.5, 9.5, 2, 2, 0, 0, 4, 4);
  assert.deepEqual(calls[1][1].source, [0, 9.5, 1.5, 0.5]);
  assert.deepEqual(calls[1][1].dest, [1, 0, 3, 1]);
});

test('fonts.load and fonts.check pick the unicode-range subsets the text needs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  try {
    const set = new FontFaceSet();
    const latin = new FontFace('Game', 'url(https://example.test/latin)', { unicodeRange: 'U+0-FF' });
    const cyrillic = new FontFace('Game', 'url(https://example.test/cyrillic)', { unicodeRange: 'U+400-4FF' });
    set.add(latin);
    set.add(cyrillic);
    assert.equal(set.check('16px Game', 'Ж'), false);
    assert.deepEqual(await set.load('16px Game', 'Ж'), [cyrillic]);
    assert.equal(latin.status, 'unloaded');
    assert.equal(set.check('16px Game', 'Ж'), true);
    assert.equal(set.check('16px Game', 'a'), false);
    assert.deepEqual(await set.load('16px Game'), [latin]);
    assert.equal(set.check('16px Game', 'aЖ'), true);
    assert.deepEqual(await set.load('16px Game', '一'), []);
  } finally { globalThis.fetch = originalFetch; }
});

test('text draws send every unicode-range subset with its ranges, and load only the subsets the text needs', () => {
  const doc = new Document({});
  const ctx = doc.createElement('canvas').getContext('2d');
  const latin = new FontFace('Game', new Uint8Array(4), { unicodeRange: 'U+0-FF, U+2000-206F' });
  const greek = new FontFace('Game', 'url(https://example.test/greek)', { unicodeRange: 'U+37?' });
  const cyrillic = new FontFace('Game', 'url(https://example.test/cyrillic)', { unicodeRange: 'U+400-4FF' });
  for (const face of [latin, greek, cyrillic]) doc.fonts.add(face);
  calls.length = 0;
  ctx.font = '16px Game';
  ctx.fillText('aЖ', 0, 0);
  assert.equal(greek.status, 'unloaded');
  assert.equal(cyrillic.status, 'loading');
  assert.deepEqual(calls[0][1].font.families, [
    { face: { id: 1, weight: [400, 400], ranges: [[0, 0xff], [0x2000, 0x206f]] } },
    { system: 'game' },
  ]);
});

test('unicode-range takes wildcards with or without leading digits and rejects malformed ranges', async () => {
  // The characters of `text` a face with `value` as its range would load for.
  const covered = async (value, text) => {
    const set = new FontFaceSet();
    set.add(new FontFace('W', new Uint8Array(4), { unicodeRange: value }));
    const hits = [];
    for (const c of text) if ((await set.load('16px W', c)).length) hits.push(c);
    return hits.join('');
  };
  assert.equal(await covered('U+???', 'AΩЖ࿿က'), 'AΩЖ࿿');
  assert.equal(await covered('u+4??, U+0-7f', 'AΩЖԀ'), 'AЖ');
  for (const bad of ['U+', 'U+-41', 'U+1234567', 'U+41-', 'U+4?1', 'U+???????', 'U+110000']) {
    assert.throws(() => new FontFace('W', 'url(x)', { unicodeRange: bad }), { name: 'SyntaxError' }, bad);
  }
});

test('assigning unicodeRange changes which text a face matches', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  try {
    const set = new FontFaceSet();
    const face = new FontFace('Moved', 'url(https://example.test/moved)', { unicodeRange: 'U+0-FF' });
    set.add(face);
    face.unicodeRange = 'U+400-4FF';
    assert.equal(face.unicodeRange, 'U+400-4FF');
    assert.deepEqual(await set.load('16px Moved', 'a'), []);
    assert.deepEqual(await set.load('16px Moved', 'Ж'), [face]);
    assert.throws(() => { face.unicodeRange = 'nonsense'; }, { name: 'SyntaxError' });
    assert.equal(face.unicodeRange, 'U+400-4FF');
  } finally { globalThis.fetch = originalFetch; }
});

test('font sets report a loading cycle across shared and newly added faces', async () => {
  const first = new FontFace('One', 'url(data:application/octet-stream;base64,AA==)');
  const second = new FontFace('Two', 'url(data:application/octet-stream;base64,AA==)');
  const a = new FontFaceSet();
  const b = new FontFaceSet();
  const events = [];
  for (const [name, set] of [['a', a], ['b', b]]) {
    set.onloading = event => events.push([name, event.type]);
    set.onloadingdone = event => events.push([name, event.type, [...event.fontfaces]]);
  }
  a.add(first); b.add(first);
  const p = first.load();
  a.add(second);
  const q = second.load();
  await Promise.all([p, q]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(events.filter(e => e[1] === 'loading').map(e => e[0]).sort(), ['a', 'b']);
  assert.deepEqual(events.find(e => e[0] === 'a' && e[1] === 'loadingdone')[2], [first, second]);
  assert.deepEqual(events.find(e => e[0] === 'b' && e[1] === 'loadingdone')[2], [first]);
});

test('font sets report failed faces after a load settles', async () => {
  const set = new FontFaceSet();
  const face = new FontFace('Bad', 'url(data:application/octet-stream;base64,AA==)');
  set.add(face);
  const events = [];
  set.onloadingdone = e => events.push([e.type, [...e.fontfaces]]);
  set.onloadingerror = e => events.push([e.type, [...e.fontfaces]]);
  setCanvasHost({ fontLoad: () => { throw new Error('bad font'); } });
  try {
    await assert.rejects(face.load());
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(events, [['loadingdone', []], ['loadingerror', [face]]]);
  } finally { setCanvasHost(canvasHost); }
});

test('document.fonts reports one loading cycle for a face added mid-load and none for a face it lacks, as in Edge', async () => {
  const fonts = new Document({}).fonts;
  for (const type of ['loading', 'loadingdone', 'loadingerror']) assert.ok(`on${type}` in fonts, type);
  const events = [];
  for (const type of ['loading', 'loadingdone', 'loadingerror']) {
    fonts.addEventListener(type, event => events.push([type, event instanceof FontFaceSetLoadEvent, event.fontfaces.map(face => face.family)]));
  }
  const source = 'url(data:application/octet-stream;base64,AA==)';
  await new FontFace('Loose', source).load();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(events, []);
  const first = new FontFace('Mid1', source);
  fonts.add(first);
  const p = first.load();
  const second = new FontFace('Mid2', source);
  fonts.add(second);
  await Promise.all([p, second.load()]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(events, [['loading', true, []], ['loadingdone', true, ['Mid1', 'Mid2']]]);
});

test('a face deleted while it loads leaves the cycle without failing it', async () => {
  const set = new FontFaceSet();
  const kept = new FontFace('Kept', 'url(data:application/octet-stream;base64,AA==)');
  const dropped = new FontFace('Dropped', 'url(data:application/octet-stream;base64,AA==)');
  set.add(kept); set.add(dropped);
  const events = [];
  set.onloadingdone = event => events.push([event.type, [...event.fontfaces]]);
  set.onloadingerror = event => events.push([event.type, [...event.fontfaces]]);
  const loads = [kept.load(), dropped.load()];
  set.delete(dropped);
  await Promise.all(loads);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(events, [['loadingdone', [kept]]]);
});

test('a failed face the page deletes before its cycle reports leaves no empty loadingerror', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const when of ['while another face loads', 'after the cycle ends']) {
      let release;
      const slow = new Promise(resolve => { release = resolve; });
      globalThis.fetch = async url => {
        if (url.includes('gone')) return { ok: false, status: 404 };
        await slow;
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
      };
      const set = new FontFaceSet();
      const bad = new FontFace('Bad', 'url(https://example.test/gone)');
      const good = new FontFace('Good', 'url(https://example.test/good)');
      set.add(bad); set.add(good);
      const events = [];
      set.onloadingdone = event => events.push([event.type, [...event.fontfaces]]);
      set.onloadingerror = event => events.push([event.type, [...event.fontfaces]]);
      const loads = [bad.load(), good.load()];
      if (when === 'while another face loads') {
        await assert.rejects(loads[0]);
        set.delete(bad);
        release();
        await Promise.allSettled(loads);
      } else {
        release();
        await Promise.allSettled(loads);
        set.delete(bad);
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(events, [['loadingdone', [good]]], when);
    }
  } finally { globalThis.fetch = originalFetch; }
});
