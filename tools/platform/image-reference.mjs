// Writes crates/host/tests/fixtures/alpha.png, a PNG with alpha, and alpha.rgba, the RGBA8 bytes Edge's WebGPU
// copyExternalImageToTexture gives for it with premultipliedAlpha false, read back from the texture. It drives the
// GPU, so run it under the lease: `node tools/platform/image-reference.mjs`.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const width = 7;
const height = 5;
const png = new PNG({ width, height, colorType: 6 });
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    png.data.set([(x * 40 + 15) & 255, (y * 60 + 3) & 255, ((x + y) * 31) & 255, [255, 0, 1, 128, 200, 64, 254][x]], i);
  }
}
const bytes = PNG.sync.write(png, { colorType: 6 });
await writeFile('crates/host/tests/fixtures/alpha.png', bytes);
if (process.argv.includes('--png-only')) process.exit(0);

const profile = await mkdtemp(join(tmpdir(), 'threejsc-edge-'));
const timeout = setTimeout(() => { console.error('image-reference: Edge did not finish within 5 minutes'); process.exit(1); }, 300_000);
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, timeout: 60_000, args: ['--enable-unsafe-webgpu', '--enable-gpu'] });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.route('https://reference.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('https://reference.test/');
  const result = await page.evaluate(async ({ data, width, height }) => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const read = async source => {
      const texture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT });
      device.queue.copyExternalImageToTexture({ source }, { texture, premultipliedAlpha: false }, [width, height]);
      const buffer = device.createBuffer({ size: 256 * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const rows = new Uint8Array(buffer.getMappedRange());
      const out = [];
      for (let y = 0; y < height; y++) out.push(...rows.subarray(y * 256, y * 256 + width * 4));
      return out;
    };
    const blob = new Blob([new Uint8Array(data)], { type: 'image/png' });
    const bitmap = await read(await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
    const image = new Image();
    image.src = URL.createObjectURL(blob);
    await image.decode();
    return { bitmap, image: await read(image), userAgent: navigator.userAgent };
  }, { data: [...bytes], width, height });
  const same = result.bitmap.every((value, i) => value === result.image[i]);
  await writeFile('crates/host/tests/fixtures/alpha.rgba', Uint8Array.from(result.bitmap));
  const differ = result.bitmap.filter((value, i) => value !== png.data[i]).length;
  console.log(`${result.userAgent}: bitmap and image ${same ? 'agree' : 'differ'}; ${differ} of ${png.data.length} bytes differ from the encoded pixels`);
} finally {
  clearTimeout(timeout);
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
