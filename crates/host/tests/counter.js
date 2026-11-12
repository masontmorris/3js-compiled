let frame = 0;
function tick() {
  setClearColor((frame % 256) / 255, 0, 0, 1);
  frame++;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
