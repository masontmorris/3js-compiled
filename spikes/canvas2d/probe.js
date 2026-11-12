const fonts = new URL('../../examples/canvas2d/fonts/', import.meta.url);
document.fonts.add(await new FontFace('Amatic SC', `url(${new URL('AmaticSC-Bold.ttf', fonts).href})`, { weight: '700' }).load());
const c = document.createElement('canvas').getContext('2d');
const out = {};
for (const [text, family] of [['สวัสดี', 'Tahoma'], ['Καλημέρα', 'Times New Roman'], ['नमस्ते', 'Nirmala UI'], ['こんにちは', 'Yu Gothic'], ['你好世界', 'Microsoft YaHei'], ['مرحبا', 'Times New Roman']]) {
  for (const font of [`700 64px "Amatic SC"`, `400 64px "${family}"`, `700 64px "${family}"`, `600 64px "${family}"`]) { c.font = font; out[`${text} ${font}`] = c.measureText(text).width; }
}
globalThis.__result = out;
if (typeof globalThis.submitGpuCommands === 'function') console.log(`P ${JSON.stringify(out)}`);
