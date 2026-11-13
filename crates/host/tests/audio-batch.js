// Each frame changes 8 voices' gain, playback rate and pan position, and a panner property, as a busy game does, with
// no other audio call, and counts its changes in globalThis.__made. The host test checks that each frame's changes all
// reach the engine, in one call, by the time the frame ends.
const ctx = new AudioContext();
const voices = Array.from({ length: 8 }, (_, i) => {
  const source = new OscillatorNode(ctx, { frequency: 220 * (1 + i / 4) });
  const gain = new GainNode(ctx, { gain: 0 });
  const panner = new PannerNode(ctx, { panningModel: 'HRTF' });
  source.connect(gain).connect(panner).connect(ctx.destination);
  source.start();
  return { source, gain, panner };
});
globalThis.__made = 0;
function frame(time) {
  const t = time / 1000;
  let made = 0;
  voices.forEach(({ source, gain, panner }, i) => {
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.01 * (1 + Math.sin(t + i)), now);
    source.frequency.setValueAtTime(220 * (1 + i / 4) * (1 + 0.1 * Math.sin(t)), now);
    panner.positionX.value = 4 * Math.cos(t + i);
    panner.refDistance = 1 + (i % 2);
    made += 4;
  });
  globalThis.__made = made;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
