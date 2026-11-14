// Opens hud-hover.html, a HUD button that reports its :hover state and its pointer and mouse
// boundary events, and logs each HUD event over a red canvas.
import { bridge } from '../../../packages/three-native/src/bridge.js';

bridge.open('hud-hover.html');
bridge.onEvent(event => console.log(`HUD event ${JSON.stringify(event)}`));
let frame = 0;
function tick() {
  frame += 1;
  setClearColor(1, 0, 0, 1);
  bridge.send({ seq: frame });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
