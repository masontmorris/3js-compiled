let frame = 0;
function draw() {
  frame += 1;
  setClearColor((frame % 256) / 255, 0.25, 0.5);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
