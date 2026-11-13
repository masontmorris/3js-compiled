import { CommandEncoder } from '../../../packages/three-native/src/commands.js';

// Fills a buffer in a stream submitted at the top level and reads it back in a stream submitted in the first frame,
// as a page that draws while it loads and again on its first frame. The clear turns green once the readback holds
// the top level's bytes.
const loading = new CommandEncoder();
loading.createBuffer(1, 4, 12);
loading.writeBuffer(1, 0, new Uint8Array([11, 22, 33, 44]));
submitGpuCommands(loading.finish());
addEventListener('gpu-response', event => {
  const bytes = event.responses.find(item => item.type === 'readback' && item.request === 2)?.bytes;
  if (bytes && new Uint8Array(bytes).join(',') === '11,22,33,44') setClearColor(0, 1, 0, 1);
});
requestAnimationFrame(() => {
  const frame = new CommandEncoder();
  frame.readBuffer(2, 1, 0, 4);
  try { submitGpuCommands(frame.finish(1)); } catch (error) { console.log(`first frame submit failed: ${error.message}`); }
});
