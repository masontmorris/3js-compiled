import { CommandEncoder, Opcode } from '../../../packages/three-native/src/commands.js';

addEventListener('gpu-response', event => {
  if (event.responses.some(item => item.type === 'error' && item.message.includes('cannot be destroyed'))) setClearColor(0, 1, 0, 1);
});
requestAnimationFrame(() => {
  const frame = new CommandEncoder();
  frame.words(Opcode.ACQUIRE_SURFACE, [1, innerWidth, innerHeight]);
  frame.destroyTexture(1);
  submitGpuCommands(frame.finish());
});
