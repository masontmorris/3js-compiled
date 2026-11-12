// Frame pacing after a late frame, in headless Edge and in the host. Each frame callback works 3 ms, and every 30th
// works 9 ms, longer than a 169 Hz refresh, as a game's occasional heavy frame does. The page logs the timestamp of the
// first of 300 frames and of each after it, in ms; the host's test checks that no display refresh begins two of them.
// The timestamp is when the frame began, which a busy PC's preemption before the callback runs does not move. The
// host's clear colour turns green once the page reports.
const native = typeof submitGpuCommands === 'function';
const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };
const starts = [];
let frames = 0;
function frame(t) {
  starts.push(t);
  busy(frames % 30 === 29 ? 9 : 3);
  if (++frames === 300) {
    console.log(`R frame start origin ms: ${starts[0].toFixed(3)}`);
    console.log(`R frame starts: ${starts.map(s => (s - starts[0]).toFixed(2)).join(' ')}`);
    if (native) setClearColor(0, 1, 0, 1);
    return;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
