import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasGradient, FontFace, FontFaceSet, ImageData, OffscreenCanvas, Path2D, parseColor, parseFont, serializeColor, serializeFont, setCanvasHost } from '../src/platform/canvas2d.js';
import { Document } from '../src/platform/dom.js';

const edge = JSON.parse(readFileSync(new URL('./fixtures/canvas2d-edge.json', import.meta.url), 'utf8'));
const cases = kind => edge.lines.filter(line => line.kind === kind);

// A host that records each draw and fills whole-pixel rectangles with the fill color, enough to see what the
// context sends and what its pixels hold.
const calls = [];
setCanvasHost({
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
});
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

test('canvases match Edge\'s pixels: folio\'s labels, scripts no requested font covers, named Windows fonts', { skip: !hostPath && 'no host executable; set THREEJSC_HOST' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'threejsc-canvas2d-'));
  try {
    const run = spawnSync(hostPath, ['--headless', '1', '--entry', fileURLToPath(new URL('./canvas2d-pixels.js', import.meta.url))], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr);
    const lines = readFileSync(join(dir, 'host.log'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('P ')).map(line => JSON.parse(line.slice(2)));
    assert.equal(lines.length, 25);
    const failures = lines.filter(line => line.size !== line.edgeSize || Math.abs(line.coverage - 1) > 0.02 || line.mean > 0.02)
      .map(line => `${line.name}: ${line.size} vs Edge ${line.edgeSize}, coverage ${line.coverage.toFixed(4)} of Edge's, mean difference ${(line.mean * 100).toFixed(3)}%`);
    assert.deepEqual(failures, []);
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
