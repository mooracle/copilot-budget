// Convert the YAML fixture (byte-identical mirror of the upstream rate card)
// to the JSON form the runtime loader now expects. Runs once before the test
// suite. Keeps the YAML canonical for upstream-sync diffs while letting the
// production code path stay JSON-only (no js-yaml at runtime).
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

module.exports = async function () {
  const dir = path.join(__dirname, 'src', '__fixtures__');
  const yamlPath = path.join(dir, 'models-and-pricing.yml');
  const jsonPath = path.join(dir, 'models-and-pricing.json');
  const parsed = yaml.load(fs.readFileSync(yamlPath, 'utf-8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`fixture YAML did not parse to an array: ${yamlPath}`);
  }
  fs.writeFileSync(jsonPath, JSON.stringify(parsed) + '\n');
};
