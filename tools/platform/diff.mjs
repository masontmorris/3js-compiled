// Compares two PNG captures of the same size: the mean RGB difference as a fraction of full scale and the share
// of pixels where a channel differs by more than 2 of 255, and writes a difference image.
//   node tools/platform/diff.mjs <a.png> <b.png> [<diff.png>]
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [a, b, out] = process.argv.slice(2).map(path => path);
const left = PNG.sync.read(readFileSync(a));
const right = PNG.sync.read(readFileSync(b));
if (left.width !== right.width || left.height !== right.height) {
  console.log(`size differs: ${left.width}x${left.height} and ${right.width}x${right.height}`);
  process.exit(1);
}
const diff = new PNG({ width: left.width, height: left.height });
let sum = 0;
let differing = 0;
for (let i = 0; i < left.data.length; i += 4) {
  let pixel = 0;
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(left.data[i + c] - right.data[i + c]);
    sum += d;
    pixel = Math.max(pixel, d);
  }
  if (pixel > 2) differing++;
  diff.data.set([Math.min(255, pixel * 8), 0, 0, 255], i);
}
const pixels = left.width * left.height;
const mean = sum / (pixels * 3 * 255);
if (out) writeFileSync(out, PNG.sync.write(diff));
console.log(JSON.stringify({ a, b, mean: Number(mean.toFixed(6)), differing: Number((differing / pixels).toFixed(6)) }));
