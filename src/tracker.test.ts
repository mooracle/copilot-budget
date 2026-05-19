import { Tracker, TrackingStats, ModelStats } from './tracker';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as sessionDiscovery from './sessionDiscovery';
import * as sessionParser from './sessionParser';
import * as tokenRates from './tokenRates';

jest.mock('fs');
jest.mock('./sessionDiscovery');
jest.mock('./sessionParser');
jest.mock('./tokenRates');
jest.mock('./logger');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockDiscovery = sessionDiscovery as jest.Mocked<typeof sessionDiscovery>;
const mockParser = sessionParser as jest.Mocked<typeof sessionParser>;
const mockTokenRates = tokenRates as jest.Mocked<typeof tokenRates>;

const STUB_STORAGE_URI = vscode.Uri.file('/test/workspaceStorage/abc123/pub.ext');

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

function emptyTokens() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function setupEmptyDiscovery() {
  mockDiscovery.discoverSessionFiles.mockReturnValue([]);
}

function setupFiles(
  files: {
    path: string;
    mtime: number;
    content: string;
    parseResult: ReturnType<typeof sessionParser.parseSessionFileContent>;
  }[],
) {
  // Tag content per-file so the parser mock can route on content alone now
  // that parseSessionFileContent no longer takes a path argument. Fixtures
  // share `content: '{}'`, so the tag is what makes them distinct.
  const tagged = files.map((f, i) => ({ ...f, taggedContent: `${f.content}\n#file=${i}` }));

  mockDiscovery.discoverSessionFiles.mockReturnValue(tagged.map((f) => f.path));

  mockFs.statSync.mockImplementation((p: fs.PathLike) => {
    const file = tagged.find((f) => f.path === p.toString());
    if (!file) throw new Error(`ENOENT: no such file ${p}`);
    return { mtimeMs: file.mtime } as fs.Stats;
  });

  mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
    const file = tagged.find((f) => f.path === p.toString());
    if (!file) throw new Error(`ENOENT: no such file ${p}`);
    return file.taggedContent as any;
  });

  mockParser.parseSessionFileContent.mockImplementation((content: string) => {
    const file = tagged.find((f) => f.taggedContent === content);
    if (!file)
      return { interactions: 0, modelUsage: {}, modelInteractions: {} };
    return file.parseResult;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // setImmediate is left real so the tracker's per-file yield resolves
  // naturally inside awaited scanAll() calls. setInterval/setTimeout remain
  // faked for the periodic-scanning tests.
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  mockTokenRates.computeCost.mockImplementation((modelId, tokens) =>
    fixtureCost(modelId, tokens) * 100,
  );
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Tracker — initial state', () => {
  it('returns zero stats before initialize', async () => {
    const tracker = new Tracker(STUB_STORAGE_URI);
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

describe('Tracker — baseline computation', () => {
  it('scans sessions and zeros out delta on initialize', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: {
          interactions: 3,
          modelUsage: {
            'claude-sonnet-4.6': {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 200,
              cacheCreationTokens: 10,
            },
          },
          modelInteractions: { 'claude-sonnet-4.6': 3 },
        },
      },
    ]);

    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();
    const stats = tracker.getStats();

    expect(stats.totalTokens).toBe(0);
    expect(stats.totalAiCredits).toBe(0);
    expect(stats.interactions).toBe(0);
    expect(stats.models).toEqual({});
    tracker.dispose();
  });

  it('handles no session files', async () => {
    setupEmptyDiscovery();
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();
    expect(tracker.getStats().totalTokens).toBe(0);
    tracker.dispose();
  });
});

describe('Tracker — delta computation', () => {
  it('computes per-model deltas across all four token buckets', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: {
          interactions: 1,
          modelUsage: {
            'claude-sonnet-4.6': {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 200,
              cacheCreationTokens: 0,
            },
          },
          modelInteractions: { 'claude-sonnet-4.6': 1 },
        },
      },
    ]);

    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: {
          interactions: 3,
          modelUsage: {
            'claude-sonnet-4.6': {
              inputTokens: 250,
              outputTokens: 130,
              cacheReadTokens: 800,
              cacheCreationTokens: 40,
            },
          },
          modelInteractions: { 'claude-sonnet-4.6': 3 },
        },
      },
    ]);

    await tracker.update();
    const stats = tracker.getStats();

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
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: {
          interactions: 1,
          modelUsage: {
            'gpt-4.1': { ...emptyTokens(), inputTokens: 100, outputTokens: 50 },
          },
          modelInteractions: { 'gpt-4.1': 1 },
        },
      },
    ]);

    const tracker = new Tracker(STUB_STORAGE_URI);
    const listener = jest.fn();
    tracker.onStatsChanged(listener);
    await tracker.initialize();
    await tracker.update();
    expect(listener).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('fires listener when totalAiCredits changes', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: {
          interactions: 0,
          modelUsage: {},
          modelInteractions: {},
        },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
    const listener = jest.fn();
    tracker.onStatsChanged(listener);
    await tracker.initialize();

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: {
          interactions: 1,
          modelUsage: {
            'gpt-4.1': {
              ...emptyTokens(),
              inputTokens: 1_000_000,
              outputTokens: 0,
            },
          },
          modelInteractions: { 'gpt-4.1': 1 },
        },
      },
    ]);
    await tracker.update();
    expect(listener).toHaveBeenCalledTimes(1);
    const stats: TrackingStats = listener.mock.calls[0][0];
    expect(stats.totalAiCredits).toBeCloseTo(200, 6);
    tracker.dispose();
  });
});

describe('Tracker — published-rate billing for "included" models', () => {
  it('GPT-4.1 contributes cost at the published per-token rate (no zero special-case)', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: {
          interactions: 0,
          modelUsage: {},
          modelInteractions: {},
        },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: {
          interactions: 1,
          modelUsage: {
            'gpt-4.1': {
              ...emptyTokens(),
              inputTokens: 1_000_000,
            },
          },
          modelInteractions: { 'gpt-4.1': 1 },
        },
      },
    ]);
    await tracker.update();
    expect(tracker.getStats().models['gpt-4.1'].costAic).toBeCloseTo(200, 6);
    tracker.dispose();
  });

  it('GPT-5 mini contributes cost at the published per-token rate', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 0, modelUsage: {}, modelInteractions: {} },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: {
          interactions: 1,
          modelUsage: {
            'gpt-5-mini': {
              ...emptyTokens(),
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
            },
          },
          modelInteractions: { 'gpt-5-mini': 1 },
        },
      },
    ]);
    await tracker.update();
    expect(tracker.getStats().models['gpt-5-mini'].costAic).toBeCloseTo(
      (0.25 + 2.0) * 100,
      6,
    );
    tracker.dispose();
  });
});

describe('Tracker — mixed-model session', () => {
  it('aggregates Anthropic + OpenAI side-by-side with independent costs', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 0, modelUsage: {}, modelInteractions: {} },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: {
          interactions: 2,
          modelUsage: {
            'claude-sonnet-4.6': {
              ...emptyTokens(),
              inputTokens: 500_000,
              outputTokens: 100_000,
              cacheReadTokens: 1_000_000,
              cacheCreationTokens: 50_000,
            },
            'gpt-4.1': {
              ...emptyTokens(),
              inputTokens: 200_000,
              outputTokens: 50_000,
            },
          },
          modelInteractions: { 'claude-sonnet-4.6': 1, 'gpt-4.1': 1 },
        },
      },
    ]);
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
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 0, modelUsage: {}, modelInteractions: {} },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: {
          interactions: 1,
          modelUsage: {
            'claude-sonnet-4.6': {
              inputTokens: 100,
              outputTokens: 200,
              cacheReadTokens: 400,
              cacheCreationTokens: 50,
            },
          },
          modelInteractions: { 'claude-sonnet-4.6': 1 },
        },
      },
    ]);
    await tracker.update();
    expect(tracker.getStats().totalTokens).toBe(100 + 200 + 400 + 50);
    tracker.dispose();
  });
});

describe('Tracker — restored stats merge', () => {
  it('adds previousStats values to the live delta', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 0, modelUsage: {}, modelInteractions: {} },
      },
    ]);

    const tracker = new Tracker(STUB_STORAGE_URI);
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

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: {
          interactions: 2,
          modelUsage: {
            'claude-sonnet-4.6': {
              inputTokens: 50,
              outputTokens: 25,
              cacheReadTokens: 100,
              cacheCreationTokens: 5,
            },
          },
          modelInteractions: { 'claude-sonnet-4.6': 2 },
        },
      },
    ]);
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

  it('reset() clears previousStats and resets baseline', async () => {
    setupEmptyDiscovery();
    const tracker = new Tracker(STUB_STORAGE_URI);
    tracker.setPreviousStats({
      since: '2026-04-01T00:00:00.000Z',
      interactions: 5,
      models: {
        'gpt-4.1': {
          ...emptyTokens(),
          inputTokens: 1000,
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
    // the hook truncates the file. Before consume() runs, a new Copilot
    // turn lands. A full reset would absorb that turn into the new baseline
    // and silently drop it. consume() rebases to S_update so the new turn
    // shows up as the next commit's delta.
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: {
          interactions: 0,
          modelUsage: {},
          modelInteractions: {},
        },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: {
          interactions: 2,
          modelUsage: {
            'gpt-4.1': {
              ...emptyTokens(),
              inputTokens: 1000,
              outputTokens: 500,
            },
          },
          modelInteractions: { 'gpt-4.1': 2 },
        },
      },
    ]);
    await tracker.update();
    const consumedStats = tracker.getStats();
    expect(consumedStats.interactions).toBe(2);
    expect(consumedStats.models['gpt-4.1'].inputTokens).toBe(1000);

    // New activity lands between the commit (consumed `consumedStats`) and
    // the truncation-detection running consume().
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 3000,
        content: '{}',
        parseResult: {
          interactions: 3,
          modelUsage: {
            'gpt-4.1': {
              ...emptyTokens(),
              inputTokens: 1300,
              outputTokens: 600,
            },
          },
          modelInteractions: { 'gpt-4.1': 3 },
        },
      },
    ]);

    await tracker.consume();
    const postConsume = tracker.getStats();
    // The 300 input + 100 output that landed after the consumed update
    // must survive into the next delta. A reset()-style rescan would zero
    // it out.
    expect(postConsume.interactions).toBe(1);
    expect(postConsume.models['gpt-4.1'].inputTokens).toBe(300);
    expect(postConsume.models['gpt-4.1'].outputTokens).toBe(100);
    tracker.dispose();
  });

  it('consume() zeros stats when nothing happened after the last update', async () => {
    // The common case: hook fires, truncation poll detects it before any
    // new Copilot activity. consume() should produce the same zero-stats
    // state as reset() would.
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: {
          interactions: 1,
          modelUsage: {
            'gpt-4.1': { ...emptyTokens(), inputTokens: 500 },
          },
          modelInteractions: { 'gpt-4.1': 1 },
        },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
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
    setupEmptyDiscovery();
    const tracker = new Tracker(STUB_STORAGE_URI);
    tracker.setPreviousStats({
      since: '2026-04-01T00:00:00.000Z',
      interactions: 5,
      models: {
        'gpt-4.1': {
          ...emptyTokens(),
          inputTokens: 1000,
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

describe('Tracker — getFileDiagnostics', () => {
  it('flags files present at initialize as inBaseline and new files as not', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: {
          interactions: 2,
          modelUsage: {
            'gpt-4.1': { ...emptyTokens(), inputTokens: 500, outputTokens: 100 },
          },
          modelInteractions: { 'gpt-4.1': 2 },
        },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();

    // File b appears after initialize — its entire content (including the
    // very first request) should attribute to the session delta, and
    // getFileDiagnostics should mark it inBaseline: false.
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: {
          interactions: 2,
          modelUsage: {
            'gpt-4.1': { ...emptyTokens(), inputTokens: 500, outputTokens: 100 },
          },
          modelInteractions: { 'gpt-4.1': 2 },
        },
      },
      {
        path: '/sessions/b.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: {
          interactions: 1,
          modelUsage: {
            'claude-sonnet-4.6': {
              ...emptyTokens(),
              inputTokens: 300,
              outputTokens: 50,
            },
          },
          modelInteractions: { 'claude-sonnet-4.6': 1 },
        },
      },
    ]);
    await tracker.update();

    const diag = tracker.getFileDiagnostics();
    expect(diag).toHaveLength(2);

    const a = diag.find((f) => f.path === '/sessions/a.jsonl')!;
    expect(a.inBaseline).toBe(true);
    expect(a.interactions).toBe(2);
    expect(a.modelUsage['gpt-4.1'].inputTokens).toBe(500);

    const b = diag.find((f) => f.path === '/sessions/b.jsonl')!;
    expect(b.inBaseline).toBe(false);
    expect(b.interactions).toBe(1);
    expect(b.modelUsage['claude-sonnet-4.6'].inputTokens).toBe(300);

    tracker.dispose();
  });

  it('returns an empty list before initialize', async () => {
    setupEmptyDiscovery();
    const tracker = new Tracker(STUB_STORAGE_URI);
    expect(tracker.getFileDiagnostics()).toEqual([]);
    tracker.dispose();
  });
});

describe('Tracker — mtime caching', () => {
  it('skips re-parsing unchanged files', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: {
          interactions: 1,
          modelUsage: {
            'gpt-4.1': { ...emptyTokens(), inputTokens: 100 },
          },
          modelInteractions: { 'gpt-4.1': 1 },
        },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();
    expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);

    await tracker.update();
    expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('re-parses when mtime changes', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 0, modelUsage: {}, modelInteractions: {} },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();
    expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: { interactions: 1, modelUsage: {}, modelInteractions: {} },
      },
    ]);
    await tracker.update();
    expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });

  it('evicts cache entries for deleted files', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 0, modelUsage: {}, modelInteractions: {} },
      },
      {
        path: '/sessions/b.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: { interactions: 0, modelUsage: {}, modelInteractions: {} },
      },
    ]);
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();
    expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(2);

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 0, modelUsage: {}, modelInteractions: {} },
      },
    ]);
    await tracker.update();
    expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });
});

describe('Tracker — periodic scanning', () => {
  it('calls update on interval', async () => {
    setupEmptyDiscovery();
    const tracker = new Tracker(STUB_STORAGE_URI);
    // Await start so the setInterval is installed before we advance fake
    // timers — start() is async (it awaits the initial scan) and would
    // otherwise still be in its microtask when advanceTimersByTime runs.
    await tracker.start(60_000);
    expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledTimes(2);

    tracker.stop();
    jest.advanceTimersByTime(60_000);
    expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });
});

describe('Tracker — error handling', () => {
  it('skips files that fail stat', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue([
      '/sessions/good.jsonl',
      '/sessions/bad.jsonl',
    ]);
    mockFs.statSync.mockImplementation((p: fs.PathLike) => {
      if (p.toString() === '/sessions/bad.jsonl') throw new Error('ENOENT');
      return { mtimeMs: 1000 } as fs.Stats;
    });
    mockFs.readFileSync.mockReturnValue('{}' as any);
    mockParser.parseSessionFileContent.mockReturnValue({
      interactions: 0,
      modelUsage: {},
      modelInteractions: {},
    });
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();
    expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('skips files that fail to read', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    mockFs.statSync.mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();
    expect(tracker.getStats().totalTokens).toBe(0);
    tracker.dispose();
  });
});

describe('Tracker — cache persistence across mtime filter', () => {
  // Once a file is in the cache it contributed to baseline; if discovery later
  // filters it out (aged past sessionMaxAgeDays), we must keep scanning it so
  // its tokens don't silently drop out of `current` and skew the delta.
  it('keeps scanning a cached file even after discovery stops returning it', async () => {
    const aFile = '/sessions/a.jsonl';
    const usage = {
      'gpt-4.1': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };
    setupFiles([
      {
        path: aFile,
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 1, modelUsage: usage, modelInteractions: { 'gpt-4.1': 1 } },
      },
    ]);

    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();
    expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);

    // Discovery filters the file out (e.g. it aged past sessionMaxAgeDays),
    // but the underlying file is still on disk. statSync still resolves.
    mockDiscovery.discoverSessionFiles.mockReturnValue([]);
    await tracker.update();

    // Cached file still consulted via statSync — no re-parse since mtime
    // unchanged, but the file's contribution survives in `current`.
    expect(mockFs.statSync).toHaveBeenCalledWith(aFile);
    expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('evicts a cached file from the cache when statSync fails (file deleted)', async () => {
    const aFile = '/sessions/a.jsonl';
    setupFiles([
      {
        path: aFile,
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 1, modelUsage: {}, modelInteractions: {} },
      },
    ]);

    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();
    expect(tracker.getFileDiagnostics()).toHaveLength(1);

    // File deleted from disk; discovery also drops it.
    mockDiscovery.discoverSessionFiles.mockReturnValue([]);
    mockFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    await tracker.update();

    expect(tracker.getFileDiagnostics()).toHaveLength(0);
    tracker.dispose();
  });
});

describe('Tracker — dispose', () => {
  it('clears timer, listeners, and cache', async () => {
    setupEmptyDiscovery();
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.start(60_000);
    tracker.dispose();
    jest.advanceTimersByTime(120_000);
    expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledTimes(1);
  });

  it('does not install the poll timer when disposed mid-start', async () => {
    // dispose() can land between activate() kicking off the fire-and-forget
    // start() and the initial scan resolving. Without the disposed-flag check
    // in start(), setInterval would be installed on a disposed tracker and
    // leak forever.
    setupEmptyDiscovery();
    const tracker = new Tracker(STUB_STORAGE_URI);
    const startPromise = tracker.start(60_000);
    tracker.dispose();
    await startPromise;

    const beforeAdvance = mockDiscovery.discoverSessionFiles.mock.calls.length;
    jest.advanceTimersByTime(180_000);
    expect(mockDiscovery.discoverSessionFiles.mock.calls.length).toBe(beforeAdvance);
  });
});

describe('Tracker — storageUri threading', () => {
  it('passes the stored storageUri to discoverSessionFiles on scan', async () => {
    setupEmptyDiscovery();
    const tracker = new Tracker(STUB_STORAGE_URI);
    await tracker.initialize();
    expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledWith(STUB_STORAGE_URI);
    tracker.dispose();
  });

  it('passes undefined to discoverSessionFiles when no storageUri given', async () => {
    setupEmptyDiscovery();
    const tracker = new Tracker(undefined);
    await tracker.initialize();
    expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledWith(undefined);
    tracker.dispose();
  });

  it('reports zero stats when storageUri is undefined and discovery returns empty', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue([]);
    const tracker = new Tracker(undefined);
    await tracker.initialize();
    const stats = tracker.getStats();
    expect(stats.interactions).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.totalAiCredits).toBe(0);
    expect(stats.models).toEqual({});
    tracker.dispose();
  });
});
