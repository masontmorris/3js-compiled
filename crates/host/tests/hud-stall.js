// Opens hud-stall.html, whose image never loads, and sends a magenta patch every frame over a red
// canvas.
import { bridge } from '../../../packages/three-native/src/bridge.js';

bridge.open('hud-stall.html');
function frame() {
  setClearColor(1, 0, 0, 1);
  bridge.send({ color: 'rgb(255, 0, 255)' });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
