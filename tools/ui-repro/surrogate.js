import { bridge } from "../../packages/three-native/src/bridge.js";

bridge.open("tools/ui-repro/surrogate.html");
bridge.onEvent(event => console.log("UIEV " + JSON.stringify(event)));
addEventListener("pointerdown", event => console.log("GAMEPTR " + JSON.stringify({ x: event.clientX, y: event.clientY, button: event.button })));

let frame = 0;
function tick() {
  frame += 1;
  setClearColor(0.0, 0.05, 1.0);
  bridge.send({ seq: frame });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
