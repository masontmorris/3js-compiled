import { CommandEncoder, Opcode } from '../../../packages/three-native/src/commands.js';

let rejected = false;
addEventListener('gpu-response', event => {
  rejected ||= event.responses.some(item => item.type === 'error' && item.message.includes('cannot be destroyed'));
});
requestAnimationFrame(() => {
  const frame = new CommandEncoder();
  frame.words(Opcode.ACQUIRE_SURFACE, [1, innerWidth, innerHeight]);
  frame.destroyTexture(1);
  submitGpuCommands(frame.finish(0));
  requestAnimationFrame(function draw() {
    if (!rejected) return requestAnimationFrame(draw);
    const next = new CommandEncoder();
    next.words(Opcode.ACQUIRE_SURFACE, [2, innerWidth, innerHeight]);
    next.createTextureView(3, 2, { baseMip: 0, mips: 0, baseLayer: 0, layers: 0, dimension: 0, aspect: 0, usage: 0 });
    next.beginRenderPass([{ view: 3, resolve: null, load: 1, store: 1, clear: [0, 1, 0, 1] }], null);
    next.append(Opcode.END_RENDER_PASS);
    next.append(Opcode.SUBMIT);
    submitGpuCommands(next.finish(1));
  });
});
