// Runs every scene of the canvas 2D example headless, with no renderer, for 60 frames each, and logs what each
// scene logs, so a scene's drawing can be checked with no GPU.
//   host --headless 1 --entry tools/canvas2d/scenes-smoke.js [--hash pally=<folder URL>]
import { SCENES } from '../../examples/canvas2d/src/scenes.js';

const fonts = new URL('../../examples/canvas2d/fonts/', import.meta.url);
const pally = new URLSearchParams(location.hash.slice(1)).get('pally');
const faces = [new FontFace('Amatic SC', `url(${new URL('AmaticSC-Bold.ttf', fonts).href})`, { weight: '700' }), new FontFace('Nunito', `url(${new URL('Nunito-wght.ttf', fonts).href})`, { weight: '200 1000' })];
if (pally) faces.push(...[['Pally-Regular.ttf', '400'], ['Pally-Medium.ttf', '500'], ['Pally-Bold.ttf', '700']].map(([file, weight]) => new FontFace('Pally', `url(${new URL(file, pally).href})`, { weight })));
for (const face of faces) document.fonts.add(await face.load());
for (const [name, scene] of Object.entries(SCENES)) {
  const shown = [];
  const update = await scene({ assets: new URL('../../examples/platform/assets/', import.meta.url), show: (canvas, x, y) => { shown.push(`${canvas.width}x${canvas.height}@${x},${y}`); return { texture: { dispose() {} }, place() {} }; }, log: line => console.log(`S ${name} ${line}`) });
  for (let frame = 0; frame < 60; frame++) update?.();
  console.log(`S ${name} shown ${shown.join(' ')}`);
}
