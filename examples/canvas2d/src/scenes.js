// The canvas 2D example's scenes. Each draws its 2D canvases, shows them with `show(canvas, x, y)` and logs `R`
// lines with `log`, and may return a function to run every frame.
import { FOLIO_CANVASES } from './folio-canvases.js';

const round = value => Math.round(value * 1000) / 1000;

function metrics(context, text) {
  const m = context.measureText(text);
  return ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent', 'fontBoundingBoxAscent', 'fontBoundingBoxDescent', 'hangingBaseline', 'alphabeticBaseline', 'ideographicBaseline']
    .map(key => `${key}=${round(m[key])}`).join(' ');
}

function textCanvas(width, height, draw) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  const context = element.getContext('2d');
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  draw(context, element);
  return element;
}

export const SCENES = {
  // folio's ten canvases, as folio draws them.
  folio({ show, log }) {
    let x = 10;
    let y = 10;
    let rowHeight = 0;
    for (const { name, draw } of FOLIO_CANVASES) {
      const element = document.createElement('canvas');
      const context = draw(element);
      if (x + element.width > innerWidth - 10) { x = 10; y += rowHeight + 10; rowHeight = 0; }
      show(element, x, y);
      log(`${name} ${element.width}x${element.height} font=${context.font}`);
      x += element.width + 10;
      rowHeight = Math.max(rowHeight, element.height);
    }
    const pally = textCanvas(500, 64, context => {
      context.font = '700 40px Pally';
      context.textBaseline = 'middle';
      context.fillText('Bruno Simon, Pally', 10, 32);
    });
    show(pally, 10, innerHeight - 74);
  },
  pally({ show, log }) {
    [400, 500, 700].forEach((weight, i) => {
      const element = textCanvas(620, 80, context => {
        context.font = `${weight} 48px Pally`;
        context.textBaseline = 'middle';
        context.fillText(`Pally ${weight}: Welcome!`, 10, 40);
        log(`pally ${weight} font=${context.font} ${metrics(context, `Pally ${weight}: Welcome!`)}`);
      });
      show(element, 20, 20 + i * 100);
    });
  },
  amatic({ show, log }) {
    [['Achievements', 64], ['Three.js Journey', 80], ['threejs-journey.com', 46], ['Hey! Watch where you are going!', 36]].forEach(([text, size], i) => {
      const element = textCanvas(820, Math.ceil(size * 1.5), (context, canvas) => {
        context.font = `700 ${size}px "Amatic SC"`;
        context.textBaseline = 'middle';
        context.fillText(text, 12, canvas.height / 2 + 2);
        log(`amatic ${size} ${metrics(context, text)}`);
      });
      show(element, 20, 20 + [0, 110, 240, 320][i]);
    });
  },
  sizes({ show, log }) {
    [12, 24, 64].forEach((size, i) => {
      const element = textCanvas(900, Math.ceil(size * 1.6), context => {
        context.font = `700 ${size}px Nunito`;
        context.textBaseline = 'alphabetic';
        context.fillText('Nunito 00:41:337 Leaderboard', 8, Math.round(size * 1.2));
        log(`nunito ${size} ${metrics(context, 'Nunito 00:41:337 Leaderboard')}`);
      });
      show(element, 20, 20 + [0, 50, 110][i]);
    });
  },
  align({ show, log }) {
    const aligns = ['start', 'end', 'left', 'right', 'center'];
    const baselines = ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'];
    const element = textCanvas(1000, 600, context => {
      context.font = '700 30px Nunito';
      aligns.forEach((align, column) => baselines.forEach((baseline, row) => {
        const x = 100 + column * 200;
        const y = 50 + row * 95;
        context.fillStyle = '#ff3030';
        context.fillRect(x - 0.5, y - 20, 1, 40);
        context.fillRect(x - 20, y - 0.5, 40, 1);
        context.fillStyle = '#ffffff';
        context.textAlign = align;
        context.textBaseline = baseline;
        context.fillText('Ág', x, y);
        log(`align ${align} ${baseline} ${metrics(context, 'Ág')}`);
      }));
    });
    show(element, 10, 10);
  },
  emoji({ show, log }) {
    const element = textCanvas(700, 100, context => {
      context.font = '700 56px "Amatic SC"';
      context.textBaseline = 'middle';
      context.fillText('Hi 👋 🎉 ✨ 🏎️', 12, 52);
      log(`emoji ${metrics(context, 'Hi 👋 🎉 ✨ 🏎️')}`);
    });
    show(element, 20, 20);
  },
  async image({ show, log }) {
    const image = new Image();
    image.src = new URL('../../platform/assets/alpha.png', import.meta.url).href;
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    const element = textCanvas(600, 300, context => {
      context.drawImage(image, 20, 20, 256, 256);
      context.drawImage(image, 64, 64, 128, 128, 300, 20, 280, 140);
      context.globalAlpha = 0.5;
      context.drawImage(image, 300, 170, 120, 120);
      context.globalAlpha = 1;
      context.font = '700 64px "Amatic SC"';
      context.textBaseline = 'middle';
      context.fillStyle = '#ffe14a';
      context.fillText('Under the text', 40, 150);
    });
    log(`image ${image.width}x${image.height}`);
    show(element, 20, 20);
  },
  fills({ show, log }) {
    const element = textCanvas(640, 400, context => {
      const linear = context.createLinearGradient(20, 0, 300, 0);
      linear.addColorStop(0, '#ffb646');
      linear.addColorStop(0.5, '#ff347e');
      linear.addColorStop(1, '#01005f');
      context.fillStyle = linear;
      context.fillRect(20, 20, 280, 160);
      const radial = context.createRadialGradient(470, 100, 10, 470, 100, 90);
      radial.addColorStop(0, 'white');
      radial.addColorStop(0.4, 'rgba(91, 194, 185, 0.8)');
      radial.addColorStop(1, 'rgba(19, 55, 95, 0)');
      context.fillStyle = radial;
      context.fillRect(370, 10, 200, 190);
      context.globalAlpha = 0.5;
      context.fillStyle = '#ff0000';
      context.fillRect(40, 220, 200, 120);
      context.fillStyle = 'hsl(220, 90%, 60%)';
      context.fillRect(140, 260, 200, 120);
      context.globalAlpha = 1;
      context.save();
      context.translate(480, 300);
      context.rotate(Math.PI / 8);
      context.fillStyle = 'rgba(255, 255, 0, 0.7)';
      context.fillRect(-60, -40, 120, 80.5);
      context.restore();
      context.clearRect(250.5, 120.5, 60, 40);
    });
    show(element, 20, 20);
  },
  resize({ show, log }) {
    const element = textCanvas(256, 64, context => {
      context.font = '700 48px "Amatic SC"';
      context.textBaseline = 'middle';
      context.fillText('First size', 10, 34);
    });
    const shown = show(element, 20, 20);
    let frames = 0;
    return () => {
      if (++frames !== 30) return;
      element.width = 400;
      element.height = 120;
      const context = element.getContext('2d');
      context.font = '700 72px "Amatic SC"';
      context.textBaseline = 'middle';
      context.fillStyle = '#20a0ff';
      context.fillText('Second size', 14, 62);
      shown.texture.needsUpdate = true;
      shown.place();
      log(`resized ${element.width}x${element.height} font=${context.font} fill=${context.fillStyle}`);
    };
  },
  dynamic({ show, log }) {
    const element = document.createElement('canvas');
    const context = element.getContext('2d');
    element.width = 192;
    element.height = 32;
    context.font = '700 32px "Nunito"';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const shown = show(element, 20, 20);
    let frames = 0;
    const times = [];
    return () => {
      frames++;
      const start = performance.now();
      context.fillStyle = '#000000';
      context.fillRect(0, 0, 192, 32);
      context.fillStyle = '#ffffff';
      context.fillText(String(frames).padStart(6, '0'), 96, 16);
      times.push(performance.now() - start);
      shown.texture.needsUpdate = true;
      if (frames % 300 === 0) {
        const sorted = [...times].sort((a, b) => a - b);
        log(`dynamic frames=${frames} draw median ms=${round(sorted[sorted.length >> 1])} p95 ms=${round(sorted[Math.floor(sorted.length * 0.95)])} max ms=${round(sorted.at(-1))}`);
        times.length = 0;
      }
      globalThis.__frameNumber = frames;
    };
  },
  // Draws folio's ten canvases at load, timed, then again warm.
  perf({ show, log }) {
    for (let run = 0; run < 6; run++) {
      const start = performance.now();
      const drawn = FOLIO_CANVASES.map(({ draw }) => { const element = document.createElement('canvas'); draw(element); return element; });
      const elapsed = performance.now() - start;
      log(`perf load run=${run} ms=${round(elapsed)} canvases=${drawn.length}`);
      if (run === 0) drawn.forEach((element, i) => show(element, 10 + (i % 3) * 420, 10 + Math.floor(i / 3) * 140));
    }
  },
};
