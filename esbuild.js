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

function copyRateCard() {
  mkdirSync('dist', { recursive: true });
  const yamlSrc = path.join(__dirname, 'data', 'models-and-pricing.yml');
  if (existsSync(yamlSrc)) {
    copyFileSync(yamlSrc, path.join(__dirname, 'dist', 'models-and-pricing.yml'));
    console.log('Copied models-and-pricing.yml to dist/');
  } else {
    console.warn('Warning: models-and-pricing.yml not found at', yamlSrc, '— run npm run update-rates');
  }
}

async function main() {
  if (watch) {
    copyWasm();
    copyRateCard();
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    copyWasm();
    copyRateCard();
    console.log('Build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
