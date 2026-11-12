// Frames that do no work, for the host's test that the game thread wakes as soon as the render thread finishes a frame.
// The page logs the timestamp of each of 600 frames, in ms after the first, and turns the clear colour green.
const native = typeof submitGpuCommands === 'function';
const starts = [];
function frame(t) {
  starts.push(t);
  if (starts.length === 600) {
    console.log(`R frame starts: ${starts.map(s => (s - starts[0]).toFixed(3)).join(' ')}`);
    if (native) setClearColor(0, 1, 0, 1);
    return;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
