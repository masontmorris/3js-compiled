// Lane 9: a steady tone while the system default output changes underneath it. With no --audio-device the host follows
// the default output, so the tone moves with it.
const ctx = new AudioContext();
const tone = new OscillatorNode(ctx, { frequency: 1000 });
const gain = new GainNode(ctx, { gain: 0.2 });
tone.connect(gain).connect(ctx.destination);
tone.start();
console.log(`lane9: started ${ctx.currentTime.toFixed(3)} ${ctx.state} ${ctx.sampleRate}`);
