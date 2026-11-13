import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as audio from '../src/platform/audio.js';
import { XMLHttpRequest } from '../src/platform/xhr.js';
import { Document } from '../src/platform/dom.js';
import { fetch, setHost } from '../src/platform/images.js';
import { mediaTypes, scenarios } from '../../../tools/audio-parity/scenarios.mjs';
import { scenarioEnv } from '../../../tools/audio-parity/scenario-env.mjs';

const repo = new URL('../../../', import.meta.url);
const edge = JSON.parse(readFileSync(new URL('tools/audio-parity/scenarios.edge.json', repo), 'utf8')).scenarios;

// Each node kind's param defaults, which the fake host answers until a page sets a value.
const DEFAULTS = {
  Gain: { gain: 1 }, AudioBufferSource: { playbackRate: 1, detune: 0 }, Oscillator: { frequency: 440, detune: 0 }, ConstantSource: { offset: 1 },
  StereoPanner: { pan: 0 }, Panner: { positionX: 0, positionY: 0, positionZ: 0, orientationX: 1, orientationY: 0, orientationZ: 0 },
  BiquadFilter: { frequency: 350, detune: 0, Q: 1, gain: 0 }, Delay: { delayTime: 0 },
  Listener: { positionX: 0, positionY: 0, positionZ: 0, forwardX: 0, forwardY: 0, forwardZ: -1, upX: 0, upY: 1, upZ: 0 },
};

// A host that keeps what the engine would: values a page sets, a clock that runs while a context runs, and lifecycle
// calls that settle a few milliseconds later, as the audio thread's do.
function fakeHost() {
  let next = 1;
  const kinds = new Map();
  const values = new Map();
  const clocks = new Map();
  const later = value => new Promise(resolve => setTimeout(() => resolve(value), 5));
  // The engine's clock advances by whole render quanta of 128 frames at 48 kHz.
  const time = id => {
    const clock = clocks.get(id);
    if (!clock) return 0;
    const seconds = clock.held + (clock.running ? (performance.now() - clock.since) / 1000 : 0);
    return (Math.floor((seconds * 48000) / 128) * 128) / 48000;
  };
  const run = (id, running) => {
    const clock = clocks.get(id);
    clock.held = time(id);
    clock.since = performance.now();
    clock.running = running;
  };
  const calls = [];
  return {
    calls,
    context: spec => {
      const id = next++;
      // The clock starts a few milliseconds after the context, as a device does, so a read in the same turn is 0.
      if (spec.kind === 'online') {
        clocks.set(id, { held: 0, since: performance.now(), running: false });
        setTimeout(() => { if (!clocks.get(id).stopped) run(id, true); }, 5);
      }
      return { id, sampleRate: spec.sampleRate ?? 48000 };
    },
    currentTime: time,
    baseLatency: () => 0.01,
    outputLatency: () => 0.02,
    destination: () => next++,
    listener: () => { const id = next++; kinds.set(id, 'Listener'); return id; },
    maxChannelCount: () => 2,
    suspend: id => { run(id, false); clocks.get(id).stopped = true; return later(); },
    resume: id => { run(id, true); return later(); },
    close: id => { run(id, false); clocks.get(id).stopped = true; return later(); },
    render: id => later([new Float32Array(4410), new Float32Array(4410)]),
    node: (context, kind) => { const id = next++; kinds.set(id, kind); return id; },
    set: (...args) => calls.push(['set', ...args]),
    param: (id, name, method, a) => {
      calls.push(['param', id, name, method, a]);
      if (method === 'value') values.set(`${id}.${name}`, a);
    },
    curve: (...args) => calls.push(['curve', ...args]),
    paramValue: (id, name) => values.get(`${id}.${name}`) ?? DEFAULTS[kinds.get(id)]?.[name] ?? 0,
    connect: (...args) => calls.push(['connect', ...args]),
    connectParam: (...args) => calls.push(['connectParam', ...args]),
    disconnect: (...args) => calls.push(['disconnect', ...args]),
    disconnectParam: (...args) => calls.push(['disconnectParam', ...args]),
    start: (...args) => calls.push(['start', ...args]),
    stop: (...args) => calls.push(['stop', ...args]),
    release: id => calls.push(['release', id]),
    buffer: () => next++,
    bufferData: () => new Float32Array(0),
    sourceBuffer: (...args) => calls.push(['sourceBuffer', ...args]),
    decode: () => Promise.reject(new Error('no decoder')),
    analyser: () => {},
  };
}

const examples = new URL('examples/audio/', repo);
function install() {
  const host = fakeHost();
  audio.setAudioHost(host);
  const document = new Document(globalThis);
  Object.assign(globalThis, {
    AudioContext: audio.AudioContext, OfflineAudioContext: audio.OfflineAudioContext, OscillatorNode: audio.OscillatorNode, AudioBuffer: audio.AudioBuffer,
    HTMLMediaElement: audio.HTMLMediaElement, Audio: audio.audioConstructor(document), document, XMLHttpRequest, fetch,
    location: { href: new URL('index.html', examples).href, origin: 'null' },
  });
  setHost({
    readFile: async path => { try { return new Uint8Array(readFileSync(path)); } catch { return null; } },
    decode: async () => { throw new Error('no images'); },
  });
  return host;
}

async function run(name) {
  const log = [];
  await scenarios[name]((...entry) => log.push(entry), scenarioEnv(pathToFileURL(fileURLToPath(examples)).href));
  return JSON.parse(JSON.stringify(log));
}

// Edge plays Opus and AAC, which the host cannot decode, so the host answers '' for them and a page falls back.
const UNDECODED = new Set(['audio/ogg; codecs="opus"', 'audio/aac;', 'audio/x-m4a;', 'audio/mp4;', 'video/mp4']);
const hostAnswers = {
  'audio-element': log => log.map(([kind, ...rest]) => kind === 'canPlayType' ? [kind, rest[0].map((answer, i) => UNDECODED.has(mediaTypes[i]) ? '' : answer)] : [kind, ...rest]),
};

for (const name of ['context-start', 'current-time', 'param-errors', 'node-errors', 'statechange-timing', 'statechange-races', 'suspend-resume-close', 'offline-render', 'audio-element', 'xhr']) {
  test(`${name} logs what Edge logs`, async () => {
    install();
    assert.deepEqual(await run(name), hostAnswers[name]?.(edge[name]) ?? edge[name]);
  });
}

test('the media and script methods that the host leaves out throw errors that name them', async () => {
  install();
  const ctx = new AudioContext();
  for (const method of ['createMediaElementSource', 'createMediaStreamSource', 'createScriptProcessor', 'createPeriodicWave', 'createConvolver']) {
    assert.throws(() => ctx[method](), { name: 'NotSupportedError', message: new RegExp(`\\.${method} is not supported`) });
  }
  await assert.rejects(ctx.audioWorklet.addModule('x.js'), { name: 'NotSupportedError', message: /AudioWorklet\.addModule is not supported/ });
  await assert.rejects(new Audio().play(), { name: 'NotSupportedError', message: /HTMLMediaElement\.play is not supported/ });
  assert.throws(() => ctx.createOscillator().setPeriodicWave(), { message: /OscillatorNode\.setPeriodicWave/ });
});

test('an AudioParam forwards each event and drops ones the context has passed', () => {
  const host = install();
  const ctx = new OfflineAudioContext(1, 128, 48000);
  const gain = ctx.createGain().gain;
  gain.setValueCurveAtTime([0, 1], 10, 1);
  for (let i = 0; i < 100; i++) gain.setValueAtTime(i / 100, i / 1000);
  assert.throws(() => gain.setValueAtTime(0.5, 10.5), { name: 'NotSupportedError' });
  assert.equal(host.calls.filter(c => c[0] === 'param').length, 100);
  const curve = host.calls.find(c => c[0] === 'curve');
  assert.deepEqual([curve[2], [...curve[3]], curve[4], curve[5]], ['gain', [0, 1], 10, 1]);
  gain.setTargetAtTime(0.3, 0.2, 0);
  assert.deepEqual(host.calls.at(-1).slice(2), ['gain', 'setValueAtTime', Math.fround(0.3)], 'a zero time constant jumps to the target');
  gain.cancelScheduledValues(5);
  gain.setValueAtTime(0.5, 10.5);
});

test('a buffer source hands the engine the buffer it holds, and sends a page-written buffer again on each acquire', () => {
  const host = install();
  const ctx = new OfflineAudioContext(1, 128, 48000);
  const buffer = ctx.createBuffer(1, 4, 48000);
  buffer.getChannelData(0)[1] = 0.5;
  const uploads = [];
  host.buffer = channels => { uploads.push([...channels[0]]); return 77; };
  ctx.createBufferSource().buffer = buffer;
  buffer.getChannelData(0)[2] = 0.25;
  new audio.AudioBufferSourceNode(ctx, { buffer });
  assert.deepEqual(uploads, [[0, 0.5, 0, 0], [0, 0.5, 0.25, 0]]);
  assert.deepEqual(host.calls.filter(c => c[0] === 'sourceBuffer').map(c => c[2]), [77, 77]);
  assert.deepEqual(host.calls.filter(c => c[0] === 'release').map(c => c[1]), [77], 'the copy the second acquire replaced');
});

test('native ids cannot be reassigned and unsupported codecs are rejected', () => {
  install();
  const a = new AudioContext();
  const b = new AudioContext();
  const node = a.createGain();
  assert.throws(() => { node.id = b.destination.id; }, TypeError);
  assert.throws(() => { a.id = b.id; }, TypeError);
  const media = new HTMLMediaElement();
  for (const type of ['audio/ogg; codecs="opus"', 'audio/aac;', 'audio/x-m4a;', 'audio/mp4;', 'video/mp4']) {
    assert.equal(media.canPlayType(type), '');
  }
  assert.equal(media.canPlayType('audio/ogg; codecs="vorbis"'), 'probably');
});
