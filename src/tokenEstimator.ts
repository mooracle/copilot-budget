import * as path from 'path';
import * as fs from 'fs';

interface EstimatorsData {
  estimators: Record<string, number>;
  premiumMultipliers: Record<string, number>;
}

const DEFAULT_RATIO = 0.25;
const DEFAULT_PREMIUM_MULTIPLIER = 1;
export const PREMIUM_REQUEST_COST = 0.04;

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

export function estimateTokensFromText(
  text: string,
  model: string = 'gpt-4',
): number {
  let tokensPerChar = DEFAULT_RATIO;
  let bestMatchLen = 0;

  for (const [modelKey, ratio] of Object.entries(estimators)) {
    if (model.includes(modelKey) || model.includes(modelKey.replace(/-/g, ''))) {
      if (modelKey.length > bestMatchLen) {
        bestMatchLen = modelKey.length;
        tokensPerChar = ratio;
      }
    }
  }

  return Math.ceil(text.length * tokensPerChar);
}

export function getPremiumMultiplier(model: string): number {
  let multiplier = DEFAULT_PREMIUM_MULTIPLIER;
  let bestMatchLen = 0;

  for (const [modelKey, mult] of Object.entries(premiumMultipliers)) {
    if (model.includes(modelKey) || model.includes(modelKey.replace(/-/g, ''))) {
      if (modelKey.length > bestMatchLen) {
        bestMatchLen = modelKey.length;
        multiplier = mult;
      }
    }
  }

  return multiplier;
}
