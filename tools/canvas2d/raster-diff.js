// Draws folio's canvases with the host's canvas 2D, headless, and compares each with Edge's PNG of the same canvas
// from the rasterizer spike, inside the page: the mean RGBA difference as a fraction of full scale and the share
// of pixels where a channel differs by more than 2 of 255. It needs no GPU.
//   host --headless 1 --entry tools/canvas2d/raster-diff.js --hash refs=<file URL of the spike's edge folder>/
import { FOLIO_CANVASES, TEXT_CANVAS_VARIANTS } from '../../examples/canvas2d/src/folio-canvases.js';

const refs = new URLSearchParams(location.hash.slice(1)).get('refs');
const fonts = new URL('../../examples/canvas2d/fonts/', import.meta.url);
for (const face of [new FontFace('Amatic SC', `url(${new URL('AmaticSC-Bold.ttf', fonts).href})`, { weight: '700' }), new FontFace('Nunito', `url(${new URL('Nunito-wght.ttf', fonts).href})`, { weight: '200 1000' })]) {
  document.fonts.add(await face.load());
}
let total = 0;
let totalDiffering = 0;
let pixels = 0;
for (const { name, draw } of [...FOLIO_CANVASES, ...TEXT_CANVAS_VARIANTS]) {
  const canvas = document.createElement('canvas');
  const context = draw(canvas);
  const ours = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const bitmap = await createImageBitmap(await (await fetch(new URL(`${name}.png`, refs).href)).blob(), { colorSpaceConversion: 'none' });
  if (bitmap.width !== canvas.width || bitmap.height !== canvas.height) throw new Error(`${name}.png is ${bitmap.width}x${bitmap.height}, not ${canvas.width}x${canvas.height}`);
  const edge = bitmap[Symbol.for('threejsc.pixels')].data;
  let sum = 0;
  let differing = 0;
  for (let i = 0; i < ours.length; i += 4) {
    let most = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(ours[i + c] - edge[i + c]);
      sum += d;
      most = Math.max(most, d);
    }
    if (most > 2) differing++;
  }
  const count = ours.length / 4;
  console.log(`D ${name} ${canvas.width}x${canvas.height} mean=${(sum / (count * 4 * 255)).toFixed(6)} differing=${(differing / count).toFixed(6)}`);
  if (!name.startsWith('gradient')) {
    total += sum / (4 * 255);
    totalDiffering += differing;
    pixels += count;
  }
}
console.log(`D text mean=${(total / pixels).toFixed(6)} differing=${(totalDiffering / pixels).toFixed(6)}`);
