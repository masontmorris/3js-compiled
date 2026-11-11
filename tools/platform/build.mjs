import { build } from 'esbuild';

await build({
  entryPoints: ['examples/platform/src/app.js'],
  outfile: 'examples/platform/platform-bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
