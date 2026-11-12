// Copies of the drawing code behind folio-2025's ten canvas textures, one function per source. Each takes the
// canvas to draw on and the text to draw, and draws as folio does. Paths are relative to folio's `sources/Game`.

// TextCanvas.js, as LabArea.js:602 and ProjectsArea.js:900 create it for a title.
function textCanvas(canvas, lines, { fontSize, width, height, density = 200, align = 'center', lineHeight = 1 }) {
  const font = `700 ${fontSize * density}px "Amatic SC"`;
  canvas.width = Math.ceil(width * density);
  canvas.height = Math.ceil(height * density);
  const context = canvas.getContext('2d');
  context.font = font;
  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textAlign = align;
  context.textBaseline = 'middle';
  context.fillStyle = '#ffffff';
  const step = lineHeight * density;
  lines.forEach((line, i) => {
    const y = canvas.height / 2 + (i - (lines.length - 1) / 2) * step;
    const x = align === 'center' ? canvas.width / 2 : align === 'left' ? 0 : canvas.width;
    context.fillText(line, x, y);
  });
  return context;
}

// InteractivePoints.js:212, a label whose width follows measureText.
function interactiveLabel(canvas, text) {
  const height = 64;
  const textPaddingLeft = 12;
  const textPaddingRight = 60;
  const font = `700 ${height}px "Amatic SC"`;
  const context = canvas.getContext('2d');
  context.font = font;
  const textSize = context.measureText(text);
  const width = Math.ceil(textSize.width) + textPaddingLeft + textPaddingRight + 2;
  canvas.width = width;
  canvas.height = height;
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  context.font = font;
  context.fillStyle = '#ffffff';
  context.textAlign = 'start';
  context.textBaseline = 'middle';
  context.fillText(text, textPaddingLeft + 1, height * 0.5 + 2);
  return context;
}

// World/Bubble.js:23 and :233.
function bubble(canvas, text) {
  const height = 64;
  canvas.width = height * 16;
  canvas.height = height;
  const font = `700 ${height}px "Amatic SC"`;
  const context = canvas.getContext('2d');
  context.font = font;
  context.measureText(text);
  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = font;
  context.fillStyle = '#ffffff';
  context.textAlign = 'start';
  context.textBaseline = 'middle';
  context.fillText(text, 10 + 1, height * 0.5 + 2);
  return context;
}

// World/Areas/CircuitArea.js:162 and :207, the race timer digits.
function timer(canvas, text) {
  const height = 32;
  const font = `700 ${height}px "Nunito"`;
  const context = canvas.getContext('2d');
  context.font = font;
  canvas.width = height * 6;
  canvas.height = height;
  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = font;
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('00:00:000', height * 3, height * 0.5);
  context.fillStyle = '#000000';
  context.fillRect(0, 0, height * 6, height);
  context.fillStyle = '#ffffff';
  context.fillText(text, height * 3, height * 0.5);
  return context;
}

// World/Areas/CircuitArea.js:797 and :857, the leaderboard, with the scores it shows and no flags.
function leaderboard(canvas, scores) {
  const resolution = 512;
  const font = `700 ${resolution / 14}px "Nunito"`;
  const context = canvas.getContext('2d');
  context.font = font;
  canvas.width = resolution;
  canvas.height = resolution;
  const columns = [
    { align: 'right', x: resolution * 0.125 },
    { x: resolution * 0.19 },
    { align: 'center', x: resolution * 0.43 },
    { align: 'left', x: resolution * 0.725 },
  ];
  const interline = resolution / 12;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = font;
  context.fillStyle = '#ffffff';
  context.textBaseline = 'middle';
  let rank = 1;
  for (const score of scores) {
    context.textAlign = columns[0].align;
    context.fillText(rank, columns[0].x, (rank + 0.5) * interline);
    context.textAlign = columns[2].align;
    context.fillText(score[0], columns[2].x, (rank + 0.5) * interline);
    context.textAlign = columns[2].align;
    context.fillText(score[1], columns[3].x, (rank + 0.5) * interline);
    rank++;
  }
  return context;
}

// World/Areas/CircuitArea.js:990 and :1078, the time to the leaderboard reset.
function resetTime(canvas, text) {
  const width = 128;
  const height = 32;
  const font = `700 ${height / 1.75}px "Nunito"`;
  const context = canvas.getContext('2d');
  context.font = font;
  canvas.width = width;
  canvas.height = height;
  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = font;
  context.fillText(text, canvas.width * 0.5, canvas.height * 0.5);
  return context;
}

// World/Areas/CookieArea.js:307 and :378, the cookie counter.
function cookieCounter(canvas, value) {
  const height = 64;
  const font = `700 ${height}px "Amatic SC"`;
  const context = canvas.getContext('2d');
  context.font = font;
  canvas.width = 256;
  canvas.height = height;
  const text = value.toLocaleString('en-US');
  context.measureText(text);
  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = font;
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height * 0.5 + 2);
  return context;
}

// World/Areas/AltarArea.js:350 and :466, the altar counter, stroked in red under a green fill.
function altar(canvas, text) {
  const width = 256;
  const height = width / 4;
  const font = `700 ${height}px "Amatic SC"`;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.font = font;
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  context.font = font;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.strokeStyle = '#ff0000';
  context.lineWidth = height * 0.15;
  context.strokeText(text, width * 0.5, height * 0.55);
  context.fillStyle = '#00ff00';
  context.fillText(text, width * 0.5, height * 0.55);
  return context;
}

// Materials.js:44 and Terrain.js:33, a one-pixel-wide vertical gradient.
function gradient(canvas, colors) {
  const height = 16;
  canvas.width = 1;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const fill = context.createLinearGradient(0, 0, 0, height);
  for (const color of colors) fill.addColorStop(color.stop, color.value);
  context.fillStyle = fill;
  context.fillRect(0, 0, 1, height);
  return context;
}

// The ten sources, each with the content folio draws first or most often.
export const FOLIO_CANVASES = [
  { name: 'text-title', source: 'TextCanvas.js:18', draw: canvas => textCanvas(canvas, ['Three.js Journey'], { fontSize: 0.4, width: 4, height: 0.6 }) },
  { name: 'label', source: 'InteractivePoints.js:212', draw: canvas => interactiveLabel(canvas, 'Achievements') },
  { name: 'bubble', source: 'World/Bubble.js:23', draw: canvas => bubble(canvas, 'Hey! Watch where you are going!') },
  { name: 'timer', source: 'World/Areas/CircuitArea.js:162', draw: canvas => timer(canvas, '01:23:456') },
  { name: 'leaderboard', source: 'World/Areas/CircuitArea.js:797', draw: canvas => leaderboard(canvas, [['BRUNO', '00:41:337'], ['ANA', '00:44:019'], ['MAX', '00:52:880']]) },
  { name: 'reset-time', source: 'World/Areas/CircuitArea.js:990', draw: canvas => resetTime(canvas, 'in 3h 12m') },
  { name: 'cookie', source: 'World/Areas/CookieArea.js:307', draw: canvas => cookieCounter(canvas, 1234567) },
  { name: 'altar', source: 'World/Areas/AltarArea.js:350', draw: canvas => altar(canvas, '42') },
  { name: 'gradient-materials', source: 'Materials.js:44', draw: canvas => gradient(canvas, [{ stop: 0, value: '#ffb646' }, { stop: 0.5, value: '#ff347e' }, { stop: 1, value: '#01005f' }]) },
  { name: 'gradient-terrain', source: 'Terrain.js:33', draw: canvas => gradient(canvas, [{ stop: 0.1, value: '#ffa94e' }, { stop: 0.3, value: '#5bc2b9' }, { stop: 0.9, value: '#13375f' }]) },
];

// The other text canvases folio makes from TextCanvas, which the rasterizer spike also compares.
export const TEXT_CANVAS_VARIANTS = [
  { name: 'text-url', source: 'World/Areas/ProjectsArea.js:942', draw: canvas => textCanvas(canvas, ['threejs-journey.com'], { fontSize: 0.23, width: 4, height: 0.2 }) },
  { name: 'text-lab-item', source: 'World/Areas/LabArea.js:891', draw: canvas => textCanvas(canvas, ['Ultra Bowling'], { fontSize: 0.18, width: 1.5, height: 0.2, lineHeight: 0.2 }) },
  { name: 'text-project-item', source: 'World/Areas/ProjectsArea.js:708', draw: canvas => textCanvas(canvas, ['Infinite', 'World'], { fontSize: 0.23, width: 1.4, height: 0.45, lineHeight: 0.2 }) },
  { name: 'text-adjacent', source: 'World/Areas/ProjectsArea.js:781', draw: canvas => textCanvas(canvas, ['Previous', 'project'], { fontSize: 0.3, width: 1.25, height: 0.75, lineHeight: 0.3 }) },
];
