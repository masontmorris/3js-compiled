// Canvases canvas2d.test.js compares with Edge's pixels: folio's label canvases, text in scripts no requested font
// covers, named Windows fonts, and sizes, weights and squeezes of folio's fonts. Edge records each canvas as a PNG
// through canvas2d-pixels.html. The host draws each headless, compares it with the PNG and logs one
// `P <json>` line: the mean RGBA difference as a fraction of full scale, and its total coverage over Edge's.
import { FOLIO_CANVASES } from '../../../examples/canvas2d/src/folio-canvases.js';

const FONTS = new URL('../../../examples/canvas2d/fonts/', import.meta.url);
const FIXTURES = new URL('./fixtures/canvas2d/', import.meta.url);

function text(font, value, { fill = '#ffffff', maxWidth, stroke } = {}) {
  return canvas => {
    canvas.width = 640;
    canvas.height = 80;
    const context = canvas.getContext('2d');
    context.fillStyle = '#000000';
    context.fillRect(0, 0, 640, 80);
    context.font = font;
    context.textBaseline = 'middle';
    if (stroke) {
      context.strokeStyle = stroke;
      context.lineWidth = 6;
      context.strokeText(value, 12, 40, maxWidth);
    }
    context.fillStyle = fill;
    context.fillText(value, 12, 40, maxWidth);
  };
}

export const PIXEL_CASES = [
  ...FOLIO_CANVASES.filter(({ name }) => ['label', 'timer', 'text-title', 'leaderboard', 'altar'].includes(name)).map(({ name, draw }) => ({ name: `folio-${name}`, draw })),
  { name: 'nunito-24-bold', draw: text('700 24px Nunito', 'Leaderboard 00:41:337 BRUNO') },
  { name: 'nunito-32', draw: text('400 32px Nunito', 'Nunito regular at 32 px') },
  { name: 'nunito-12', draw: text('700 12px Nunito', 'Small Nunito, 12 px, 01:23:456') },
  { name: 'amatic-max-width', draw: text('700 64px "Amatic SC"', 'Hey! Watch where you are going!', { maxWidth: 300 }) },
  { name: 'amatic-green', draw: text('700 56px "Amatic SC"', 'Green text 1,234', { fill: '#00ff00' }) },
  { name: 'nunito-stroked', draw: text('700 40px Nunito', 'Stroked 42', { fill: '#00ff00', stroke: '#ff0000' }) },
  { name: 'japanese', draw: text('32px sans-serif', 'こんにちは世界、ゲーム') },
  { name: 'chinese', draw: text('32px sans-serif', '你好世界，游戏') },
  { name: 'thai', draw: text('32px sans-serif', 'สวัสดีครับ โลก') },
  { name: 'devanagari', draw: text('32px sans-serif', 'नमस्ते दुनिया') },
  { name: 'greek', draw: text('700 40px "Amatic SC"', 'Καλημέρα κόσμε') },
  { name: 'arabic', draw: text('32px sans-serif', 'مرحبا بالعالم') },
  { name: 'whispers-japanese', draw: text('700 64px "Amatic SC"', 'Hi! こんにちは') },
  ...['Verdana', '"Courier New"', 'Georgia', 'Tahoma', 'Calibri', '"Trebuchet MS"', 'Helvetica'].map(family => ({
    name: `named-${family.replace(/"/g, '').replace(/ /g, '-').toLowerCase()}`,
    draw: text(`24px ${family}`, 'The quick brown fox jumps, 0123'),
  })),
];

export async function loadFonts() {
  const faces = [
    new FontFace('Amatic SC', `url(${new URL('AmaticSC-Bold.ttf', FONTS).href})`, { weight: '700' }),
    new FontFace('Nunito', `url(${new URL('Nunito-wght.ttf', FONTS).href})`, { weight: '200 1000' }),
  ];
  for (const face of faces) document.fonts.add(await face.load());
}

export function drawAll() {
  return PIXEL_CASES.map(({ name, draw }) => {
    const canvas = document.createElement('canvas');
    draw(canvas);
    return { name, canvas };
  });
}

if (typeof globalThis.submitGpuCommands === 'function') {
  await loadFonts();
  for (const { name, canvas } of drawAll()) {
    const bitmap = await createImageBitmap(await (await fetch(new URL(`${name}.png`, FIXTURES).href)).blob(), { colorSpaceConversion: 'none' });
    const ours = canvas.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height).data;
    const edge = bitmap[Symbol.for('threejsc.pixels')].data;
    let difference = 0;
    let oursCoverage = 0;
    let edgeCoverage = 0;
    for (let i = 0; i < ours.length; i += 4) {
      for (let c = 0; c < 4; c++) difference += Math.abs(ours[i + c] - edge[i + c]);
      oursCoverage += ours[i] + ours[i + 1] + ours[i + 2];
      edgeCoverage += edge[i] + edge[i + 1] + edge[i + 2];
    }
    const size = `${canvas.width}x${canvas.height}`;
    const edgeSize = `${bitmap.width}x${bitmap.height}`;
    console.log(`P ${JSON.stringify({ name, size, edgeSize, mean: difference / (ours.length * 255), coverage: oursCoverage / edgeCoverage })}`);
  }
}
