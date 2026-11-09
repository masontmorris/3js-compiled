import { build } from 'esbuild';

await build({
  entryPoints: ['examples/scenes/src/app.js'],
  outfile: 'examples/scenes/scene-bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  loader: { '.glb': 'binary' },
});
