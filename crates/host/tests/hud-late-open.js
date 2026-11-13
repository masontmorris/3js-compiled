// Opens hud-replace.html only after a top-level await, so the host has already started its frame
// loop when the page request arrives, and sends a magenta patch every frame over a red canvas.
import { bridge } from '../../../packages/three-native/src/bridge.js';

await new Promise(resolve => setTimeout(resolve, 100));
bridge.open('hud-replace.html');
function frame() {
  setClearColor(1, 0, 0, 1);
  bridge.send({ color: 'rgb(255, 0, 255)' });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
