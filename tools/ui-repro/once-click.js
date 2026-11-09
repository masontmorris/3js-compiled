import { bridge } from "../../packages/three-native/src/bridge.js";
bridge.open("examples/hud/index.html");
bridge.onEvent(event => console.log("HUD event", JSON.stringify(event)));
bridge.send({ seq: 1, hp: 50 });
let frame = 0;
function tick() {
  frame += 1;
  setClearColor(0, 0, 1);
  if (frame % 120 === 0) console.log("frame", frame);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
