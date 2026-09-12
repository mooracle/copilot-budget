#!/usr/bin/env node
// rate-card-changelog.mjs — describe a rate-card change as a CHANGELOG entry.
//
// Compares two copies of data/models-and-pricing.yml (old vs new) and prints a
// Keep-a-Changelog section listing models added, repriced, and retired. Used by
// .github/workflows/rate-card-sync.yml to write the entry for the patch release
// it cuts, and handy by hand after `npm run update-rates`:
//
//   git show HEAD:data/models-and-pricing.yml > /tmp/old.yml
//   node scripts/rate-card-changelog.mjs /tmp/old.yml data/models-and-pricing.yml 2.1.4
//
// With --write, the section is spliced into CHANGELOG.md: an existing
// `## [Unreleased]` heading is renamed to the new version (so notes a human
// parked there ship with the release) and the rate-card section is appended to
// it; otherwise a fresh entry is inserted above the newest release.
//
// Only Default-tier rows are compared — that is what the extension prices with
// (see buildRateMap in src/tokenRates.ts). Footnote markers on model names are
// stripped the same way normalizeModelId does.
import fs from 'node:fs';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const write = args.includes('--write');
const [oldPath, newPath, version] = args.filter((a) => a !== '--write');
if (!oldPath || !newPath || !version) {
  console.error('usage: rate-card-changelog.mjs <old.yml> <new.yml> <version> [--write]');
  process.exit(2);
}

function load(p) {
  const rows = yaml.load(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(rows)) throw new Error(`${p}: expected a YAML array`);
  const map = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object' || typeof r.model !== 'string') continue;
    if (r.tier !== undefined && r.tier !== 'Default') continue;
    const name = r.model.replace(/\[\^[^\]]+\]/g, '').trim();
    if (!map.has(name)) map.set(name, r);
  }
  return map;
}

// Mirror parsePrice in src/tokenRates.ts: "$1.25" → 1.25; anything else
// ("Not applicable", absent) → null, which the extension treats as "fall back
// to the input rate". So `cache_write: Not applicable` appearing on a row is
// not a price change.
function usd(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = parseFloat(v.trim().replace(/^\$/, ''));
  return Number.isFinite(n) ? n : null;
}
const price = (r) => {
  const cw = usd(r.cache_write);
  return `${r.input} / ${r.cached_input} / ${r.output}` + (cw === null ? '' : ` / cache write $${cw}`);
};
const priceKey = (r) => [usd(r.input), usd(r.cached_input), usd(r.output), usd(r.cache_write)].join('|');
const code = (s) => '`' + s + '`';

const oldCard = load(oldPath);
const newCard = load(newPath);

const added = [...newCard.keys()].filter((k) => !oldCard.has(k));
const removed = [...oldCard.keys()].filter((k) => !newCard.has(k));
const repriced = [...newCard.keys()].filter((k) => oldCard.has(k) && priceKey(oldCard.get(k)) !== priceKey(newCard.get(k)));

const today = new Date().toISOString().slice(0, 10);
const lines = [];
lines.push(`## [${version}] - ${today}`);
lines.push('');
const summary = [];
if (added.length) summary.push(`${added.length} newly priced`);
if (repriced.length) summary.push(`${repriced.length} repriced`);
if (removed.length) summary.push(`${removed.length} retired`);
lines.push(
  `Rate card refreshed from \`github/docs\` upstream (${summary.join(', ') || 'no priced-model changes'}; ` +
    `${oldCard.size} → ${newCard.size} priced models). Released automatically by \`rate-card-sync.yml\`.`,
);
lines.push('');
lines.push('### Changed');
lines.push('');
lines.push('- **Rate card refreshed** — `data/models-and-pricing.yml` re-mirrored from upstream.');
if (added.length) {
  lines.push(`  - Added: ${added.join(', ')}.`);
}
if (repriced.length) {
  const parts = repriced.map((k) => `${k} ${code(price(oldCard.get(k)))} → ${code(price(newCard.get(k)))}`);
  lines.push(`  - Repriced: ${parts.join('; ')} (input / cached input / output per 1M tokens, USD).`);
}
if (removed.length) {
  lines.push(
    `  - **Retired upstream: ${removed.join(', ')}.** GitHub dropped these from the published pricing table, ` +
      'so they now resolve to zero cost rather than a stale rate. Tokens are still counted; only costing is skipped.',
  );
}
lines.push('');
const section = lines.join('\n');

if (!write) {
  process.stdout.write(section + '\n');
  process.exit(0);
}

const changelogPath = 'CHANGELOG.md';
let changelog = fs.readFileSync(changelogPath, 'utf8');
const unreleased = /^## \[Unreleased\][^\n]*\n/m;
if (unreleased.test(changelog)) {
  // Rename the parked heading and append the rate-card section to its body,
  // i.e. just before the next `## [` heading (or EOF).
  changelog = changelog.replace(unreleased, `## [${version}] - ${today}\n`);
  const start = changelog.indexOf(`## [${version}]`);
  const next = changelog.indexOf('\n## [', start + 1);
  const body = lines.slice(2).join('\n') + '\n';
  changelog = next === -1 ? changelog.trimEnd() + '\n\n' + body : changelog.slice(0, next + 1) + body + '\n' + changelog.slice(next + 1);
} else {
  const firstRelease = changelog.search(/^## \[/m);
  if (firstRelease === -1) throw new Error('CHANGELOG.md: no release heading found');
  changelog = changelog.slice(0, firstRelease) + section + '\n' + changelog.slice(firstRelease);
}
fs.writeFileSync(changelogPath, changelog);
console.log(`CHANGELOG.md: added ${version} (added ${added.length}, repriced ${repriced.length}, retired ${removed.length})`);
