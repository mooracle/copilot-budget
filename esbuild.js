const esbuild = require('esbuild');
const { copyFileSync, mkdirSync, existsSync } = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
};

function copyWasm() {
  mkdirSync('dist', { recursive: true });
  const wasmSrc = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  if (existsSync(wasmSrc)) {
    copyFileSync(wasmSrc, path.join(__dirname, 'dist', 'sql-wasm.wasm'));
    console.log('Copied sql-wasm.wasm to dist/');
  } else {
    console.warn('Warning: sql-wasm.wasm not found at', wasmSrc, '— run npm install first');
  }
}

async function main() {
  if (watch) {
    copyWasm();
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    copyWasm();
    console.log('Build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
