// A running context playing a tone. The host test reads its currentTime, frame after frame, against the engine's.
const ctx = new AudioContext();
const tone = new OscillatorNode(ctx);
tone.connect(new GainNode(ctx, { gain: 0 })).connect(ctx.destination);
tone.start();
globalThis.__time = () => ctx.currentTime;
globalThis.__rate = ctx.sampleRate;
