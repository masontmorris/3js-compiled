// Lane 6: Howler 2.2.4 making folio's calls on a clip loaded through XMLHttpRequest: a pool of 2, rate, pos, volume,
// mute, Howler.mute, fade and loop. A key press runs Howler's unlock. Each Howler event and each change of
// Howler.ctx.state logs one `H <what>` line, and each play() logs the context time it was called at, as
// `H play-call <n> <currentTime>`, so a capture shows where each sound should start. `H done` ends the run.
import { Howl, Howler } from 'howler';

const lines = [];
const log = line => { lines.push(line); console.log(`H ${line}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchContext = () => {
  const ctx = Howler.ctx;
  if (!ctx || ctx.watched) return;
  ctx.watched = true;
  log(`ctx ${ctx.state}`);
  ctx.addEventListener('statechange', () => log(`ctx statechange ${ctx.state}`));
};

const ids = [];
const name = id => `#${ids.indexOf(id)}`;
const sound = new Howl({
  src: [new URL('clips/tone-stereo-44100.mp3', location.href).href],
  format: ['mp3'],
  pool: 2,
  onload: () => log('load'),
  onloaderror: (_, error) => log(`loaderror ${error}`),
  onplayerror: (id, error) => log(`playerror ${name(id)} ${error}`),
  onplay: id => log(`play ${name(id)}`),
  onend: id => log(`end ${name(id)}`),
  onpause: id => log(`pause ${name(id)}`),
  onstop: id => log(`stop ${name(id)}`),
  onmute: id => log(`mute ${name(id)}`),
  onvolume: id => log(`volume ${name(id)}`),
  onrate: id => log(`rate ${name(id)}`),
  onfade: id => log(`fade ${name(id)}`),
  onunlock: () => log('unlock'),
});
watchContext();

await new Promise(resolve => (sound.state() === 'loaded' ? resolve() : sound.once('load', resolve)));
log(`unlocked before key ${Howler._audioUnlocked}`);
// The driver presses a key once the page logs this line.
log('press a key');
await new Promise(resolve => sound.once('unlock', resolve));
watchContext();
log(`codecs mp3 ${Howler.codecs('mp3')} ogg ${Howler.codecs('ogg')} opus ${Howler.codecs('opus')}`);

const play = (...args) => {
  const time = Howler.ctx.currentTime;
  const id = sound.play(...args);
  if (!ids.includes(id)) ids.push(id);
  log(`play-call ${name(id)} ${time.toFixed(4)}`);
  return id;
};

const first = play();
sound.rate(1.5, first);
sound.pos(2, 0, -1, first);
sound.volume(0.5, first);
await wait(1000);
const second = play();
sound.fade(1, 0, 300, second);
await wait(1000);
const third = play();
sound.mute(true, third);
sound.mute(false, third);
await wait(1000);
Howler.mute(true);
Howler.mute(false);
const fourth = play();
sound.loop(true, fourth);
await wait(1200);
sound.stop(fourth);
log(`pool ${sound._sounds.length}`);
await wait(300);
log('done');
