// Frame pacing after a late frame, in headless Edge and in the host. Each frame callback works 3 ms, and every 30th
// works 9 ms, longer than a 169 Hz refresh, as a game's occasional heavy frame does. The page logs when each of 300
// frame callbacks began, in ms after the first; the host's turn checks that no display refresh begins two of them. The
// host's clear colour turns green once the page reports.
const native = typeof submitGpuCommands === 'function';
const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };
const starts = [];
let frames = 0;
function frame() {
  const t = performance.now();
  starts.push(t);
  busy(frames % 30 === 29 ? 9 : 3);
  if (++frames === 300) {
    console.log(`R frame starts: ${starts.map(s => (s - starts[0]).toFixed(2)).join(' ')}`);
    if (native) setClearColor(0, 1, 0, 1);
    return;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
