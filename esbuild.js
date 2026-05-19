const esbuild = require('esbuild');
const { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const watch = process.argv.includes('--watch');
const distDir = path.join(__dirname, 'dist');

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

function cleanDist() {
  rmSync(distDir, { recursive: true, force: true });
}

// Convert the YAML rate card to JSON at build time so the runtime bundle has
// no dependency on js-yaml. The YAML on disk stays the byte-identical upstream
// mirror (data/models-and-pricing.yml); only the bundled artifact is JSON.
function buildRateCard() {
  mkdirSync(distDir, { recursive: true });
  const yamlSrc = path.join(__dirname, 'data', 'models-and-pricing.yml');
  if (!existsSync(yamlSrc)) {
    console.warn('Warning: models-and-pricing.yml not found at', yamlSrc, '— run npm run update-rates');
    return;
  }
  const raw = readFileSync(yamlSrc, 'utf-8');
  const parsed = yaml.load(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`models-and-pricing.yml: expected a YAML array, got ${typeof parsed}`);
  }
  const jsonOut = path.join(distDir, 'models-and-pricing.json');
  writeFileSync(jsonOut, JSON.stringify(parsed) + '\n');
  console.log(`Converted ${path.basename(yamlSrc)} -> ${path.basename(jsonOut)} (${parsed.length} entries)`);
}

async function main() {
  cleanDist();
  if (watch) {
    buildRateCard();
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    buildRateCard();
    console.log('Build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
