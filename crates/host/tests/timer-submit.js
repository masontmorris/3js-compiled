import { CommandEncoder } from '../../../packages/three-native/src/commands.js';

// Submits an empty stream for `frame`, logging a rejected submit.
function submit(frame) {
  try { submitGpuCommands(new CommandEncoder().finish(frame)); } catch (error) { console.log(`stream ${frame} failed: ${error.message}`); }
}
// The frame end submits the work the page awaits only after the timer in the third frame asks for it.
let waiting = false;
globalThis.__gpuFrameEnd = () => {
  if (waiting) submit(4);
  waiting = false;
};
// A timer set in a frame's callbacks falls due before the next frame's callbacks, and Edge runs it first. In the second
// frame the timer and the callback both submit. In the third only the timer does, so the frame end still submits.
requestAnimationFrame(() => {
  setTimeout(() => submit(1), 0);
  requestAnimationFrame(() => {
    submit(2);
    setTimeout(() => { submit(3); waiting = true; }, 0);
  });
});
