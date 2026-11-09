import { writeFileSync } from 'node:fs';
import { CommandEncoder, Opcode } from '../../../../packages/three-native/src/commands.js';

const envelope = new CommandEncoder();
envelope.append(Opcode.CREATE_BUFFER, new Uint8Array([0, 1, 2, 255]));
envelope.append(Opcode.DRAW, new Uint8Array([42]));
envelope.append(Opcode.SUBMIT);
writeFileSync(new URL('./frame.bin', import.meta.url), envelope.finish());

const replay = new CommandEncoder();
replay.createBuffer(1, 16, 12);
replay.writeBuffer(1, 4, new Uint8Array([11, 22, 33, 44]));
replay.readBuffer(2, 1, 0, 16);
replay.destroyBuffer(1);
replay.readBuffer(3, 1, 0, 4);
writeFileSync(new URL('./buffers.bin', import.meta.url), replay.finish());

const shaders = new CommandEncoder();
shaders.createShader(4, 'broken-material', '@vertex fn main() -> @builtin(position) vec4f {\n  return vec4f(;\n}');
shaders.createShader(5, 'valid-material', '@compute @workgroup_size(1) fn main() {}');
shaders.destroyResource(4);
shaders.destroyResource(5);
shaders.createBuffer(6, 4, 12);
shaders.writeBuffer(6, 0, new Uint8Array([8, 7, 6, 5]));
shaders.readBuffer(7, 6, 0, 4);
writeFileSync(new URL('./shaders.bin', import.meta.url), shaders.finish());

const textures = new CommandEncoder();
textures.createTexture(10, { width: 2, height: 2, layers: 1, mips: 1, samples: 1, usage: 3, format: 'rgba8unorm' });
textures.createTextureView(14, 10, { baseMip: 0, mips: 1, baseLayer: 0, layers: 1, dimension: 1, aspect: 0, usage: 0 });
textures.writeTexture(10, { mip: 0, x: 0, y: 0, layer: 0, bytesPerRow: 8, rowsPerImage: 2, width: 2, height: 2, layers: 1 }, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]));
textures.readTexture(11, 10, { mip: 0, x: 0, y: 0, layer: 0, width: 2, height: 2 });
textures.writeTexture(10, { mip: 0, x: 0, y: 1, layer: 0, bytesPerRow: 0, rowsPerImage: 0, width: 2, height: 1, layers: 1 }, new Uint8Array([4, 3, 2, 1, 8, 7, 6, 5]));
textures.readTexture(13, 10, { mip: 0, x: 0, y: 1, layer: 0, width: 2, height: 1 });
textures.destroyTexture(10);
textures.readTexture(12, 10, { mip: 0, x: 0, y: 0, layer: 0, width: 1, height: 1 });
textures.destroyResource(14);
writeFileSync(new URL('./textures.bin', import.meta.url), textures.finish());
