// The reference graphs. Each one is plain data: a context, then a list of calls. run-graph.js plays the list
// against any Web Audio implementation, and crates/audio/tests/offline.rs plays the same list against
// web-audio-api-rs, so Edge, the host and the Rust engine render one definition.
//
// Calls:
//   ["buffer", id, { channels, length, sampleRate, signal }]   a generated AudioBuffer (signals.js)
//   ["node", id, kind, options]                                new <kind>Node(ctx, options); options.buffer names a buffer id
//   ["param", id, name, method, ...args]                       node[name][method](...args); method "value" sets .value
//   ["listener", name, value]                                  ctx.listener[name].value = value
//   ["connect", from, to]                                      "out" is ctx.destination
//   ["start", id, ...args] and ["stop", id, when]

export const decodeRates = [44100, 48000];
export const clipRates = [22050, 44100, 48000];
export const clipFormats = ['mp3', 'ogg', 'wav'];

export function clipName(format, channels, rate) {
  return `tone-${channels === 1 ? 'mono' : 'stereo'}-${rate}.${format}`;
}

// MP3s with no LAME or Xing header, so no encoder delay or padding to trim.
export const bareClips = ['tone-stereo-44100-bare.mp3', 'tone-mono-22050-bare.mp3'];

export function decodeCases() {
  const cases = bareClips.flatMap(file => decodeRates.map(sampleRate => ({ name: `decode-${file.replace('.mp3', '')}-to-${sampleRate}`, lane: 'decode', file, sampleRate })));
  for (const format of clipFormats) {
    for (const channels of [1, 2]) {
      for (const rate of clipRates) {
        for (const sampleRate of decodeRates) {
          cases.push({ name: `decode-${format}-${channels}ch-${rate}-to-${sampleRate}`, lane: 'decode', file: clipName(format, channels, rate), sampleRate });
        }
      }
    }
  }
  return cases;
}

const rate = 48000;
const length = 24000;

function graph(lane, name, ops, options = {}) {
  return { name, lane, sampleRate: options.sampleRate ?? rate, length: options.length ?? length, channels: options.channels ?? 2, ops };
}

function constantThroughGain(name, automation, offset = 1) {
  return graph('graph', name, [
    ['node', 'c', 'ConstantSource', { offset }],
    ['node', 'g', 'Gain', { gain: 1 }],
    ...automation.map(call => ['param', 'g', 'gain', ...call]),
    ['connect', 'c', 'g'],
    ['connect', 'g', 'out'],
    ['start', 'c', 0],
  ], { channels: 1 });
}

function gainGraphs() {
  const curve = [0, 0.8, 0.2, 1, 0.5, 0.05, 0.9];
  return [
    constantThroughGain('gain-set-value-at-time', [['setValueAtTime', 0.25, 0.1], ['setValueAtTime', 0.75, 0.2004], ['setValueAtTime', 0, 0.3]]),
    constantThroughGain('gain-linear-ramp', [['setValueAtTime', 0, 0.05], ['linearRampToValueAtTime', 1, 0.25], ['linearRampToValueAtTime', 0.1, 0.4]]),
    constantThroughGain('gain-linear-ramp-no-anchor', [['linearRampToValueAtTime', 0.2, 0.3]]),
    constantThroughGain('gain-exponential-ramp', [['setValueAtTime', 0.01, 0.05], ['exponentialRampToValueAtTime', 1, 0.25], ['exponentialRampToValueAtTime', 0.001, 0.45]]),
    constantThroughGain('gain-set-target', [['setTargetAtTime', 0, 0.05, 0.03], ['setTargetAtTime', 0.8, 0.25, 0.1]]),
    constantThroughGain('gain-value-curve', [['setValueCurveAtTime', curve, 0.1, 0.3]]),
    constantThroughGain('gain-set-value-fractional', [['setValueAtTime', 0.4, 0.0500091], ['setValueAtTime', 0.9, 0.1000137], ['setValueAtTime', 0.1, 0.30000001]]),
    constantThroughGain('gain-linear-ramp-fractional', [['setValueAtTime', 0.3, 0.0500091], ['linearRampToValueAtTime', 0.9, 0.2000313], ['linearRampToValueAtTime', 0.2, 0.3500077]]),
    constantThroughGain('gain-exponential-ramp-fractional', [['setValueAtTime', 0.05, 0.0500091], ['exponentialRampToValueAtTime', 0.9, 0.2000313]]),
    constantThroughGain('gain-set-target-fractional', [['setTargetAtTime', 0.2, 0.1000137, 0.02], ['setTargetAtTime', 0.7, 0.3000071, 0.05]]),
    constantThroughGain('gain-value-curve-fractional', [['setValueCurveAtTime', curve, 0.1000071, 0.2000033]]),
    constantThroughGain('gain-cancel-scheduled', [['setValueAtTime', 0, 0], ['linearRampToValueAtTime', 1, 0.4], ['cancelScheduledValues', 0.2]]),
    constantThroughGain('gain-cancel-and-hold', [['setValueAtTime', 0, 0], ['linearRampToValueAtTime', 1, 0.4], ['cancelAndHoldAtTime', 0.2]]),
    // Howler's fade: setValueAtTime(current, now) then linearRampToValueAtTime(target, now + duration).
    graph('graph', 'gain-howler-fade-on-tone', [
      ['buffer', 'b', { channels: 1, length: rate, sampleRate: rate, signal: 'mix' }],
      ['node', 's', 'AudioBufferSource', { buffer: 'b' }],
      ['node', 'g', 'Gain', { gain: 1 }],
      ['param', 'g', 'gain', 'setValueAtTime', 1, 0.1],
      ['param', 'g', 'gain', 'linearRampToValueAtTime', 0, 0.35],
      ['connect', 's', 'g'],
      ['connect', 'g', 'out'],
      ['start', 's', 0],
    ], { channels: 1 }),
  ];
}

function sourceGraph(name, sourceOptions, start, extra = [], signal = 'mix', bufferRate = rate) {
  return graph('graph', name, [
    ['buffer', 'b', { channels: 1, length: Math.round(bufferRate * 0.25), sampleRate: bufferRate, signal }],
    ['node', 's', 'AudioBufferSource', { buffer: 'b', ...sourceOptions }],
    ['connect', 's', 'out'],
    ['start', 's', ...start],
    ...extra,
  ], { channels: 1 });
}

function sourceGraphs() {
  const graphs = [];
  for (const playbackRate of [0.5, 0.75, 1, 1.5, 2, 3.3, 4]) {
    graphs.push(sourceGraph(`rate-${playbackRate}`, { playbackRate }, [0]));
  }
  graphs.push(sourceGraph('rate-ramp', {}, [0], [['param', 's', 'playbackRate', 'setValueAtTime', 0.5, 0], ['param', 's', 'playbackRate', 'linearRampToValueAtTime', 4, 0.2]]));
  graphs.push(sourceGraph('rate-1-buffer-22050', {}, [0], [], 'mix', 22050));
  graphs.push(sourceGraph('rate-1.5-buffer-44100', { playbackRate: 1.5 }, [0], [], 'mix', 44100));
  graphs.push(sourceGraph('detune-700', { detune: 700 }, [0]));
  graphs.push(sourceGraph('loop-whole', { loop: true }, [0]));
  graphs.push(sourceGraph('loop-start-end', { loop: true, loopStart: 0.05, loopEnd: 0.12 }, [0]));
  graphs.push(sourceGraph('loop-start-end-rate-1.7', { loop: true, loopStart: 0.05, loopEnd: 0.12, playbackRate: 1.7 }, [0]));
  graphs.push(sourceGraph('loop-offset-past-end', { loop: true, loopStart: 0.05, loopEnd: 0.12 }, [0, 0.2]));
  graphs.push(sourceGraph('start-at-sample', {}, [0.1]));
  graphs.push(sourceGraph('start-subsample', {}, [0.100013]));
  graphs.push(sourceGraph('start-offset', {}, [0.05, 0.1]));
  graphs.push(sourceGraph('start-offset-duration', {}, [0.05, 0.03, 0.08]));
  graphs.push(sourceGraph('start-stop', {}, [0.02], [['stop', 's', 0.15]]));
  graphs.push(sourceGraph('stop-subsample', {}, [0], [['stop', 's', 0.150007]]));
  graphs.push(sourceGraph('loop-stop', { loop: true, loopStart: 0.01, loopEnd: 0.2 }, [0], [['stop', 's', 0.37]]));
  // Howler plays a sprite as start(0, offset, duration) on a looping source with loopStart and loopEnd.
  graphs.push(sourceGraph('howler-sprite-loop', { loop: true, loopStart: 0.03, loopEnd: 0.09 }, [0, 0.03, 86400]));
  graphs.push({ ...sourceGraph('rate-1.5-context-44100', { playbackRate: 1.5 }, [0]), name: 'rate-1.5-context-44100', sampleRate: 44100, length: 22050 });
  graphs.push({ ...sourceGraph('loop-start-end-context-44100', { loop: true, loopStart: 0.05, loopEnd: 0.12 }, [0.010007]), name: 'loop-start-end-context-44100', sampleRate: 44100, length: 22050 });
  graphs.push(graph('graph', 'oscillator-sine-1k', [
    ['node', 'o', 'Oscillator', { type: 'sine', frequency: 1000 }],
    ['node', 'g', 'Gain', { gain: 0.5 }],
    ['connect', 'o', 'g'],
    ['connect', 'g', 'out'],
    ['start', 'o', 0],
  ], { channels: 1 }));
  return graphs;
}

// Eight directions around the listener, on the horizontal plane and above and below it.
export const positions = [
  [0, 0, -1], [1, 0, -1], [1, 0, 0], [1, 0, 1], [0, 0, 1], [-1, 0, 1], [-1, 0, 0], [-0.5, 0.8, -0.3],
];

function panGraphs() {
  const graphs = [];
  const mono = ['buffer', 'b', { channels: 1, length, sampleRate: rate, signal: 'mix' }];
  const stereo = ['buffer', 'b', { channels: 2, length, sampleRate: rate, signal: 'mix' }];
  for (const pan of [-1, -0.75, -0.4, -0.1, 0, 0.3, 0.7, 1]) {
    for (const [label, buffer] of [['mono', mono], ['stereo', stereo]]) {
      graphs.push(graph('pan', `stereo-panner-${label}-${pan}`, [
        buffer,
        ['node', 's', 'AudioBufferSource', { buffer: 'b' }],
        ['node', 'p', 'StereoPanner', { pan }],
        ['connect', 's', 'p'],
        ['connect', 'p', 'out'],
        ['start', 's', 0],
      ]));
    }
  }
  graphs.push(graph('pan', 'stereo-panner-automated', [
    mono,
    ['node', 's', 'AudioBufferSource', { buffer: 'b' }],
    ['node', 'p', 'StereoPanner', { pan: -1 }],
    ['param', 'p', 'pan', 'linearRampToValueAtTime', 1, 0.5],
    ['connect', 's', 'p'],
    ['connect', 'p', 'out'],
    ['start', 's', 0],
  ]));
  graphs.push(graph('pan', 'stereo-panner-context-44100', [
    ['buffer', 'b', { channels: 1, length: 22050, sampleRate: 44100, signal: 'mix' }],
    ['node', 's', 'AudioBufferSource', { buffer: 'b' }],
    ['node', 'p', 'StereoPanner', { pan: 0.35 }],
    ['connect', 's', 'p'],
    ['connect', 'p', 'out'],
    ['start', 's', 0],
  ], { sampleRate: 44100, length: 22050 }));
  for (const distanceModel of ['linear', 'inverse', 'exponential']) {
    positions.forEach(([x, y, z], i) => {
      const scale = 1 + i * 1.7;
      graphs.push(graph('pan', `equalpower-${distanceModel}-${i}`, [
        mono,
        ['node', 's', 'AudioBufferSource', { buffer: 'b' }],
        ['node', 'p', 'Panner', { panningModel: 'equalpower', distanceModel, refDistance: 1, maxDistance: 20, rolloffFactor: 1, positionX: x * scale, positionY: y * scale, positionZ: z * scale }],
        ['connect', 's', 'p'],
        ['connect', 'p', 'out'],
        ['start', 's', 0],
      ]));
    });
  }
  graphs.push(graph('pan', 'equalpower-moving', [
    mono,
    ['node', 's', 'AudioBufferSource', { buffer: 'b' }],
    ['node', 'p', 'Panner', { panningModel: 'equalpower', distanceModel: 'inverse', positionX: -4, positionZ: -1 }],
    ['param', 'p', 'positionX', 'linearRampToValueAtTime', 4, 0.5],
    ['connect', 's', 'p'],
    ['connect', 'p', 'out'],
    ['start', 's', 0],
  ]));
  graphs.push(graph('pan', 'equalpower-listener-turned', [
    mono,
    ['listener', 'forwardX', 1],
    ['listener', 'forwardZ', 0],
    ['listener', 'positionX', 0.5],
    ['node', 's', 'AudioBufferSource', { buffer: 'b' }],
    ['node', 'p', 'Panner', { panningModel: 'equalpower', distanceModel: 'inverse', positionX: 2, positionZ: 2 }],
    ['connect', 's', 'p'],
    ['connect', 'p', 'out'],
    ['start', 's', 0],
  ]));
  graphs.push(graph('pan', 'equalpower-cone', [
    mono,
    ['node', 's', 'AudioBufferSource', { buffer: 'b' }],
    ['node', 'p', 'Panner', { panningModel: 'equalpower', positionX: 1, positionZ: -2, orientationX: 1, orientationY: 0, orientationZ: 0, coneInnerAngle: 60, coneOuterAngle: 180, coneOuterGain: 0.2 }],
    ['connect', 's', 'p'],
    ['connect', 'p', 'out'],
    ['start', 's', 0],
  ]));
  positions.forEach(([x, y, z], i) => {
    graphs.push(graph('hrtf', `hrtf-${i}`, [
      ['buffer', 'b', { channels: 1, length, sampleRate: rate, signal: 'noise' }],
      ['node', 's', 'AudioBufferSource', { buffer: 'b' }],
      ['node', 'p', 'Panner', { panningModel: 'HRTF', distanceModel: 'inverse', positionX: x * 2, positionY: y * 2, positionZ: z * 2 }],
      ['connect', 's', 'p'],
      ['connect', 'p', 'out'],
      ['start', 's', 0],
    ]));
  });
  return graphs;
}

export function referenceGraphs() {
  return [...gainGraphs(), ...sourceGraphs(), ...panGraphs()];
}
