import { CommandEncoder } from '../../../packages/three-native/src/commands.js';

// A stream submitted at the top level for frame 7 and the first frame's stream for frame 1 each create a broken
// shader as their second command, so each raises an error that names its own stream's frame and command.
const broken = '@vertex fn main() -> @builtin(position) vec4f {\nreturn vec4f(;\n}';
const loading = new CommandEncoder();
loading.createBuffer(1, 4, 12);
loading.createShader(2, 'loading', broken, 0);
submitGpuCommands(loading.finish(7));
requestAnimationFrame(() => {
  const frame = new CommandEncoder();
  frame.createBuffer(3, 4, 12);
  frame.createShader(4, 'frame', broken, 0);
  submitGpuCommands(frame.finish(1));
});
