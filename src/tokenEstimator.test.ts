import { estimateTokensFromText, getPremiumMultiplier, PREMIUM_REQUEST_COST } from './tokenEstimator';

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

  describe('PREMIUM_REQUEST_COST', () => {
    it('is $0.04 per premium request', () => {
      expect(PREMIUM_REQUEST_COST).toBe(0.04);
    });
  });

  describe('getPremiumMultiplier', () => {
    it('returns 1 for standard models (e.g. claude-sonnet-4)', () => {
      expect(getPremiumMultiplier('claude-sonnet-4')).toBe(1);
    });

    it('returns 0 for free-tier models (e.g. gpt-4o)', () => {
      expect(getPremiumMultiplier('gpt-4o')).toBe(0);
    });

    it('returns 3 for premium models (e.g. claude-opus-4.6)', () => {
      expect(getPremiumMultiplier('claude-opus-4.6')).toBe(3);
    });

    it('returns 0.33 for low-cost models (e.g. claude-haiku)', () => {
      expect(getPremiumMultiplier('claude-haiku')).toBe(0.33);
    });

    it('uses longest matching key (gpt-4o-mini=0 over gpt-4=1)', () => {
      expect(getPremiumMultiplier('gpt-4o-mini')).toBe(0);
    });

    it('returns default multiplier 1 for unknown models', () => {
      expect(getPremiumMultiplier('some-unknown-model-xyz')).toBe(1);
    });

    it('matches gemini models', () => {
      expect(getPremiumMultiplier('gemini-2.5-flash')).toBe(0.33);
      expect(getPremiumMultiplier('gemini-2.5-pro')).toBe(1);
    });

    it('returns 30 for fast-mode opus models', () => {
      expect(getPremiumMultiplier('claude-opus-4.6-fast')).toBe(30);
    });
  });
});
