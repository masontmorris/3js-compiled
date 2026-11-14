import { bridge } from "../packages/three-native/src/bridge.js";
bridge.open("tools/ui-once.html");
bridge.send({ seq: 77 });
function tick() {
  setClearColor(0, 0, 1);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
