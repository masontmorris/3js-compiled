import { bridge } from "../../packages/three-native/src/bridge.js";
bridge.open("examples/hud/index.html");
let frame = 0;
function tick() {
  frame += 1;
  setClearColor(0, 0, 1);
  if (frame === 300) { try { bridge.send({ blob: "x".repeat(1100000) }); console.log("sent 1.1 MB state at frame 300"); } catch (error) { console.log("send rejected: " + error); } }
  bridge.send({ seq: frame, hp: 50 });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
