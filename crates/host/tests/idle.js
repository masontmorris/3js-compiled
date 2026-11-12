import { CommandEncoder, Opcode } from '../../../packages/three-native/src/commands.js';

setClearColor(1, 0, 1, 1);
requestAnimationFrame(() => {
  const frame = new CommandEncoder();
  frame.words(Opcode.ACQUIRE_SURFACE, [1, innerWidth, innerHeight]);
  frame.createTextureView(2, 1, { baseMip: 0, mips: 0, baseLayer: 0, layers: 0, dimension: 0, aspect: 0, usage: 0 });
  frame.beginRenderPass([{ view: 2, resolve: null, load: 1, store: 1, clear: [0, 1, 0, 1] }], null);
  frame.append(Opcode.END_RENDER_PASS);
  frame.append(Opcode.SUBMIT);
  submitGpuCommands(frame.finish());
});
