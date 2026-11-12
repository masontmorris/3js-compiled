// Frames for the host's tests of how fast frames follow the render thread: each works the scene's number of ms, 0 by
// default. The page logs the timestamp of each of 600 frames, in ms after the first, and turns the clear colour green.
const native = typeof submitGpuCommands === 'function';
const work = Number(native ? (globalThis.__sceneName ?? 0) : 0);
const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };
const starts = [];
function frame(t) {
  starts.push(t);
  busy(work);
  if (starts.length === 600) {
    console.log(`R frame starts: ${starts.map(s => (s - starts[0]).toFixed(3)).join(' ')}`);
    if (native) setClearColor(0, 1, 0, 1);
    return;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
