import { readFileSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const shared: Options = {
  platform: 'node',
  target: 'node20',
  // import.meta.url works in the CJS build too (used to locate built-in presets)
  shims: true,
  // sharp stays a real dependency (native binaries); picomatch is tiny and gets bundled in.
  external: ['sharp'],
  noExternal: ['picomatch'],
  define: {
    __VERSION__: JSON.stringify(pkg.version)
  }
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true
  },
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    // the CLI imports the engine from dist/index.js instead of bundling it a second time
    external: ['sharp', './index.js']
  }
]);
