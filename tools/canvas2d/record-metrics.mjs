// Records Edge's answers for the canvas text cases in packages/three-native/test/canvas2d-measure.js into the
// fixture canvas2d.test.js compares the host with. Text metrics do not use the GPU, so Edge runs without it.
//   node tools/canvas2d/record-metrics.mjs
import { writeFile } from 'node:fs/promises';
import { withEdge, withTimeout } from './edge.mjs';

const { version, lines } = await withEdge(async (page, origin) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await withTimeout(page.goto(`${origin}/packages/three-native/test/canvas2d-measure.html`), 'goto');
  await withTimeout(page.waitForFunction(() => globalThis.__result || null), 'wait for the cases');
  if (errors.length) throw new Error(errors.join('\n'));
  return { version: await page.evaluate(() => navigator.userAgent), lines: await page.evaluate(() => globalThis.__result) };
}, { gpu: false });
const out = 'packages/three-native/test/fixtures/canvas2d-edge.json';
await writeFile(out, JSON.stringify({ edge: version.match(/Edg\/[\d.]+/)?.[0], recorded: new Date().toISOString().slice(0, 10), lines }, null, 0).replace(/\},\{/g, '},\n{') + '\n');
console.log(`${lines.length} cases from ${version} in ${out}`);
