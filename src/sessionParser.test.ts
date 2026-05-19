import * as path from 'path';
import { parseSessionFileContent } from './sessionParser';
import { loadRateCard, resetRateCardForTesting } from './tokenRates';

const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'models-and-pricing.json');

beforeAll(() => {
  resetRateCardForTesting();
  loadRateCard(FIXTURE_PATH);
});

afterAll(() => {
  resetRateCardForTesting();
});

function makeRequest(opts: {
  model?: string;
  selectedModelId?: string;
  promptTokens?: number | string | null;
  outputTokens?: number | string | null;
  cacheReadTokens?: number | string | null;
  cacheCreationTokens?: number | string | null;
  noResult?: boolean;
  noMetadata?: boolean;
  modelStateValue?: number;
}): any {
  const request: any = {};
  if (opts.model !== undefined) request.modelId = opts.model;
  if (opts.selectedModelId !== undefined) {
    request.selectedModel = { identifier: opts.selectedModelId };
  }
  if (opts.modelStateValue !== undefined) {
    request.modelState = { value: opts.modelStateValue };
  }
  if (opts.noResult) return request;
  const result: any = {};
  if (!opts.noMetadata) {
    const metadata: any = {};
    if (opts.promptTokens !== undefined) metadata.promptTokens = opts.promptTokens;
    if (opts.outputTokens !== undefined) metadata.outputTokens = opts.outputTokens;
    if (opts.cacheReadTokens !== undefined) metadata.cacheReadTokens = opts.cacheReadTokens;
    if (opts.cacheCreationTokens !== undefined) metadata.cacheCreationTokens = opts.cacheCreationTokens;
    result.metadata = metadata;
  }
  request.result = result;
  return request;
}

// Wraps a requests[] array as a single-line kind:0 delta — equivalent to the
// initial snapshot VS Code writes at the top of a JSONL session.
function deltaSession(requests: any[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: 0, v: { requests, ...extra } });
}

describe('parseSessionFileContent — JSONL session reads', () => {
  it('returns zero stats for empty content', () => {
    expect(parseSessionFileContent('')).toEqual({
      interactions: 0,
      modelUsage: {},
      modelInteractions: {},
    });
  });

  it('returns zero stats for unparseable first line', () => {
    expect(parseSessionFileContent('not json')).toEqual({
      interactions: 0,
      modelUsage: {},
      modelInteractions: {},
    });
  });

  it('returns zero stats when first line is JSON but lacks kind', () => {
    expect(parseSessionFileContent(JSON.stringify({ requests: [] }))).toEqual({
      interactions: 0,
      modelUsage: {},
      modelInteractions: {},
    });
  });

  it('returns zero for unparseable later lines but keeps earlier state', () => {
    expect(parseSessionFileContent('garbage\nnot json')).toEqual({
      interactions: 0,
      modelUsage: {},
      modelInteractions: {},
    });
  });

  it('reads server tokens straight from result.metadata', () => {
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({
          model: 'claude-sonnet-4.6',
          promptTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 800,
          cacheCreationTokens: 100,
        }),
      ]),
    );
    expect(result.interactions).toBe(1);
    expect(result.modelUsage['claude-sonnet-4.6']).toEqual({
      inputTokens: 100, // 1000 - 800 - 100
      outputTokens: 200,
      cacheReadTokens: 800,
      cacheCreationTokens: 100,
    });
    expect(result.modelInteractions).toEqual({ 'claude-sonnet-4.6': 1 });
  });

  it('aggregates multiple requests for the same model', () => {
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({
          model: 'gpt-4.1',
          promptTokens: 500,
          outputTokens: 100,
          cacheReadTokens: 0,
        }),
        makeRequest({
          model: 'gpt-4.1',
          promptTokens: 700,
          outputTokens: 150,
          cacheReadTokens: 600,
        }),
      ]),
    );
    expect(result.interactions).toBe(2);
    expect(result.modelUsage['gpt-4.1']).toEqual({
      inputTokens: 600, // 500 + (700 - 600)
      outputTokens: 250,
      cacheReadTokens: 600,
      cacheCreationTokens: 0,
    });
    expect(result.modelInteractions).toEqual({ 'gpt-4.1': 2 });
  });

  it('keeps mixed-model sessions separated by canonical id (full version preserved)', () => {
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({
          model: 'claude-sonnet-4.6',
          promptTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 800,
        }),
        makeRequest({
          model: 'gpt-5.3-codex',
          promptTokens: 500,
          outputTokens: 50,
          cacheReadTokens: 100,
        }),
      ]),
    );
    expect(Object.keys(result.modelUsage).sort()).toEqual([
      'claude-sonnet-4.6',
      'gpt-5.3-codex',
    ]);
    expect(result.modelUsage['claude-sonnet-4.6'].cacheReadTokens).toBe(800);
    expect(result.modelUsage['gpt-5.3-codex'].cacheReadTokens).toBe(100);
  });

  it('skips requests missing result.metadata entirely (no interaction increment)', () => {
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({ model: 'gpt-4.1', noResult: true }),
        makeRequest({ model: 'gpt-4.1', noMetadata: true }),
        makeRequest({
          model: 'gpt-4.1',
          promptTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
        }),
      ]),
    );
    expect(result.interactions).toBe(1);
    expect(result.modelInteractions).toEqual({ 'gpt-4.1': 1 });
    expect(result.modelUsage['gpt-4.1'].inputTokens).toBe(100);
  });

  it('clamps malformed token values to 0 but still counts the interaction', () => {
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({
          model: 'gpt-4.1',
          promptTokens: 'abc' as any,
          outputTokens: -100 as any,
          cacheReadTokens: null,
        }),
      ]),
    );
    expect(result.interactions).toBe(1);
    expect(result.modelUsage['gpt-4.1']).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('treats explicit cacheReadTokens=null as 0, not as missing data triggering the heuristic', () => {
    // Two requests in one session — the heuristic would normally kick in on
    // turn 2+. An explicit null says "no cache reads happened", so the input
    // bucket must keep the full promptTokens instead of getting 75% diverted
    // to cache_read.
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({
          model: 'gpt-4.1',
          promptTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: null,
        }),
        makeRequest({
          model: 'gpt-4.1',
          promptTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: null,
        }),
      ]),
    );
    expect(result.interactions).toBe(2);
    expect(result.modelUsage['gpt-4.1']).toEqual({
      inputTokens: 2000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('skips pending requests (modelState.value !== 1) — no tokens, no interaction', () => {
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({
          model: 'gpt-4.1',
          modelStateValue: 2,
          promptTokens: 500,
          outputTokens: 100,
          cacheReadTokens: 0,
        }),
        makeRequest({
          model: 'gpt-4.1',
          promptTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
        }),
      ]),
    );
    expect(result.interactions).toBe(1);
    expect(result.modelUsage['gpt-4.1'].inputTokens).toBe(100);
  });

  it('defaults to "unknown" when model id missing', () => {
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({ promptTokens: 100, outputTokens: 50, cacheReadTokens: 0 }),
      ]),
    );
    expect(result.modelUsage['unknown']).toBeDefined();
  });

  it('strips copilot/, copilotcli/, claude-code/ prefixes', () => {
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({
          model: 'copilot/gpt-4.1',
          promptTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 0,
        }),
        makeRequest({
          model: 'copilotcli/claude-opus-4.6',
          promptTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 0,
        }),
        makeRequest({
          model: 'claude-code/claude-sonnet-4.6',
          promptTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 0,
        }),
      ]),
    );
    expect(result.modelUsage['gpt-4.1']).toBeDefined();
    expect(result.modelUsage['claude-opus-4.6']).toBeDefined();
    expect(result.modelUsage['claude-sonnet-4.6']).toBeDefined();
  });

  it('uses selectedModel.identifier when modelId absent', () => {
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({
          selectedModelId: 'claude-opus-4.6',
          promptTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
        }),
      ]),
    );
    expect(result.modelUsage['claude-opus-4.6']).toBeDefined();
  });
});

describe('cache-split heuristic', () => {
  it('does NOT fire when cacheReadTokens is explicitly present', () => {
    const result = parseSessionFileContent(
      deltaSession([
        makeRequest({
          model: 'claude-sonnet-4.6',
          promptTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 200, // explicit
        }),
        makeRequest({
          model: 'claude-sonnet-4.6',
          promptTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 800, // explicit
        }),
      ]),
    );
    expect(result.modelUsage['claude-sonnet-4.6']).toEqual({
      inputTokens: 1000, // (1000-200) + (1000-800) = 800 + 200
      outputTokens: 200,
      cacheReadTokens: 1000, // 200 + 800
      cacheCreationTokens: 0,
    });
  });

  it('turn 1 has 0% cache; turn 2+ has 75% cache when cacheReadTokens absent', () => {
    const result = parseSessionFileContent(
      deltaSession([
        // Turn 1: no cache field; expect 0% cached
        makeRequest({
          model: 'gpt-4.1',
          promptTokens: 1000,
          outputTokens: 100,
        }),
        // Turn 2: no cache field; expect 75% cached (floor(2000 * 0.75) = 1500)
        makeRequest({
          model: 'gpt-4.1',
          promptTokens: 2000,
          outputTokens: 200,
        }),
      ]),
    );
    // Turn 1: input=1000, cacheRead=0
    // Turn 2: cacheRead = floor(2000 * 0.75) = 1500, input = 2000 - 1500 = 500
    expect(result.modelUsage['gpt-4.1']).toEqual({
      inputTokens: 1500, // 1000 + 500
      outputTokens: 300,
      cacheReadTokens: 1500, // 0 + 1500
      cacheCreationTokens: 0,
    });
  });

  it('heuristic caps at the remaining prompt budget when cacheCreationTokens is reported alone', () => {
    // Defensive: if upstream ever ships cacheCreationTokens without
    // cacheReadTokens, the heuristic must not push the three buckets above
    // promptTokens (would double-count tokens at higher rates).
    const result = parseSessionFileContent(
      deltaSession([
        // Turn 1
        makeRequest({
          model: 'claude-sonnet-4.6',
          promptTokens: 100,
          outputTokens: 10,
        }),
        // Turn 2: cacheCreation reported, cacheRead absent. Without the cap,
        // heuristic would set cacheRead = floor(1000 * 0.75) = 750 and the
        // sum (750 + 800 + 0 input) = 1550 > promptTokens.
        makeRequest({
          model: 'claude-sonnet-4.6',
          promptTokens: 1000,
          outputTokens: 100,
          cacheCreationTokens: 800,
        }),
      ]),
    );
    const usage = result.modelUsage['claude-sonnet-4.6'];
    // Turn 2: remaining = 1000 - 800 = 200; cacheRead = floor(200 * 0.75) = 150;
    // input = 1000 - 150 - 800 = 50. Sum = 1000 (matches promptTokens).
    expect(usage.cacheReadTokens).toBe(150); // 0 (turn 1) + 150 (turn 2)
    expect(usage.cacheCreationTokens).toBe(800);
    // Turn 1 input=100, Turn 2 input=50
    expect(usage.inputTokens).toBe(150);
    // No bucket overshoot vs sum of promptTokens across both turns (100 + 1000)
    expect(
      usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    ).toBeLessThanOrEqual(1100);
  });

  it('counts pending requests against turn index so heuristic still aligns with array position', () => {
    const result = parseSessionFileContent(
      deltaSession([
        // Turn 1: pending — skipped, but turnIndex advances to 1
        makeRequest({
          model: 'gpt-4.1',
          modelStateValue: 2,
          promptTokens: 9999,
        }),
        // Turn 2: complete, no cache field → heuristic applies (75%)
        makeRequest({
          model: 'gpt-4.1',
          promptTokens: 1000,
          outputTokens: 100,
        }),
      ]),
    );
    expect(result.modelUsage['gpt-4.1']).toEqual({
      inputTokens: 250, // 1000 - 750
      outputTokens: 100,
      cacheReadTokens: 750, // floor(1000 * 0.75)
      cacheCreationTokens: 0,
    });
  });
});

describe('parseSessionFileContent — multi-line delta reconstruction', () => {
  it('reconstructs session from kind:0 + kind:2 deltas', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { requests: [] } }),
      JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: makeRequest({
          model: 'gpt-4.1',
          promptTokens: 500,
          outputTokens: 100,
          cacheReadTokens: 0,
        }),
      }),
    ];
    const result = parseSessionFileContent(lines.join('\n'));
    expect(result.interactions).toBe(1);
    expect(result.modelUsage['gpt-4.1'].inputTokens).toBe(500);
  });

  it('applies kind:1 path update writing metadata under requests[0].result.metadata', () => {
    const lines = [
      JSON.stringify({
        kind: 0,
        v: {
          requests: [
            {
              modelId: 'claude-sonnet-4.6',
              result: {},
            },
          ],
        },
      }),
      JSON.stringify({
        kind: 1,
        k: ['requests', '0', 'result', 'metadata'],
        v: {
          promptTokens: 800,
          outputTokens: 150,
          cacheReadTokens: 600,
          cacheCreationTokens: 0,
        },
      }),
    ];
    const result = parseSessionFileContent(lines.join('\n'));
    expect(result.interactions).toBe(1);
    expect(result.modelUsage['claude-sonnet-4.6']).toEqual({
      inputTokens: 200, // 800 - 600
      outputTokens: 150,
      cacheReadTokens: 600,
      cacheCreationTokens: 0,
    });
  });

  it('handles multiple delta appends with mixed models', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { requests: [] } }),
      JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: makeRequest({
          model: 'gpt-4.1',
          promptTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
        }),
      }),
      JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: makeRequest({
          model: 'claude-sonnet-4.6',
          promptTokens: 200,
          outputTokens: 30,
          cacheReadTokens: 0,
        }),
      }),
    ];
    const result = parseSessionFileContent(lines.join('\n'));
    expect(result.interactions).toBe(2);
    expect(Object.keys(result.modelUsage).sort()).toEqual([
      'claude-sonnet-4.6',
      'gpt-4.1',
    ]);
  });
});

describe('prototype pollution prevention', () => {
  it('rejects __proto__ in delta key paths', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: {} }),
      JSON.stringify({ kind: 1, k: ['__proto__', 'polluted'], v: true }),
    ];
    const result = parseSessionFileContent(lines.join('\n'));
    expect(({} as any).polluted).toBeUndefined();
    expect(result.interactions).toBe(0);
  });

  it('rejects constructor in delta key paths', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: {} }),
      JSON.stringify({
        kind: 1,
        k: ['constructor', 'prototype'],
        v: { evil: true },
      }),
    ];
    const result = parseSessionFileContent(lines.join('\n'));
    expect(({} as any).evil).toBeUndefined();
    expect(result.interactions).toBe(0);
  });

  it('rejects prototype in delta key paths', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: {} }),
      JSON.stringify({ kind: 1, k: ['prototype', 'injected'], v: 'bad' }),
    ];
    const result = parseSessionFileContent(lines.join('\n'));
    expect(({} as any).injected).toBeUndefined();
    expect(result.interactions).toBe(0);
  });

  it('rejects keys starting with double underscore', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: {} }),
      JSON.stringify({ kind: 1, k: ['__custom', 'data'], v: 'bad' }),
    ];
    const result = parseSessionFileContent(lines.join('\n'));
    expect(result.interactions).toBe(0);
  });
});
