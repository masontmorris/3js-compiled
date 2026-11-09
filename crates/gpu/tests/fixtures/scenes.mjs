// Records example scenes for the replay tests and adds a surface readback to the last frame.
// The Edge references come from tools/parity: <scene>-web.png saved here as <scene>-edge.png.
// Usage, from the repository root: node crates/gpu/tests/fixtures/scenes.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandEncoder, decodeCommands, Opcode } from '../../../../packages/three-native/src/commands.js';

for (const scene of ['basic-cube', 'standard-shadow']) {
  const dir = mkdtempSync(join(tmpdir(), 'threejsc-scene-'));
  execFileSync(process.execPath, ['tools/scenes/record.mjs', scene, dir, '2'], { stdio: 'inherit' });
  for (const index of [0, 1]) {
    const records = decodeCommands(new Uint8Array(readFileSync(join(dir, `00${index}.bin`))));
    const frame = new CommandEncoder();
    for (const { opcode, payload } of records) frame.append(opcode, payload);
    if (index === 1) {
      const acquire = records.find(record => record.opcode === Opcode.ACQUIRE_SURFACE);
      const surface = new DataView(acquire.payload.buffer).getUint32(0, true);
      frame.readTexture(0xffffffff, surface, { mip: 0, x: 0, y: 0, layer: 0, width: 1280, height: 720 });
    }
    writeFileSync(new URL(`./${scene}-${index}.bin`, import.meta.url), frame.finish());
  }
}
