import { CommandEncoder } from '../../../packages/three-native/src/commands.js';

const width = 1280;
const height = 720;
const pattern = new Uint8Array(width * height * 4).map((_, index) => (index * 7) & 255);
let duplicateRejected = false;
let submitted = 0;
addEventListener('gpu-response', event => {
  const readback = request => event.responses.find(item => item.type === 'readback' && item.request === request)?.bytes;
  const small = readback(2);
  const large = readback(5);
  const error = event.responses.find(item => item.type === 'error' && item.label === 'bad-material' && item.frame === 7);
  const matches = large instanceof ArrayBuffer && new Uint8Array(large).every((value, index) => value === pattern[index]);
  console.log(`readback of ${large?.byteLength} bytes arrived ${(performance.now() - submitted).toFixed(1)} ms after submission, matches ${matches}`);
  if (duplicateRejected && error && small && new Uint8Array(small).join(',') === '11,22,33,44' && matches) setClearColor(0, 1, 0, 1);
});
requestAnimationFrame(() => {
  const frame = new CommandEncoder();
  frame.createShader(3, 'bad-material', '@vertex fn main() -> @builtin(position) vec4f {\nreturn vec4f(;\n}');
  frame.createBuffer(1, 4, 12);
  frame.writeBuffer(1, 0, new Uint8Array([11, 22, 33, 44]));
  frame.readBuffer(2, 1, 0, 4);
  frame.createTexture(4, { width, height, layers: 1, mips: 1, samples: 1, usage: 3, format: 'rgba8unorm', label: 'pattern' });
  frame.writeTexture(4, { mip: 0, x: 0, y: 0, layer: 0, bytesPerRow: width * 4, rowsPerImage: height, width, height, layers: 1 }, pattern);
  frame.readTexture(5, 4, { mip: 0, x: 0, y: 0, layer: 0, width, height });
  submitted = performance.now();
  submitGpuCommands(frame.finish(7));
  try { submitGpuCommands(new CommandEncoder().finish()); } catch { duplicateRejected = true; }
});
