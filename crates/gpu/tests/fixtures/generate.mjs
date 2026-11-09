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
