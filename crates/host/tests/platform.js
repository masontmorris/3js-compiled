// Checks the platform shims inside the host. Each result is one `R` line, and the page turns the clear color
// green once every check has run.
const results = [];
const check = (name, value) => results.push(`R ${name}: ${value}`);

const canvas = document.createElement('canvas');
document.body.append(canvas);
check('canvas fills the window', JSON.stringify(canvas.getBoundingClientRect().width === innerWidth && canvas.clientHeight === innerHeight));
check('location', `${location.protocol} ${location.hash} ${location.pathname.endsWith('/tests/platform.js')}`);
check('matchMedia', `${matchMedia('(min-width: 1000px)').matches} ${matchMedia('(max-width: 1000px)').matches} ${matchMedia('(prefers-color-scheme: dark)').matches}`);
check('navigator', `${navigator.platform} ${/Edg\//.test(navigator.userAgent)} ${navigator.getGamepads().length}`);

const runs = Number(localStorage.getItem('runs') ?? 0) + 1;
localStorage.setItem('runs', String(runs));
localStorage.big = 'x'.repeat(1000);
for (const key of ['c', 'a', 'b']) localStorage.setItem(key, key);
check('localStorage runs', runs);
check('key order', Object.keys(localStorage).filter(key => key.length === 1).join(','));
check('cookie before', JSON.stringify(document.cookie));
document.cookie = `visits=${runs}`;
const random = crypto.getRandomValues(new Uint32Array(8));
check('crypto', `${/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID())} ${new Set(random).size > 1}`);

const order = [];
addEventListener('keydown', event => order.push(`window:${event.key}:${event.isTrusted}`));
document.body.addEventListener('keydown', event => order.push(`body:${event.code}:${event.keyCode}`), true);
addEventListener('pointerdown', event => order.push(`pointerdown:${event.target.localName}:${event.clientX}`));
addEventListener('click', event => order.push(`click:${event.target.localName}`));
addEventListener('resize', () => order.push(`resize:${innerWidth}x${innerHeight}:${matchMedia('(min-width: 1100px)').matches}`));
const wide = matchMedia('(min-width: 1100px)');
wide.addEventListener('change', event => order.push(`media:${event.matches}`));
addEventListener('gamepadconnected', event => order.push(`gamepad:${event.gamepad.id}`));
globalThis.__events = order;

const pending = [];
pending.push(fetch('fixtures/alpha.png').then(response => response.blob()).then(async blob => {
  check('fetch', `${blob.type} ${blob.size}`);
  const bitmap = await createImageBitmap(blob);
  check('createImageBitmap', `${bitmap.width}x${bitmap.height}`);
  const image = new Image();
  const loaded = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
  image.src = URL.createObjectURL(blob);
  await loaded;
  check('image', `${image.naturalWidth}x${image.naturalHeight} ${image.complete}`);
}));
pending.push(fetch('fixtures/missing.png').then(response => check('missing file', `${response.status} ${response.ok}`)));
pending.push(createImageBitmap(new Blob(['not an image'])).catch(error => check('broken image', error.name)));

Promise.all(pending).then(() => {
  canvas.requestFullscreen();
  canvas.requestFullscreen();
  globalThis.__report = () => {
    for (const line of [...results, `R events: ${order.join(' ')}`]) console.log(line);
    setClearColor(0, 1, 0, 1);
  };
});
