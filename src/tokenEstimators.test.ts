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
    for (const [model, ratio] of Object.entries(data.estimators)) {
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
});
