// The canvas text cases canvas2d.test.js checks against Edge. Edge runs them through canvas2d-measure.html to
// record the fixture, and the host runs them headless. Each case logs one `M <json>` line.
const FONTS = new URL('../../../examples/canvas2d/fonts/', import.meta.url);

export const MEASURE_FONTS = ['700 64px "Amatic SC"', '700 46px "Amatic SC"', '700 32px Nunito', '400 24px Nunito', '900 18.2857px Nunito', '700 36.5714px Nunito', '10px sans-serif', '16px serif', '700 20px Arial', '13px monospace', '700 40px "Amatic SC", sans-serif', '700 30px "Not A Font"'];
export const MEASURE_TEXTS = ['Achievements', 'Hey! Watch where you are going!', '00:41:337', '1,234,567', 'Ág', 'fi ffl AV To', '', 'héllo wörld', 'Three.js Journey'];
const ALIGNS = ['start', 'end', 'left', 'right', 'center'];
const BASELINES = ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'];
const KEYS = ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent', 'fontBoundingBoxAscent', 'fontBoundingBoxDescent', 'hangingBaseline', 'alphabeticBaseline', 'ideographicBaseline'];
// What the canvas's getters return after these sets, which Edge serializes.
export const STYLE_INPUTS = ['red', '#F00', '#ff000080', 'rgba(255, 0, 0, 0.5)', 'rgb(10 20 30 / 25%)', 'hsl(120, 100%, 25%)', 'transparent', 'rgba(0,0,0,0.333)', 'not a color', 'rebeccapurple'];
export const FONT_INPUTS = ['700 64px "Amatic SC"', 'bold 12pt Arial', 'italic small-caps 300 2em serif', '18.2857px Nunito', '900 20px/1.5 "Amatic SC", sans-serif', '20px', 'large Nunito', '700 36.571428px Nunito', 'oblique 10px a b c'];

export async function measureAll() {
  const faces = [
    new FontFace('Amatic SC', `url(${new URL('AmaticSC-Bold.ttf', FONTS).href})`, { weight: '700' }),
    new FontFace('Nunito', `url(${new URL('Nunito-wght.ttf', FONTS).href})`, { weight: '200 1000' }),
  ];
  for (const face of faces) document.fonts.add(await face.load());
  const context = document.createElement('canvas').getContext('2d');
  const lines = [];
  const record = (kind, font, text, align, baseline) => {
    context.font = font;
    context.textAlign = align;
    context.textBaseline = baseline;
    const metrics = context.measureText(text);
    lines.push({ kind, font, text, align, baseline, ...Object.fromEntries(KEYS.map(key => [key, metrics[key]])) });
  };
  for (const font of MEASURE_FONTS) for (const text of MEASURE_TEXTS) record('text', font, text, 'start', 'alphabetic');
  for (const font of MEASURE_FONTS.slice(0, 6)) for (const baseline of BASELINES) for (const align of ALIGNS) record('layout', font, 'Ág', align, baseline);
  for (const value of STYLE_INPUTS) {
    context.fillStyle = '#123456';
    context.fillStyle = value;
    lines.push({ kind: 'fillStyle', input: value, value: context.fillStyle });
  }
  for (const value of FONT_INPUTS) {
    context.font = '10px sans-serif';
    context.font = value;
    lines.push({ kind: 'font', input: value, value: context.font });
  }
  return lines;
}

if (typeof globalThis.submitGpuCommands === 'function' || globalThis.__measureNow) {
  for (const line of await measureAll()) console.log(`M ${JSON.stringify(line)}`);
}
