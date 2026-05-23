import { Tracker, TrackingStats, ModelStats } from './tracker';
import * as tokenRates from './tokenRates';
import { OTelReader, PerModelAggregate } from './otelReader';

jest.mock('./tokenRates');
jest.mock('./logger');

const mockTokenRates = tokenRates as jest.Mocked<typeof tokenRates>;

// Fixture rates pulled directly from src/__fixtures__/models-and-pricing.yml so
// the cost assertions match what the real rate card would produce.
const FIXTURE_RATES: Record<
  string,
  { input: number; cached: number; output: number; cacheCreation: number }
> = {
  'gpt-4.1': { input: 2.0, cached: 0.5, output: 8.0, cacheCreation: 2.0 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0, cacheCreation: 0.25 },
  'claude-sonnet-4.6': {
    input: 3.0,
    cached: 0.3,
    output: 15.0,
    cacheCreation: 3.75,
  },
};

function fixtureCost(
  modelId: string,
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number },
): number {
  const r = FIXTURE_RATES[modelId];
  if (!r) return 0;
  return (
    (tokens.input * r.input +
      tokens.cacheRead * r.cached +
      tokens.cacheCreation * r.cacheCreation +
      tokens.output * r.output) /
    1_000_000
  );
}

function makeMockReader(opts: {
  latest?: number;
  aggregates?: PerModelAggregate[][];
  isAvailable?: boolean;
}): jest.Mocked<OTelReader> {
  // `aggregates` is an array of result batches, one per scan call. The reader
  // returns the next entry on each invocation; once exhausted it returns the
  // last batch (mirroring on-disk persistence between scans).
  let idx = 0;
  const aggregates = opts.aggregates ?? [];
  return {
    isAvailable: jest.fn(() => opts.isAvailable ?? true),
    aggregateSince: jest.fn((_sinceMs: number, _sessionIds: string[]) => {
      if (aggregates.length === 0) return [];
      if (idx < aggregates.length) {
        const next = aggregates[idx];
        idx += 1;
        return next;
      }
      return aggregates[aggregates.length - 1];
    }),
    getLatestTimestamp: jest.fn(() => opts.latest ?? 0),
    close: jest.fn(),
  } as unknown as jest.Mocked<OTelReader>;
}

function row(overrides: Partial<PerModelAggregate> = {}): PerModelAggregate {
  return {
    model: 'gpt-4.1',
    chats: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockTokenRates.computeCost.mockImplementation((modelId, tokens) =>
    fixtureCost(modelId, tokens) * 100,
  );
  mockTokenRates.normalizeModelId.mockImplementation((raw: string) =>
    raw.trim().toLowerCase().replace(/\s+/g, '-'),
  );
  mockTokenRates.stripModelPrefix.mockImplementation((raw: string) => {
    for (const prefix of ['copilot/', 'copilotcli/', 'claude-code/']) {
      if (raw.startsWith(prefix)) return raw.slice(prefix.length);
    }
    return raw;
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Tracker — construction and initial state', () => {
  it('captures the construction-time baseline via reader.getLatestTimestamp', () => {
    const reader = makeMockReader({ latest: 12_345 });
    new Tracker(reader, () => []);
    expect(reader.getLatestTimestamp).toHaveBeenCalledTimes(1);
  });

  it('does not throw and falls back to Date.now() when getLatestTimestamp throws at construction', async () => {
    // Activation must survive a DB that exists on disk but is not yet
    // queryable (empty file, half-initialized schema, transient lock). With a
    // Date.now() fallback the next scan does not re-attribute pre-activation
    // history; once the DB becomes readable the poll picks up new spans.
    const reader = makeMockReader({});
    (reader.getLatestTimestamp as jest.Mock).mockImplementation(() => {
      throw new Error('SQLITE_ERROR: no such table: spans');
    });
    const before = Date.now();
    expect(() => new Tracker(reader, () => ['session-A'])).not.toThrow();
    const after = Date.now();
    const tracker = new Tracker(reader, () => ['session-A']);
    // Drive a scan and confirm the baseline passed to aggregateSince is in
    // [before, after] — i.e. Date.now() at construction, not 0.
    await tracker.initialize();
    const [baselineArg] = (reader.aggregateSince as jest.Mock).mock.calls[0];
    expect(baselineArg).toBeGreaterThanOrEqual(before);
    expect(baselineArg).toBeLessThanOrEqual(after);
    tracker.dispose();
  });

  it('returns zero stats before initialize', () => {
    const reader = makeMockReader({});
    const tracker = new Tracker(reader, () => []);
    const stats = tracker.getStats();
    expect(stats.totalTokens).toBe(0);
    expect(stats.interactions).toBe(0);
    expect(stats.totalAiCredits).toBe(0);
    expect(stats.models).toEqual({});
    expect(stats.since).toBeDefined();
    expect(stats.lastUpdated).toBeDefined();
    tracker.dispose();
  });
});

describe('Tracker — aggregateSince integration', () => {
  it('passes the construction baseline and current sessionIds to aggregateSince', async () => {
    const reader = makeMockReader({ latest: 5_000 });
    const sessionIdsFn = jest.fn(() => ['session-A', 'session-B']);
    const tracker = new Tracker(reader, sessionIdsFn);
    await tracker.initialize();

    expect(sessionIdsFn).toHaveBeenCalled();
    expect(reader.aggregateSince).toHaveBeenCalledWith(5_000, [
      'session-A',
      'session-B',
    ]);
    tracker.dispose();
  });

  it('keeps previously seen session ids in the filter even after they age out of discovery', async () => {
    const reader = makeMockReader({ latest: 0 });
    let snapshot: string[] = ['session-A', 'session-B'];
    const tracker = new Tracker(reader, () => snapshot);

    await tracker.initialize();
    expect(reader.aggregateSince).toHaveBeenLastCalledWith(0, [
      'session-A',
      'session-B',
    ]);

    // session-B ages out of discovery (or dir is transiently unreadable).
    snapshot = ['session-A'];
    await tracker.update();
    expect(reader.aggregateSince).toHaveBeenLastCalledWith(0, [
      'session-A',
      'session-B',
    ]);

    // Even when discovery returns nothing, the sticky set drives the query.
    snapshot = [];
    await tracker.update();
    expect(reader.aggregateSince).toHaveBeenLastCalledWith(0, [
      'session-A',
      'session-B',
    ]);
    tracker.dispose();
  });
});

describe('Tracker — baseline computation', () => {
  it('zeros out delta on initialize', async () => {
    const reader = makeMockReader({
      aggregates: [
        [
          row({
            model: 'claude-sonnet-4.6',
            chats: 3,
            inputTokens: 310,
            outputTokens: 50,
            cacheReadTokens: 200,
            cacheCreationTokens: 10,
          }),
        ],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.initialize();
    const stats = tracker.getStats();

    expect(stats.totalTokens).toBe(0);
    expect(stats.totalAiCredits).toBe(0);
    expect(stats.interactions).toBe(0);
    expect(stats.models).toEqual({});
    tracker.dispose();
  });

  it('handles empty result set', async () => {
    const reader = makeMockReader({ aggregates: [[]] });
    const tracker = new Tracker(reader, () => []);
    await tracker.initialize();
    expect(tracker.getStats().totalTokens).toBe(0);
    tracker.dispose();
  });
});

describe('Tracker — delta computation', () => {
  it('computes per-model deltas across all four token buckets', async () => {
    const reader = makeMockReader({
      aggregates: [
        [
          row({
            model: 'claude-sonnet-4.6',
            chats: 1,
            inputTokens: 300,
            outputTokens: 50,
            cacheReadTokens: 200,
            cacheCreationTokens: 0,
          }),
        ],
        [
          row({
            model: 'claude-sonnet-4.6',
            chats: 3,
            inputTokens: 1090,
            outputTokens: 130,
            cacheReadTokens: 800,
            cacheCreationTokens: 40,
          }),
        ],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.initialize();
    await tracker.update();
    const stats = tracker.getStats();

    // pureInput at scan 1 = 300 - 200 - 0 = 100
    // pureInput at scan 2 = 1090 - 800 - 40 = 250
    // delta input = 250 - 100 = 150
    const expectedTokens = {
      inputTokens: 150,
      outputTokens: 80,
      cacheReadTokens: 600,
      cacheCreationTokens: 40,
    };
    expect(stats.models['claude-sonnet-4.6']).toMatchObject(expectedTokens);
    expect(stats.totalTokens).toBe(150 + 80 + 600 + 40);
    expect(stats.interactions).toBe(2);

    const expectedCost = fixtureCost('claude-sonnet-4.6', {
      input: 150,
      output: 80,
      cacheRead: 600,
      cacheCreation: 40,
    });
    expect(stats.models['claude-sonnet-4.6'].costAic).toBeCloseTo(expectedCost * 100, 8);
    expect(stats.totalAiCredits).toBeCloseTo(expectedCost * 100, 8);
    tracker.dispose();
  });

  it('does not fire listener when stats unchanged', async () => {
    const reader = makeMockReader({
      aggregates: [
        [
          row({
            model: 'gpt-4.1',
            chats: 1,
            inputTokens: 100,
            outputTokens: 50,
          }),
        ],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    const listener = jest.fn();
    tracker.onStatsChanged(listener);
    await tracker.initialize();
    await tracker.update();
    expect(listener).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('fires listener when totalAiCredits changes', async () => {
    const reader = makeMockReader({
      aggregates: [
        [],
        [
          row({
            model: 'gpt-4.1',
            chats: 1,
            inputTokens: 1_000_000,
            outputTokens: 0,
          }),
        ],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    const listener = jest.fn();
    tracker.onStatsChanged(listener);
    await tracker.initialize();
    await tracker.update();
    expect(listener).toHaveBeenCalledTimes(1);
    const stats: TrackingStats = listener.mock.calls[0][0];
    expect(stats.totalAiCredits).toBeCloseTo(200, 6);
    tracker.dispose();
  });
});

describe('Tracker — model handling', () => {
  it('strips Copilot request-routing prefixes', async () => {
    const reader = makeMockReader({
      aggregates: [
        [],
        [
          row({ model: 'copilot/gpt-4.1', chats: 1, inputTokens: 500_000 }),
          row({ model: 'copilotcli/gpt-4.1', chats: 1, inputTokens: 500_000 }),
        ],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.initialize();
    await tracker.update();
    const stats = tracker.getStats();
    expect(Object.keys(stats.models)).toEqual(['gpt-4.1']);
    expect(stats.models['gpt-4.1'].inputTokens).toBe(1_000_000);
    tracker.dispose();
  });

  it('routes null model id to "unknown" with zero cost', async () => {
    // `request_model = NULL` → keyed as 'unknown'; getRateCard returns null
    // (mocked to 0 in this suite) so cost stays 0 even with tokens recorded.
    mockTokenRates.computeCost.mockImplementation((modelId) => {
      if (modelId === 'unknown') return 0;
      return 100;
    });
    const reader = makeMockReader({
      aggregates: [
        [],
        [row({ model: null, chats: 1, inputTokens: 100, outputTokens: 50 })],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.initialize();
    await tracker.update();
    const stats = tracker.getStats();
    expect(stats.models['unknown']).toBeDefined();
    expect(stats.models['unknown'].costAic).toBe(0);
    expect(stats.models['unknown'].inputTokens).toBe(100);
    tracker.dispose();
  });

  it('clamps pure input at 0 when cache buckets exceed prompt total', async () => {
    const reader = makeMockReader({
      aggregates: [
        [],
        [
          row({
            model: 'claude-sonnet-4.6',
            chats: 1,
            inputTokens: 100,
            cacheReadTokens: 80,
            cacheCreationTokens: 50,
          }),
        ],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.initialize();
    await tracker.update();
    expect(tracker.getStats().models['claude-sonnet-4.6'].inputTokens).toBe(0);
    tracker.dispose();
  });

  it('aggregates Anthropic + OpenAI side-by-side with independent costs', async () => {
    const reader = makeMockReader({
      aggregates: [
        [],
        [
          row({
            model: 'claude-sonnet-4.6',
            chats: 1,
            // pureInput after cache splits = 500_000
            inputTokens: 1_550_000,
            outputTokens: 100_000,
            cacheReadTokens: 1_000_000,
            cacheCreationTokens: 50_000,
          }),
          row({
            model: 'gpt-4.1',
            chats: 1,
            inputTokens: 200_000,
            outputTokens: 50_000,
          }),
        ],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.initialize();
    await tracker.update();
    const stats = tracker.getStats();
    const expectedClaude = fixtureCost('claude-sonnet-4.6', {
      input: 500_000,
      output: 100_000,
      cacheRead: 1_000_000,
      cacheCreation: 50_000,
    });
    const expectedGpt = fixtureCost('gpt-4.1', {
      input: 200_000,
      output: 50_000,
      cacheRead: 0,
      cacheCreation: 0,
    });
    expect(stats.models['claude-sonnet-4.6'].costAic).toBeCloseTo(expectedClaude * 100, 8);
    expect(stats.models['gpt-4.1'].costAic).toBeCloseTo(expectedGpt * 100, 8);
    expect(stats.totalAiCredits).toBeCloseTo((expectedClaude + expectedGpt) * 100, 8);
    tracker.dispose();
  });
});

describe('Tracker — totalTokens invariant', () => {
  it('includes cacheRead + cacheCreation in totalTokens', async () => {
    const reader = makeMockReader({
      aggregates: [
        [],
        [
          row({
            model: 'claude-sonnet-4.6',
            chats: 1,
            inputTokens: 550, // pureInput = 550 - 400 - 50 = 100
            outputTokens: 200,
            cacheReadTokens: 400,
            cacheCreationTokens: 50,
          }),
        ],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.initialize();
    await tracker.update();
    expect(tracker.getStats().totalTokens).toBe(100 + 200 + 400 + 50);
    tracker.dispose();
  });
});

describe('Tracker — restored stats merge', () => {
  it('adds previousStats values to the live delta', async () => {
    const reader = makeMockReader({
      aggregates: [
        [],
        [
          row({
            model: 'claude-sonnet-4.6',
            chats: 2,
            inputTokens: 155, // pureInput = 155 - 100 - 5 = 50
            outputTokens: 25,
            cacheReadTokens: 100,
            cacheCreationTokens: 5,
          }),
        ],
      ],
    });

    const tracker = new Tracker(reader, () => ['session-A']);
    tracker.setPreviousStats({
      since: '2026-04-01T00:00:00.000Z',
      interactions: 7,
      models: {
        'claude-sonnet-4.6': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 200,
          cacheCreationTokens: 10,
          costAic: 0.5,
        },
      },
    });
    await tracker.initialize();
    await tracker.update();
    const stats = tracker.getStats();
    const sessionDeltaCost = fixtureCost('claude-sonnet-4.6', {
      input: 50,
      output: 25,
      cacheRead: 100,
      cacheCreation: 5,
    });

    expect(stats.since).toBe('2026-04-01T00:00:00.000Z');
    expect(stats.interactions).toBe(9); // 7 restored + 2 delta
    expect(stats.models['claude-sonnet-4.6'].inputTokens).toBe(150); // 100 + 50
    expect(stats.models['claude-sonnet-4.6'].cacheReadTokens).toBe(300);
    expect(stats.models['claude-sonnet-4.6'].costAic).toBeCloseTo(
      0.5 + sessionDeltaCost * 100,
      8,
    );
    expect(stats.totalAiCredits).toBeCloseTo(0.5 + sessionDeltaCost * 100, 8);
    tracker.dispose();
  });

  it('reset() clears previousStats and rebases baseline', async () => {
    const reader = makeMockReader({});
    const tracker = new Tracker(reader, () => []);
    tracker.setPreviousStats({
      since: '2026-04-01T00:00:00.000Z',
      interactions: 5,
      models: {
        'gpt-4.1': {
          inputTokens: 1000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costAic: 0.2,
        } as ModelStats,
      },
    });
    await tracker.initialize();
    expect(tracker.getStats().totalAiCredits).toBeCloseTo(0.2, 6);

    await tracker.reset();
    expect(tracker.getStats().totalAiCredits).toBe(0);
    expect(tracker.getStats().interactions).toBe(0);
    tracker.dispose();
  });

  it('consume() preserves activity that landed since the last update', async () => {
    // Simulates the post-commit window: after update() captures S_update,
    // the hook truncates the file. Before consume() runs, a new chat span
    // lands. A full reset would absorb it into the new baseline and silently
    // drop it. consume() rebases to S_update so the new span shows up as
    // the next commit's delta.
    const reader = makeMockReader({
      aggregates: [
        // initialize: empty
        [],
        // update: 2 chats, 1000 input, 500 output
        [
          row({
            model: 'gpt-4.1',
            chats: 2,
            inputTokens: 1000,
            outputTokens: 500,
          }),
        ],
        // consume() scan (current): 3 chats, 1300 input, 600 output
        // (baselineSnapshot reuses the prior lastSnapshot, only one scan happens)
        [
          row({
            model: 'gpt-4.1',
            chats: 3,
            inputTokens: 1300,
            outputTokens: 600,
          }),
        ],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.initialize();
    await tracker.update();
    const consumedStats = tracker.getStats();
    expect(consumedStats.interactions).toBe(2);
    expect(consumedStats.models['gpt-4.1'].inputTokens).toBe(1000);

    await tracker.consume();
    const postConsume = tracker.getStats();
    expect(postConsume.interactions).toBe(1);
    expect(postConsume.models['gpt-4.1'].inputTokens).toBe(300);
    expect(postConsume.models['gpt-4.1'].outputTokens).toBe(100);
    tracker.dispose();
  });

  it('consume() zeros stats when nothing happened after the last update', async () => {
    const reader = makeMockReader({
      aggregates: [
        [
          row({
            model: 'gpt-4.1',
            chats: 1,
            inputTokens: 500,
          }),
        ],
      ],
    });
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.initialize();
    await tracker.update();

    await tracker.consume();
    const stats = tracker.getStats();
    expect(stats.totalTokens).toBe(0);
    expect(stats.interactions).toBe(0);
    expect(stats.totalAiCredits).toBe(0);
    tracker.dispose();
  });

  it('consume() clears previousStats so restored prior-session stats do not leak forward', async () => {
    const reader = makeMockReader({});
    const tracker = new Tracker(reader, () => []);
    tracker.setPreviousStats({
      since: '2026-04-01T00:00:00.000Z',
      interactions: 5,
      models: {
        'gpt-4.1': {
          inputTokens: 1000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costAic: 0.2,
        } as ModelStats,
      },
    });
    await tracker.initialize();
    expect(tracker.getStats().totalAiCredits).toBeCloseTo(0.2, 6);

    await tracker.consume();
    expect(tracker.getStats().totalAiCredits).toBe(0);
    expect(tracker.getStats().interactions).toBe(0);
    tracker.dispose();
  });
});

describe('Tracker — periodic scanning', () => {
  it('calls aggregateSince on interval', async () => {
    const reader = makeMockReader({});
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.start(60_000);
    expect(reader.aggregateSince).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    // Drain microtasks queued by the timer callback.
    await Promise.resolve();
    await Promise.resolve();
    expect(reader.aggregateSince).toHaveBeenCalledTimes(2);

    tracker.stop();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(reader.aggregateSince).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });
});

describe('Tracker — dispose', () => {
  it('clears timer, listeners, and closes the reader', async () => {
    const reader = makeMockReader({});
    const tracker = new Tracker(reader, () => ['session-A']);
    await tracker.start(60_000);
    tracker.dispose();
    jest.advanceTimersByTime(120_000);
    expect(reader.aggregateSince).toHaveBeenCalledTimes(1);
    expect(reader.close).toHaveBeenCalledTimes(1);
  });

  it('does not install the poll timer when disposed mid-start', async () => {
    const reader = makeMockReader({});
    const tracker = new Tracker(reader, () => ['session-A']);
    const startPromise = tracker.start(60_000);
    tracker.dispose();
    await startPromise;

    const beforeAdvance = (reader.aggregateSince as jest.Mock).mock.calls.length;
    jest.advanceTimersByTime(180_000);
    expect((reader.aggregateSince as jest.Mock).mock.calls.length).toBe(
      beforeAdvance,
    );
  });
});

describe('Tracker.start resilience', () => {
  it('installs the poll timer even when initialize() rejects', async () => {
    let scanCallCount = 0;
    const reader = makeMockReader({});
    (reader.aggregateSince as jest.Mock).mockImplementation(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) {
        throw new Error('transient OTel DB lock');
      }
      return [row({ model: 'gpt-4.1', chats: 1 })];
    });
    const tracker = new Tracker(reader, () => ['session-A']);

    // start() must resolve (not reject) and install the timer so the next
    // poll can recover.
    await expect(tracker.start(30_000)).resolves.toBeUndefined();
    expect(scanCallCount).toBe(1);

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(scanCallCount).toBeGreaterThanOrEqual(2);
    tracker.dispose();
  });
});
