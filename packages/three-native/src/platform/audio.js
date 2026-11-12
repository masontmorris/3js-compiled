// Web Audio on the host's engine, web-audio-api-rs. These classes check arguments and throw Edge's errors, keep the
// state a page reads back, and forward every graph change to the host, which hands it to the audio thread without
// blocking. setAudioHost() supplies the host; the Node tests supply a fake one.
import { Event, EventTarget, defineHandlers } from './events.js';
import { ELEMENT_CLASSES, HTMLElement } from './dom.js';

let host = null;
export function setAudioHost(next) { host = next; }

const FLT_MAX = 3.4028234663852886e38;
const MIN_RATE = 3000;
const MAX_RATE = 768000;
const MAX_CHANNELS = 32;
const PENDING_EVENTS_LIMIT = 64;

function domError(message, name) { return new DOMException(message, name); }
const executing = (iface, method) => `Failed to execute '${method}' on '${iface}'`;
const setting = (iface, prop) => `Failed to set the '${prop}' property on '${iface}'`;
const constructing = iface => `Failed to construct '${iface}'`;

function toFloat(value, prefix) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${prefix}: The provided float value is non-finite.`);
  return Math.fround(n);
}
function toDouble(value, prefix) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${prefix}: The provided double value is non-finite.`);
  return n;
}
function toTime(value, prefix, label = 'Time') {
  const n = toDouble(value, prefix);
  if (n < 0) throw new RangeError(`${prefix}: ${label} must be a finite non-negative number: ${n}`);
  return n;
}
function checkRate(rate, prefix, label) {
  if (!(rate >= MIN_RATE && rate <= MAX_RATE)) throw domError(`${prefix}: The ${label} provided (${rate}) is outside the range [${MIN_RATE}, ${MAX_RATE}].`, 'NotSupportedError');
}
function checkChannels(channels, prefix) {
  if (!(channels >= 1 && channels <= MAX_CHANNELS)) throw domError(`${prefix}: The number of channels provided (${channels}) is outside the range [1, ${MAX_CHANNELS}].`, 'NotSupportedError');
}
function unsupported(iface, method) {
  return domError(`${iface}.${method} is not supported by the native host.`, 'NotSupportedError');
}

// Each AudioParam remembers the events a page scheduled, for Edge's overlap checks. Events before the current time
// drop out once the list is long, as Edge's timeline drops events it has rendered.
export class AudioParam {
  #node;
  #name;
  #events = [];
  #rate;
  #fixedRate;
  constructor(node, name, { defaultValue, minValue = -FLT_MAX, maxValue = FLT_MAX, automationRate = 'a-rate', fixedRate = false }) {
    this.#node = node;
    this.#name = name;
    this.defaultValue = Math.fround(defaultValue);
    this.minValue = Math.fround(minValue);
    this.maxValue = Math.fround(maxValue);
    this.#rate = automationRate;
    this.#fixedRate = fixedRate;
    Object.defineProperties(this, { defaultValue: { writable: false }, minValue: { writable: false }, maxValue: { writable: false } });
  }
  get [Symbol.toStringTag]() { return 'AudioParam'; }
  get automationRate() { return this.#rate; }
  set automationRate(value) {
    const rate = String(value);
    if (rate !== 'a-rate' && rate !== 'k-rate') return;
    if (this.#fixedRate && rate !== this.#rate) {
      throw domError(`${setting('AudioParam', 'automationRate')}: ${this.#fixedRate}.automationRate is fixed and cannot be changed to "${rate}"`, 'InvalidStateError');
    }
    this.#rate = rate;
    host.set(this.#node.id, `${this.#name}.automationRate`, rate);
  }
  get value() {
    const value = host.paramValue(this.#node.id, this.#name);
    return Math.min(this.maxValue, Math.max(this.minValue, value));
  }
  set value(value) {
    const v = toFloat(value, setting('AudioParam', 'value'));
    host.param(this.#node.id, this.#name, 'value', v, 0, 0);
  }
  #insert(method, time, describe, duration = 0) {
    const prefix = executing('AudioParam', method);
    const now = this.#node.context.currentTime;
    if (this.#events.length > PENDING_EVENTS_LIMIT) this.#events = this.#events.filter(e => e.time + e.duration >= now);
    for (const e of this.#events) {
      if (e.method === 'setValueCurveAtTime' && time >= e.time && time < e.time + e.duration) {
        throw domError(`${prefix}: ${describe} overlaps setValueCurveAtTime(..., ${e.time}, ${e.duration})`, 'NotSupportedError');
      }
      if (method === 'setValueCurveAtTime' && e.time > time && e.time < time + duration) {
        throw domError(`${prefix}: ${describe} overlaps ${e.describe}`, 'NotSupportedError');
      }
    }
    this.#events.push({ method, time, duration, describe });
  }
  setValueAtTime(value, startTime) {
    const prefix = executing('AudioParam', 'setValueAtTime');
    const v = toFloat(value, prefix);
    const t = toTime(startTime, prefix);
    this.#insert('setValueAtTime', t, `setValueAtTime(${v}, ${t})`);
    host.param(this.#node.id, this.#name, 'setValueAtTime', v, t, 0);
    return this;
  }
  linearRampToValueAtTime(value, endTime) {
    const prefix = executing('AudioParam', 'linearRampToValueAtTime');
    const v = toFloat(value, prefix);
    const t = toTime(endTime, prefix);
    this.#insert('linearRampToValueAtTime', t, `linearRampToValueAtTime(${v}, ${t})`);
    host.param(this.#node.id, this.#name, 'linearRampToValueAtTime', v, t, 0);
    return this;
  }
  exponentialRampToValueAtTime(value, endTime) {
    const prefix = executing('AudioParam', 'exponentialRampToValueAtTime');
    const v = toFloat(value, prefix);
    const t = toTime(endTime, prefix);
    if (Math.abs(v) < 1.401298464324817e-45) throw new RangeError(`${prefix}: The float target value provided (${v}) should not be in the range (-1.40130e-45, 1.40130e-45).`);
    this.#insert('exponentialRampToValueAtTime', t, `exponentialRampToValueAtTime(${v}, ${t})`);
    host.param(this.#node.id, this.#name, 'exponentialRampToValueAtTime', v, t, 0);
    return this;
  }
  setTargetAtTime(target, startTime, timeConstant) {
    const prefix = executing('AudioParam', 'setTargetAtTime');
    const v = toFloat(target, prefix);
    const t = toTime(startTime, prefix);
    const c = toFloat(timeConstant, prefix);
    if (c < 0) throw new RangeError(`${prefix}: Time constant must be a finite non-negative number: ${c}`);
    this.#insert('setTargetAtTime', t, `setTargetAtTime(${v}, ${t}, ${c})`);
    // Edge treats a zero time constant as a jump to the target, as the spec says.
    if (c === 0) host.param(this.#node.id, this.#name, 'setValueAtTime', v, t, 0);
    else host.param(this.#node.id, this.#name, 'setTargetAtTime', v, t, c);
    return this;
  }
  setValueCurveAtTime(values, startTime, duration) {
    const prefix = executing('AudioParam', 'setValueCurveAtTime');
    if (values == null || typeof values[Symbol.iterator] !== 'function') throw new TypeError(`${prefix}: The provided value cannot be converted to a sequence.`);
    const curve = Float32Array.from(values, v => toFloat(v, prefix));
    const t = toTime(startTime, prefix);
    const d = toDouble(duration, prefix);
    if (curve.length < 2) throw domError(`${prefix}: The curve length provided (${curve.length}) is less than the minimum bound (2).`, 'InvalidStateError');
    if (!(d > 0)) throw new RangeError(`${prefix}: Duration must be a finite positive number: ${d}`);
    this.#insert('setValueCurveAtTime', t, `setValueCurveAtTime(..., ${t}, ${d})`, d);
    host.curve(this.#node.id, this.#name, curve, t, d);
    return this;
  }
  cancelScheduledValues(cancelTime) {
    const t = toTime(cancelTime, executing('AudioParam', 'cancelScheduledValues'));
    this.#events = this.#events.filter(e => e.time < t);
    host.param(this.#node.id, this.#name, 'cancelScheduledValues', t, 0, 0);
    return this;
  }
  cancelAndHoldAtTime(cancelTime) {
    const t = toTime(cancelTime, executing('AudioParam', 'cancelAndHoldAtTime'));
    this.#events = this.#events.filter(e => e.time < t).map(e => (e.time + e.duration > t ? { ...e, duration: t - e.time } : e));
    host.param(this.#node.id, this.#name, 'cancelAndHoldAtTime', t, 0, 0);
    return this;
  }
}

const CHANNEL_COUNT_MODES = new Set(['max', 'clamped-max', 'explicit']);
const CHANNEL_INTERPRETATIONS = new Set(['speakers', 'discrete']);

export class AudioNode extends EventTarget {
  #context;
  #outputs;
  #channelCount;
  #channelCountMode;
  #channelInterpretation;
  #connections = [];
  constructor(context, kind, options, { inputs = 1, outputs = 1, channelCount = 2, channelCountMode = 'max', channelInterpretation = 'speakers', hostOptions = {} }) {
    super();
    if (!(context instanceof BaseAudioContext)) throw new TypeError(`${constructing(kind)}: parameter 1 is not of type 'BaseAudioContext'.`);
    this.#context = context;
    this.numberOfInputs = inputs;
    this.numberOfOutputs = outputs;
    this.#outputs = outputs;
    this.#channelCount = channelCount;
    this.#channelCountMode = channelCountMode;
    this.#channelInterpretation = channelInterpretation;
    this.id = kind === 'Destination' || kind === 'Listener' ? hostOptions.id : host.node(context.id, kind, hostOptions);
    if (options?.channelCount !== undefined) this.channelCount = options.channelCount;
    if (options?.channelCountMode !== undefined) this.channelCountMode = options.channelCountMode;
    if (options?.channelInterpretation !== undefined) this.channelInterpretation = options.channelInterpretation;
  }
  get context() { return this.#context; }
  get channelCount() { return this.#channelCount; }
  set channelCount(value) {
    const count = Number(value) >>> 0;
    this.checkChannelCount(count);
    this.#channelCount = count;
    host.set(this.id, 'channelCount', count);
  }
  checkChannelCount(count) {
    if (count < 1 || count > MAX_CHANNELS) throw domError(`${setting('AudioNode', 'channelCount')}: The channel count provided (${count}) is outside the range [1, ${MAX_CHANNELS}].`, 'NotSupportedError');
  }
  get channelCountMode() { return this.#channelCountMode; }
  set channelCountMode(value) {
    const mode = String(value);
    if (!CHANNEL_COUNT_MODES.has(mode)) return;
    this.checkChannelCountMode(mode);
    this.#channelCountMode = mode;
    host.set(this.id, 'channelCountMode', mode);
  }
  checkChannelCountMode() {}
  get channelInterpretation() { return this.#channelInterpretation; }
  set channelInterpretation(value) {
    const interpretation = String(value);
    if (!CHANNEL_INTERPRETATIONS.has(interpretation)) return;
    this.#channelInterpretation = interpretation;
    host.set(this.id, 'channelInterpretation', interpretation);
  }
  connect(destination, output = 0, input = 0) {
    const prefix = executing('AudioNode', 'connect');
    const isParam = destination instanceof AudioParam;
    if (!(destination instanceof AudioNode) && !isParam) throw new TypeError(`${prefix}: Overload resolution failed.`);
    const owner = isParam ? paramOwner.get(destination) : destination;
    if (owner.context !== this.#context) {
      throw domError(`${prefix}: cannot connect to ${isParam ? 'an AudioParam' : 'an AudioNode'} belonging to a different audio context.`, 'InvalidAccessError');
    }
    output = Number(output) >>> 0;
    if (output >= this.#outputs) throw domError(`${prefix}: output index (${output}) exceeds number of outputs (${this.#outputs}).`, 'IndexSizeError');
    if (isParam) {
      host.connectParam(this.id, owner.id, paramName.get(destination), output);
      this.#connections.push({ destination, output, input: -1 });
      return undefined;
    }
    input = Number(input) >>> 0;
    if (input >= destination.numberOfInputs) throw domError(`${prefix}: input index (${input}) exceeds number of inputs (${destination.numberOfInputs}).`, 'IndexSizeError');
    if (!this.#connections.some(c => c.destination === destination && c.output === output && c.input === input)) {
      host.connect(this.id, destination.id, output, input);
      this.#connections.push({ destination, output, input });
    }
    return destination;
  }
  disconnect(...args) {
    const prefix = executing('AudioNode', 'disconnect');
    const [first, output, input] = args;
    let matches;
    if (args.length === 0) matches = () => true;
    else if (typeof first === 'number' || (!(first instanceof AudioNode) && !(first instanceof AudioParam))) {
      const index = Number(first) >>> 0;
      if (index >= this.#outputs) throw domError(`${prefix}: The output index provided (${index}) is outside the range [0, ${this.#outputs - 1}].`, 'IndexSizeError');
      matches = c => c.output === index;
    } else {
      if (output !== undefined && Number(output) >>> 0 >= this.#outputs) throw domError(`${prefix}: The output index provided (${output}) is outside the range [0, ${this.#outputs - 1}].`, 'IndexSizeError');
      matches = c => c.destination === first && (output === undefined || c.output === Number(output) >>> 0) && (input === undefined || c.input === Number(input) >>> 0);
      if (!this.#connections.some(matches)) throw domError(`${prefix}: the given destination is not connected.`, 'InvalidAccessError');
    }
    const keep = [];
    for (const c of this.#connections) {
      if (!matches(c)) { keep.push(c); continue; }
      if (c.input === -1) host.disconnectParam(this.id, paramOwner.get(c.destination).id, paramName.get(c.destination), c.output);
      else host.disconnect(this.id, c.destination.id, c.output, c.input);
    }
    this.#connections = keep;
  }
}

const paramOwner = new WeakMap();
const paramName = new WeakMap();
function param(node, name, descriptor, owner = node) {
  const p = new AudioParam(owner, name, descriptor);
  paramOwner.set(p, owner);
  paramName.set(p, name);
  Object.defineProperty(node, name, { value: p, enumerable: true });
  return p;
}
function initialParams(node, options, names) {
  for (const name of names) if (options?.[name] !== undefined) node[name].value = options[name];
}

export class AudioDestinationNode extends AudioNode {
  #max;
  constructor(context, id, maxChannelCount) {
    super(context, 'Destination', undefined, { inputs: 1, outputs: 0, channelCount: 2, channelCountMode: 'explicit', hostOptions: { id } });
    this.#max = maxChannelCount;
  }
  get maxChannelCount() { return this.#max; }
  checkChannelCount(count) {
    if (count < 1 || count > this.#max) throw domError(`${setting('AudioNode', 'channelCount')}: The channel count provided (${count}) is outside the range [1, ${this.#max}].`, 'IndexSizeError');
  }
}

export class AudioListener {
  #context;
  constructor(context, id) {
    this.#context = context;
    this.id = id;
    const owner = { id, context };
    for (const [name, value] of Object.entries({ positionX: 0, positionY: 0, positionZ: 0, forwardX: 0, forwardY: 0, forwardZ: -1, upX: 0, upY: 1, upZ: 0 })) {
      param(this, name, { defaultValue: value }, owner);
    }
  }
  setPosition(x, y, z) {
    const prefix = executing('AudioListener', 'setPosition');
    const now = this.#context.currentTime;
    [x, y, z].forEach((v, i) => this[['positionX', 'positionY', 'positionZ'][i]].setValueAtTime(toFloat(v, prefix), now));
  }
  setOrientation(x, y, z, upX, upY, upZ) {
    const prefix = executing('AudioListener', 'setOrientation');
    const now = this.#context.currentTime;
    const names = ['forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'];
    [x, y, z, upX, upY, upZ].forEach((v, i) => this[names[i]].setValueAtTime(toFloat(v, prefix), now));
  }
}

export class AudioScheduledSourceNode extends AudioNode {
  #started = false;
  #interface;
  constructor(context, kind, options, layout) {
    super(context, kind, options, { inputs: 0, ...layout });
    this.#interface = `${kind}Node`;
    sources.set(this.id, this);
  }
  start(when = 0) {
    const prefix = executing(this.#interface, 'start');
    const t = toDouble(when, prefix);
    this.assertUnstarted(prefix);
    if (t < 0) throw new RangeError(`${prefix}: The start time provided (${t}) is less than the minimum bound (0).`);
    this.#started = true;
    host.start(this.id, t, 0, -1);
  }
  assertUnstarted(prefix) {
    if (this.#started) throw domError(`${prefix}: cannot call start more than once.`, 'InvalidStateError');
  }
  markStarted() { this.#started = true; }
  stop(when = 0) {
    const prefix = executing('AudioScheduledSourceNode', 'stop');
    const t = toDouble(when, prefix);
    if (!this.#started) throw domError(`${prefix}: cannot call stop without calling start first.`, 'InvalidStateError');
    if (t < 0) throw new RangeError(`${prefix}: The stop time provided (${t}) is less than the minimum bound (0).`);
    host.stop(this.id, t);
  }
}
defineHandlers(AudioScheduledSourceNode.prototype, ['ended']);
const sources = new Map();

export class GainNode extends AudioNode {
  constructor(context, options = {}) {
    super(context, 'Gain', options, {});
    param(this, 'gain', { defaultValue: 1 });
    initialParams(this, options, ['gain']);
  }
}

export class ConstantSourceNode extends AudioScheduledSourceNode {
  constructor(context, options = {}) {
    super(context, 'ConstantSource', options, {});
    param(this, 'offset', { defaultValue: 1 });
    initialParams(this, options, ['offset']);
  }
}

const OSCILLATOR_TYPES = new Set(['sine', 'square', 'sawtooth', 'triangle']);
export class OscillatorNode extends AudioScheduledSourceNode {
  #type = 'sine';
  constructor(context, options = {}) {
    if (options.type === 'custom' && !options.periodicWave) throw domError(`${constructing('OscillatorNode')}: A PeriodicWave must be specified if the type is set to "custom"`, 'InvalidStateError');
    if (options.periodicWave) throw unsupported('OscillatorNode', 'periodicWave');
    super(context, 'Oscillator', options, {});
    const nyquist = context.sampleRate / 2;
    param(this, 'frequency', { defaultValue: 440, minValue: -nyquist, maxValue: nyquist });
    param(this, 'detune', { defaultValue: 0, minValue: -153600, maxValue: 153600 });
    if (options.type !== undefined) this.type = options.type;
    initialParams(this, options, ['frequency', 'detune']);
  }
  get type() { return this.#type; }
  set type(value) {
    const type = String(value);
    if (type === 'custom') throw domError(`${setting('OscillatorNode', 'type')}: 'type' cannot be set directly to 'custom'.  Use setPeriodicWave() to create a custom Oscillator type.`, 'InvalidStateError');
    if (!OSCILLATOR_TYPES.has(type)) return;
    this.#type = type;
    host.set(this.id, 'type', type);
  }
  setPeriodicWave() { throw unsupported('OscillatorNode', 'setPeriodicWave'); }
}

export class AudioBufferSourceNode extends AudioScheduledSourceNode {
  #buffer = null;
  #bufferSet = false;
  #loop = false;
  #loopStart = 0;
  #loopEnd = 0;
  constructor(context, options = {}) {
    super(context, 'AudioBufferSource', options, {});
    param(this, 'playbackRate', { defaultValue: 1, automationRate: 'k-rate', fixedRate: 'AudioBufferSource.playbackRate' });
    param(this, 'detune', { defaultValue: 0, automationRate: 'k-rate', fixedRate: 'AudioBufferSource.detune' });
    if (options.buffer != null) this.buffer = options.buffer;
    if (options.loop !== undefined) this.loop = options.loop;
    if (options.loopStart !== undefined) this.loopStart = options.loopStart;
    if (options.loopEnd !== undefined) this.loopEnd = options.loopEnd;
    initialParams(this, options, ['playbackRate', 'detune']);
  }
  get buffer() { return this.#buffer; }
  set buffer(value) {
    const prefix = setting('AudioBufferSourceNode', 'buffer');
    if (value !== null && !(value instanceof AudioBuffer)) throw new TypeError(`${prefix}: Failed to convert value to 'AudioBuffer'.`);
    if (value !== null && this.#bufferSet) throw domError(`${prefix}: Cannot set buffer to non-null after it has been already been set to a non-null buffer`, 'InvalidStateError');
    this.#buffer = value;
    if (value === null) return;
    this.#bufferSet = true;
    host.sourceBuffer(this.id, value.acquire());
  }
  get loop() { return this.#loop; }
  set loop(value) { this.#loop = !!value; host.set(this.id, 'loop', this.#loop); }
  get loopStart() { return this.#loopStart; }
  set loopStart(value) { this.#loopStart = toDouble(value, setting('AudioBufferSourceNode', 'loopStart')); host.set(this.id, 'loopStart', this.#loopStart); }
  get loopEnd() { return this.#loopEnd; }
  set loopEnd(value) { this.#loopEnd = toDouble(value, setting('AudioBufferSourceNode', 'loopEnd')); host.set(this.id, 'loopEnd', this.#loopEnd); }
  start(when = 0, offset, duration) {
    const prefix = executing('AudioBufferSourceNode', 'start');
    const t = toDouble(when, prefix);
    const o = offset === undefined ? 0 : toDouble(offset, prefix);
    const d = duration === undefined ? -1 : toDouble(duration, prefix);
    this.assertUnstarted(prefix);
    if (t < 0) throw new RangeError(`${prefix}: The start time provided (${t}) is less than the minimum bound (0).`);
    if (o < 0) throw new RangeError(`${prefix}: The offset provided (${o}) is less than the minimum bound (0).`);
    if (duration !== undefined && d < 0) throw new RangeError(`${prefix}: The duration provided (${d}) is less than the minimum bound (0).`);
    this.markStarted();
    host.start(this.id, t, o, d);
  }
}

export class StereoPannerNode extends AudioNode {
  constructor(context, options = {}) {
    super(context, 'StereoPanner', options, { channelCountMode: 'clamped-max' });
    param(this, 'pan', { defaultValue: 0, minValue: -1, maxValue: 1 });
    initialParams(this, options, ['pan']);
  }
  checkChannelCount(count) { stereoCount(count); }
  checkChannelCountMode(mode) { if (mode === 'max') throw domError(`${setting('AudioNode', 'channelCountMode')}: StereoPanner: 'max' is not allowed`, 'NotSupportedError'); }
}
function stereoCount(count) {
  if (count < 1 || count > 2) throw domError(`${setting('AudioNode', 'channelCount')}: The channelCount provided (${count}) is outside the range [1, 2].`, 'NotSupportedError');
}

const PANNING_MODELS = new Set(['equalpower', 'HRTF']);
const DISTANCE_MODELS = new Set(['linear', 'inverse', 'exponential']);
export class PannerNode extends AudioNode {
  #panningModel = 'equalpower';
  #distanceModel = 'inverse';
  #refDistance = 1;
  #maxDistance = 10000;
  #rolloffFactor = 1;
  #coneInnerAngle = 360;
  #coneOuterAngle = 360;
  #coneOuterGain = 0;
  constructor(context, options = {}) {
    super(context, 'Panner', options, { channelCountMode: 'clamped-max' });
    for (const [name, value] of Object.entries({ positionX: 0, positionY: 0, positionZ: 0, orientationX: 1, orientationY: 0, orientationZ: 0 })) param(this, name, { defaultValue: value });
    for (const name of ['panningModel', 'distanceModel', 'refDistance', 'maxDistance', 'rolloffFactor', 'coneInnerAngle', 'coneOuterAngle', 'coneOuterGain']) {
      if (options[name] !== undefined) this[name] = options[name];
    }
    initialParams(this, options, ['positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ']);
  }
  checkChannelCount(count) { stereoCount(count); }
  checkChannelCountMode(mode) { if (mode === 'max') throw domError(`${setting('AudioNode', 'channelCountMode')}: Panner: 'max' is not allowed`, 'NotSupportedError'); }
  get panningModel() { return this.#panningModel; }
  set panningModel(value) { const v = String(value); if (!PANNING_MODELS.has(v)) return; this.#panningModel = v; host.set(this.id, 'panningModel', v); }
  get distanceModel() { return this.#distanceModel; }
  set distanceModel(value) { const v = String(value); if (!DISTANCE_MODELS.has(v)) return; this.#distanceModel = v; host.set(this.id, 'distanceModel', v); }
  get refDistance() { return this.#refDistance; }
  set refDistance(value) {
    const v = toDouble(value, setting('PannerNode', 'refDistance'));
    if (v < 0) throw new RangeError(`${setting('PannerNode', 'refDistance')}: The refDistance provided (${v}) is less than the minimum bound (0).`);
    this.#refDistance = v;
    host.set(this.id, 'refDistance', v);
  }
  get maxDistance() { return this.#maxDistance; }
  set maxDistance(value) {
    const v = toDouble(value, setting('PannerNode', 'maxDistance'));
    if (!(v > 0)) throw new RangeError(`${setting('PannerNode', 'maxDistance')}: The maxDistance provided (${v}) is less than or equal to the minimum bound (0).`);
    this.#maxDistance = v;
    host.set(this.id, 'maxDistance', v);
  }
  get rolloffFactor() { return this.#rolloffFactor; }
  set rolloffFactor(value) {
    const v = toDouble(value, setting('PannerNode', 'rolloffFactor'));
    if (v < 0) throw new RangeError(`${setting('PannerNode', 'rolloffFactor')}: The rolloffFactor provided (${v}) is less than the minimum bound (0).`);
    this.#rolloffFactor = v;
    host.set(this.id, 'rolloffFactor', v);
  }
  get coneInnerAngle() { return this.#coneInnerAngle; }
  set coneInnerAngle(value) { this.#coneInnerAngle = toDouble(value, setting('PannerNode', 'coneInnerAngle')); host.set(this.id, 'coneInnerAngle', this.#coneInnerAngle); }
  get coneOuterAngle() { return this.#coneOuterAngle; }
  set coneOuterAngle(value) { this.#coneOuterAngle = toDouble(value, setting('PannerNode', 'coneOuterAngle')); host.set(this.id, 'coneOuterAngle', this.#coneOuterAngle); }
  get coneOuterGain() { return this.#coneOuterGain; }
  set coneOuterGain(value) {
    const v = toDouble(value, setting('PannerNode', 'coneOuterGain'));
    if (v < 0 || v > 1) throw domError(`${setting('PannerNode', 'coneOuterGain')}: The coneOuterGain provided (${v}) is outside the range [0, 1].`, 'InvalidStateError');
    this.#coneOuterGain = v;
    host.set(this.id, 'coneOuterGain', v);
  }
  setPosition(x, y, z) {
    const prefix = executing('PannerNode', 'setPosition');
    const now = this.context.currentTime;
    [x, y, z].forEach((v, i) => this[['positionX', 'positionY', 'positionZ'][i]].setValueAtTime(toFloat(v, prefix), now));
  }
  setOrientation(x, y, z) {
    const prefix = executing('PannerNode', 'setOrientation');
    const now = this.context.currentTime;
    [x, y, z].forEach((v, i) => this[['orientationX', 'orientationY', 'orientationZ'][i]].setValueAtTime(toFloat(v, prefix), now));
  }
}

export class AnalyserNode extends AudioNode {
  #fftSize = 2048;
  #minDecibels = -100;
  #maxDecibels = -30;
  #smoothing = 0.8;
  constructor(context, options = {}) {
    super(context, 'Analyser', options, { channelCount: 2 });
    for (const name of ['fftSize', 'maxDecibels', 'minDecibels', 'smoothingTimeConstant']) if (options[name] !== undefined) this[name] = options[name];
  }
  get fftSize() { return this.#fftSize; }
  set fftSize(value) {
    const size = Number(value) >>> 0;
    const prefix = setting('AnalyserNode', 'fftSize');
    if (size < 32 || size > 32768) throw domError(`${prefix}: The value provided (${size}) is outside the range [32, 32768].`, 'IndexSizeError');
    if (size & (size - 1)) throw domError(`${prefix}: The value provided (${size}) is not a power of two.`, 'IndexSizeError');
    this.#fftSize = size;
    host.set(this.id, 'fftSize', size);
  }
  get frequencyBinCount() { return this.#fftSize / 2; }
  get minDecibels() { return this.#minDecibels; }
  set minDecibels(value) {
    const v = toDouble(value, setting('AnalyserNode', 'minDecibels'));
    if (v >= this.#maxDecibels) throw domError(`${setting('AnalyserNode', 'minDecibels')}: The minDecibels provided (${v}) is greater than the maximum bound (${this.#maxDecibels}).`, 'IndexSizeError');
    this.#minDecibels = v;
    host.set(this.id, 'minDecibels', v);
  }
  get maxDecibels() { return this.#maxDecibels; }
  set maxDecibels(value) {
    const v = toDouble(value, setting('AnalyserNode', 'maxDecibels'));
    if (v <= this.#minDecibels) throw domError(`${setting('AnalyserNode', 'maxDecibels')}: The maxDecibels provided (${v}) is less than the minimum bound (${this.#minDecibels}).`, 'IndexSizeError');
    this.#maxDecibels = v;
    host.set(this.id, 'maxDecibels', v);
  }
  get smoothingTimeConstant() { return this.#smoothing; }
  set smoothingTimeConstant(value) {
    const v = toDouble(value, setting('AnalyserNode', 'smoothingTimeConstant'));
    if (v < 0 || v > 1) throw domError(`${setting('AnalyserNode', 'smoothingTimeConstant')}: The smoothing value provided (${v}) is outside the range [0, 1].`, 'IndexSizeError');
    this.#smoothing = v;
    host.set(this.id, 'smoothingTimeConstant', v);
  }
  getFloatFrequencyData(array) { host.analyser(this.id, 'floatFrequency', array); }
  getByteFrequencyData(array) { host.analyser(this.id, 'byteFrequency', array); }
  getFloatTimeDomainData(array) { host.analyser(this.id, 'floatTime', array); }
  getByteTimeDomainData(array) { host.analyser(this.id, 'byteTime', array); }
}

const BIQUAD_TYPES = new Set(['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass']);
export class BiquadFilterNode extends AudioNode {
  #type = 'lowpass';
  constructor(context, options = {}) {
    super(context, 'BiquadFilter', options, {});
    const nyquist = context.sampleRate / 2;
    param(this, 'frequency', { defaultValue: 350, minValue: 0, maxValue: nyquist });
    param(this, 'detune', { defaultValue: 0, minValue: -153600, maxValue: 153600 });
    param(this, 'Q', { defaultValue: 1 });
    param(this, 'gain', { defaultValue: 0, maxValue: 1541.273681640625 });
    if (options.type !== undefined) this.type = options.type;
    initialParams(this, options, ['frequency', 'detune', 'Q', 'gain']);
  }
  get type() { return this.#type; }
  set type(value) { const v = String(value); if (!BIQUAD_TYPES.has(v)) return; this.#type = v; host.set(this.id, 'type', v); }
  getFrequencyResponse() { throw unsupported('BiquadFilterNode', 'getFrequencyResponse'); }
}

export class DelayNode extends AudioNode {
  constructor(context, options = {}) {
    const maxDelayTime = options.maxDelayTime === undefined ? 1 : toDouble(options.maxDelayTime, constructing('DelayNode'));
    if (!(maxDelayTime > 0 && maxDelayTime < 180)) throw domError(`${executing('BaseAudioContext', 'createDelay')}: The max delay time provided (${maxDelayTime}) is outside the range (0, 180).`, 'NotSupportedError');
    super(context, 'Delay', options, { hostOptions: { maxDelayTime } });
    param(this, 'delayTime', { defaultValue: 0, minValue: 0, maxValue: maxDelayTime });
    initialParams(this, options, ['delayTime']);
  }
}

// An AudioBuffer's samples stay in the host after decodeAudioData until a page reads them, so a buffer a game only
// plays is never copied. Once a page holds its channel arrays, each acquire sends their current contents.
export class AudioBuffer {
  #hostId;
  #channels = null;
  #length;
  #sampleRate;
  #count;
  constructor(options) {
    const prefix = constructing('AudioBuffer');
    if (options == null || typeof options !== 'object') throw new TypeError(`${prefix}: 1 argument required, but only 0 present.`);
    const count = options.numberOfChannels === undefined ? 1 : Number(options.numberOfChannels) >>> 0;
    const length = Number(options.length) >>> 0;
    const rate = toFloat(options.sampleRate, prefix);
    checkChannels(count, prefix);
    if (length < 1) throw domError(`${prefix}: The number of frames provided (${length}) is less than or equal to the minimum bound (0).`, 'NotSupportedError');
    checkRate(rate, prefix, 'sample rate');
    this.#count = count;
    this.#length = length;
    this.#sampleRate = rate;
    this.#hostId = options[HOST_ID] ?? null;
    if (this.#hostId === null) this.#channels = Array.from({ length: count }, () => new Float32Array(length));
  }
  get length() { return this.#length; }
  get sampleRate() { return this.#sampleRate; }
  get numberOfChannels() { return this.#count; }
  get duration() { return this.#length / this.#sampleRate; }
  #materialize() {
    this.#channels ??= Array.from({ length: this.#count }, (_, c) => host.bufferData(this.#hostId, c));
    return this.#channels;
  }
  getChannelData(channel) {
    const c = Number(channel) >>> 0;
    if (c >= this.#count) throw domError(`${executing('AudioBuffer', 'getChannelData')}: channel index (${c}) exceeds number of channels (${this.#count})`, 'IndexSizeError');
    return this.#materialize()[c];
  }
  copyFromChannel(destination, channel, start = 0) {
    const c = Number(channel) >>> 0;
    if (c >= this.#count) throw domError(`${executing('AudioBuffer', 'copyFromChannel')}: The channelNumber provided (${c}) is outside the range [0, ${this.#count - 1}].`, 'IndexSizeError');
    const offset = Number(start) >>> 0;
    if (offset >= this.#length) return;
    destination.set(this.#materialize()[c].subarray(offset, offset + destination.length));
  }
  copyToChannel(source, channel, start = 0) {
    const c = Number(channel) >>> 0;
    if (c >= this.#count) throw domError(`${executing('AudioBuffer', 'copyToChannel')}: The channelNumber provided (${c}) is outside the range [0, ${this.#count - 1}].`, 'IndexSizeError');
    const offset = Number(start) >>> 0;
    if (offset >= this.#length) return;
    this.#materialize()[c].set(source.subarray(0, this.#length - offset), offset);
  }
  acquire() {
    if (this.#channels) this.#hostId = host.buffer(this.#channels, this.#sampleRate);
    return this.#hostId;
  }
}
const HOST_ID = Symbol('host buffer');

export class OfflineAudioCompletionEvent extends Event {
  constructor(type, init) { super(type, init); this.renderedBuffer = init.renderedBuffer; }
}

export class BaseAudioContext extends EventTarget {
  #state;
  #listener;
  #destination;
  #queue = Promise.resolve();
  constructor(info, state) {
    super();
    this.id = info.id;
    this.sampleRate = info.sampleRate;
    this.#state = state;
    Object.defineProperty(this, 'sampleRate', { writable: false });
    contexts.set(this.id, this);
  }
  get state() { return this.#state; }
  get currentTime() { return host.currentTime(this.id); }
  get destination() { return (this.#destination ??= new AudioDestinationNode(this, host.destination(this.id), host.maxChannelCount(this.id))); }
  get listener() { return (this.#listener ??= new AudioListener(this, host.listener(this.id))); }
  get audioWorklet() {
    return { addModule: () => Promise.reject(unsupported('AudioWorklet', 'addModule')) };
  }
  // Sets the state and answers whether it changed. The page sees the change at once; its statechange comes later.
  changeState(state) {
    if (state === this.#state) return false;
    this.#state = state;
    return true;
  }
  // Fires statechange as a task, so it lands after the promise of the call that caused it settles.
  notifyStatechange() {
    setTimeout(() => this.dispatchEvent(new Event('statechange')), 0);
  }
  // Host calls for one context run in order, so a suspend() then resume() settle in that order.
  serially(call) {
    const result = this.#queue.then(call);
    this.#queue = result.catch(() => {});
    return result;
  }
  // Settles once every earlier host call has.
  settled() { return this.#queue; }
  createGain() { return new GainNode(this); }
  createBufferSource() { return new AudioBufferSourceNode(this); }
  createOscillator() { return new OscillatorNode(this); }
  createConstantSource() { return new ConstantSourceNode(this); }
  createStereoPanner() { return new StereoPannerNode(this); }
  createPanner() { return new PannerNode(this); }
  createAnalyser() { return new AnalyserNode(this); }
  createBiquadFilter() { return new BiquadFilterNode(this); }
  createDelay(maxDelayTime = 1) {
    const max = toDouble(maxDelayTime, executing('BaseAudioContext', 'createDelay'));
    return new DelayNode(this, { maxDelayTime: max });
  }
  createBuffer(numberOfChannels, length, sampleRate) {
    const prefix = executing('BaseAudioContext', 'createBuffer');
    const count = Number(numberOfChannels) >>> 0;
    const frames = Number(length) >>> 0;
    const rate = toFloat(sampleRate, prefix);
    checkChannels(count, prefix);
    if (frames < 1) throw domError(`${prefix}: The number of frames provided (${frames}) is less than or equal to the minimum bound (0).`, 'NotSupportedError');
    checkRate(rate, prefix, 'sample rate');
    return new AudioBuffer({ numberOfChannels: count, length: frames, sampleRate: rate });
  }
  decodeAudioData(audioData, successCallback, errorCallback) {
    const prefix = executing('BaseAudioContext', 'decodeAudioData');
    if (!(audioData instanceof ArrayBuffer)) return Promise.reject(new TypeError(`${prefix}: parameter 1 is not of type 'ArrayBuffer'.`));
    const fail = error => {
      if (typeof errorCallback === 'function') errorCallback(error);
      throw error;
    };
    if (audioData.detached) return Promise.reject(domError('Cannot decode detached ArrayBuffer', 'DataCloneError')).catch(fail);
    const bytes = audioData.transfer();
    return host.decode(bytes, this.sampleRate).then(decoded => {
      const buffer = new AudioBuffer({ numberOfChannels: decoded.numberOfChannels, length: decoded.length, sampleRate: decoded.sampleRate, [HOST_ID]: decoded.id });
      if (typeof successCallback === 'function') successCallback(buffer);
      return buffer;
    }, () => fail(domError('Unable to decode audio data', 'EncodingError')));
  }
  createPeriodicWave() { throw unsupported('BaseAudioContext', 'createPeriodicWave'); }
  createScriptProcessor() { throw unsupported('BaseAudioContext', 'createScriptProcessor'); }
  createConvolver() { throw unsupported('BaseAudioContext', 'createConvolver'); }
  createWaveShaper() { throw unsupported('BaseAudioContext', 'createWaveShaper'); }
  createDynamicsCompressor() { throw unsupported('BaseAudioContext', 'createDynamicsCompressor'); }
  createIIRFilter() { throw unsupported('BaseAudioContext', 'createIIRFilter'); }
  createChannelSplitter() { throw unsupported('BaseAudioContext', 'createChannelSplitter'); }
  createChannelMerger() { throw unsupported('BaseAudioContext', 'createChannelMerger'); }
}
defineHandlers(BaseAudioContext.prototype, ['statechange']);
const contexts = new Map();

// Edge starts an AudioContext running at once, with --autoplay-policy=no-user-gesture-required, and fires its first
// statechange a moment later. suspend() and close() change the state when called and resume() when it resolves, and
// each change fires one statechange after its promise settles, which reads the state at dispatch.
export class AudioContext extends BaseAudioContext {
  constructor(options = {}) {
    const prefix = constructing('AudioContext');
    if (options.sampleRate !== undefined) {
      const rate = toFloat(options.sampleRate, prefix);
      if (!(rate >= MIN_RATE && rate <= MAX_RATE)) throw domError(`${prefix}: The hardware sample rate provided (${rate}) is outside the range [${MIN_RATE}, ${MAX_RATE}].`, 'NotSupportedError');
    }
    if (options.sinkId !== undefined && options.sinkId !== '') throw unsupported('AudioContext', 'sinkId');
    const info = host.context({ kind: 'online', sampleRate: options.sampleRate ?? null, latencyHint: typeof options.latencyHint === 'number' ? options.latencyHint : String(options.latencyHint ?? 'interactive') });
    super(info, 'running');
    // Edge fires the first statechange once the audio thread runs, after any lifecycle call made in the same turn.
    setTimeout(() => this.settled().then(() => this.notifyStatechange()), 0);
  }
  get baseLatency() { return host.baseLatency(this.id); }
  get outputLatency() { return host.outputLatency(this.id); }
  getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: performance.now() }; }
  suspend() {
    if (this.state === 'closed') return Promise.reject(domError('Cannot suspend a closed AudioContext.', 'InvalidStateError'));
    // Edge settles a call that changes nothing without a trip to the audio thread.
    if (!this.changeState('suspended')) return this.settled().then(() => undefined);
    return this.serially(() => host.suspend(this.id)).then(() => this.notifyStatechange());
  }
  resume() {
    if (this.state === 'closed') return Promise.reject(domError('Cannot resume a closed AudioContext.', 'InvalidStateError'));
    if (this.state === 'running') return this.settled().then(() => undefined);
    return this.serially(() => host.resume(this.id)).then(() => {
      if (this.state !== 'closed' && this.changeState('running')) this.notifyStatechange();
    });
  }
  // Edge settles close() before statechange events queued by earlier calls fire, so it does not wait for the audio
  // thread. The engine closes after every earlier host call, in the background.
  close() {
    if (this.state === 'closed') return Promise.reject(domError('Cannot close a closed AudioContext.', 'InvalidStateError'));
    this.changeState('closed');
    const done = this.settled().then(() => this.notifyStatechange());
    this.serially(() => host.close(this.id));
    return done;
  }
  createMediaElementSource() { throw unsupported('AudioContext', 'createMediaElementSource'); }
  createMediaStreamSource() { throw unsupported('AudioContext', 'createMediaStreamSource'); }
  createMediaStreamTrackSource() { throw unsupported('AudioContext', 'createMediaStreamTrackSource'); }
  createMediaStreamDestination() { throw unsupported('AudioContext', 'createMediaStreamDestination'); }
  setSinkId() { return Promise.reject(unsupported('AudioContext', 'setSinkId')); }
}

export class OfflineAudioContext extends BaseAudioContext {
  #length;
  #rendering = false;
  constructor(...args) {
    const prefix = constructing('OfflineAudioContext');
    const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : { numberOfChannels: args[0], length: args[1], sampleRate: args[2] };
    const channels = options.numberOfChannels === undefined ? 1 : Number(options.numberOfChannels) >>> 0;
    const length = Number(options.length) >>> 0;
    const rate = toFloat(options.sampleRate, prefix);
    checkChannels(channels, prefix);
    if (length < 1) throw domError(`${prefix}: The number of frames provided (${length}) is less than the minimum bound (1).`, 'NotSupportedError');
    checkRate(rate, prefix, 'sampleRate');
    super(host.context({ kind: 'offline', channels, length, sampleRate: rate }), 'suspended');
    this.#length = length;
  }
  get length() { return this.#length; }
  startRendering() {
    if (this.#rendering) return Promise.reject(domError(`${executing('OfflineAudioContext', 'startRendering')}: cannot call startRendering on an OfflineAudioContext in a stopped state.`, 'InvalidStateError'));
    this.#rendering = true;
    if (this.changeState('running')) this.notifyStatechange();
    return host.render(this.id).then(channels => {
      const renderedBuffer = new AudioBuffer({ numberOfChannels: channels.length, length: this.#length, sampleRate: this.sampleRate });
      channels.forEach((data, c) => renderedBuffer.copyToChannel(data, c));
      this.dispatchEvent(new OfflineAudioCompletionEvent('complete', { renderedBuffer }));
      if (this.changeState('closed')) this.notifyStatechange();
      return renderedBuffer;
    });
  }
  suspend() { return Promise.reject(unsupported('OfflineAudioContext', 'suspend')); }
  resume() { return Promise.reject(unsupported('OfflineAudioContext', 'resume')); }
}
defineHandlers(OfflineAudioContext.prototype, ['complete']);

// The host reports each source that ended.
export function sourceEnded(id) {
  const source = sources.get(id);
  if (!source) return;
  sources.delete(id);
  source.dispatchEvent(new Event('ended'));
}

// Edge 157's answers for Howler's codec checks. The native host decodes MP3, Ogg Vorbis, WAV and FLAC.
const CAN_PLAY = new Map([
  ['audio/mpeg;', 'probably'], ['audio/mp3;', 'probably'], ['audio/ogg; codecs="opus"', 'probably'], ['audio/ogg; codecs="vorbis"', 'probably'],
  ['audio/wav; codecs="1"', 'probably'], ['audio/wav', 'maybe'], ['audio/aac;', 'probably'], ['audio/x-m4a;', 'maybe'], ['audio/mp4;', 'maybe'],
  ['audio/webm; codecs="vorbis"', 'probably'], ['audio/flac;', 'probably'], ['video/mp4', 'maybe'],
]);

export class HTMLMediaElement extends HTMLElement {
  get paused() { return true; }
  get volume() { return 1; }
  set volume(_) {}
  get muted() { return false; }
  set muted(_) {}
  get readyState() { return 0; }
  get currentTime() { return 0; }
  set currentTime(_) {}
  get duration() { return NaN; }
  get src() { return this.getAttribute('src') ?? ''; }
  set src(value) { this.setAttribute('src', String(value)); }
  canPlayType(type) { return CAN_PLAY.get(String(type)) ?? ''; }
  play() { return Promise.reject(unsupported('HTMLMediaElement', 'play')); }
  pause() { throw unsupported('HTMLMediaElement', 'pause'); }
  load() { throw unsupported('HTMLMediaElement', 'load'); }
}
export class HTMLAudioElement extends HTMLMediaElement {}
ELEMENT_CLASSES.set('audio', HTMLAudioElement);

export function audioConstructor(document) {
  return function Audio(src) {
    const audio = document.createElement('audio');
    if (src !== undefined) audio.src = src;
    return audio;
  };
}
