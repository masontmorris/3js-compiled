// Writes crates/host/tests/fixtures/color/reference.json: for each fixture from color_fixtures.py, the RGBA8 Edge
// gives at the center of each 16x16 block on the three paths three.js uses to upload an image: an image element,
// createImageBitmap with colorSpaceConversion 'default', and with 'none', as ImageBitmapLoader passes it. Each is
// copied with copyExternalImageToTexture into an rgba8unorm texture and read back. It drives the GPU, so run it
// under the lease: `node tools/platform/color-reference.mjs`.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const dir = 'crates/host/tests/fixtures/color';
const files = (await readdir(dir)).filter(name => /\.(png|jpg|webp)$/.test(name)).sort();
const profile = await mkdtemp(join(tmpdir(), 'threejsc-edge-'));
const timeout = setTimeout(() => { console.error('color-reference: Edge did not finish within 5 minutes'); process.exit(1); }, 300_000);
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, timeout: 60_000, args: ['--enable-unsafe-webgpu', '--enable-gpu'] });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.route('https://reference.test/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (!name) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' });
    route.fulfill({ status: 200, contentType: { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[name.split('.').pop()], body: await readFile(join(dir, name)) });
  });
  await page.goto('https://reference.test/');
  const result = await page.evaluate(async files => {
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const read = async source => {
      const texture = device.createTexture({ size: [64, 32], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT });
      device.queue.copyExternalImageToTexture({ source }, { texture, premultipliedAlpha: false }, [64, 32]);
      const buffer = device.createBuffer({ size: 256 * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [64, 32]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(buffer.getMappedRange());
      const samples = [];
      for (let block = 0; block < 8; block++) {
        const x = (block % 4) * 16 + 8;
        const y = Math.floor(block / 4) * 16 + 8;
        samples.push([...bytes.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4)]);
      }
      buffer.unmap();
      return samples;
    };
    const out = {};
    for (const name of files) {
      const blob = await (await fetch(name)).blob();
      const image = new Image();
      image.src = name;
      await image.decode();
      out[name] = {
        image: await read(image),
        bitmapDefault: await read(await createImageBitmap(blob, { colorSpaceConversion: 'default', premultiplyAlpha: 'none' })),
        bitmapNone: await read(await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })),
      };
    }
    return { userAgent: navigator.userAgent, samples: out };
  }, files);
  await writeFile(join(dir, 'reference.json'), JSON.stringify(result, null, 1) + '\n');
  for (const [name, paths] of Object.entries(result.samples)) {
    console.log(name, Object.entries(paths).map(([path, samples]) => `${path} ${samples.slice(0, 3).map(s => s.slice(0, 3).join(',')).join(' ')}`).join(' | '));
  }
} finally {
  clearTimeout(timeout);
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
