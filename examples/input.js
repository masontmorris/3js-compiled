let key = false;
let x = 0;
let y = 0;
addEventListener("keydown", event => { if (event.code === "KeyW") key = true; });
addEventListener("keyup", event => { if (event.code === "KeyW") key = false; });
addEventListener("pointermove", event => { x = event.clientX; y = event.clientY; });
addEventListener("pointerdown", event => { x = event.clientX; y = event.clientY; });
function draw() {
  const gamepad = navigator.getGamepads().some(pad => pad?.buttons[0].pressed);
  setClearColor(key ? 1 : x / 255, gamepad ? 1 : y / 255, 0.25);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
