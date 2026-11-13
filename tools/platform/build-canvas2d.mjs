import { build } from 'esbuild';

await build({
  entryPoints: ['examples/canvas2d/src/app.js'],
  outfile: 'examples/canvas2d/canvas2d-bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
