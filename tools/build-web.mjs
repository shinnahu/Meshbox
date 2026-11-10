// Bundles the web UI (three.js included) into src/web/dist/app.js and copies the decoder libraries.
// node tools/build-web.mjs [--dev]
import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const web = join(root, 'src/web');

if (!existsSync(join(web, 'js/vendor/FBXLoader.js'))) await import('./patch-fbxloader.mjs');

const started = Date.now();
await build({
  entryPoints: [join(web, 'js/main.js')],
  bundle: true,
  format: 'esm',
  target: ['chrome110'],
  outfile: join(web, 'dist/app.js'),
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
});

// Draco / Basis decoders are loaded at runtime by GLTFLoader (only for files that use them).
const libs = join(root, 'node_modules/three/examples/jsm/libs');
mkdirSync(join(web, 'assets/draco'), { recursive: true });
mkdirSync(join(web, 'assets/basis'), { recursive: true });
for (const f of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) cpSync(join(libs, 'draco/gltf', f), join(web, 'assets/draco', f));
for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) cpSync(join(libs, 'basis', f), join(web, 'assets/basis', f));
console.log(`web bundle built in ${Date.now() - started} ms${dev ? ' (dev)' : ''}`);
