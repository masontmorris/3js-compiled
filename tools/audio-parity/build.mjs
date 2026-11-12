// Bundles the audio examples in examples/audio/src into examples/audio/<name>-bundle.js.
import { build } from 'esbuild';

for (const [entry, out] of [['app', 'audio'], ['stress', 'stress'], ['howler', 'howler']]) {
  await build({ entryPoints: [`examples/audio/src/${entry}.js`], outfile: `examples/audio/${out}-bundle.js`, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
}
