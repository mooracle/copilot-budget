import {
  Tracker,
  TrackingStats,
  ModelStats,
  JsonlSource,
  OTelSource,
  Source,
  RawAggregateBatch,
} from './tracker';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as sessionDiscovery from './sessionDiscovery';
import * as sessionParser from './sessionParser';
import * as tokenRates from './tokenRates';
import { OTelReader, SpanRow } from './otelReader';

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
  // share `content: '{}'`, so the tag is what makes them distinct. The
  // trailing newline keeps the fixture realistic — the tracker's full
  // re-parse path now only parses lines that have a terminating \n.
  const tagged = files.map((f, i) => ({
    ...f,
    taggedContent: `${f.content}\n#file=${i}\n`,
  }));

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

  // Stateful parser mocks. applyDeltaLines stashes the lines it was given on
  // the state so aggregateFromState can route to the right fixture by exact
  // line-array match. Task 3 incremental tests build on this layer.
  mockParser.createParserState.mockImplementation(() => ({
    sessionState: Object.create(null),
  }));

  mockParser.applyDeltaLines.mockImplementation((lines, state) => {
    const s = state as unknown as { __lines?: string[]; hasReceivedDelta?: boolean };
    if (!Array.isArray(s.__lines)) s.__lines = [];
    for (const line of lines) s.__lines.push(line);
    // Mirror the real parser: flip hasReceivedDelta=true once at least one
    // line has been applied. Tracker uses this flag to decide whether to
    // preserve incremental state after a full re-parse — without the flip
    // it would treat every successful parse as "rejected".
    if (lines.length > 0) s.hasReceivedDelta = true;
    return state;
  });

  mockParser.aggregateFromState.mockImplementation((state) => {
    const lines = (state as unknown as { __lines?: string[] }).__lines ?? [];
    for (const f of tagged) {
      const fLines = f.taggedContent.split(/\r?\n/).filter((l) => l.trim());
      if (
        fLines.length === lines.length &&
        fLines.every((l, i) => l === lines[i])
      ) {
        return f.parseResult;
      }
    }
    return { interactions: 0, modelUsage: {}, modelInteractions: {} };
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
  // OTelSource calls stripModelPrefix + normalizeModelId on each span. With
  // the module mocked, default to the same lowercase-and-trim + known-prefix
  // strip shape the real impls produce so assertions can compare against
  // known model ids.
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

describe('Tracker — initial state', () => {
  it('returns zero stats before initialize', async () => {
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);

    await tracker.update();
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 2000,
        content: '{}',
        parseResult: { interactions: 1, modelUsage: {}, modelInteractions: {} },
      },
    ]);
    await tracker.update();
    expect(mockParser.createParserState).toHaveBeenCalledTimes(2);
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    expect(mockParser.createParserState).toHaveBeenCalledTimes(2);

    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 0, modelUsage: {}, modelInteractions: {} },
      },
    ]);
    await tracker.update();
    expect(mockParser.createParserState).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });
});

describe('Tracker — parser state cache', () => {
  it('creates a non-null parserState and sets lastOffset to content length on first scan', async () => {
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();

    // Tagged content the readFileSync mock returns is `{}\n#file=0\n`.
    const expectedContent = `{}\n#file=0\n`;
    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<string, { lastOffset: number; parserState: unknown; interactions: number }>;
    }).fileCache;
    const entry = cache.get('/sessions/a.jsonl');
    expect(entry).toBeDefined();
    expect(entry!.parserState).not.toBeNull();
    expect(entry!.lastOffset).toBe(expectedContent.length);
    expect(entry!.interactions).toBe(1);

    // Pipeline was driven once: fresh state, lines applied, then aggregated.
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(1);
    const [linesArg] = mockParser.applyDeltaLines.mock.calls[0];
    expect(linesArg).toEqual(['{}', '#file=0']);
    expect(mockParser.aggregateFromState).toHaveBeenCalledTimes(1);

    tracker.dispose();
  });

  it('does not re-run the parser when mtime is unchanged on the next scan', async () => {
    setupFiles([
      {
        path: '/sessions/a.jsonl',
        mtime: 1000,
        content: '{}',
        parseResult: { interactions: 0, modelUsage: {}, modelInteractions: {} },
      },
    ]);
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(1);
    expect(mockParser.aggregateFromState).toHaveBeenCalledTimes(1);

    await tracker.update();
    // Same mtime → cache hit → no parser activity at all.
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(1);
    expect(mockParser.aggregateFromState).toHaveBeenCalledTimes(1);

    tracker.dispose();
  });
});

describe('Tracker — incremental parsing', () => {
  // Build a fresh parser-mock layer that records `applyDeltaLines` calls and
  // returns queued aggregates per `aggregateFromState` invocation. Lets each
  // test simulate "file grew" scenarios without the line-matching gymnastics
  // of setupFiles (which retags every file on every call and breaks once a
  // parserState is reused across scans).
  function setupIncrementalParser() {
    const aggregates: ReturnType<typeof sessionParser.aggregateFromState>[] = [];
    let aggIdx = 0;

    mockParser.createParserState.mockImplementation(() => ({
      sessionState: Object.create(null),
    }));
    mockParser.applyDeltaLines.mockImplementation((lines, state) => {
      // Match the real parser's hasReceivedDelta flip so the tracker keeps
      // the parserState after a successful full re-parse.
      if (lines.length > 0) {
        (state as unknown as { hasReceivedDelta?: boolean }).hasReceivedDelta = true;
      }
      return state;
    });
    mockParser.aggregateFromState.mockImplementation(() => {
      const next = aggregates[aggIdx] ?? {
        interactions: 0,
        modelUsage: {},
        modelInteractions: {},
      };
      aggIdx += 1;
      return next;
    });

    return {
      queue: (r: ReturnType<typeof sessionParser.aggregateFromState>) =>
        aggregates.push(r),
    };
  }

  function queueScan(mtime: number, content: string) {
    mockFs.statSync.mockReturnValueOnce({ mtimeMs: mtime } as fs.Stats);
    mockFs.readFileSync.mockReturnValueOnce(content as never);
  }

  it('passes only the new tail to applyDeltaLines when the file grew', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    const parser = setupIncrementalParser();
    parser.queue({
      interactions: 1,
      modelUsage: {
        'gpt-4.1': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      modelInteractions: { 'gpt-4.1': 1 },
    });
    parser.queue({
      interactions: 2,
      modelUsage: {
        'gpt-4.1': {
          inputTokens: 200,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      modelInteractions: { 'gpt-4.1': 2 },
    });
    queueScan(1000, 'line1\nline2\n');
    queueScan(2000, 'line1\nline2\nline3\nline4\n');

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(1);
    expect(mockParser.applyDeltaLines.mock.calls[0][0]).toEqual(['line1', 'line2']);

    await tracker.update();

    // Incremental: parserState reused (no new create), only the new tail
    // passed in.
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(2);
    expect(mockParser.applyDeltaLines.mock.calls[1][0]).toEqual(['line3', 'line4']);
    // Reused state: argument identity matches the one from scan 1.
    expect(mockParser.applyDeltaLines.mock.calls[1][1]).toBe(
      mockParser.applyDeltaLines.mock.calls[0][1],
    );

    const stats = tracker.getStats();
    expect(stats.interactions).toBe(1); // 2 current - 1 baseline
    expect(stats.models['gpt-4.1'].inputTokens).toBe(100);
    expect(stats.models['gpt-4.1'].outputTokens).toBe(50);

    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<string, { lastOffset: number; parserState: unknown }>;
    }).fileCache;
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe(
      'line1\nline2\nline3\nline4\n'.length,
    );
    tracker.dispose();
  });

  it('falls back to full re-parse when the file is truncated', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    const parser = setupIncrementalParser();
    parser.queue({ interactions: 3, modelUsage: {}, modelInteractions: {} });
    parser.queue({ interactions: 1, modelUsage: {}, modelInteractions: {} });
    queueScan(1000, 'a\nb\nc\n');
    queueScan(2000, 'a\n');

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    const stateBefore = mockParser.applyDeltaLines.mock.calls[0][1];
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);

    await tracker.update();

    // Full re-parse: a fresh parserState is created and all lines from index 0
    // are passed in.
    expect(mockParser.createParserState).toHaveBeenCalledTimes(2);
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(2);
    expect(mockParser.applyDeltaLines.mock.calls[1][0]).toEqual(['a']);
    expect(mockParser.applyDeltaLines.mock.calls[1][1]).not.toBe(stateBefore);

    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<string, { lastOffset: number }>;
    }).fileCache;
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe(2);
    tracker.dispose();
  });

  it('falls back to full re-parse on same-size in-place rewrite', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    const parser = setupIncrementalParser();
    parser.queue({ interactions: 0, modelUsage: {}, modelInteractions: {} });
    parser.queue({ interactions: 1, modelUsage: {}, modelInteractions: {} });
    queueScan(1000, 'aaa\n');
    queueScan(2000, 'bbb\n');

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    const stateBefore = mockParser.applyDeltaLines.mock.calls[0][1];
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);

    await tracker.update();

    // size === lastOffset (4 === 4) with changed mtime → full re-parse, not
    // incremental.
    expect(mockParser.createParserState).toHaveBeenCalledTimes(2);
    expect(mockParser.applyDeltaLines.mock.calls[1][0]).toEqual(['bbb']);
    expect(mockParser.applyDeltaLines.mock.calls[1][1]).not.toBe(stateBefore);
    tracker.dispose();
  });

  it('holds off parsing a first-scan partial line until its completion arrives', async () => {
    // Regression: previously the full re-parse path advanced lastOffset to
    // content.length even when content ended mid-line. The partial line was
    // fed to applyDeltaLines (silently dropped by JSON.parse), and on the
    // next scan only the completion *suffix* was parsed — the original
    // request's tokens were lost. The fix mirrors the incremental branch's
    // atomicity guarantee: only parse up to the last complete \n.
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    const parser = setupIncrementalParser();
    parser.queue({ interactions: 0, modelUsage: {}, modelInteractions: {} });
    parser.queue({ interactions: 1, modelUsage: {}, modelInteractions: {} });
    // Scan 1 catches the file mid-write: "good\n" complete, "partial" not.
    queueScan(1000, 'good\npartial');
    queueScan(2000, 'good\npartial-completed\nnext\n');

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    // Only the complete "good" line was parsed; the partial trailing line
    // was held back, not fed to the parser.
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(1);
    expect(mockParser.applyDeltaLines.mock.calls[0][0]).toEqual(['good']);

    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<string, { lastOffset: number }>;
    }).fileCache;
    // lastOffset stops after the last \n, not at content.length.
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe('good\n'.length);

    await tracker.update();

    // Incremental tail starts where scan 1 stopped, so the completion bytes
    // arrive as one atomic line plus the new "next" line.
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(2);
    expect(mockParser.applyDeltaLines.mock.calls[1][0]).toEqual([
      'partial-completed',
      'next',
    ]);
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe(
      'good\npartial-completed\nnext\n'.length,
    );
    tracker.dispose();
  });

  it('holds off parsing when the appended tail has no trailing newline, then parses on completion', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    const parser = setupIncrementalParser();
    parser.queue({ interactions: 0, modelUsage: {}, modelInteractions: {} });
    // Scan 2 (partial) shouldn't aggregate — no queue entry consumed.
    parser.queue({ interactions: 2, modelUsage: {}, modelInteractions: {} });
    queueScan(1000, 'a\n');
    queueScan(2000, 'a\nbpartial');
    queueScan(3000, 'a\nbpartial-complete\nmore\n');

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(1);
    expect(mockParser.applyDeltaLines.mock.calls[0][0]).toEqual(['a']);

    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<string, { lastOffset: number; mtime: number }>;
    }).fileCache;
    const offsetAfterScan1 = cache.get('/sessions/a.jsonl')!.lastOffset;
    expect(offsetAfterScan1).toBe(2);

    // Scan 2: appended bytes have no trailing \n. Parser must NOT be called,
    // lastOffset must NOT advance, and mtime must be bumped so we don't loop.
    await tracker.update();
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(1);
    expect(mockParser.aggregateFromState).toHaveBeenCalledTimes(1);
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe(offsetAfterScan1);
    expect(cache.get('/sessions/a.jsonl')!.mtime).toBe(2000);

    // Scan 3: completion + more. Now the originally-partial line parses
    // exactly once (in its completed form) alongside the new line.
    await tracker.update();
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(2);
    expect(mockParser.applyDeltaLines.mock.calls[1][0]).toEqual([
      'bpartial-complete',
      'more',
    ]);
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe(
      'a\nbpartial-complete\nmore\n'.length,
    );
    tracker.dispose();
  });

  it('keeps parserState across a pending→completed transition', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    const parser = setupIncrementalParser();
    // Scan 1: only a pending request is present, no interactions yet.
    parser.queue({ interactions: 0, modelUsage: {}, modelInteractions: {} });
    // Scan 2: completion lines flip the request to value=1.
    parser.queue({
      interactions: 1,
      modelUsage: {
        'gpt-4.1': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      modelInteractions: { 'gpt-4.1': 1 },
    });
    queueScan(1000, 'pending\n');
    queueScan(2000, 'pending\nresult\nmodelState\n');

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    const stateBefore = mockParser.applyDeltaLines.mock.calls[0][1];
    expect(tracker.getStats().interactions).toBe(0);

    await tracker.update();

    // Same parserState reused for the completion lines.
    expect(mockParser.applyDeltaLines.mock.calls[1][1]).toBe(stateBefore);
    expect(mockParser.applyDeltaLines.mock.calls[1][0]).toEqual([
      'result',
      'modelState',
    ]);
    const stats = tracker.getStats();
    expect(stats.interactions).toBe(1);
    expect(stats.models['gpt-4.1'].inputTokens).toBe(100);
    expect(stats.models['gpt-4.1'].outputTokens).toBe(50);
    tracker.dispose();
  });

  it('slices multi-byte content by code-units, not bytes (regression guard)', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    const parser = setupIncrementalParser();
    parser.queue({ interactions: 1, modelUsage: {}, modelInteractions: {} });
    parser.queue({ interactions: 2, modelUsage: {}, modelInteractions: {} });

    // `café 🎉` is 7 UTF-16 code units but 10 UTF-8 bytes. If the tracker
    // tracked offsets in bytes (e.g. via Buffer.byteLength) and then sliced
    // the string, the offset would land 3 chars early and corrupt the next
    // line's JSON envelope, dropping it from the parse.
    const scan1 = 'café 🎉\nline-one\n';
    const tailToAppend = '日本語 🚀\nline-two\n';
    const scan2 = scan1 + tailToAppend;
    queueScan(1000, scan1);
    queueScan(2000, scan2);

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<string, { lastOffset: number }>;
    }).fileCache;
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe(scan1.length);

    await tracker.update();

    // The new tail must equal exactly the appended slice — no surrogate-pair
    // split, no off-by-3 byte/code-unit mismatch.
    const expectedNewLines = tailToAppend
      .slice(0, tailToAppend.lastIndexOf('\n'))
      .split(/\r?\n/)
      .filter((l) => l.trim());
    expect(mockParser.applyDeltaLines.mock.calls[1][0]).toEqual(expectedNewLines);
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe(scan2.length);
    tracker.dispose();
  });

  it('drops parserState and resets lastOffset when full re-parse rejects the batch', async () => {
    // Regression: after a corrupted first line, the parser leaves
    // hasReceivedDelta=false. If the tracker still cached the un-primed
    // parserState and advanced lastOffset past the bad line, the next mtime
    // change would take the incremental path and feed only the appended
    // tail. The parser's still-fresh guard would then accept the first
    // appended kind:1/kind:2 line and fabricate a requests tree. The tracker
    // must detect rejection and refuse to cache the state.
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    const parser = setupIncrementalParser();

    // Scan 1: simulate rejection — applyDeltaLines does NOT flip
    // hasReceivedDelta. Aggregate is the empty session (parser returned 0).
    mockParser.applyDeltaLines.mockImplementationOnce((_lines, state) => state);
    parser.queue({ interactions: 0, modelUsage: {}, modelInteractions: {} });
    queueScan(1000, 'corrupted\n');

    // Scan 2: file appended. Tracker MUST run full re-parse (not incremental)
    // since scan 1 dropped the parserState. We simulate the corrupted prefix
    // still rejecting — the parser's first-line guard rejects again because
    // the first line is still "corrupted". Same rejection behavior expected.
    mockParser.applyDeltaLines.mockImplementationOnce((_lines, state) => state);
    parser.queue({ interactions: 0, modelUsage: {}, modelInteractions: {} });
    queueScan(2000, 'corrupted\nlater-line\n');

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();

    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<string, { lastOffset: number; parserState: unknown }>;
    }).fileCache;
    // After scan 1's rejection: parserState dropped, lastOffset reset.
    expect(cache.get('/sessions/a.jsonl')!.parserState).toBeNull();
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe(0);

    const lru = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      parserStateLru: string[];
    }).parserStateLru;
    expect(lru).not.toContain('/sessions/a.jsonl');

    await tracker.update();

    // Scan 2 took the full re-parse path again (parserState was null →
    // canIncremental=false). createParserState fires a second time; the
    // call gets the FULL content lines, not just the appended tail.
    expect(mockParser.createParserState).toHaveBeenCalledTimes(2);
    expect(mockParser.applyDeltaLines).toHaveBeenCalledTimes(2);
    expect(mockParser.applyDeltaLines.mock.calls[1][0]).toEqual([
      'corrupted',
      'later-line',
    ]);
    // Rejected again — parserState still null, lastOffset still 0.
    expect(cache.get('/sessions/a.jsonl')!.parserState).toBeNull();
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe(0);
    tracker.dispose();
  });

  it('clears prior LRU entry when a subsequent full re-parse rejects', async () => {
    // First scan accepts (state primed → LRU populated). A later in-place
    // rewrite gets rejected; the LRU entry must be cleared so the slot is
    // freed for other actively-incrementing files.
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    const parser = setupIncrementalParser();
    parser.queue({ interactions: 1, modelUsage: {}, modelInteractions: {} });
    parser.queue({ interactions: 0, modelUsage: {}, modelInteractions: {} });
    queueScan(1000, 'good\n');
    queueScan(2000, 'bad!\n'); // same length → falls to full re-parse branch

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    const lru = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      parserStateLru: string[];
    }).parserStateLru;
    expect(lru).toContain('/sessions/a.jsonl');

    // Override the second applyDeltaLines call to simulate rejection.
    mockParser.applyDeltaLines.mockImplementationOnce((_lines, state) => state);
    await tracker.update();

    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<string, { lastOffset: number; parserState: unknown }>;
    }).fileCache;
    expect(cache.get('/sessions/a.jsonl')!.parserState).toBeNull();
    expect(cache.get('/sessions/a.jsonl')!.lastOffset).toBe(0);
    expect(lru).not.toContain('/sessions/a.jsonl');
    tracker.dispose();
  });
});

describe('Tracker — parserState LRU eviction', () => {
  function fourFiles(mtime = 1000) {
    return ['a', 'b', 'c', 'd'].map((n, i) => ({
      path: `/sessions/${n}.jsonl`,
      mtime,
      content: '{}',
      parseResult: {
        interactions: i + 1,
        modelUsage: {
          'gpt-4.1': { ...emptyTokens(), inputTokens: 100 * (i + 1) },
        },
        modelInteractions: { 'gpt-4.1': i + 1 },
      },
    }));
  }

  it('caps parserState retention at 3 entries; oldest evicted, aggregate preserved', async () => {
    // Files are processed in array order, so a is touched first and becomes
    // the LRU head. After d is touched, length=4>cap → a evicted.
    setupFiles(fourFiles());

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();

    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<
        string,
        { parserState: unknown; interactions: number; modelUsage: any }
      >;
    }).fileCache;

    expect(cache.get('/sessions/a.jsonl')!.parserState).toBeNull();
    expect(cache.get('/sessions/b.jsonl')!.parserState).not.toBeNull();
    expect(cache.get('/sessions/c.jsonl')!.parserState).not.toBeNull();
    expect(cache.get('/sessions/d.jsonl')!.parserState).not.toBeNull();

    // Evicted file's aggregate survives eviction unchanged.
    const a = cache.get('/sessions/a.jsonl')!;
    expect(a.interactions).toBe(1);
    expect(a.modelUsage['gpt-4.1'].inputTokens).toBe(100);

    tracker.dispose();
  });

  it('re-installs parserState via full re-parse when an evicted file changes', async () => {
    setupFiles(fourFiles());

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();

    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<string, { parserState: unknown }>;
    }).fileCache;
    expect(cache.get('/sessions/a.jsonl')!.parserState).toBeNull();

    // Bump a's mtime — full re-parse runs since parserState was evicted.
    // LRU rotates: a goes to tail, b becomes the new head and gets evicted.
    const refreshed = fourFiles().map((f) =>
      f.path === '/sessions/a.jsonl' ? { ...f, mtime: 2000 } : f,
    );
    setupFiles(refreshed);
    await tracker.update();

    expect(cache.get('/sessions/a.jsonl')!.parserState).not.toBeNull();
    expect(cache.get('/sessions/b.jsonl')!.parserState).toBeNull();
    expect(cache.get('/sessions/c.jsonl')!.parserState).not.toBeNull();
    expect(cache.get('/sessions/d.jsonl')!.parserState).not.toBeNull();

    // b's aggregate is unchanged after eviction.
    const b = (cache.get('/sessions/b.jsonl')! as unknown as {
      interactions: number;
      modelUsage: any;
    });
    expect(b.interactions).toBe(2);
    expect(b.modelUsage['gpt-4.1'].inputTokens).toBe(200);
    tracker.dispose();
  });

  it('preserves getFileDiagnostics() output across LRU eviction', async () => {
    setupFiles(fourFiles());

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();

    const diag = tracker.getFileDiagnostics();
    expect(diag).toHaveLength(4);

    const a = diag.find((d) => d.path === '/sessions/a.jsonl')!;
    expect(a.interactions).toBe(1);
    expect(a.modelInteractions).toEqual({ 'gpt-4.1': 1 });
    expect(a.modelUsage['gpt-4.1'].inputTokens).toBe(100);
    expect(a.inBaseline).toBe(true);

    const d = diag.find((d) => d.path === '/sessions/d.jsonl')!;
    expect(d.interactions).toBe(4);
    expect(d.modelUsage['gpt-4.1'].inputTokens).toBe(400);
    expect(d.inBaseline).toBe(true);

    tracker.dispose();
  });

  it('drops evicted-file LRU entry when the file is deleted', async () => {
    // Cover the statSync-fail eviction path: it must also clear parserStateLru
    // so a later re-creation doesn't end up double-tracked.
    setupFiles(fourFiles());

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();

    const lru = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      parserStateLru: string[];
    }).parserStateLru;
    expect(lru).toEqual(['/sessions/b.jsonl', '/sessions/c.jsonl', '/sessions/d.jsonl']);

    // Delete b: discovery drops it AND statSync throws for that path.
    mockDiscovery.discoverSessionFiles.mockReturnValue([
      '/sessions/a.jsonl',
      '/sessions/c.jsonl',
      '/sessions/d.jsonl',
    ]);
    mockFs.statSync.mockImplementation((p: fs.PathLike) => {
      if (p.toString() === '/sessions/b.jsonl') throw new Error('ENOENT');
      return { mtimeMs: 1000 } as fs.Stats;
    });

    await tracker.update();

    expect(lru).toEqual(['/sessions/c.jsonl', '/sessions/d.jsonl']);
    const cache = ((tracker as unknown as { source: JsonlSource }).source as unknown as {
      fileCache: Map<string, unknown>;
    }).fileCache;
    expect(cache.has('/sessions/b.jsonl')).toBe(false);
    tracker.dispose();
  });
});

describe('Tracker — periodic scanning', () => {
  it('calls update on interval', async () => {
    setupEmptyDiscovery();
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    mockParser.createParserState.mockReturnValue({ sessionState: {} });
    mockParser.applyDeltaLines.mockImplementation((lines, state) => {
      if (lines.length > 0) {
        (state as unknown as { hasReceivedDelta?: boolean }).hasReceivedDelta = true;
      }
      return state;
    });
    mockParser.aggregateFromState.mockReturnValue({
      interactions: 0,
      modelUsage: {},
      modelInteractions: {},
    });
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('skips files that fail to read', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue(['/sessions/a.jsonl']);
    mockFs.statSync.mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);

    // Discovery filters the file out (e.g. it aged past sessionMaxAgeDays),
    // but the underlying file is still on disk. statSync still resolves.
    mockDiscovery.discoverSessionFiles.mockReturnValue([]);
    await tracker.update();

    // Cached file still consulted via statSync — no re-parse since mtime
    // unchanged, but the file's contribution survives in `current`.
    expect(mockFs.statSync).toHaveBeenCalledWith(aFile);
    expect(mockParser.createParserState).toHaveBeenCalledTimes(1);
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

    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
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
    const tracker = new Tracker(new JsonlSource(STUB_STORAGE_URI), 'files');
    await tracker.initialize();
    expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledWith(STUB_STORAGE_URI);
    tracker.dispose();
  });

  it('passes undefined to discoverSessionFiles when no storageUri given', async () => {
    setupEmptyDiscovery();
    const tracker = new Tracker(new JsonlSource(undefined), 'files');
    await tracker.initialize();
    expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledWith(undefined);
    tracker.dispose();
  });

  it('reports zero stats when storageUri is undefined and discovery returns empty', async () => {
    mockDiscovery.discoverSessionFiles.mockReturnValue([]);
    const tracker = new Tracker(new JsonlSource(undefined), 'files');
    await tracker.initialize();
    const stats = tracker.getStats();
    expect(stats.interactions).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.totalAiCredits).toBe(0);
    expect(stats.models).toEqual({});
    tracker.dispose();
  });
});

describe('Tracker — Source strategy', () => {
  // Tracker is source-agnostic: it delegates discovery+parse to the injected
  // Source and only handles baseline/delta arithmetic. A bare in-memory mock
  // satisfying the Source interface should drive every Tracker code path
  // (initialize, update, dispose) without touching fs, discovery, or parser
  // mocks. This is the contract Task 5b's OTelSource will rely on.
  function makeMockSource(batches: RawAggregateBatch[]): Source & {
    scan: jest.Mock<Promise<RawAggregateBatch>, []>;
    dispose: jest.Mock<void, []>;
  } {
    let idx = 0;
    const scan = jest.fn(async () => {
      const next =
        batches[idx] ??
        ({ interactions: 0, modelUsage: {}, modelInteractions: {} } as RawAggregateBatch);
      idx += 1;
      return next;
    });
    const dispose = jest.fn();
    return { scan, dispose };
  }

  it('initialize calls source.scan exactly once and zeros the delta', async () => {
    const source = makeMockSource([
      {
        interactions: 5,
        modelUsage: {
          'gpt-4.1': {
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
        modelInteractions: { 'gpt-4.1': 5 },
      },
    ]);
    const tracker = new Tracker(source, 'files');
    await tracker.initialize();

    expect(source.scan).toHaveBeenCalledTimes(1);
    const stats = tracker.getStats();
    // Initial scan becomes the baseline → delta is zero.
    expect(stats.totalTokens).toBe(0);
    expect(stats.interactions).toBe(0);
    expect(stats.totalAiCredits).toBe(0);
    expect(stats.models).toEqual({});
    tracker.dispose();
  });

  it('update calls source.scan again and surfaces the delta', async () => {
    const source = makeMockSource([
      {
        interactions: 0,
        modelUsage: {},
        modelInteractions: {},
      },
      {
        interactions: 1,
        modelUsage: {
          'gpt-4.1': {
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
        modelInteractions: { 'gpt-4.1': 1 },
      },
    ]);
    const tracker = new Tracker(source, 'files');
    await tracker.initialize();
    expect(source.scan).toHaveBeenCalledTimes(1);

    await tracker.update();
    expect(source.scan).toHaveBeenCalledTimes(2);

    const stats = tracker.getStats();
    expect(stats.interactions).toBe(1);
    expect(stats.models['gpt-4.1'].inputTokens).toBe(1_000_000);
    expect(stats.totalAiCredits).toBeCloseTo(200, 6);
    tracker.dispose();
  });

  it('dispose forwards to source.dispose', async () => {
    const source = makeMockSource([
      { interactions: 0, modelUsage: {}, modelInteractions: {} },
    ]);
    const tracker = new Tracker(source, 'files');
    await tracker.initialize();
    tracker.dispose();
    expect(source.dispose).toHaveBeenCalledTimes(1);
  });

  it('mode passed at construction is reflected in getStats', async () => {
    const source = makeMockSource([
      { interactions: 0, modelUsage: {}, modelInteractions: {} },
    ]);
    const filesTracker = new Tracker(source, 'files');
    await filesTracker.initialize();
    expect(filesTracker.mode).toBe('files');
    expect(filesTracker.getStats().mode).toBe('files');
    filesTracker.dispose();

    const telemetrySource = makeMockSource([
      { interactions: 0, modelUsage: {}, modelInteractions: {} },
    ]);
    const telemetryTracker = new Tracker(telemetrySource, 'telemetry');
    await telemetryTracker.initialize();
    expect(telemetryTracker.mode).toBe('telemetry');
    expect(telemetryTracker.getStats().mode).toBe('telemetry');
    telemetryTracker.dispose();
  });

  it('getFileDiagnostics returns [] for a non-JSONL Source', async () => {
    // OTelSource won't have per-file granularity (it's per-span). Tracker
    // must return an empty list for any Source that isn't a JsonlSource
    // rather than crashing or throwing.
    const source = makeMockSource([
      { interactions: 0, modelUsage: {}, modelInteractions: {} },
    ]);
    const tracker = new Tracker(source, 'telemetry');
    await tracker.initialize();
    expect(tracker.getFileDiagnostics()).toEqual([]);
    tracker.dispose();
  });
});

describe('OTelSource', () => {
  function makeMockReader(opts: {
    latest?: number;
    spans?: SpanRow[];
    isAvailable?: boolean;
  }): jest.Mocked<OTelReader> {
    return {
      isAvailable: jest.fn(() => opts.isAvailable ?? true),
      readSpansSince: jest.fn((_sinceMs: number, _sessionIds: string[] | null) =>
        opts.spans ?? [],
      ),
      getLatestTimestamp: jest.fn(() => opts.latest ?? 0),
      close: jest.fn(),
    } as jest.Mocked<OTelReader>;
  }

  function span(overrides: Partial<SpanRow> = {}): SpanRow {
    return {
      sessionId: 'session-A',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      startTimeMs: 1_000,
      endTimeMs: 1_500,
      ...overrides,
    };
  }

  it('captures baseline timestamp at construction via getLatestTimestamp', () => {
    const reader = makeMockReader({ latest: 12_345 });
    const sessionIdsFn = jest.fn(() => ['session-A']);
    new OTelSource(reader, sessionIdsFn);
    expect(reader.getLatestTimestamp).toHaveBeenCalledTimes(1);
  });

  it('passes the construction-time baseline and resolver-provided session ids to readSpansSince', async () => {
    const reader = makeMockReader({ latest: 5_000 });
    const sessionIdsFn = jest.fn(() => ['session-A', 'session-B']);
    const src = new OTelSource(reader, sessionIdsFn);
    await src.scan();
    expect(sessionIdsFn).toHaveBeenCalled();
    expect(reader.readSpansSince).toHaveBeenCalledWith(5_000, [
      'session-A',
      'session-B',
    ]);
  });

  it('re-resolves session ids on each scan (delta correctness across scans)', async () => {
    const reader = makeMockReader({ latest: 0 });
    let snapshot: string[] = ['session-A'];
    const sessionIdsFn = jest.fn(() => snapshot);
    const src = new OTelSource(reader, sessionIdsFn);

    await src.scan();
    expect(reader.readSpansSince).toHaveBeenLastCalledWith(0, ['session-A']);

    snapshot = ['session-A', 'session-B'];
    await src.scan();
    expect(reader.readSpansSince).toHaveBeenLastCalledWith(0, [
      'session-A',
      'session-B',
    ]);
  });

  it('aggregates spans into per-model usage with cache splits honored', async () => {
    const reader = makeMockReader({
      spans: [
        span({
          model: 'gpt-4o',
          inputTokens: 1000,
          outputTokens: 200,
          cachedTokens: 600,
          cacheCreationTokens: 100,
        }),
        span({
          model: 'gpt-4o',
          inputTokens: 500,
          outputTokens: 80,
          cachedTokens: 0,
          cacheCreationTokens: 0,
        }),
        span({
          model: 'Claude-Sonnet-4.6',
          inputTokens: 2000,
          outputTokens: 500,
          cachedTokens: 1500,
          cacheCreationTokens: 200,
        }),
      ],
    });
    const src = new OTelSource(reader, () => ['session-A']);
    const batch = await src.scan();

    expect(batch.interactions).toBe(3);
    // Cache splits: pureInput = inputTokens - cachedTokens - cacheCreationTokens
    expect(batch.modelUsage['gpt-4o']).toEqual({
      inputTokens: 300 + 500, // (1000-600-100) + (500-0-0)
      outputTokens: 280,
      cacheReadTokens: 600,
      cacheCreationTokens: 100,
    });
    expect(batch.modelUsage['claude-sonnet-4.6']).toEqual({
      inputTokens: 300, // 2000-1500-200
      outputTokens: 500,
      cacheReadTokens: 1500,
      cacheCreationTokens: 200,
    });
    expect(batch.modelInteractions).toEqual({
      'gpt-4o': 2,
      'claude-sonnet-4.6': 1,
    });
  });

  it('clamps input tokens at 0 when cached + cache_creation exceed input (defensive)', async () => {
    const reader = makeMockReader({
      spans: [
        span({
          inputTokens: 100,
          cachedTokens: 80,
          cacheCreationTokens: 50,
        }),
      ],
    });
    const src = new OTelSource(reader, () => ['session-A']);
    const batch = await src.scan();
    expect(batch.modelUsage['gpt-4o'].inputTokens).toBe(0);
  });

  it('routes null model id to "unknown" rather than crashing', async () => {
    const reader = makeMockReader({
      spans: [span({ model: null, inputTokens: 100, outputTokens: 50 })],
    });
    const src = new OTelSource(reader, () => ['session-A']);
    const batch = await src.scan();
    expect(Object.keys(batch.modelUsage)).toEqual(['unknown']);
  });

  it('strips Copilot request-routing prefixes so keys match JsonlSource', async () => {
    // Without prefix strip, `copilot/gpt-4o` and `gpt-4o` would aggregate under
    // separate keys — splitting per-model totals after a Files→Telemetry swap
    // and exposing the prefix in panel labels.
    const reader = makeMockReader({
      spans: [
        span({ model: 'copilot/gpt-4o', inputTokens: 100, outputTokens: 50 }),
        span({ model: 'gpt-4o', inputTokens: 200, outputTokens: 100 }),
        span({
          model: 'copilotcli/Claude-Sonnet-4.6',
          inputTokens: 300,
          outputTokens: 150,
        }),
      ],
    });
    const src = new OTelSource(reader, () => ['session-A']);
    const batch = await src.scan();
    expect(Object.keys(batch.modelUsage).sort()).toEqual([
      'claude-sonnet-4.6',
      'gpt-4o',
    ]);
    expect(batch.modelInteractions['gpt-4o']).toBe(2);
  });

  it('returns empty batch when reader returns no spans', async () => {
    const reader = makeMockReader({ spans: [] });
    const src = new OTelSource(reader, () => ['session-A']);
    const batch = await src.scan();
    expect(batch.interactions).toBe(0);
    expect(batch.modelUsage).toEqual({});
    expect(batch.modelInteractions).toEqual({});
  });

  it('passes an empty session-id array verbatim (window has no JSONL companions yet)', async () => {
    // Per plan §172 — a span whose JSONL companion hasn't materialized yet is
    // excluded. The reader honors empty array as "filter to no sessions".
    const reader = makeMockReader({});
    const src = new OTelSource(reader, () => []);
    await src.scan();
    expect(reader.readSpansSince).toHaveBeenCalledWith(0, []);
  });

  it('dispose closes the reader', () => {
    const reader = makeMockReader({});
    const src = new OTelSource(reader, () => []);
    src.dispose();
    expect(reader.close).toHaveBeenCalledTimes(1);
  });

  it('integrates with Tracker — telemetry mode delta surfaces in stats', async () => {
    const reader = makeMockReader({
      latest: 1_000,
      spans: [],
    });
    const src = new OTelSource(reader, () => ['session-A']);
    const tracker = new Tracker(src, 'telemetry');
    await tracker.initialize();
    expect(tracker.getStats().totalTokens).toBe(0);
    expect(tracker.getStats().mode).toBe('telemetry');

    // Next scan: a chat span lands. Update should pick it up as delta.
    reader.readSpansSince.mockReturnValue([
      span({
        model: 'gpt-4o',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
      }),
    ]);
    await tracker.update();
    const stats = tracker.getStats();
    expect(stats.interactions).toBe(1);
    expect(stats.models['gpt-4o'].inputTokens).toBe(1_000_000);
    // gpt-4o rate isn't in the fixture; cost just needs to be non-negative.
    expect(stats.totalAiCredits).toBeGreaterThanOrEqual(0);
    tracker.dispose();
  });
});

describe('Tracker.swapSource', () => {
  function makeBatch(
    overrides: Partial<RawAggregateBatch> = {},
  ): RawAggregateBatch {
    return {
      interactions: 0,
      modelUsage: {},
      modelInteractions: {},
      ...overrides,
    };
  }

  function makeMockSource(batches: RawAggregateBatch[]): Source & {
    scan: jest.Mock<Promise<RawAggregateBatch>, []>;
    dispose: jest.Mock<void, []>;
  } {
    let idx = 0;
    const scan = jest.fn(async () => {
      const next = batches[idx] ?? makeBatch();
      idx += 1;
      return next;
    });
    const dispose = jest.fn();
    return { scan, dispose };
  }

  it('disposes the old source and adopts the new one', async () => {
    const oldSource = makeMockSource([makeBatch()]);
    const newSource = makeMockSource([makeBatch()]);
    const tracker = new Tracker(oldSource, 'files');
    await tracker.initialize();
    expect(oldSource.dispose).not.toHaveBeenCalled();

    await tracker.swapSource(newSource, 'telemetry');
    expect(oldSource.dispose).toHaveBeenCalledTimes(1);
    expect(newSource.scan).toHaveBeenCalledTimes(1);
    expect(tracker.mode).toBe('telemetry');
    expect(tracker.getStats().mode).toBe('telemetry');
    tracker.dispose();
    // The new source's dispose should also fire on tracker.dispose().
    expect(newSource.dispose).toHaveBeenCalledTimes(1);
  });

  it('preserves cumulative interactions and AIC across swap', async () => {
    // Files mode session accumulates some activity:
    //   baseline = 0; current = 1M input tokens on gpt-4.1 → 200 AIC (per fixture)
    const oldSource = makeMockSource([
      makeBatch(),
      makeBatch({
        interactions: 1,
        modelUsage: {
          'gpt-4.1': {
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
        modelInteractions: { 'gpt-4.1': 1 },
      }),
    ]);
    const tracker = new Tracker(oldSource, 'files');
    await tracker.initialize();
    await tracker.update();
    const preSwap = tracker.getStats();
    expect(preSwap.interactions).toBe(1);
    expect(preSwap.totalAiCredits).toBeCloseTo(200, 6);

    // Swap into Telemetry mode. New source contributes nothing initially.
    const newSource = makeMockSource([makeBatch()]);
    await tracker.swapSource(newSource, 'telemetry');

    const postSwap = tracker.getStats();
    // Cumulative interactions and AIC carry over via previousStats.
    expect(postSwap.interactions).toBe(1);
    expect(postSwap.totalAiCredits).toBeCloseTo(200, 6);
    expect(postSwap.models['gpt-4.1']?.inputTokens).toBe(1_000_000);
    expect(postSwap.mode).toBe('telemetry');
    tracker.dispose();
  });

  it('adds post-swap delta on top of carried-over cumulative', async () => {
    const oldSource = makeMockSource([
      makeBatch({
        interactions: 2,
        modelUsage: {
          'gpt-4.1': {
            inputTokens: 500_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
        modelInteractions: { 'gpt-4.1': 2 },
      }),
    ]);
    // initialize() sets baseline; lastStats reflects 0 delta but previousStats=null
    const tracker = new Tracker(oldSource, 'files');
    await tracker.initialize();
    // Force a stat with non-zero "previous session" carryover so the test
    // proves prior accumulation survives the swap.
    tracker.setPreviousStats({
      since: '2024-01-01T00:00:00Z',
      interactions: 2,
      models: {
        'gpt-4.1': {
          inputTokens: 500_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costAic: 100, // arbitrary fixture-aligned value
        },
      },
    });
    const preSwap = tracker.getStats();
    expect(preSwap.interactions).toBe(2);
    expect(preSwap.models['gpt-4.1'].inputTokens).toBe(500_000);

    // Swap with new source delivering additional measured activity.
    const newSource = makeMockSource([
      makeBatch({
        interactions: 0,
        modelUsage: {},
        modelInteractions: {},
      }),
      makeBatch({
        interactions: 3,
        modelUsage: {
          'gpt-4.1': {
            inputTokens: 200_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
        modelInteractions: { 'gpt-4.1': 3 },
      }),
    ]);
    await tracker.swapSource(newSource, 'telemetry');
    // First post-swap scan = baseline → carried-over total only.
    expect(tracker.getStats().interactions).toBe(2);

    await tracker.update();
    const final = tracker.getStats();
    // 2 (carried) + 3 (new) = 5 total interactions
    expect(final.interactions).toBe(5);
    expect(final.models['gpt-4.1'].inputTokens).toBe(500_000 + 200_000);
    tracker.dispose();
  });

  it('notifies listeners after swap completes', async () => {
    const oldSource = makeMockSource([makeBatch()]);
    const tracker = new Tracker(oldSource, 'files');
    await tracker.initialize();

    const listener = jest.fn();
    tracker.onStatsChanged(listener);
    expect(listener).not.toHaveBeenCalled();

    const newSource = makeMockSource([makeBatch()]);
    await tracker.swapSource(newSource, 'telemetry');
    expect(listener).toHaveBeenCalled();
    const finalStats = listener.mock.calls[listener.mock.calls.length - 1][0];
    expect(finalStats.mode).toBe('telemetry');
    tracker.dispose();
  });

  it('swap with no prior stats sets previousStats to null without crashing', async () => {
    const oldSource = makeMockSource([]);
    const tracker = new Tracker(oldSource, 'files');
    // No initialize() — lastStats is still null.
    const newSource = makeMockSource([makeBatch()]);
    await expect(
      tracker.swapSource(newSource, 'telemetry'),
    ).resolves.not.toThrow();
    expect(tracker.mode).toBe('telemetry');
    tracker.dispose();
  });

  it('disposes the new source and rethrows when its first scan fails', async () => {
    const oldSource = makeMockSource([makeBatch()]);
    const tracker = new Tracker(oldSource, 'files');
    await tracker.initialize();

    const scan = jest.fn().mockRejectedValue(new Error('boom'));
    const dispose = jest.fn();
    const failingSource: Source = { scan, dispose };

    await expect(
      tracker.swapSource(failingSource, 'telemetry'),
    ).rejects.toThrow('boom');
    expect(dispose).toHaveBeenCalledTimes(1);
    // Old source remains active.
    expect(oldSource.dispose).not.toHaveBeenCalled();
    expect(tracker.mode).toBe('files');
    tracker.dispose();
  });

  it('disposes the new source if tracker.dispose lands during scan', async () => {
    const oldSource = makeMockSource([makeBatch()]);
    const tracker = new Tracker(oldSource, 'files');
    await tracker.initialize();

    let resolveScan: (b: RawAggregateBatch) => void = () => {};
    const scan = jest.fn(
      () =>
        new Promise<RawAggregateBatch>((resolve) => {
          resolveScan = resolve;
        }),
    );
    const dispose = jest.fn();
    const newSource: Source = { scan, dispose };

    const swap = tracker.swapSource(newSource, 'telemetry');
    // Dispose the tracker before the new source's scan resolves.
    tracker.dispose();
    resolveScan(makeBatch());
    await swap;

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
