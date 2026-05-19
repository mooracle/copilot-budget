import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  computeCost,
  getAllRates,
  getDisplayName,
  getRateCard,
  loadRateCard,
  normalizeModelId,
  resetRateCardForTesting,
} from './tokenRates';

const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'models-and-pricing.json');

beforeEach(() => {
  resetRateCardForTesting();
  loadRateCard(FIXTURE_PATH);
});

afterEach(() => {
  resetRateCardForTesting();
});

describe('normalizeModelId', () => {
  it('strips footnote markers', () => {
    expect(normalizeModelId('GPT-4.1[^1]')).toBe('gpt-4.1');
    expect(normalizeModelId('GPT-5 mini[^1]')).toBe('gpt-5-mini');
  });

  it('preserves dots in version-qualified names', () => {
    expect(normalizeModelId('Claude Opus 4.6')).toBe('claude-opus-4.6');
    expect(normalizeModelId('GPT-4.1')).toBe('gpt-4.1');
    expect(normalizeModelId('Claude Sonnet 4.6')).toBe('claude-sonnet-4.6');
  });

  it('lowercases and replaces whitespace runs with hyphens', () => {
    expect(normalizeModelId('Gemini 3 Flash')).toBe('gemini-3-flash');
    expect(normalizeModelId('  Claude   Sonnet   4.6  ')).toBe('claude-sonnet-4.6');
  });

  it('does not collapse version-qualified names to a base family', () => {
    expect(normalizeModelId('Claude Opus 4.6')).not.toBe('claude-opus-4');
    expect(normalizeModelId('Claude Sonnet 4.6')).not.toBe('claude-sonnet-4');
  });
});

describe('loadRateCard schema robustness', () => {
  it('skips entries missing required keys without crashing', () => {
    const tmp = path.join(os.tmpdir(), `rate-card-test-${Date.now()}.json`);
    fs.writeFileSync(
      tmp,
      JSON.stringify([
        {
          model: 'Good Model',
          provider: 'openai',
          input: '$1.00',
          cached_input: '$0.10',
          output: '$5.00',
        },
        {
          model: 'Missing Input',
          provider: 'openai',
          cached_input: '$0.10',
          output: '$5.00',
        },
      ]),
    );
    resetRateCardForTesting();
    const map = loadRateCard(tmp, true);
    expect(map.has('good-model')).toBe(true);
    expect(map.has('missing-input')).toBe(false);
    fs.unlinkSync(tmp);
  });

  it('returns an empty map when the rate card file is missing', () => {
    resetRateCardForTesting();
    const map = loadRateCard(path.join(os.tmpdir(), 'definitely-not-there.json'), true);
    expect(map.size).toBe(0);
  });
});

describe('getRateCard', () => {
  it('returns the rate card for an exact normalized id (AIC per 1M tokens)', () => {
    const card = getRateCard('claude-sonnet-4.6');
    expect(card).not.toBeNull();
    expect(card?.provider).toBe('anthropic');
    expect(card?.input).toBeCloseTo(300.0, 9);
    expect(card?.cachedInput).toBeCloseTo(30.0, 9);
    expect(card?.output).toBeCloseTo(1500.0, 9);
    expect(card?.cacheCreation).toBeCloseTo(375.0, 9);
    expect(card?.displayName).toBe('Claude Sonnet 4.6');
  });

  it('strips the copilot/ prefix', () => {
    const card = getRateCard('copilot/gpt-4.1');
    expect(card).not.toBeNull();
    expect(card?.provider).toBe('openai');
    expect(card?.input).toBeCloseTo(200.0, 9);
  });

  it('strips the copilotcli/ prefix', () => {
    const card = getRateCard('copilotcli/claude-opus-4.6');
    expect(card).not.toBeNull();
    expect(card?.provider).toBe('anthropic');
    expect(card?.input).toBeCloseTo(500.0, 9);
  });

  it('strips the claude-code/ prefix', () => {
    const card = getRateCard('claude-code/claude-sonnet-4.6');
    expect(card).not.toBeNull();
    expect(card?.provider).toBe('anthropic');
  });

  it('returns null for unknown models with no family fallback', () => {
    expect(getRateCard('claude-sonnet-5')).toBeNull();
    expect(getRateCard('gpt-99')).toBeNull();
    expect(getRateCard('totally-made-up')).toBeNull();
  });

  it('does not collapse claude-opus-4.6 to a generic claude-opus', () => {
    expect(getRateCard('claude-opus-4.6')).not.toBeNull();
    expect(getRateCard('claude-opus')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(getRateCard('')).toBeNull();
  });

  it('handles all upstream providers', () => {
    expect(getRateCard('gpt-4.1')?.provider).toBe('openai');
    expect(getRateCard('claude-sonnet-4.6')?.provider).toBe('anthropic');
    expect(getRateCard('gemini-3-flash')?.provider).toBe('google');
    expect(getRateCard('grok-code-fast-1')?.provider).toBe('xai');
    expect(getRateCard('raptor-mini')?.provider).toBe('github');
  });
});

describe('computeCost', () => {
  it('charges GPT-4.1 at the published per-token rates in AIC (no zero special-case)', () => {
    const cost = computeCost('gpt-4.1', {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
    expect(cost).toBeCloseTo(200.0, 6);
  });

  it('charges GPT-5 mini at the published per-token rates in AIC', () => {
    const cost = computeCost('gpt-5-mini', {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 0,
      cacheCreation: 0,
    });
    expect(cost).toBeCloseTo((0.25 + 2.0) * 100, 6);
  });

  it('applies all four token rates for an Anthropic model in AIC', () => {
    const cost = computeCost('claude-sonnet-4.6', {
      input: 1000,
      cacheRead: 1000,
      cacheCreation: 1000,
      output: 1000,
    });
    const expected =
      (1000 * 300.0 + 1000 * 30.0 + 1000 * 375.0 + 1000 * 1500.0) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 9);
  });

  it('falls back cacheCreation rate to input rate when YAML lacks cache_write (OpenAI, AIC)', () => {
    const cost = computeCost('gpt-4.1', {
      input: 0,
      cacheRead: 0,
      cacheCreation: 1_000_000,
      output: 0,
    });
    expect(cost).toBeCloseTo(200.0, 6);
  });

  it('falls back cacheCreation rate to input rate when YAML lacks cache_write (Gemini, AIC)', () => {
    const cost = computeCost('gemini-3-flash', {
      input: 0,
      cacheRead: 0,
      cacheCreation: 1_000_000,
      output: 0,
    });
    expect(cost).toBeCloseTo(50.0, 6);
  });

  it('returns 0 for unknown models', () => {
    const cost = computeCost('claude-sonnet-5', {
      input: 1_000_000,
      cacheRead: 1_000_000,
      cacheCreation: 1_000_000,
      output: 1_000_000,
    });
    expect(cost).toBe(0);
  });

  it('returns 0 when all token counts are 0', () => {
    expect(
      computeCost('claude-sonnet-4.6', { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }),
    ).toBe(0);
  });
});

describe('getDisplayName', () => {
  it('returns the YAML display name for a known model', () => {
    expect(getDisplayName('claude-sonnet-4.6')).toBe('Claude Sonnet 4.6');
    expect(getDisplayName('gpt-4.1')).toBe('GPT-4.1');
    expect(getDisplayName('gpt-5-mini')).toBe('GPT-5 mini');
  });

  it('returns the YAML display name even when called with a prefixed id', () => {
    expect(getDisplayName('copilot/gpt-4.1')).toBe('GPT-4.1');
  });

  it('falls back to the normalized stripped id for unknown models', () => {
    expect(getDisplayName('copilot/some-future-model')).toBe('some-future-model');
    expect(getDisplayName('Totally  New  Model')).toBe('totally-new-model');
  });
});

describe('getAllRates', () => {
  it('exposes the loaded rate map', () => {
    const map = getAllRates();
    expect(map.size).toBeGreaterThan(0);
    expect(map.has('claude-sonnet-4.6')).toBe(true);
  });
});
