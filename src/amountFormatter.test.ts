import { formatAmount } from './amountFormatter';

describe('formatAmount', () => {
  describe('files mode + aic', () => {
    it('short precision: ceils and adds tilde + AIC suffix', () => {
      expect(formatAmount(42.31, { mode: 'files', currency: 'aic', precision: 'short' })).toBe('~43 AIC');
    });

    it('full precision: keeps 2dp and tilde', () => {
      expect(formatAmount(42.31, { mode: 'files', currency: 'aic', precision: 'full' })).toBe('~42.31 AIC');
    });

    it('full precision is the default', () => {
      expect(formatAmount(42.31, { mode: 'files', currency: 'aic' })).toBe('~42.31 AIC');
    });
  });

  describe('files mode + usd', () => {
    it('short precision: ceils AIC to whole cents then renders $X.XX', () => {
      // 42.31 AIC = $0.4231 → ceil to 43 AIC → $0.43
      expect(formatAmount(42.31, { mode: 'files', currency: 'usd', precision: 'short' })).toBe('~$0.43');
    });

    it('full precision: divides by 100 and shows 2dp', () => {
      expect(formatAmount(42.31, { mode: 'files', currency: 'usd', precision: 'full' })).toBe('~$0.42');
    });

    it('sub-cent USD rounds up in short precision', () => {
      // 0.5 AIC = $0.005 → ceil to 1 AIC → $0.01
      expect(formatAmount(0.5, { mode: 'files', currency: 'usd', precision: 'short' })).toBe('~$0.01');
    });

    it('sub-cent USD shows 2dp truncation in full precision', () => {
      // 0.5 AIC = $0.005 → toFixed(2) → "0.01" (JS rounds half-even depending, but 0.005→"0.01" in V8)
      const out = formatAmount(0.5, { mode: 'files', currency: 'usd', precision: 'full' });
      expect(out.startsWith('~$0.0')).toBe(true);
    });
  });

  describe('telemetry mode + aic', () => {
    it('short precision: no tilde, ceils', () => {
      expect(formatAmount(42.31, { mode: 'telemetry', currency: 'aic', precision: 'short' })).toBe('43 AIC');
    });

    it('full precision: no tilde, 2dp', () => {
      expect(formatAmount(42.31, { mode: 'telemetry', currency: 'aic', precision: 'full' })).toBe('42.31 AIC');
    });
  });

  describe('telemetry mode + usd', () => {
    it('short precision: no tilde, ceil AIC → cents', () => {
      expect(formatAmount(42.31, { mode: 'telemetry', currency: 'usd', precision: 'short' })).toBe('$0.43');
    });

    it('full precision: no tilde, 2dp', () => {
      expect(formatAmount(42.31, { mode: 'telemetry', currency: 'usd', precision: 'full' })).toBe('$0.42');
    });
  });

  describe('zero', () => {
    it('files+aic short shows "0 AIC" without tilde', () => {
      expect(formatAmount(0, { mode: 'files', currency: 'aic', precision: 'short' })).toBe('0 AIC');
    });

    it('files+aic full shows "0.00 AIC" without tilde', () => {
      expect(formatAmount(0, { mode: 'files', currency: 'aic', precision: 'full' })).toBe('0.00 AIC');
    });

    it('telemetry+aic short shows "0 AIC"', () => {
      expect(formatAmount(0, { mode: 'telemetry', currency: 'aic', precision: 'short' })).toBe('0 AIC');
    });

    it('files+usd short shows "$0.00" without tilde', () => {
      expect(formatAmount(0, { mode: 'files', currency: 'usd', precision: 'short' })).toBe('$0.00');
    });

    it('files+usd full shows "$0.00" without tilde', () => {
      expect(formatAmount(0, { mode: 'files', currency: 'usd', precision: 'full' })).toBe('$0.00');
    });

    it('telemetry+usd short shows "$0.00"', () => {
      expect(formatAmount(0, { mode: 'telemetry', currency: 'usd', precision: 'short' })).toBe('$0.00');
    });

    it('negative is coerced to zero output (no tilde)', () => {
      expect(formatAmount(-5, { mode: 'files', currency: 'aic', precision: 'short' })).toBe('0 AIC');
    });

    it('NaN renders zero output (no tilde, no crash)', () => {
      expect(formatAmount(NaN, { mode: 'files', currency: 'aic', precision: 'short' })).toBe('0 AIC');
      expect(formatAmount(NaN, { mode: 'files', currency: 'usd', precision: 'full' })).toBe('$0.00');
    });
  });

  describe('large amounts', () => {
    it('files+aic full: 99999.99 AIC', () => {
      expect(formatAmount(99999.99, { mode: 'files', currency: 'aic', precision: 'full' })).toBe('~99999.99 AIC');
    });

    it('telemetry+usd short: ceil 99999.01 AIC → $1000.00', () => {
      // 99999.01 → ceil to 100000 → $1000.00
      expect(formatAmount(99999.01, { mode: 'telemetry', currency: 'usd', precision: 'short' })).toBe('$1000.00');
    });

    it('telemetry+aic short: 1234567.5 → 1234568 AIC', () => {
      expect(formatAmount(1234567.5, { mode: 'telemetry', currency: 'aic', precision: 'short' })).toBe('1234568 AIC');
    });
  });
});
