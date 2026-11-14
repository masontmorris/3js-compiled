// Opens hud-right.html, a blue HUD box 40 px from the right edge that takes the color of its
// patch, and sends a magenta patch every frame over a red canvas.
import { bridge } from '../../../packages/three-native/src/bridge.js';

bridge.open('hud-right.html');
function frame() {
  setClearColor(1, 0, 0, 1);
  bridge.send({ color: 'rgb(255, 0, 255)' });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
