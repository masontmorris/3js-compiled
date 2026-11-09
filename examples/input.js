let key = false;
let gamepad = false;
let x = 0;
let y = 0;
addEventListener("keydown", event => { if (event.code === "KeyW") key = true; });
addEventListener("keyup", event => { if (event.code === "KeyW") key = false; });
addEventListener("pointermove", event => { x = event.clientX; y = event.clientY; });
addEventListener("pointerdown", event => { x = event.clientX; y = event.clientY; });
addEventListener("gamepadbutton", event => { if (event.button === 0) gamepad = event.down; });
function draw() {
  setClearColor(key ? 1 : x / 255, gamepad ? 1 : y / 255, 0.25);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
