// Loads files through three's own FileLoader and ImageBitmapLoader, which pass an AbortSignal to fetch.
import { FileLoader, ImageBitmapLoader } from '../../../node_modules/three/build/three.module.js';

const results = [];
try {
  const json = await new FileLoader().setResponseType('json').loadAsync('fixtures/data.json');
  results.push(`R json: ${JSON.stringify(json)}`);
  const bytes = await new FileLoader().setResponseType('arraybuffer').loadAsync('fixtures/alpha.png');
  results.push(`R arraybuffer: ${bytes.byteLength}`);
  const bitmap = await new ImageBitmapLoader().setOptions({ imageOrientation: 'flipY' }).loadAsync('fixtures/alpha.png');
  results.push(`R bitmap: ${bitmap.width}x${bitmap.height}`);
  await new FileLoader().loadAsync('fixtures/missing.json').catch(error => results.push(`R missing: ${error.name} ${error.response?.status}`));
} catch (error) {
  results.push(`R error: ${error}`);
}
for (const line of results) console.log(line);
setClearColor(0, 1, 0, 1);
