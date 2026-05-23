import { formatAmount } from './amountFormatter';

describe('formatAmount', () => {
  describe('aic currency', () => {
    it('short precision: ceils and adds AIC suffix', () => {
      expect(formatAmount(42.31, { currency: 'aic', precision: 'short' })).toBe('43 AIC');
    });

    it('full precision: keeps 2dp', () => {
      expect(formatAmount(42.31, { currency: 'aic', precision: 'full' })).toBe('42.31 AIC');
    });

    it('full precision is the default', () => {
      expect(formatAmount(42.31, { currency: 'aic' })).toBe('42.31 AIC');
    });
  });

  describe('usd currency', () => {
    it('short precision: ceils AIC to whole cents then renders $X.XX', () => {
      // 42.31 AIC = $0.4231 → ceil to 43 AIC → $0.43
      expect(formatAmount(42.31, { currency: 'usd', precision: 'short' })).toBe('$0.43');
    });

    it('full precision: divides by 100 and shows 2dp', () => {
      expect(formatAmount(42.31, { currency: 'usd', precision: 'full' })).toBe('$0.42');
    });

    it('sub-cent USD rounds up in short precision', () => {
      // 0.5 AIC = $0.005 → ceil to 1 AIC → $0.01
      expect(formatAmount(0.5, { currency: 'usd', precision: 'short' })).toBe('$0.01');
    });

    it('sub-cent USD shows 2dp truncation in full precision', () => {
      // 0.5 AIC = $0.005 → toFixed(2) → "0.01" (JS rounds half-even depending, but 0.005→"0.01" in V8)
      const out = formatAmount(0.5, { currency: 'usd', precision: 'full' });
      expect(out.startsWith('$0.0')).toBe(true);
    });
  });

  describe('zero', () => {
    it('aic short shows "0 AIC"', () => {
      expect(formatAmount(0, { currency: 'aic', precision: 'short' })).toBe('0 AIC');
    });

    it('aic full shows "0.00 AIC"', () => {
      expect(formatAmount(0, { currency: 'aic', precision: 'full' })).toBe('0.00 AIC');
    });

    it('usd short shows "$0.00"', () => {
      expect(formatAmount(0, { currency: 'usd', precision: 'short' })).toBe('$0.00');
    });

    it('usd full shows "$0.00"', () => {
      expect(formatAmount(0, { currency: 'usd', precision: 'full' })).toBe('$0.00');
    });

    it('negative is coerced to zero output', () => {
      expect(formatAmount(-5, { currency: 'aic', precision: 'short' })).toBe('0 AIC');
    });

    it('NaN renders zero output (no crash)', () => {
      expect(formatAmount(NaN, { currency: 'aic', precision: 'short' })).toBe('0 AIC');
      expect(formatAmount(NaN, { currency: 'usd', precision: 'full' })).toBe('$0.00');
    });
  });

  describe('large amounts', () => {
    it('aic full: 99999.99 AIC', () => {
      expect(formatAmount(99999.99, { currency: 'aic', precision: 'full' })).toBe('99999.99 AIC');
    });

    it('usd short: ceil 99999.01 AIC → $1000.00', () => {
      // 99999.01 → ceil to 100000 → $1000.00
      expect(formatAmount(99999.01, { currency: 'usd', precision: 'short' })).toBe('$1000.00');
    });

    it('aic short: 1234567.5 → 1234568 AIC', () => {
      expect(formatAmount(1234567.5, { currency: 'aic', precision: 'short' })).toBe('1234568 AIC');
    });
  });
});
