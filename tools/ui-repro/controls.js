import { bridge } from "../../packages/three-native/src/bridge.js";

bridge.open("tools/ui-repro/controls.html");
let frame = 0;
bridge.onEvent(event => console.log(`HUD event ${JSON.stringify(event)} at game frame ${frame}`));
for (const type of ["pointerdown", "pointerup"]) {
  addEventListener(type, event => console.log(`GAME ${type} x=${event.clientX} button=${event.button} at game frame ${frame}`));
}
function tick() {
  frame += 1;
  setClearColor(0.1, 0.1, 0.3);
  bridge.send({ seq: frame });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
