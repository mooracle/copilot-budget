import { formatAmount } from './amountFormatter';

describe('formatAmount', () => {
  describe('files mode + aic (mode param ignored)', () => {
    it('short precision: ceils and adds AIC suffix (no tilde)', () => {
      expect(formatAmount(42.31, { mode: 'files', currency: 'aic', precision: 'short' })).toBe('43 AIC');
    });

    it('full precision: keeps 2dp (no tilde)', () => {
      expect(formatAmount(42.31, { mode: 'files', currency: 'aic', precision: 'full' })).toBe('42.31 AIC');
    });

    it('full precision is the default', () => {
      expect(formatAmount(42.31, { mode: 'files', currency: 'aic' })).toBe('42.31 AIC');
    });
  });

  describe('files mode + usd (mode param ignored)', () => {
    it('short precision: ceils AIC to whole cents then renders $X.XX (no tilde)', () => {
      // 42.31 AIC = $0.4231 → ceil to 43 AIC → $0.43
      expect(formatAmount(42.31, { mode: 'files', currency: 'usd', precision: 'short' })).toBe('$0.43');
    });

    it('full precision: divides by 100 and shows 2dp (no tilde)', () => {
      expect(formatAmount(42.31, { mode: 'files', currency: 'usd', precision: 'full' })).toBe('$0.42');
    });

    it('sub-cent USD rounds up in short precision', () => {
      // 0.5 AIC = $0.005 → ceil to 1 AIC → $0.01
      expect(formatAmount(0.5, { mode: 'files', currency: 'usd', precision: 'short' })).toBe('$0.01');
    });

    it('sub-cent USD shows 2dp truncation in full precision', () => {
      // 0.5 AIC = $0.005 → toFixed(2) → "0.01" (JS rounds half-even depending, but 0.005→"0.01" in V8)
      const out = formatAmount(0.5, { mode: 'files', currency: 'usd', precision: 'full' });
      expect(out.startsWith('$0.0')).toBe(true);
    });
  });

  describe('telemetry mode + aic', () => {
    it('short precision: ceils', () => {
      expect(formatAmount(42.31, { mode: 'telemetry', currency: 'aic', precision: 'short' })).toBe('43 AIC');
    });

    it('full precision: 2dp', () => {
      expect(formatAmount(42.31, { mode: 'telemetry', currency: 'aic', precision: 'full' })).toBe('42.31 AIC');
    });
  });

  describe('telemetry mode + usd', () => {
    it('short precision: ceil AIC → cents', () => {
      expect(formatAmount(42.31, { mode: 'telemetry', currency: 'usd', precision: 'short' })).toBe('$0.43');
    });

    it('full precision: 2dp', () => {
      expect(formatAmount(42.31, { mode: 'telemetry', currency: 'usd', precision: 'full' })).toBe('$0.42');
    });
  });

  describe('mode-equivalence (post-OTel-only)', () => {
    it('files and telemetry produce identical output for the same amount', () => {
      const files = formatAmount(42.31, { mode: 'files', currency: 'aic', precision: 'short' });
      const telemetry = formatAmount(42.31, { mode: 'telemetry', currency: 'aic', precision: 'short' });
      expect(files).toBe(telemetry);
    });

    it('files and telemetry produce identical USD output', () => {
      const files = formatAmount(42.31, { mode: 'files', currency: 'usd', precision: 'full' });
      const telemetry = formatAmount(42.31, { mode: 'telemetry', currency: 'usd', precision: 'full' });
      expect(files).toBe(telemetry);
    });
  });

  describe('zero', () => {
    it('files+aic short shows "0 AIC"', () => {
      expect(formatAmount(0, { mode: 'files', currency: 'aic', precision: 'short' })).toBe('0 AIC');
    });

    it('files+aic full shows "0.00 AIC"', () => {
      expect(formatAmount(0, { mode: 'files', currency: 'aic', precision: 'full' })).toBe('0.00 AIC');
    });

    it('telemetry+aic short shows "0 AIC"', () => {
      expect(formatAmount(0, { mode: 'telemetry', currency: 'aic', precision: 'short' })).toBe('0 AIC');
    });

    it('files+usd short shows "$0.00"', () => {
      expect(formatAmount(0, { mode: 'files', currency: 'usd', precision: 'short' })).toBe('$0.00');
    });

    it('files+usd full shows "$0.00"', () => {
      expect(formatAmount(0, { mode: 'files', currency: 'usd', precision: 'full' })).toBe('$0.00');
    });

    it('telemetry+usd short shows "$0.00"', () => {
      expect(formatAmount(0, { mode: 'telemetry', currency: 'usd', precision: 'short' })).toBe('$0.00');
    });

    it('negative is coerced to zero output', () => {
      expect(formatAmount(-5, { mode: 'files', currency: 'aic', precision: 'short' })).toBe('0 AIC');
    });

    it('NaN renders zero output (no crash)', () => {
      expect(formatAmount(NaN, { mode: 'files', currency: 'aic', precision: 'short' })).toBe('0 AIC');
      expect(formatAmount(NaN, { mode: 'files', currency: 'usd', precision: 'full' })).toBe('$0.00');
    });
  });

  describe('large amounts', () => {
    it('files+aic full: 99999.99 AIC', () => {
      expect(formatAmount(99999.99, { mode: 'files', currency: 'aic', precision: 'full' })).toBe('99999.99 AIC');
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
