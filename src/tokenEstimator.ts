import * as path from 'path';
import * as fs from 'fs';

interface EstimatorsData {
  estimators: Record<string, number>;
}

const DEFAULT_RATIO = 0.25;

// Load estimators once at module level
const dataPath = path.join(__dirname, '..', 'data', 'tokenEstimators.json');
let estimators: Record<string, number> = {};
try {
  const raw = fs.readFileSync(dataPath, 'utf-8');
  const data: EstimatorsData = JSON.parse(raw);
  estimators = data.estimators;
} catch {
  // Fallback: use default ratio only
}

export function estimateTokensFromText(
  text: string,
  model: string = 'gpt-4',
): number {
  let tokensPerChar = DEFAULT_RATIO;

  for (const [modelKey, ratio] of Object.entries(estimators)) {
    if (model.includes(modelKey) || model.includes(modelKey.replace(/-/g, ''))) {
      tokensPerChar = ratio;
      break;
    }
  }

  return Math.ceil(text.length * tokensPerChar);
}
