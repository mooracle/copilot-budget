import * as path from 'path';
import * as fs from 'fs';

interface EstimatorsData {
  estimators: Record<string, number>;
  premiumMultipliers: Record<string, number>;
}

const DEFAULT_RATIO = 0.25;
const DEFAULT_PREMIUM_MULTIPLIER = 1;

// Load estimators once at module level
const dataPath = path.join(__dirname, '..', 'data', 'tokenEstimators.json');
let estimators: Record<string, number> = {};
let premiumMultipliers: Record<string, number> = {};
try {
  const raw = fs.readFileSync(dataPath, 'utf-8');
  const data: EstimatorsData = JSON.parse(raw);
  estimators = data.estimators;
  premiumMultipliers = data.premiumMultipliers ?? {};
} catch {
  // Fallback: use defaults only
}

function findBestMatch<T>(record: Record<string, T>, model: string, fallback: T): T {
  let best = fallback;
  let bestLen = 0;

  for (const [key, value] of Object.entries(record)) {
    if (model.includes(key) || model.includes(key.replace(/-/g, ''))) {
      if (key.length > bestLen) {
        bestLen = key.length;
        best = value;
      }
    }
  }

  return best;
}

export function estimateTokensFromText(
  text: string,
  model: string = 'gpt-4',
): number {
  const tokensPerChar = findBestMatch(estimators, model, DEFAULT_RATIO);
  return Math.ceil(text.length * tokensPerChar);
}

export function getPremiumMultiplier(model: string): number {
  return findBestMatch(premiumMultipliers, model, DEFAULT_PREMIUM_MULTIPLIER);
}
