import { bridge } from "../../packages/three-native/src/bridge.js";

bridge.open("tools/ui-repro/flood.html");
let count = 0;
bridge.onEvent(event => {
  count += 1;
  if (count % 100000 === 0) console.log("EVENTS " + count);
});

let frame = 0;
function tick() {
  frame += 1;
  setClearColor(0.0, 0.05, 1.0);
  bridge.send({ seq: frame });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
