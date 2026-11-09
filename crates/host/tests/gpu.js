import { CommandEncoder } from '../../../packages/three-native/src/commands.js';

let duplicateRejected = false;
addEventListener('gpu-response', event => {
  const response = event.responses.find(item => item.type === 'readback' && item.request === 2);
  const error = event.responses.find(item => item.type === 'error' && item.message.includes('bad-material'));
  if (duplicateRejected && error && response && response.bytes.join(',') === '11,22,33,44') setClearColor(0, 1, 0, 1);
});
requestAnimationFrame(() => {
  const frame = new CommandEncoder();
  frame.createShader(3, 'bad-material', '@vertex fn main() -> @builtin(position) vec4f {\nreturn vec4f(;\n}');
  frame.createBuffer(1, 4, 12);
  frame.writeBuffer(1, 0, new Uint8Array([11, 22, 33, 44]));
  frame.readBuffer(2, 1, 0, 4);
  submitGpuCommands(frame.finish());
  try { submitGpuCommands(new CommandEncoder().finish()); } catch { duplicateRejected = true; }
});
