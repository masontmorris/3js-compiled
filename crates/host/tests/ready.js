// Clears to a red level of the host frame number, as counter.js does, and sets `globalThis.ready` in frame 20, for
// the wait_for step's tests.
let frame = 0;
function tick() {
  setClearColor((frame % 256) / 255, 0, 0, 1);
  if (frame === 20) globalThis.ready = true;
  frame++;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
