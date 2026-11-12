// The order of input listeners and the promise jobs they queue, which Edge interleaves.
const key = [];
const pointer = [];
addEventListener('keydown', () => { key.push('keydown-A'); Promise.resolve().then(() => key.push('keydown-A-job')); });
addEventListener('keydown', () => key.push('keydown-B'));
for (const type of ['pointerdown', 'pointerup']) addEventListener(type, () => { pointer.push(type); Promise.resolve().then(() => pointer.push(`${type}-job`)); });
for (const type of ['mousedown', 'mouseup']) addEventListener(type, () => pointer.push(type));
globalThis.__report = () => {
  console.log(`R jobs-key: ${key.join('|')}`);
  console.log(`R jobs-pointer: ${pointer.join('|')}`);
};
