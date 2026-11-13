// Graph and lifecycle scenarios. Each logs what a page can observe, and the same module runs in Edge (edge-scenarios.mjs)
// and in the host (examples/audio/scenarios.js), so each scenario's log is one row of the scenario table. A log
// entry is an array of JSON values. Values that depend on the output device are logged as types or ranges.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function running(ctx) {
  for (let i = 0; i < 100 && ctx.state !== 'running'; i++) await sleep(10);
}

function attempt(log, label, fn) {
  try {
    const value = fn();
    log(label, 'ok', value === undefined ? null : value);
  } catch (error) {
    log(label, error.constructor.name, error.name, error.message);
  }
}

async function attemptAsync(log, label, fn) {
  try {
    const value = await Promise.race([fn(), sleep(1000).then(() => 'still pending after 1 s')]);
    log(label, 'resolved', value === undefined ? null : value);
  } catch (error) {
    log(label, error.constructor.name, error.name, error.message);
  }
}

// The types Howler asks canPlayType about, and two it does not.
export const mediaTypes = ['audio/mpeg;', 'audio/mp3;', 'audio/ogg; codecs="opus"', 'audio/ogg; codecs="vorbis"', 'audio/wav; codecs="1"', 'audio/wav', 'audio/aac;', 'audio/x-caf;', 'audio/x-m4a;', 'audio/m4a;', 'audio/x-m4b;', 'audio/m4b;', 'audio/x-mp4;', 'audio/mp4;', 'audio/webm; codecs="vorbis"', 'audio/mp4; codecs="ec-3"', 'audio/x-flac;', 'audio/flac;', 'video/mp4', 'bogus'];

export const scenarios = {
  async 'context-start'(log) {
    const ctx = new AudioContext();
    log('state at construction', ctx.state);
    ctx.onstatechange = () => log('statechange', ctx.state);
    await running(ctx);
    log('state', ctx.state);
    log('sampleRate is the device rate', ctx.sampleRate === 44100 || ctx.sampleRate === 48000);
    log('baseLatency', ctx.baseLatency);
    log('latency under 50 ms', ctx.baseLatency + ctx.outputLatency <= 0.05);
    const t = ctx.currentTime;
    await sleep(100);
    log('currentTime advances', ctx.currentTime > t);
    log('destination', ctx.destination.maxChannelCount >= 2, ctx.destination.channelCount, ctx.destination.numberOfInputs, ctx.destination.numberOfOutputs);
    await ctx.close();
    log('state after close', ctx.state);
  },

  // currentTime is 0 at construction, advances by whole render quanta while the context runs, holds while it is
  // suspended, and advances again after resume.
  async 'current-time'(log) {
    const ctx = new AudioContext();
    const whole = t => Math.abs((t * ctx.sampleRate) / 128 - Math.round((t * ctx.sampleRate) / 128)) < 1e-6;
    log('at construction', ctx.currentTime);
    await running(ctx);
    await sleep(200);
    const ran = ctx.currentTime;
    log('running: advances, in whole render quanta', ran > 0, whole(ran));
    await ctx.suspend();
    const held = ctx.currentTime;
    await sleep(150);
    log('suspended: holds, in whole render quanta', ctx.currentTime === held, whole(held));
    await ctx.resume();
    await sleep(150);
    const resumed = ctx.currentTime;
    log('resumed: advances again, in whole render quanta', resumed > held, whole(resumed));
    await ctx.close();
  },

  async 'suspend-resume-close'(log) {
    const ctx = new AudioContext();
    await running(ctx);
    ctx.onstatechange = () => log('statechange', ctx.state);
    const suspended = ctx.suspend().then(v => log('suspend resolved', ctx.state, v === undefined));
    log('after suspend()', ctx.state);
    await suspended;
    const t = ctx.currentTime;
    await sleep(100);
    log('currentTime holds while suspended', ctx.currentTime === t);
    await ctx.suspend().then(() => log('suspend again resolved', ctx.state));
    const resumed = ctx.resume().then(() => log('resume resolved', ctx.state));
    log('after resume()', ctx.state);
    await resumed;
    await ctx.resume().then(() => log('resume again resolved', ctx.state));
    const closed = ctx.close().then(() => log('close resolved', ctx.state));
    log('after close()', ctx.state);
    await closed;
    await attemptAsync(log, 'resume after close', () => ctx.resume());
    await attemptAsync(log, 'suspend after close', () => ctx.suspend());
    await attemptAsync(log, 'close after close', () => ctx.close());
    attempt(log, 'createGain after close', () => ctx.createGain().gain.value);
    const next = new AudioContext();
    log('new context state', next.state);
    await running(next);
    log('new context running', next.state);
    await next.close();
  },

  async 'statechange-timing'(log) {
    const ctx = new AudioContext();
    const start = performance.now();
    const order = [];
    ctx.onstatechange = () => order.push(['statechange', ctx.state]);
    const mark = label => order.push([label, ctx.state]);
    await sleep(300);
    mark('settled');
    const s = ctx.suspend().then(() => mark('suspend resolved'));
    mark('suspend called');
    await sleep(300);
    const r = ctx.resume().then(() => mark('resume resolved'));
    mark('resume called');
    await sleep(300);
    const s2 = ctx.suspend().then(() => mark('suspend 2 resolved'));
    const r2 = ctx.resume().then(() => mark('resume 2 resolved'));
    mark('suspend then resume called');
    await sleep(300);
    const c = ctx.close().then(() => mark('close resolved'));
    mark('close called');
    await sleep(300);
    await Promise.all([s, r, s2, r2, c]);
    log('order', order);
    log('took under 3 s', performance.now() - start < 3000);
  },

  async 'statechange-races'(log) {
    const order = [];
    const watch = (label, ctx) => { ctx.onstatechange = () => order.push([label, 'statechange', ctx.state]); };
    const a = new AudioContext();
    watch('close at once', a);
    await a.close();
    order.push(['close at once', 'closed', a.state]);
    await sleep(300);
    const b = new AudioContext();
    watch('resume then close', b);
    await sleep(300);
    await b.suspend();
    await sleep(300);
    await b.resume();
    order.push(['resume then close', 'resumed', b.state]);
    await b.close();
    order.push(['resume then close', 'closed', b.state]);
    await sleep(300);
    const c = new AudioContext();
    watch('suspend at once', c);
    await c.suspend();
    order.push(['suspend at once', 'suspended', c.state]);
    await sleep(300);
    await c.close();
    await sleep(300);
    log('order', order);
  },

  async 'suspend-mid-sound'(log) {
    const ctx = new AudioContext();
    await running(ctx);
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    let ended = 0;
    osc.onended = () => ended++;
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    await sleep(50);
    await ctx.suspend();
    await sleep(400);
    log('ended while suspended', ended);
    await ctx.resume();
    await sleep(400);
    log('ended after resume', ended);
    await ctx.close();
  },

  async 'offline-render'(log) {
    const ctx = new OfflineAudioContext(2, 4410, 44100);
    log('state', ctx.state, ctx.length, ctx.sampleRate);
    ctx.onstatechange = () => log('statechange', ctx.state);
    ctx.oncomplete = event => log('complete', event.constructor.name, event.renderedBuffer.length);
    const osc = new OscillatorNode(ctx);
    osc.connect(ctx.destination);
    osc.start();
    const promise = ctx.startRendering();
    log('after startRendering', ctx.state);
    const buffer = await promise;
    log('resolved', buffer.constructor.name, buffer.numberOfChannels, buffer.length, buffer.sampleRate, buffer.duration);
    await attemptAsync(log, 'startRendering again', () => ctx.startRendering());
  },

  async 'decode-callbacks'(log, { clip }) {
    const ctx = new OfflineAudioContext(1, 128, 48000);
    const bytes = await (await fetch(clip)).arrayBuffer();
    const copy = bytes.slice(0);
    const promise = ctx.decodeAudioData(bytes, buffer => log('success callback', buffer.length, buffer.sampleRate), error => log('error callback', error?.name));
    log('bytes detached', bytes.byteLength);
    promise.then(buffer => log('promise resolved', buffer.length));
    await promise;
    await attemptAsync(log, 'decode a detached buffer', () => ctx.decodeAudioData(bytes));
    let callbackError;
    await attemptAsync(log, 'decode garbage', () => ctx.decodeAudioData(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, null, error => { callbackError = error; }));
    log('garbage error callback', callbackError?.constructor.name, callbackError?.name);
    log('copy decodes', (await ctx.decodeAudioData(copy)).numberOfChannels);
  },

  async 'param-errors'(log) {
    const ctx = new OfflineAudioContext(1, 128, 48000);
    const gain = ctx.createGain().gain;
    attempt(log, 'setValueAtTime NaN', () => gain.setValueAtTime(NaN, 0));
    attempt(log, 'setValueAtTime negative time', () => gain.setValueAtTime(1, -1));
    attempt(log, 'linearRamp Infinity time', () => gain.linearRampToValueAtTime(1, Infinity));
    attempt(log, 'exponentialRamp to 0', () => gain.exponentialRampToValueAtTime(0, 1));
    attempt(log, 'setTarget negative constant', () => gain.setTargetAtTime(1, 0, -1));
    attempt(log, 'setTarget zero constant', () => gain.setTargetAtTime(1, 0, 0) === gain);
    attempt(log, 'curve of one value', () => gain.setValueCurveAtTime([1], 0, 1));
    attempt(log, 'curve of zero duration', () => gain.setValueCurveAtTime([1, 2], 0, 0));
    attempt(log, 'curve', () => gain.setValueCurveAtTime(new Float32Array([0, 1]), 1, 1) === gain);
    attempt(log, 'event inside curve', () => gain.setValueAtTime(0.5, 1.5));
    attempt(log, 'event at curve end', () => gain.setValueAtTime(0.5, 2) === gain);
    attempt(log, 'curve over event', () => gain.setValueCurveAtTime([1, 2], 1.8, 1));
    attempt(log, 'ramp ending inside curve', () => gain.linearRampToValueAtTime(1, 1.5));
    attempt(log, 'cancel negative', () => gain.cancelScheduledValues(-1));
    attempt(log, 'cancelAndHold negative', () => gain.cancelAndHoldAtTime(-1));
    attempt(log, 'value Infinity', () => { gain.value = Infinity; });
    attempt(log, 'value string', () => { gain.value = '0.5'; return gain.value; });
    attempt(log, 'value clamps when read', () => { const f = ctx.createBiquadFilter().frequency; f.value = 1e9; return [f.value, f.maxValue]; });
    attempt(log, 'defaults', () => [gain.defaultValue, gain.minValue, gain.maxValue, gain.automationRate]);
    attempt(log, 'automationRate of playbackRate', () => ctx.createBufferSource().playbackRate.automationRate);
    attempt(log, 'set automationRate of playbackRate', () => { ctx.createBufferSource().playbackRate.automationRate = 'a-rate'; });
    attempt(log, 'set automationRate bogus', () => { gain.automationRate = 'b-rate'; return gain.automationRate; });
  },

  async 'node-errors'(log) {
    const ctx = new OfflineAudioContext(1, 128, 48000);
    const other = new OfflineAudioContext(1, 128, 48000);
    attempt(log, 'AudioContext sampleRate 1000', () => new AudioContext({ sampleRate: 1000 }));
    attempt(log, 'OfflineAudioContext length 0', () => new OfflineAudioContext(1, 0, 44100));
    attempt(log, 'OfflineAudioContext channels 0', () => new OfflineAudioContext(0, 10, 44100));
    attempt(log, 'OfflineAudioContext rate 1000', () => new OfflineAudioContext(1, 10, 1000));
    attempt(log, 'createBuffer channels 0', () => ctx.createBuffer(0, 10, 44100));
    attempt(log, 'createBuffer length 0', () => ctx.createBuffer(1, 0, 44100));
    attempt(log, 'createBuffer rate 1000', () => ctx.createBuffer(1, 10, 1000));
    attempt(log, 'new AudioBuffer', () => { const b = new AudioBuffer({ length: 10, sampleRate: 8000, numberOfChannels: 3 }); return [b.length, b.numberOfChannels, b.duration]; });
    const buffer = ctx.createBuffer(2, 10, 44100);
    attempt(log, 'getChannelData 5', () => buffer.getChannelData(5));
    attempt(log, 'copyToChannel 5', () => buffer.copyToChannel(new Float32Array(4), 5));
    attempt(log, 'copyFromChannel offset past end', () => { const a = new Float32Array(4).fill(7); buffer.copyFromChannel(a, 0, 20); return [...a]; });
    attempt(log, 'getChannelData is live', () => { const d = buffer.getChannelData(0); d[3] = 0.25; const out = new Float32Array(10); buffer.copyFromChannel(out, 0); return out[3]; });
    const src = ctx.createBufferSource();
    attempt(log, 'stop before start', () => src.stop());
    attempt(log, 'start negative', () => src.start(-1));
    attempt(log, 'start offset negative', () => src.start(0, -1));
    attempt(log, 'start duration negative', () => src.start(0, 0, -1));
    attempt(log, 'start', () => src.start());
    attempt(log, 'start twice', () => src.start());
    attempt(log, 'stop negative', () => src.stop(-1));
    attempt(log, 'buffer set', () => { src.buffer = buffer; return src.buffer === buffer; });
    attempt(log, 'buffer set again', () => { src.buffer = ctx.createBuffer(1, 1, 44100); });
    attempt(log, 'buffer set to null', () => { src.buffer = null; return src.buffer; });
    attempt(log, 'buffer set after null', () => { src.buffer = buffer; });
    attempt(log, 'buffer set to object', () => { ctx.createBufferSource().buffer = {}; });
    const gain = ctx.createGain();
    attempt(log, 'connect to another context', () => gain.connect(other.createGain()));
    attempt(log, 'connect output 1', () => gain.connect(ctx.destination, 1));
    attempt(log, 'connect input 1', () => gain.connect(ctx.destination, 0, 1));
    attempt(log, 'connect returns destination', () => gain.connect(ctx.destination) === ctx.destination);
    attempt(log, 'connect to param', () => gain.connect(ctx.createGain().gain));
    attempt(log, 'disconnect unconnected', () => gain.disconnect(ctx.createGain()));
    attempt(log, 'disconnect output 3', () => gain.disconnect(3));
    attempt(log, 'disconnect all', () => gain.disconnect());
    attempt(log, 'disconnect all again', () => gain.disconnect());
    attempt(log, 'connect a string', () => gain.connect('x'));
    const osc = ctx.createOscillator();
    attempt(log, 'oscillator type custom', () => { osc.type = 'custom'; });
    attempt(log, 'oscillator type bogus', () => { osc.type = 'bogus'; return osc.type; });
    attempt(log, 'oscillator type square', () => { osc.type = 'square'; return osc.type; });
    attempt(log, 'new OscillatorNode custom', () => new OscillatorNode(ctx, { type: 'custom' }));
    const panner = ctx.createPanner();
    attempt(log, 'panner defaults', () => [panner.panningModel, panner.distanceModel, panner.refDistance, panner.maxDistance, panner.rolloffFactor, panner.coneInnerAngle, panner.coneOuterAngle, panner.coneOuterGain, panner.channelCount, panner.channelCountMode]);
    attempt(log, 'refDistance -1', () => { panner.refDistance = -1; });
    attempt(log, 'maxDistance 0', () => { panner.maxDistance = 0; });
    attempt(log, 'rolloffFactor -1', () => { panner.rolloffFactor = -1; });
    attempt(log, 'coneOuterGain 2', () => { panner.coneOuterGain = 2; });
    attempt(log, 'panner channelCount 3', () => { panner.channelCount = 3; });
    attempt(log, 'panner channelCountMode max', () => { panner.channelCountMode = 'max'; });
    attempt(log, 'panningModel bogus', () => { panner.panningModel = 'bogus'; return panner.panningModel; });
    attempt(log, 'setPosition', () => { panner.setPosition(1, 2, 3); return [panner.positionX.value, panner.positionY.value, panner.positionZ.value]; });
    attempt(log, 'setOrientation', () => { panner.setOrientation(0, 1, 0); return [panner.orientationX.value, panner.orientationY.value, panner.orientationZ.value]; });
    attempt(log, 'listener', () => { ctx.listener.setPosition(1, 1, 1); ctx.listener.setOrientation(0, 0, -1, 0, 1, 0); return [ctx.listener.positionX.value, ctx.listener.forwardZ.value, ctx.listener.upY.value]; });
    const stereo = ctx.createStereoPanner();
    attempt(log, 'stereo channelCount 3', () => { stereo.channelCount = 3; });
    attempt(log, 'stereo channelCountMode max', () => { stereo.channelCountMode = 'max'; });
    attempt(log, 'gain channelCount 0', () => { gain.channelCount = 0; });
    attempt(log, 'gain channelCount 33', () => { gain.channelCount = 33; });
    attempt(log, 'gain channelInterpretation bogus', () => { gain.channelInterpretation = 'bogus'; return gain.channelInterpretation; });
    const analyser = ctx.createAnalyser();
    attempt(log, 'analyser defaults', () => [analyser.fftSize, analyser.frequencyBinCount, analyser.minDecibels, analyser.maxDecibels, analyser.smoothingTimeConstant]);
    attempt(log, 'fftSize 100', () => { analyser.fftSize = 100; });
    attempt(log, 'fftSize 64', () => { analyser.fftSize = 64; return analyser.frequencyBinCount; });
    attempt(log, 'minDecibels above max', () => { analyser.minDecibels = 0; });
    attempt(log, 'smoothing 2', () => { analyser.smoothingTimeConstant = 2; });
    attempt(log, 'createDelay 0', () => ctx.createDelay(0));
    attempt(log, 'createDelay 180', () => ctx.createDelay(180));
    attempt(log, 'delay max', () => ctx.createDelay(2).delayTime.maxValue);
    attempt(log, 'biquad type bogus', () => { const b = ctx.createBiquadFilter(); b.type = 'bogus'; return b.type; });
    attempt(log, 'node counts', () => [gain, osc, panner, stereo, analyser, ctx.createBufferSource(), ctx.createBiquadFilter(), ctx.createDelay(), ctx.createConstantSource()].map(n => [n.constructor.name, n.numberOfInputs, n.numberOfOutputs, n.channelCount, n.channelCountMode, n.channelInterpretation]));
  },

  async 'unsupported-methods'(log) {
    const ctx = new AudioContext();
    await running(ctx);
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.start();
    attempt(log, 'createMediaElementSource', () => ctx.createMediaElementSource(new Audio()).constructor.name);
    attempt(log, 'createMediaStreamSource', () => ctx.createMediaStreamSource({}).constructor.name);
    attempt(log, 'createScriptProcessor', () => ctx.createScriptProcessor(1024, 1, 1).constructor.name);
    await attemptAsync(log, 'audioWorklet.addModule', () => ctx.audioWorklet.addModule('data:text/javascript,'));
    await attemptAsync(log, 'Audio.play', () => new Audio().play());
    const t = ctx.currentTime;
    await sleep(100);
    log('still playing', ctx.state, ctx.currentTime > t);
    await ctx.close();
  },

  async 'audio-element'(log) {
    const audio = new Audio();
    log('canPlayType', mediaTypes.map(type => audio.canPlayType(type)));
    log('element', audio.constructor.name, audio.tagName, audio instanceof HTMLMediaElement, audio.paused, audio.volume, audio.muted, audio.readyState);
    log('document.createElement', document.createElement('audio').constructor.name);
  },

  async 'xhr'(log, { clip, json, text, missing }) {
    const run = (url, responseType) => new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      const events = [['readyState', xhr.readyState]];
      xhr.onreadystatechange = () => events.push(['readystatechange', xhr.readyState]);
      for (const type of ['loadstart', 'progress', 'load', 'error', 'loadend', 'abort', 'timeout']) {
        xhr.addEventListener(type, event => events.push([type, xhr.readyState, event.lengthComputable, event.loaded > 0]));
      }
      xhr.open('GET', url, true);
      events.push(['after open', xhr.readyState]);
      xhr.responseType = responseType;
      xhr.send();
      events.push(['after send', xhr.readyState]);
      xhr.onloadend = () => {
        const response = xhr.response;
        const summary = response instanceof ArrayBuffer ? ['ArrayBuffer', response.byteLength > 0] : typeof response === 'string' ? ['string', response.length > 0] : response === null ? ['null'] : [typeof response, Object.keys(response)];
        resolve([...events, ['done', xhr.status, xhr.statusText, ...summary]]);
      };
    });
    log('arraybuffer', await run(clip, 'arraybuffer'));
    log('json', await run(json, 'json'));
    log('text', await run(text, ''));
    log('missing', await run(missing, 'arraybuffer'));
    const xhr = new XMLHttpRequest();
    attempt(log, 'send before open', () => xhr.send());
    attempt(log, 'responseText of arraybuffer', () => { const x = new XMLHttpRequest(); x.open('GET', text); x.responseType = 'arraybuffer'; return x.responseText; });
    attempt(log, 'constants', () => [XMLHttpRequest.UNSENT, XMLHttpRequest.OPENED, XMLHttpRequest.HEADERS_RECEIVED, XMLHttpRequest.LOADING, XMLHttpRequest.DONE]);
    log('abort', await new Promise(resolve => {
      const x = new XMLHttpRequest();
      const events = [];
      for (const type of ['readystatechange', 'abort', 'loadend', 'load']) x.addEventListener(type, () => events.push([type, x.readyState]));
      x.open('GET', clip);
      x.send();
      x.abort();
      events.push(['after abort', x.readyState, x.status]);
      setTimeout(() => resolve(events), 100);
    }));
  },
};
