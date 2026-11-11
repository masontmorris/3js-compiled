// Writes alpha.png, the platform example's texture: a 256x256 pattern whose alpha falls from opaque at the top to
// clear at the bottom, with full color in its clear pixels. Run with `node examples/platform/assets/generate.mjs`.
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const size = 256;
const png = new PNG({ width: size, height: size, colorType: 6 });
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const ring = Math.hypot(x - 128, y - 128) % 48 < 24;
    png.data[i] = ring ? 240 : (x * 255) / size;
    png.data[i + 1] = ring ? 180 : 60;
    png.data[i + 2] = ring ? 40 : (y * 255) / size;
    png.data[i + 3] = 255 - y;
  }
}
writeFileSync(new URL('./alpha.png', import.meta.url), PNG.sync.write(png, { colorType: 6 }));
