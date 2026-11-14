import { bridge } from "../../packages/three-native/src/bridge.js";

bridge.open("tools/ui-repro/kept-hit.html");
let frame = 0;
bridge.onEvent(event => console.log(`HUD event ${JSON.stringify(event)} at game frame ${frame}`));
addEventListener("pointerdown", event => console.log(`GAME pointerdown x=${event.clientX} at game frame ${frame}`));
function tick() {
  frame += 1;
  setClearColor(0.1, 0.1, 0.3);
  bridge.send({ seq: frame });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
