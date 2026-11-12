// DOMRect, DOMPoint and DOMMatrix with their read-only bases, as Edge 157 has them for what three's dependencies
// construct and read: rectangles and their edges, points, and 2D or 3D matrices that multiply, translate, scale,
// invert and transform points.

const RECT = Symbol('rect');
export class DOMRectReadOnly {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this[RECT] = [Number(x), Number(y), Number(width), Number(height)];
  }
  static fromRect(other = {}) { return new this(other.x, other.y, other.width, other.height); }
  get x() { return this[RECT][0]; }
  get y() { return this[RECT][1]; }
  get width() { return this[RECT][2]; }
  get height() { return this[RECT][3]; }
  get top() { return Math.min(this.y, this.y + this.height); }
  get right() { return Math.max(this.x, this.x + this.width); }
  get bottom() { return Math.max(this.y, this.y + this.height); }
  get left() { return Math.min(this.x, this.x + this.width); }
  toJSON() {
    const { x, y, width, height, top, right, bottom, left } = this;
    return { x, y, width, height, top, right, bottom, left };
  }
  get [Symbol.toStringTag]() { return 'DOMRectReadOnly'; }
}
export class DOMRect extends DOMRectReadOnly {
  get x() { return this[RECT][0]; }
  set x(value) { this[RECT][0] = Number(value); }
  get y() { return this[RECT][1]; }
  set y(value) { this[RECT][1] = Number(value); }
  get width() { return this[RECT][2]; }
  set width(value) { this[RECT][2] = Number(value); }
  get height() { return this[RECT][3]; }
  set height(value) { this[RECT][3] = Number(value); }
  get [Symbol.toStringTag]() { return 'DOMRect'; }
}

const POINT = Symbol('point');
export class DOMPointReadOnly {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this[POINT] = [Number(x), Number(y), Number(z), Number(w)];
  }
  static fromPoint(other = {}) { return new this(other.x, other.y, other.z, other.w); }
  get x() { return this[POINT][0]; }
  get y() { return this[POINT][1]; }
  get z() { return this[POINT][2]; }
  get w() { return this[POINT][3]; }
  matrixTransform(matrix) { return new DOMMatrixReadOnly(matrix).transformPoint(this); }
  toJSON() { return { x: this.x, y: this.y, z: this.z, w: this.w }; }
  get [Symbol.toStringTag]() { return 'DOMPointReadOnly'; }
}
export class DOMPoint extends DOMPointReadOnly {
  get x() { return this[POINT][0]; }
  set x(value) { this[POINT][0] = Number(value); }
  get y() { return this[POINT][1]; }
  set y(value) { this[POINT][1] = Number(value); }
  get z() { return this[POINT][2]; }
  set z(value) { this[POINT][2] = Number(value); }
  get w() { return this[POINT][3]; }
  set w(value) { this[POINT][3] = Number(value); }
  get [Symbol.toStringTag]() { return 'DOMPoint'; }
}

// A matrix keeps its 16 values in column-major order, m11 m12 m13 m14 m21 ... m44, and whether it is 2D.
const MATRIX = Symbol('matrix');
const IS_2D = Symbol('is2D');
const NAMES = ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44'];
const ALIASES = { a: 0, b: 1, c: 4, d: 5, e: 12, f: 13 };
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function product(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
}
function invert(m) {
  const inv = new Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const determinant = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  return determinant === 0 ? new Array(16).fill(Number.NaN) : inv.map(value => value / determinant + 0);
}

export class DOMMatrixReadOnly {
  constructor(init) {
    if (init === undefined) {
      this[MATRIX] = identity();
      this[IS_2D] = true;
    } else if (init instanceof DOMMatrixReadOnly) {
      this[MATRIX] = [...init[MATRIX]];
      this[IS_2D] = init[IS_2D];
    } else if (typeof init === 'string') {
      throw new TypeError(`Failed to construct '${new.target.name}': parsing a transform list is not implemented natively.`);
    } else {
      const values = [...init].map(Number);
      if (values.length === 6) {
        const [a, b, c, d, e, f] = values;
        this[MATRIX] = [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1];
        this[IS_2D] = true;
      } else if (values.length === 16) {
        this[MATRIX] = values;
        this[IS_2D] = false;
      } else {
        throw new TypeError(`Failed to construct '${new.target.name}': The sequence must contain 6 elements for a 2D matrix or 16 elements for a 3D matrix.`);
      }
    }
  }
  static fromMatrix(other) { return new this(other); }
  static fromFloat32Array(array) { return new this(array); }
  static fromFloat64Array(array) { return new this(array); }
  get is2D() { return this[IS_2D]; }
  get isIdentity() { return this[MATRIX].every((value, i) => value === identity()[i]); }
  multiply(other) { return new DOMMatrix(this).multiplySelf(other); }
  translate(tx = 0, ty = 0, tz = 0) { return new DOMMatrix(this).translateSelf(tx, ty, tz); }
  scale(sx = 1, sy = sx, sz = 1, ox = 0, oy = 0, oz = 0) { return new DOMMatrix(this).scaleSelf(sx, sy, sz, ox, oy, oz); }
  inverse() { return new DOMMatrix(this).invertSelf(); }
  transformPoint(point = {}) {
    const m = this[MATRIX];
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    const z = point.z ?? 0;
    const w = point.w ?? 1;
    return new DOMPoint(
      m[0] * x + m[4] * y + m[8] * z + m[12] * w,
      m[1] * x + m[5] * y + m[9] * z + m[13] * w,
      m[2] * x + m[6] * y + m[10] * z + m[14] * w,
      m[3] * x + m[7] * y + m[11] * z + m[15] * w,
    );
  }
  toFloat32Array() { return new Float32Array(this[MATRIX]); }
  toFloat64Array() { return new Float64Array(this[MATRIX]); }
  toString() {
    const m = this[MATRIX];
    return this[IS_2D] ? `matrix(${[m[0], m[1], m[4], m[5], m[12], m[13]].join(', ')})` : `matrix3d(${m.join(', ')})`;
  }
  toJSON() {
    const out = {};
    for (const name of [...Object.keys(ALIASES), ...NAMES]) out[name] = this[name];
    return { ...out, is2D: this.is2D, isIdentity: this.isIdentity };
  }
  get [Symbol.toStringTag]() { return 'DOMMatrixReadOnly'; }
}

export class DOMMatrix extends DOMMatrixReadOnly {
  multiplySelf(other) {
    const matrix = other instanceof DOMMatrixReadOnly ? other : new DOMMatrixReadOnly(other);
    this[MATRIX] = product(this[MATRIX], matrix[MATRIX]);
    this[IS_2D] = this[IS_2D] && matrix[IS_2D];
    return this;
  }
  preMultiplySelf(other) {
    const matrix = other instanceof DOMMatrixReadOnly ? other : new DOMMatrixReadOnly(other);
    this[MATRIX] = product(matrix[MATRIX], this[MATRIX]);
    this[IS_2D] = this[IS_2D] && matrix[IS_2D];
    return this;
  }
  translateSelf(tx = 0, ty = 0, tz = 0) {
    const translation = identity();
    translation[12] = Number(tx);
    translation[13] = Number(ty);
    translation[14] = Number(tz);
    this[MATRIX] = product(this[MATRIX], translation);
    if (tz) this[IS_2D] = false;
    return this;
  }
  scaleSelf(sx = 1, sy = sx, sz = 1, ox = 0, oy = 0, oz = 0) {
    this.translateSelf(ox, oy, oz);
    const scaling = identity();
    scaling[0] = Number(sx);
    scaling[5] = Number(sy);
    scaling[10] = Number(sz);
    this[MATRIX] = product(this[MATRIX], scaling);
    if (sz !== 1) this[IS_2D] = false;
    return this.translateSelf(-ox, -oy, -oz);
  }
  invertSelf() {
    this[MATRIX] = invert(this[MATRIX]);
    if (this[MATRIX].some(Number.isNaN)) this[IS_2D] = false;
    return this;
  }
  get [Symbol.toStringTag]() { return 'DOMMatrix'; }
}

for (const [name, index] of [...Object.entries(ALIASES), ...NAMES.map((name, index) => [name, index])]) {
  Object.defineProperty(DOMMatrixReadOnly.prototype, name, { get() { return this[MATRIX][index]; }, configurable: true, enumerable: true });
  Object.defineProperty(DOMMatrix.prototype, name, {
    get() { return this[MATRIX][index]; },
    set(value) {
      this[MATRIX][index] = Number(value);
      if (![0, 1, 4, 5, 10, 12, 13, 15].includes(index) || (index === 10 || index === 15) && Number(value) !== 1) this[IS_2D] = false;
    },
    configurable: true,
    enumerable: true,
  });
}
