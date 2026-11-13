import { CommandEncoder } from '../../../packages/three-native/src/commands.js';

const frames = 6;
const valid = '@vertex fn main() -> @builtin(position) vec4f {\nreturn vec4f(0.0);\n}';
const broken = '@vertex fn main() -> @builtin(position) vec4f {\nreturn vec4f(;\n}';
// Compilation messages and readbacks by request, and each uncaptured error by the stream frame it names.
const responses = new Map();
const errors = new Map();
let current = 0;
addEventListener('gpu-response', event => {
  for (const response of event.responses) {
    if (response.type === 'error') errors.set(response.frame, response);
    else responses.set(response.request, response);
    console.log(`request ${response.request} (${response.type}, stream frame ${response.frame ?? '-'}) arrived before JavaScript frame ${current + 1}`);
  }
  if (responses.size < frames * 2 || errors.size < frames / 2) return;
  const faithful = Array.from({ length: frames }, (_, index) => index + 1).every(frame => {
    const shader = responses.get(100 + frame);
    const readback = responses.get(200 + frame);
    const error = errors.get(frame);
    const shaderOk = frame % 2
      ? shader.type === 'compilation' && shader.message !== null && error?.label === `shader-${frame}`
      : shader.type === 'compilation' && shader.message === null && error === undefined;
    return shaderOk && new Uint8Array(readback.bytes).every(value => value === frame);
  });
  console.log(`responses match their frames: ${faithful}`);
  if (faithful) setClearColor(0, 1, 0, 1);
});
function tick() {
  current++;
  if (current > frames) return;
  const encoder = new CommandEncoder();
  encoder.createShader(10 + current, `shader-${current}`, current % 2 ? broken : valid, 100 + current);
  encoder.createBuffer(20 + current, 4, 12);
  encoder.writeBuffer(20 + current, 0, new Uint8Array(4).fill(current));
  encoder.readBuffer(200 + current, 20 + current, 0, 4);
  submitGpuCommands(encoder.finish(current));
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
