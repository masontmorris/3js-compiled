import { writeFileSync } from 'node:fs';
import { CommandEncoder, Opcode } from '../../../../packages/three-native/src/commands.js';

const frame = new CommandEncoder();
frame.append(Opcode.CREATE_BUFFER, new Uint8Array([0, 1, 2, 255]));
frame.append(Opcode.DRAW, new Uint8Array([42]));
frame.append(Opcode.SUBMIT);
writeFileSync(new URL('./frame.bin', import.meta.url), frame.finish());
