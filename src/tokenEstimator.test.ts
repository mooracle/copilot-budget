import { estimateTokensFromText } from './tokenEstimator';

describe('tokenEstimator', () => {
  describe('estimateTokensFromText', () => {
    it('returns 0 for empty text', () => {
      expect(estimateTokensFromText('')).toBe(0);
    });

    it('uses default GPT ratio (0.25) when no model specified', () => {
      const text = 'Hello, world!'; // 13 chars
      // Math.ceil(13 * 0.25) = Math.ceil(3.25) = 4
      expect(estimateTokensFromText(text)).toBe(4);
    });

    it('uses GPT ratio for GPT models', () => {
      const text = 'a'.repeat(100); // 100 chars
      // Math.ceil(100 * 0.25) = 25
      expect(estimateTokensFromText(text, 'gpt-4o')).toBe(25);
    });

    it('uses Claude ratio (0.24) for Claude models', () => {
      const text = 'a'.repeat(100); // 100 chars
      // Math.ceil(100 * 0.24) = 24
      expect(estimateTokensFromText(text, 'claude-sonnet-4')).toBe(24);
    });

    it('matches model by substring', () => {
      // "gpt-4o-mini" includes "gpt-4o-mini" from the estimators
      const text = 'a'.repeat(200);
      expect(estimateTokensFromText(text, 'gpt-4o-mini')).toBe(50);
    });

    it('falls back to default ratio for unknown models', () => {
      const text = 'a'.repeat(100);
      // Unknown model -> default 0.25
      expect(estimateTokensFromText(text, 'some-unknown-model-xyz')).toBe(25);
    });

    it('rounds up with Math.ceil', () => {
      // 1 char * 0.25 = 0.25 -> ceil = 1
      expect(estimateTokensFromText('x')).toBe(1);
      // 3 chars * 0.25 = 0.75 -> ceil = 1
      expect(estimateTokensFromText('abc')).toBe(1);
    });

    it('handles large text', () => {
      const text = 'a'.repeat(10000);
      // 10000 * 0.25 = 2500
      expect(estimateTokensFromText(text, 'gpt-4')).toBe(2500);
    });
  });
});
