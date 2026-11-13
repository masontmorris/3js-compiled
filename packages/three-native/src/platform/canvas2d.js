// Canvas 2D, FontFace and document.fonts, as Edge draws them for what a three.js game reaches: rectangles, linear
// and radial gradients, images and text, with the drawing state, transforms and pixel access. A canvas keeps its
// pixels here as premultiplied RGBA8; the host shapes, rasterizes and composites into them in place. Paths,
// clipping, patterns, shadows, filters and compositing modes other than source-over log once and draw nothing.
import { EventTarget } from './events.js';
import { logOnce } from './dom.js';
import { DOMMatrix } from './geometry.js';

const PIXELS = Symbol.for('threejsc.pixels');
export const CONTEXT_2D = Symbol('threejsc.context2d');
export const RESIZE = Symbol('threejsc.resize');

let host = null;
// The host's ops: fontLoad(bytes) -> face id, fillRect, clearRect, drawImage, text, measure and unpremultiply.
export function setCanvasHost(value) { host = value; }

const NAMED = Object.fromEntries('aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32'
  .split(' ').reduce((pairs, word, i, words) => (i % 2 ? pairs : [...pairs, [word, words[i + 1]]]), []));

const clampByte = value => Math.min(255, Math.max(0, Math.round(value)));
function channel(text, scale = 255) {
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return NaN;
  return text.trim().endsWith('%') ? (value / 100) * scale : value;
}
function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const part = t => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
  };
  return [part(hue + 1 / 3), part(hue), part(hue - 1 / 3)].map(v => v * 255);
}

// A CSS color as 8-bit straight RGBA, as Edge stores a canvas color, or null when it does not parse.
export function parseColor(input) {
  const text = String(input).trim().toLowerCase();
  if (text === 'transparent') return [0, 0, 0, 0];
  if (text === 'currentcolor') return [0, 0, 0, 255];
  const hex = text.startsWith('#') ? text.slice(1) : NAMED[text];
  if (hex !== undefined) {
    if (!/^[0-9a-f]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
    const digits = hex.length <= 4 ? [...hex].map(d => d + d) : hex.match(/../g);
    const bytes = digits.map(d => Number.parseInt(d, 16));
    return bytes.length === 3 ? [...bytes, 255] : bytes;
  }
  const match = /^(rgba?|hsla?)\((.*)\)$/.exec(text);
  if (!match) return null;
  const parts = match[2].includes(',') ? match[2].split(',') : match[2].replace(/\s*\/\s*/, ' / ').split(/\s+/).filter(part => part !== '/');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const alpha = parts.length === 4 ? channel(parts[3], 1) : 1;
  let rgb;
  if (match[1].startsWith('rgb')) rgb = parts.slice(0, 3).map(part => channel(part));
  else {
    const [h, s, l] = [Number.parseFloat(parts[0]), channel(parts[1], 1), channel(parts[2], 1)];
    rgb = [h, s, l].some(Number.isNaN) ? [NaN] : hslToRgb(h, Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, l)));
  }
  if (rgb.some(Number.isNaN) || Number.isNaN(alpha)) return null;
  return [...rgb.map(clampByte), clampByte(Math.min(1, Math.max(0, alpha)) * 255)];
}

// Edge's serialization of a canvas color: #rrggbb when opaque, else rgba() with the shortest alpha that maps back
// to the same byte.
export function serializeColor([r, g, b, a]) {
  if (a === 255) return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  let alpha = '0';
  for (let digits = 1; digits <= 6 && a; digits++) {
    alpha = String(Number((a / 255).toFixed(digits)));
    if (Math.round(Number(alpha) * 255) === a) break;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
const SIZES = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
const UNITS = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 10, rem: 16, '%': 0.1 };
// What Edge resolves the CSS system font keywords to, in this document's default style.
const SYSTEM_FONTS = { caption: '16px Arial', icon: '16px Arial', menu: '12px "Segoe UI"', 'message-box': '16px Arial', 'small-caption': '12px "Segoe UI"', 'status-bar': '12px "Segoe UI"' };
const STRETCHES = new Set(['ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed', 'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded']);

function splitFamilies(text) {
  // Edge rejects a list with nothing after its last comma.
  if (/,\s*$/.test(text)) return null;
  const families = [];
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,"']+?))\s*(?:,|$)/gy;
  let match;
  let consumed = 0;
  while (consumed < text.length && (match = pattern.exec(text))) {
    if (match[0] === '') return null;
    const quoted = match[1] ?? match[2];
    const name = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : match[3].trim().replace(/\s+/g, ' ');
    if (quoted === undefined && (!name || /^\d/.test(name) || ['inherit', 'initial', 'unset', 'default'].includes(name.toLowerCase()))) return null;
    families.push({ name, quoted: quoted !== undefined });
    consumed = pattern.lastIndex;
  }
  return consumed >= text.length && families.length ? families : null;
}

// Parses the `font` shorthand. Returns null when the value is not one a canvas accepts.
export function parseFont(input) {
  const text = String(input).trim();
  if (/!\s*important/i.test(text)) return null;
  if (SYSTEM_FONTS[text.toLowerCase()]) return parseFont(SYSTEM_FONTS[text.toLowerCase()]);
  const sizeMatch = /(?:^|\s)((?:\d*\.)?\d+(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q|em|rem|%)(?:\s*\/\s*[^\s]+)?\s+(.+)$|(?:^|\s)(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)(?:\s*\/\s*[^\s]+)?\s+(.+)$/i.exec(text);
  if (!sizeMatch) return null;
  const size = sizeMatch[1] !== undefined ? Number(sizeMatch[1]) * UNITS[sizeMatch[2].toLowerCase()] : SIZES[sizeMatch[4].toLowerCase()];
  const families = splitFamilies(sizeMatch[3] ?? sizeMatch[5]);
  if (!families || !Number.isFinite(size)) return null;
  const font = { style: 'normal', variant: 'normal', weight: 400, stretch: 'normal', size, families };
  const seen = new Set();
  for (const word of text.slice(0, sizeMatch.index).split(/\s+/).filter(Boolean)) {
    const lower = word.toLowerCase();
    let property;
    if (lower === 'normal') continue;
    if (lower === 'italic' || lower === 'oblique') { property = 'style'; font.style = 'italic'; }
    else if (lower === 'small-caps') { property = 'variant'; font.variant = lower; }
    else if (lower === 'bold' || lower === 'bolder') { property = 'weight'; font.weight = 700; }
    else if (lower === 'lighter') { property = 'weight'; font.weight = 100; }
    else if (/^\d+(\.\d+)?$/.test(lower) && Number(lower) >= 1 && Number(lower) <= 1000) { property = 'weight'; font.weight = Number(lower); }
    else if (STRETCHES.has(lower)) { property = 'stretch'; font.stretch = lower; }
    else return null;
    if (seen.has(property)) return null;
    seen.add(property);
  }
  return font;
}

const needsQuotes = name => !GENERIC.has(name.toLowerCase()) && !/^-?[a-z_][\w-]*$/i.test(name);
// Edge's serialization of a canvas font: the style, weight, variant and stretch when not normal, the size in px,
// and the families, quoted when a name is not one identifier.
export function serializeFont(font) {
  const size = `${Number(font.size.toPrecision(6))}px`;
  const weight = font.weight === 400 ? '' : font.weight === 700 ? 'bold' : String(font.weight);
  // A generic keyword serializes lowercase, and a family the page quoted keeps its quotes, as Edge does.
  const families = font.families.map(({ name, quoted }) => {
    const value = quoted || !GENERIC.has(name.toLowerCase()) ? name : name.toLowerCase();
    return quoted || needsQuotes(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value;
  }).join(', ');
  return [font.style === 'normal' ? '' : font.style, weight, font.variant === 'normal' ? '' : font.variant, size, families].filter(Boolean).join(' ');
}

const DEFAULT_FONT = parseFont('10px sans-serif');

function parseWeightRange(value) {
  const words = String(value ?? 'normal').trim().toLowerCase().split(/\s+/);
  const weights = words.map(word => (word === 'normal' ? 400 : word === 'bold' ? 700 : Number(word)));
  if (!weights.length || weights.length > 2 || weights.some(w => !Number.isFinite(w) || w < 1 || w > 1000)) throw new DOMException(`Failed to set the 'weight' property on 'FontFace': Failed to set '${value}' as a property value.`, 'SyntaxError');
  return [Math.min(...weights), Math.max(...weights)];
}

// A `unicode-range` descriptor as inclusive code point ranges: U+41, U+400-4FF, or U+4?? with wildcards.
function parseUnicodeRange(value) {
  return String(value).split(',').map(token => {
    const match = /^\s*u\+([0-9a-f]{0,6})(?:-([0-9a-f]{1,6})|(\?{1,6}))?\s*$/i.exec(token);
    const wild = match?.[3] ?? '';
    const digits = match?.[1] ?? '';
    const range = match && [parseInt(digits + '0'.repeat(wild.length), 16), parseInt((match[2] ?? digits) + 'f'.repeat(wild.length), 16)];
    if (!range || !(digits || wild) || (match[2] && !digits) || digits.length + wild.length > 6 || range[0] > range[1] || range[1] > 0x10ffff) throw new DOMException(`Failed to set the 'unicodeRange' property on 'FontFace': Failed to set '${value}' as a property value.`, 'SyntaxError');
    return range;
  });
}

// Whether a face's ranges hold any character of `text`.
function coversAny(ranges, text) {
  for (const c of text) {
    const point = c.codePointAt(0);
    if (ranges.some(([min, max]) => point >= min && point <= max)) return true;
  }
  return false;
}

function normalizeFamily(family) {
  return String(family).trim().replace(/^(["'])(.*)\1$/, '$2');
}

// A face's parsed `unicode-range`, kept off the page's view of the object.
const RANGES = Symbol('unicode ranges');

// Bumped whenever a face starts a load, so `document.fonts.ready` changes when the page asks for a new font.
let loadGeneration = 0;

export class FontFace {
  #unicodeRange;
  #source;
  #load = null;
  #resolve;
  #reject;
  constructor(family, source, descriptors = {}) {
    this.family = normalizeFamily(family);
    this.style = String(descriptors.style ?? 'normal');
    this.weight = String(descriptors.weight ?? 'normal');
    this.stretch = String(descriptors.stretch ?? 'normal');
    this.unicodeRange = descriptors.unicodeRange ?? 'U+0-10FFFF';
    this.display = String(descriptors.display ?? 'auto');
    this.weightRange = parseWeightRange(this.weight);
    this.status = 'unloaded';
    this.faceId = null;
    this.loaded = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    this.loaded.catch(() => {});
    this.#source = source;
    // A face from bytes parses in the constructor, so Edge reports it loaded on the same tick.
    if (typeof source !== 'string') {
      try {
        const bytes = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
        this.faceId = host.fontLoad(bytes);
        this.status = 'loaded';
        this.#resolve(this);
      } catch (error) {
        this.status = 'error';
        this.#reject(new DOMException(`A network error occurred, or the font could not be parsed: ${error?.message ?? error}`, 'NetworkError'));
      }
      this.#load = this.loaded;
    }
  }

  get unicodeRange() { return this.#unicodeRange; }
  set unicodeRange(value) {
    this[RANGES] = parseUnicodeRange(value);
    this.#unicodeRange = String(value);
  }

  load() {
    if (this.#load) return this.loaded;
    this.status = 'loading';
    loadGeneration++;
    this.#load = (async () => {
      const source = this.#source;
      let bytes;
      let lastError = null;
      for (const [, url] of source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g).map(m => [m[0], m[1] ?? m[2] ?? m[3]])) {
        try {
          const response = await fetch(new URL(url, globalThis.location?.href).href);
          if (!response.ok) throw new Error(`status ${response.status}`);
          bytes = new Uint8Array(await response.arrayBuffer());
          this.faceId = host.fontLoad(bytes);
          break;
        } catch (error) { lastError = error; bytes = undefined; }
      }
      if (bytes === undefined) throw lastError ?? new Error('no url() in the source');
    })().then(() => {
      this.status = 'loaded';
      this.#resolve(this);
      return this;
    }, error => {
      this.status = 'error';
      const failure = new DOMException(`A network error occurred, or the font could not be parsed: ${error?.message ?? error}`, 'NetworkError');
      this.#reject(failure);
      throw failure;
    });
    this.#load.catch(() => {});
    return this.loaded;
  }
}

export class FontFaceSet extends EventTarget {
  #faces = new Set();
  #ready = null;
  get size() { return this.#faces.size; }
  get status() { return [...this.#faces].some(face => face.status === 'loading') ? 'loading' : 'loaded'; }
  // Resolves once every face that is loading finishes; an unloaded face does not hold it, and reads of an
  // unchanged set return the same promise, as in Edge.
  get ready() {
    if (!this.#ready || this.#ready.generation !== loadGeneration) {
      const promise = (async () => {
        let loading;
        while ((loading = [...this.#faces].filter(face => face.status === 'loading')).length) {
          await Promise.allSettled(loading.map(face => face.loaded));
        }
        return this;
      })();
      this.#ready = { generation: loadGeneration, promise };
    }
    return this.#ready.promise;
  }
  add(face) {
    if (!(face instanceof FontFace)) throw new TypeError("Failed to execute 'add' on 'FontFaceSet': parameter 1 is not of type 'FontFace'.");
    this.#faces.add(face);
    this.#ready = null;
    return this;
  }
  delete(face) { const deleted = this.#faces.delete(face); if (deleted) this.#ready = null; return deleted; }
  has(face) { return this.#faces.has(face); }
  clear() { this.#faces.clear(); this.#ready = null; }
  forEach(callback, thisArg) { for (const face of this.#faces) callback.call(thisArg, face, face, this); }
  values() { return this.#faces.values(); }
  keys() { return this.#faces.values(); }
  entries() { return [...this.#faces].map(face => [face, face]).values(); }
  [Symbol.iterator]() { return this.#faces.values(); }
  // The faces that would draw `text` in `font`, loading those not loaded yet.
  async load(font, text = ' ') {
    const parsed = parseFont(font);
    if (!parsed) throw new DOMException(`Failed to execute 'load' on 'FontFaceSet': Could not resolve '${font}' as a font.`, 'SyntaxError');
    const faces = parsed.families.flatMap(({ name }) => this.matching(name, parsed, true).filter(face => coversAny(face[RANGES], String(text))));
    return Promise.all(faces.map(face => face.load()));
  }
  check(font, text = ' ') {
    const parsed = parseFont(font);
    if (!parsed) throw new DOMException(`Failed to execute 'check' on 'FontFaceSet': Could not resolve '${font}' as a font.`, 'SyntaxError');
    return parsed.families.every(({ name }) => this.matching(name, parsed, true).filter(face => coversAny(face[RANGES], String(text))).every(face => face.status === 'loaded'));
  }
  // The faces CSS font matching picks for this family, weight and style: the best match, with the faces that
  // share its descriptors and differ only in `unicode-range`, latest added first, as CSS gives them precedence.
  // Drawing passes over faces that failed to load; load() and check() see them, so they report the failure as
  // Edge does.
  matching(name, font, failed = false) {
    const family = name.toLowerCase();
    let candidates = [...this.#faces].filter(face => face.family.toLowerCase() === family && (failed || face.status !== 'error'));
    if (!candidates.length) return [];
    const italic = font.style !== 'normal';
    const styled = candidates.filter(face => (face.style !== 'normal') === italic);
    if (styled.length) candidates = styled;
    const want = font.weight;
    const distance = face => {
      const [min, max] = face.weightRange;
      if (want >= min && want <= max) return 0;
      const nearest = want < min ? min : max;
      // CSS Fonts 4 weight matching: lighter faces first below 400, heavier above 500, and 400 to 500 tries up to
      // 500 before going lighter.
      const above = nearest > want;
      if (want < 400) return above ? 2000 + nearest : 1000 - nearest;
      if (want > 500) return above ? nearest : 2000 - nearest;
      if (above && nearest <= 500) return nearest;
      return above ? 3000 + nearest : 2000 - nearest;
    };
    candidates.sort((a, b) => distance(a) - distance(b));
    const [best] = candidates;
    return candidates.filter(face => face.style === best.style && face.weightRange.join() === best.weightRange.join()).reverse();
  }
}

export class CanvasGradient {
  constructor(geometry) {
    this.geometry = geometry;
    this.stops = [];
  }
  addColorStop(offset, color) {
    const value = Number(offset);
    if (!Number.isFinite(value)) throw new TypeError("Failed to execute 'addColorStop' on 'CanvasGradient': The provided double value is non-finite.");
    if (value < 0 || value > 1) throw new DOMException(`Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (${value}) is outside the range (0.0, 1.0).`, 'IndexSizeError');
    const rgba = parseColor(color);
    if (!rgba) throw new DOMException(`Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('${color}') could not be parsed as a color.`, 'SyntaxError');
    // Stops at the same offset keep the order they were added in.
    let at = this.stops.length;
    while (at > 0 && this.stops[at - 1].offset > value) at--;
    this.stops.splice(at, 0, { offset: value, rgba: rgba.map(v => v / 255) });
  }
  paint() {
    return { ...this.geometry, stops: this.stops.length ? this.stops : [{ offset: 0, rgba: [0, 0, 0, 0] }] };
  }
}

// A path a page builds for calls the canvas does not draw: its methods do nothing.
export class Path2D {
  constructor() { logOnce('Path2D is not implemented; its paths draw nothing'); }
  addPath() {}
  arc() {}
  arcTo() {}
  bezierCurveTo() {}
  closePath() {}
  ellipse() {}
  lineTo() {}
  moveTo() {}
  quadraticCurveTo() {}
  rect() {}
  roundRect() {}
}

// A canvas outside the document. Its 2D context draws into its own pixels, but nothing presents them.
export class OffscreenCanvas {
  constructor(width, height) {
    this.width = width >>> 0;
    this.height = height >>> 0;
    logOnce('OffscreenCanvas is not implemented; its 2D context draws but nothing presents it');
  }
  getContext(type) { return type === '2d' ? (this[CONTEXT_2D] ??= new CanvasRenderingContext2D(this)) : null; }
  transferToImageBitmap() { logOnce('OffscreenCanvas.transferToImageBitmap is not implemented'); return null; }
  convertToBlob() {
    logOnce('OffscreenCanvas.convertToBlob is not implemented');
    return Promise.reject(new DOMException('OffscreenCanvas.convertToBlob is not implemented', 'NotSupportedError'));
  }
}

export class TextMetrics {
  constructor(metrics) { Object.assign(this, metrics); }
}

export class ImageData {
  constructor(dataOrWidth, widthOrHeight, height) {
    if (dataOrWidth instanceof Uint8ClampedArray) {
      const width = widthOrHeight >>> 0;
      if (!width || !dataOrWidth.length || dataOrWidth.length % (4 * width) || (height !== undefined && height !== dataOrWidth.length / (4 * width))) throw new DOMException("Failed to construct 'ImageData': The input data length is not a multiple of (4 * width).", 'IndexSizeError');
      this.data = dataOrWidth;
      this.width = width;
      this.height = height ?? dataOrWidth.length / (4 * width);
    } else {
      this.width = dataOrWidth >>> 0;
      this.height = widthOrHeight >>> 0;
      if (!this.width || !this.height) throw new DOMException(`Failed to construct 'ImageData': The source ${this.width ? 'height' : 'width'} is zero or not a number.`, 'IndexSizeError');
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    }
    this.colorSpace = 'srgb';
  }
}

const TEXT_ALIGNS = new Set(['start', 'end', 'left', 'right', 'center']);
const TEXT_BASELINES = new Set(['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom']);
const LINE_JOINS = new Set(['miter', 'round', 'bevel']);
const LINE_CAPS = new Set(['butt', 'round', 'square']);
const IDENTITY = [1, 0, 0, 1, 0, 0];
const finite = (...values) => values.every(Number.isFinite);

function defaultState() {
  return {
    fillStyle: [0, 0, 0, 255], strokeStyle: [0, 0, 0, 255], globalAlpha: 1, lineWidth: 1, lineJoin: 'miter', lineCap: 'butt', miterLimit: 10,
    font: DEFAULT_FONT, textAlign: 'start', textBaseline: 'alphabetic', direction: 'inherit', transform: IDENTITY,
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low', globalCompositeOperation: 'source-over',
    shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0, filter: 'none',
    letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'auto', fontStretch: 'normal', fontVariantCaps: 'normal', textRendering: 'auto', lineDashOffset: 0,
  };
}

// State a canvas keeps but E6 does not draw with: setting one logs once, and save, restore and a resize keep it.
const UNSUPPORTED_DEFAULTS = { shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0, filter: 'none', letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'auto', fontStretch: 'normal', fontVariantCaps: 'normal', textRendering: 'auto', lineDashOffset: 0 };

const COMPOSITE = new Set(['source-over', 'source-in', 'source-out', 'source-atop', 'destination-over', 'destination-in', 'destination-out', 'destination-atop', 'lighter', 'copy', 'xor', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);

// Calls a game might make that this canvas does not draw: each logs its name once and returns undefined.
const NOT_IMPLEMENTED = ['beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'fill', 'stroke',
  'clip', 'isPointInPath', 'isPointInStroke', 'setLineDash', 'getLineDash', 'createPattern', 'strokeRect', 'drawFocusIfNeeded'];

export class CanvasRenderingContext2D {
  #canvas;
  #state;
  #stack = [];
  #pixels;
  #width = 0;
  #height = 0;
  #version = 0;
  #snapshot = null;
  #fonts;

  constructor(canvas, fonts) {
    this.#canvas = canvas;
    this.#fonts = fonts;
    this[RESIZE]();
  }

  get canvas() { return this.#canvas; }

  // Setting the canvas's width or height clears its pixels and resets the drawing state, as in Edge, even to the
  // same size.
  [RESIZE]() {
    this.#width = this.#canvas.width;
    this.#height = this.#canvas.height;
    this.#pixels = new Uint8Array(this.#width * this.#height * 4);
    this.#state = defaultState();
    this.#stack = [];
    this.#changed();
  }

  #changed() {
    this.#version++;
    this.#snapshot = null;
  }

  // The pixels as straight-alpha RGBA8, which uploads, drawImage and createImageBitmap read.
  get [PIXELS]() {
    if (!this.#snapshot) {
      const data = new Uint8Array(this.#pixels.length);
      if (data.length) host.unpremultiply(this.#pixels, data);
      this.#snapshot = { width: this.#width, height: this.#height, data, premultiplied: false };
    }
    return this.#snapshot;
  }

  // The pixels as they are, premultiplied, for drawing this canvas into another.
  premultipliedPixels() { return { width: this.#width, height: this.#height, data: this.#pixels, premultiplied: true }; }

  save() { this.#stack.push({ ...this.#state }); }
  restore() { if (this.#stack.length) this.#state = this.#stack.pop(); }
  reset() { this.#pixels.fill(0); this.#state = defaultState(); this.#stack = []; this.#changed(); }

  get fillStyle() { return this.#styleValue(this.#state.fillStyle); }
  set fillStyle(value) { this.#setStyle('fillStyle', value); }
  get strokeStyle() { return this.#styleValue(this.#state.strokeStyle); }
  set strokeStyle(value) { this.#setStyle('strokeStyle', value); }
  #styleValue(style) { return style instanceof CanvasGradient ? style : serializeColor(style); }
  #setStyle(key, value) {
    if (value instanceof CanvasGradient) { this.#state[key] = value; return; }
    if (value && typeof value === 'object') { logOnce(`CanvasRenderingContext2D: ${value.constructor?.name ?? 'object'} styles are not implemented`); return; }
    const rgba = parseColor(value);
    if (rgba) this.#state[key] = rgba;
  }

  get globalAlpha() { return this.#state.globalAlpha; }
  set globalAlpha(value) { const n = Number(value); if (Number.isFinite(n) && n >= 0 && n <= 1) this.#state.globalAlpha = n; }
  get lineWidth() { return this.#state.lineWidth; }
  set lineWidth(value) { const n = Number(value); if (Number.isFinite(n) && n > 0) this.#state.lineWidth = n; }
  get miterLimit() { return this.#state.miterLimit; }
  set miterLimit(value) { const n = Number(value); if (Number.isFinite(n) && n > 0) this.#state.miterLimit = n; }
  get lineJoin() { return this.#state.lineJoin; }
  set lineJoin(value) { if (LINE_JOINS.has(value)) this.#state.lineJoin = value; }
  get lineCap() { return this.#state.lineCap; }
  set lineCap(value) { if (LINE_CAPS.has(value)) this.#state.lineCap = value; }
  get textAlign() { return this.#state.textAlign; }
  set textAlign(value) { if (TEXT_ALIGNS.has(value)) this.#state.textAlign = value; }
  get textBaseline() { return this.#state.textBaseline; }
  set textBaseline(value) { if (TEXT_BASELINES.has(value)) this.#state.textBaseline = value; }
  get direction() { return this.#state.direction; }
  set direction(value) {
    if (value === 'rtl') logOnce('CanvasRenderingContext2D: direction rtl is not implemented; text draws left to right');
    if (['ltr', 'rtl', 'inherit'].includes(value)) this.#state.direction = value;
  }
  get font() { return serializeFont(this.#state.font); }
  set font(value) { const font = parseFont(value); if (font) this.#state.font = font; }
  get imageSmoothingEnabled() { return this.#state.imageSmoothingEnabled; }
  set imageSmoothingEnabled(value) { this.#state.imageSmoothingEnabled = !!value; }
  get imageSmoothingQuality() { return this.#state.imageSmoothingQuality; }
  set imageSmoothingQuality(value) { if (['low', 'medium', 'high'].includes(value)) this.#state.imageSmoothingQuality = value; }
  get globalCompositeOperation() { return this.#state.globalCompositeOperation; }
  set globalCompositeOperation(value) {
    value = String(value);
    if (!COMPOSITE.has(value)) return;
    if (value !== 'source-over') logOnce(`CanvasRenderingContext2D: globalCompositeOperation '${value}' is not implemented; drawing uses source-over`);
    this.#state.globalCompositeOperation = value;
  }

  get shadowBlur() { return this.#state.shadowBlur; }
  set shadowBlur(value) { this.#unsupported('shadowBlur', value); }
  get shadowColor() { return this.#state.shadowColor; }
  set shadowColor(value) { this.#unsupported('shadowColor', value); }
  get shadowOffsetX() { return this.#state.shadowOffsetX; }
  set shadowOffsetX(value) { this.#unsupported('shadowOffsetX', value); }
  get shadowOffsetY() { return this.#state.shadowOffsetY; }
  set shadowOffsetY(value) { this.#unsupported('shadowOffsetY', value); }
  get filter() { return this.#state.filter; }
  set filter(value) { this.#unsupported('filter', value); }
  get letterSpacing() { return this.#state.letterSpacing; }
  set letterSpacing(value) { this.#unsupported('letterSpacing', value); }
  get wordSpacing() { return this.#state.wordSpacing; }
  set wordSpacing(value) { this.#unsupported('wordSpacing', value); }
  get fontKerning() { return this.#state.fontKerning; }
  set fontKerning(value) { this.#unsupported('fontKerning', value); }
  get fontStretch() { return this.#state.fontStretch; }
  set fontStretch(value) { this.#unsupported('fontStretch', value); }
  get fontVariantCaps() { return this.#state.fontVariantCaps; }
  set fontVariantCaps(value) { this.#unsupported('fontVariantCaps', value); }
  get textRendering() { return this.#state.textRendering; }
  set textRendering(value) { this.#unsupported('textRendering', value); }
  get lineDashOffset() { return this.#state.lineDashOffset; }
  set lineDashOffset(value) { this.#unsupported('lineDashOffset', value); }
  #unsupported(name, value) {
    if (String(value) !== String(UNSUPPORTED_DEFAULTS[name])) logOnce(`CanvasRenderingContext2D.${name} is not implemented`);
    this.#state[name] = value;
  }

  createConicGradient(startAngle, x, y) {
    if (!finite(startAngle, x, y)) throw new TypeError("Failed to execute 'createConicGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.");
    logOnce('CanvasRenderingContext2D.createConicGradient is not implemented; it returns an inert gradient');
    return { addColorStop() {} };
  }
  getContextAttributes() { return { alpha: true, colorSpace: 'srgb', colorType: 'unorm8', desynchronized: false, toneMapping: { mode: 'standard' }, willReadFrequently: false }; }
  isContextLost() { return false; }

  scale(x, y) { if (finite(x, y)) this.transform(x, 0, 0, y, 0, 0); }
  rotate(angle) { if (finite(angle)) { const c = Math.cos(angle); const s = Math.sin(angle); this.transform(c, s, -s, c, 0, 0); } }
  translate(x, y) { if (finite(x, y)) this.transform(1, 0, 0, 1, x, y); }
  transform(a, b, c, d, e, f) {
    if (!finite(a, b, c, d, e, f)) return;
    const [m0, m1, m2, m3, m4, m5] = this.#state.transform;
    this.#state.transform = [m0 * a + m2 * b, m1 * a + m3 * b, m0 * c + m2 * d, m1 * c + m3 * d, m0 * e + m2 * f + m4, m1 * e + m3 * f + m5];
  }
  setTransform(a, b, c, d, e, f) {
    if (a && typeof a === 'object') ({ a = 1, b = 0, c = 0, d = 1, e = 0, f = 0 } = a);
    else if (a === undefined) [a, b, c, d, e, f] = IDENTITY;
    if (finite(a, b, c, d, e, f)) this.#state.transform = [a, b, c, d, e, f];
  }
  resetTransform() { this.#state.transform = IDENTITY; }
  getTransform() { return new DOMMatrix(this.#state.transform); }

  createLinearGradient(x0, y0, x1, y1) {
    if (!finite(x0, y0, x1, y1)) throw new TypeError("Failed to execute 'createLinearGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.");
    return new CanvasGradient({ kind: 'linear', from: [x0, y0], to: [x1, y1] });
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    if (!finite(x0, y0, r0, x1, y1, r1)) throw new TypeError("Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.");
    if (r0 < 0 || r1 < 0) throw new DOMException(`Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The ${r0 < 0 ? 'r0' : 'r1'} provided is less than 0.`, 'IndexSizeError');
    return new CanvasGradient({ kind: 'radial', from: [x0, y0, r0], to: [x1, y1, r1] });
  }

  #style(key) {
    const value = this.#state[key];
    const paint = value instanceof CanvasGradient ? value.paint() : { kind: 'color', rgba: value.map(v => v / 255) };
    return { paint, alpha: this.#state.globalAlpha, transform: this.#state.transform };
  }
  #drawable() { return this.#width > 0 && this.#height > 0; }

  fillRect(x, y, w, h) {
    if (!finite(x, y, w, h) || !w || !h || !this.#drawable()) return;
    host.fillRect(this.#pixels, this.#width, this.#height, { rect: [x, y, w, h], style: this.#style('fillStyle') });
    this.#changed();
  }
  clearRect(x, y, w, h) {
    if (!finite(x, y, w, h) || !w || !h || !this.#drawable()) return;
    host.clearRect(this.#pixels, this.#width, this.#height, { rect: [x, y, w, h], style: this.#style('fillStyle') });
    this.#changed();
  }

  // The font list as the host resolves it: loaded faces by ID, generic keywords as generics, the rest by name for
  // the host's installed fonts.
  // Each family's loaded faces go with their unicode ranges; a face the text needs that is not loaded yet starts
  // loading, and the family's name stands in for it until then.
  #fontSpec(text) {
    const font = this.#state.font;
    const families = [];
    for (const { name, quoted } of font.families) {
      if (!quoted && GENERIC.has(name.toLowerCase())) { families.push({ generic: name.toLowerCase() }); continue; }
      const faces = this.#fonts?.matching(name, font) ?? [];
      let missing = !faces.length;
      for (const face of faces) {
        if (face.status === 'loaded') {
          const ranges = face[RANGES];
          const whole = ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= 0x10ffff;
          families.push({ face: { id: face.faceId, weight: face.weightRange, ...(whole ? {} : { ranges }) } });
        } else if (coversAny(face[RANGES], text)) {
          if (face.status === 'unloaded') face.load();
          missing = true;
        }
      }
      if (missing) families.push({ system: name.toLowerCase() });
    }
    return { families, size: font.size, weight: font.weight, italic: font.style !== 'normal' };
  }
  #text(text, x, y, maxWidth, stroke) {
    if (!finite(x, y) || (maxWidth !== undefined && (!Number.isFinite(maxWidth) || maxWidth <= 0)) || !this.#drawable()) return;
    const state = this.#state;
    host.text(this.#pixels, this.#width, this.#height, {
      text: String(text).replace(/[\t\n\f\r]/g, ' '), font: this.#fontSpec(String(text)), x, y, align: state.textAlign, baseline: state.textBaseline,
      maxWidth: maxWidth ?? null, style: this.#style(stroke ? 'strokeStyle' : 'fillStyle'),
      stroke: stroke ? { width: state.lineWidth, miterLimit: state.miterLimit, join: state.lineJoin } : null,
    });
    this.#changed();
  }
  fillText(text, x, y, maxWidth) { this.#text(text, x, y, maxWidth, false); }
  strokeText(text, x, y, maxWidth) { this.#text(text, x, y, maxWidth, true); }
  measureText(text) {
    const metrics = host.measure({ text: String(text).replace(/[\t\n\f\r]/g, ' '), font: this.#fontSpec(String(text)), align: this.#state.textAlign, baseline: this.#state.textBaseline });
    return new TextMetrics(metrics);
  }

  drawImage(image, ...args) {
    if (![2, 4, 8].includes(args.length)) throw new TypeError(`Failed to execute 'drawImage' on 'CanvasRenderingContext2D': Valid arities are: [3, 5, 9], but ${args.length + 1} arguments provided.`);
    const pixels = image?.[CONTEXT_2D]?.premultipliedPixels() ?? image?.[PIXELS];
    const width = pixels?.width ?? image?.width ?? 0;
    const height = pixels?.height ?? image?.height ?? 0;
    if (image?.localName === 'canvas' && (!width || !height)) throw new DOMException("Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The image argument is a canvas element with a width or height of 0.", 'InvalidStateError');
    if (!pixels) {
      if (image?.localName === 'img' && image.complete && image.src) throw new DOMException("Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The HTMLImageElement provided is in the 'broken' state.", 'InvalidStateError');
      if (!(image && typeof image === 'object')) throw new TypeError("Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The provided value is not of type '(CSSImageValue or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or OffscreenCanvas or SVGImageElement or VideoFrame)'.");
      return;
    }
    let [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 8 ? args : [0, 0, width, height, ...args, ...(args.length === 2 ? [width, height] : [])];
    if (!finite(sx, sy, sw, sh, dx, dy, dw, dh) || !sw || !sh || !dw || !dh || !this.#drawable()) return;
    if (sw < 0) { sx += sw; sw = -sw; }
    if (sh < 0) { sy += sh; sh = -sh; }
    if (dw < 0) { dx += dw; dw = -dw; }
    if (dh < 0) { dy += dh; dh = -dh; }
    // A source rectangle past the image's edges draws only the part inside, into the matching part of the
    // destination, as in Edge.
    const x0 = Math.max(sx, 0);
    const y0 = Math.max(sy, 0);
    const x1 = Math.min(sx + sw, width);
    const y1 = Math.min(sy + sh, height);
    if (x1 <= x0 || y1 <= y0) return;
    const scaleX = dw / sw;
    const scaleY = dh / sh;
    const source = [x0, y0, x1 - x0, y1 - y0];
    const dest = [dx + (x0 - sx) * scaleX, dy + (y0 - sy) * scaleY, (x1 - x0) * scaleX, (y1 - y0) * scaleY];
    host.drawImage(this.#pixels, this.#width, this.#height, pixels.data, {
      width: pixels.width, height: pixels.height, premultiplied: !!pixels.premultiplied, source, dest,
      smoothing: this.#state.imageSmoothingEnabled, style: { paint: { kind: 'color', rgba: [0, 0, 0, 1] }, alpha: this.#state.globalAlpha, transform: this.#state.transform },
    });
    this.#changed();
  }

  createImageData(widthOrData, height) {
    return widthOrData instanceof ImageData ? new ImageData(widthOrData.width, widthOrData.height) : new ImageData(Math.abs(widthOrData), Math.abs(height));
  }
  getImageData(sx, sy, sw, sh) {
    if (!finite(sx, sy, sw, sh)) throw new TypeError("Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The provided double value is non-finite.");
    // The arguments are IDL longs, which truncate toward zero before any check.
    [sx, sy, sw, sh] = [sx, sy, sw, sh].map(Math.trunc);
    if (!sw || !sh) throw new DOMException(`Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The source ${sw ? 'height' : 'width'} is 0.`, 'IndexSizeError');
    if (sw < 0) { sx += sw; sw = -sw; }
    if (sh < 0) { sy += sh; sh = -sh; }
    const out = new ImageData(sw, sh);
    const row = new Uint8Array(sw * 4);
    for (let y = 0; y < sh; y++) {
      const fromY = sy + y;
      if (fromY < 0 || fromY >= this.#height) continue;
      const left = Math.max(0, -sx);
      const right = Math.min(sw, this.#width - sx);
      if (right <= left) continue;
      const start = (fromY * this.#width + sx + left) * 4;
      host.unpremultiply(this.#pixels.subarray(start, start + (right - left) * 4), row.subarray(0, (right - left) * 4));
      out.data.set(row.subarray(0, (right - left) * 4), (y * sw + left) * 4);
    }
    return out;
  }
  putImageData(imageData, dx, dy, dirtyX = 0, dirtyY = 0, dirtyWidth = imageData.width, dirtyHeight = imageData.height) {
    if (!(imageData instanceof ImageData)) throw new TypeError("Failed to execute 'putImageData' on 'CanvasRenderingContext2D': parameter 1 is not of type 'ImageData'.");
    if (!finite(dx, dy, dirtyX, dirtyY, dirtyWidth, dirtyHeight)) return;
    [dx, dy, dirtyX, dirtyY, dirtyWidth, dirtyHeight] = [dx, dy, dirtyX, dirtyY, dirtyWidth, dirtyHeight].map(Math.trunc);
    if (dirtyWidth < 0) { dirtyX += dirtyWidth; dirtyWidth = -dirtyWidth; }
    if (dirtyHeight < 0) { dirtyY += dirtyHeight; dirtyHeight = -dirtyHeight; }
    const x0 = Math.max(0, dirtyX);
    const y0 = Math.max(0, dirtyY);
    const x1 = Math.min(imageData.width, dirtyX + dirtyWidth);
    const y1 = Math.min(imageData.height, dirtyY + dirtyHeight);
    for (let y = y0; y < y1; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.#height) continue;
      for (let x = x0; x < x1; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= this.#width) continue;
        const i = (y * imageData.width + x) * 4;
        const o = (ty * this.#width + tx) * 4;
        const a = imageData.data[i + 3];
        this.#pixels[o] = Math.round((imageData.data[i] * a) / 255);
        this.#pixels[o + 1] = Math.round((imageData.data[i + 1] * a) / 255);
        this.#pixels[o + 2] = Math.round((imageData.data[i + 2] * a) / 255);
        this.#pixels[o + 3] = a;
      }
    }
    this.#changed();
  }
}
for (const name of NOT_IMPLEMENTED) {
  CanvasRenderingContext2D.prototype[name] = function () {
    logOnce(`CanvasRenderingContext2D.${name} is not implemented`);
    return name === 'getLineDash' ? [] : name === 'createPattern' ? null : name.startsWith('isPointIn') ? false : undefined;
  };
}

