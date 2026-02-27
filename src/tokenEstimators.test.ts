import * as path from 'path';
import * as fs from 'fs';

const dataPath = path.join(__dirname, '..', 'data', 'tokenEstimators.json');

describe('tokenEstimators.json', () => {
  let data: any;

  beforeAll(() => {
    const raw = fs.readFileSync(dataPath, 'utf-8');
    data = JSON.parse(raw);
  });

  it('should be valid JSON with an estimators object', () => {
    expect(data).toBeDefined();
    expect(typeof data.estimators).toBe('object');
  });

  it('should contain at least 40 models', () => {
    const modelCount = Object.keys(data.estimators).length;
    expect(modelCount).toBeGreaterThanOrEqual(40);
  });

  it('should have numeric ratios between 0 and 1 for all models', () => {
    for (const [_model, ratio] of Object.entries(data.estimators)) {
      expect(typeof ratio).toBe('number');
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThan(1);
    }
  });

  it('should have GPT models with ratio 0.25', () => {
    expect(data.estimators['gpt-4o']).toBe(0.25);
    expect(data.estimators['gpt-4']).toBe(0.25);
  });

  it('should have Claude models with ratio 0.24', () => {
    expect(data.estimators['claude-sonnet-4']).toBe(0.24);
    expect(data.estimators['claude-haiku']).toBe(0.24);
  });

  describe('premiumMultipliers', () => {
    it('should have a premiumMultipliers object', () => {
      expect(typeof data.premiumMultipliers).toBe('object');
    });

    it('should have numeric multipliers >= 0 for all models', () => {
      for (const [_model, multiplier] of Object.entries(data.premiumMultipliers)) {
        expect(typeof multiplier).toBe('number');
        expect(multiplier).toBeGreaterThanOrEqual(0);
      }
    });

    it('should have free models with multiplier 0', () => {
      expect(data.premiumMultipliers['gpt-4o']).toBe(0);
      expect(data.premiumMultipliers['gpt-4.1']).toBe(0);
      expect(data.premiumMultipliers['gpt-5-mini']).toBe(0);
      expect(data.premiumMultipliers['raptor-mini']).toBe(0);
    });

    it('should have standard models with multiplier 1', () => {
      expect(data.premiumMultipliers['claude-sonnet-4']).toBe(1);
      expect(data.premiumMultipliers['gemini-2.5-pro']).toBe(1);
    });

    it('should have premium models with multiplier > 1', () => {
      expect(data.premiumMultipliers['claude-opus-4.5']).toBe(3);
      expect(data.premiumMultipliers['claude-opus-4.6']).toBe(3);
    });

    it('should have budget models with multiplier < 1 and > 0', () => {
      expect(data.premiumMultipliers['claude-haiku-4.5']).toBe(0.33);
      expect(data.premiumMultipliers['gemini-3-flash']).toBe(0.33);
      expect(data.premiumMultipliers['grok-code-fast-1']).toBe(0.25);
    });

    it('should cover all models in the estimators section', () => {
      const estimatorModels = Object.keys(data.estimators);
      const multiplierModels = Object.keys(data.premiumMultipliers);
      for (const model of estimatorModels) {
        expect(multiplierModels).toContain(model);
      }
    });
  });
});
