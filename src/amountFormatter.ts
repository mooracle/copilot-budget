export type EstimationMode = 'files' | 'telemetry';
export type DisplayCurrency = 'aic' | 'usd';
export type AmountPrecision = 'short' | 'full';

export interface FormatAmountOpts {
  mode: EstimationMode;
  currency: DisplayCurrency;
  precision?: AmountPrecision;
}

export function formatAmount(amountAic: number, opts: FormatAmountOpts): string {
  const precision: AmountPrecision = opts.precision ?? 'full';
  const safe = Number.isFinite(amountAic) ? amountAic : 0;
  const isZero = !(safe > 0);

  let body: string;
  if (opts.currency === 'usd') {
    if (precision === 'short') {
      const cents = isZero ? 0 : Math.ceil(safe);
      body = `$${(cents / 100).toFixed(2)}`;
    } else {
      body = `$${(safe / 100).toFixed(2)}`;
    }
  } else {
    if (precision === 'short') {
      body = isZero ? '0 AIC' : `${Math.ceil(safe)} AIC`;
    } else {
      body = `${safe.toFixed(2)} AIC`;
    }
  }

  if (isZero) return body;
  return opts.mode === 'files' ? `~${body}` : body;
}
