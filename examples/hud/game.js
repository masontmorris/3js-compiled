import { bridge } from "../../packages/three-native/src/bridge.js";

bridge.open("examples/hud/index.html");
bridge.onEvent(event => console.log("HUD event", event));
let frame = 0;
function tick() {
  frame += 1;
  setClearColor(0, 0.05 * (1 + Math.sin(frame / 80)), 1);
  bridge.send({ seq: frame, hp: 50 + Math.round(40 * Math.sin(frame / 80)) });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
