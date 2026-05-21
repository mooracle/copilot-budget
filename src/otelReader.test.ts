import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

import {
  createOTelReader,
  diagnoseUnavailable,
  OTelReader,
  resolveOTelDbUri,
  SpanRow,
} from './otelReader';

// Suppress the experimental warning that Node prints once when first using
// node:sqlite. Tests don't care, and it's noisy in the Jest output.
const ORIGINAL_EMIT_WARNING = process.emitWarning;
beforeAll(() => {
  process.emitWarning = ((...args: unknown[]) => {
    const [warning, type] = args;
    if (typeof type === 'string' && type === 'ExperimentalWarning') {
      return;
    }
    if (
      warning &&
      typeof warning === 'object' &&
      (warning as { name?: string }).name === 'ExperimentalWarning'
    ) {
      return;
    }
    return (ORIGINAL_EMIT_WARNING as (...a: unknown[]) => void).apply(
      process,
      args,
    );
  }) as typeof process.emitWarning;
});
afterAll(() => {
  process.emitWarning = ORIGINAL_EMIT_WARNING;
});

// Per-test temp directory layout mirrors VS Code globalStorage:
//   <tmp>/<run>/globalStorage/mooracle.copilot-budget/      (ours)
//   <tmp>/<run>/globalStorage/github.copilot-chat/agent-traces.db  (upstream)
interface Fixture {
  rootDir: string;
  ourGlobalStorageUri: vscode.Uri;
  dbPath: string;
}

function makeFixture(label: string): Fixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `otelReader-${label}-`));
  const globalStorage = path.join(rootDir, 'globalStorage');
  const oursDir = path.join(globalStorage, 'mooracle.copilot-budget');
  const upstreamDir = path.join(globalStorage, 'github.copilot-chat');
  fs.mkdirSync(oursDir, { recursive: true });
  fs.mkdirSync(upstreamDir, { recursive: true });
  return {
    rootDir,
    ourGlobalStorageUri: vscode.Uri.file(oursDir),
    dbPath: path.join(upstreamDir, 'agent-traces.db'),
  };
}

function rmFixture(fx: Fixture): void {
  fs.rmSync(fx.rootDir, { recursive: true, force: true });
}

interface SeedSpan {
  spanId: string;
  sessionId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheCreationAttr: number | null; // null = no attribute row at all
  startTimeMs: number;
  endTimeMs: number;
  operationName?: string; // default 'chat'
}

function createSchema(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE spans (
      span_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      start_time_ms INTEGER NOT NULL,
      end_time_ms INTEGER NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 0,
      status_message TEXT,
      operation_name TEXT,
      provider_name TEXT,
      agent_name TEXT,
      conversation_id TEXT,
      request_model TEXT,
      response_model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      reasoning_tokens INTEGER,
      tool_name TEXT,
      tool_call_id TEXT,
      tool_type TEXT,
      chat_session_id TEXT,
      turn_index INTEGER,
      ttft_ms REAL
    );
    CREATE TABLE span_attributes (
      span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (span_id, key)
    );
  `);
  return db;
}

function seedSpans(dbPath: string, spans: SeedSpan[]): void {
  const db = createSchema(dbPath);
  const insertSpan = db.prepare(`
    INSERT INTO spans (
      span_id, trace_id, parent_span_id, name,
      start_time_ms, end_time_ms, status_code,
      operation_name, chat_session_id, request_model,
      input_tokens, output_tokens, cached_tokens
    ) VALUES (?, ?, NULL, 'chat', ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `);
  const insertAttr = db.prepare(
    'INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)',
  );
  for (const s of spans) {
    insertSpan.run(
      s.spanId,
      `trace-${s.spanId}`,
      s.startTimeMs,
      s.endTimeMs,
      s.operationName ?? 'chat',
      s.sessionId,
      s.model,
      s.inputTokens,
      s.outputTokens,
      s.cachedTokens,
    );
    if (s.cacheCreationAttr !== null) {
      insertAttr.run(
        s.spanId,
        'gen_ai.usage.cache_creation.input_tokens',
        String(s.cacheCreationAttr),
      );
    }
  }
  db.close();
}

function bySpanId(rows: SpanRow[], _: never = undefined as never): SpanRow[] {
  // Stable order for assertions: rely on startTimeMs (the SQL ORDER BY).
  return rows;
}

describe('resolveOTelDbUri', () => {
  it('navigates from our globalStorage to upstream agent-traces.db', () => {
    const ours = vscode.Uri.file(
      '/home/u/.config/Code/User/globalStorage/mooracle.copilot-budget',
    );
    const dbUri = resolveOTelDbUri(ours);
    expect(dbUri.fsPath).toBe(
      '/home/u/.config/Code/User/globalStorage/github.copilot-chat/agent-traces.db',
    );
  });
});

describe('createOTelReader — DB missing', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture('missing');
    // intentionally do not seed the DB
  });
  afterEach(() => rmFixture(fx));

  it('isAvailable() returns false', () => {
    const reader = createOTelReader(fx.ourGlobalStorageUri);
    expect(reader.isAvailable()).toBe(false);
    reader.close();
  });

  it('readSpansSince returns [] without throwing', () => {
    const reader = createOTelReader(fx.ourGlobalStorageUri);
    expect(reader.readSpansSince(0, null)).toEqual([]);
    reader.close();
  });

  it('getLatestTimestamp returns 0', () => {
    const reader = createOTelReader(fx.ourGlobalStorageUri);
    expect(reader.getLatestTimestamp()).toBe(0);
    reader.close();
  });
});

describe('createOTelReader — DB present but empty', () => {
  let fx: Fixture;
  let reader: OTelReader;
  beforeEach(() => {
    fx = makeFixture('empty');
    seedSpans(fx.dbPath, []);
    reader = createOTelReader(fx.ourGlobalStorageUri);
  });
  afterEach(() => {
    reader.close();
    rmFixture(fx);
  });

  it('isAvailable() returns true', () => {
    expect(reader.isAvailable()).toBe(true);
  });

  it('readSpansSince returns []', () => {
    expect(reader.readSpansSince(0, null)).toEqual([]);
  });

  it('getLatestTimestamp returns 0', () => {
    expect(reader.getLatestTimestamp()).toBe(0);
  });
});

describe('createOTelReader — DB with spans', () => {
  let fx: Fixture;
  let reader: OTelReader;

  beforeEach(() => {
    fx = makeFixture('seeded');
    seedSpans(fx.dbPath, [
      {
        spanId: 'span-1',
        sessionId: 'session-A',
        model: 'gpt-4o',
        inputTokens: 1000,
        outputTokens: 200,
        cachedTokens: 750,
        cacheCreationAttr: 100,
        startTimeMs: 1_000,
        endTimeMs: 1_500,
      },
      {
        spanId: 'span-2',
        sessionId: 'session-A',
        model: 'gpt-4o',
        inputTokens: 500,
        outputTokens: 80,
        cachedTokens: null, // server omitted cached_tokens
        cacheCreationAttr: null, // no cache_creation attribute row
        startTimeMs: 2_000,
        endTimeMs: 2_400,
      },
      {
        spanId: 'span-3',
        sessionId: 'session-B',
        model: 'claude-sonnet-4',
        inputTokens: 2000,
        outputTokens: 500,
        cachedTokens: 1500,
        cacheCreationAttr: 200,
        startTimeMs: 3_000,
        endTimeMs: 3_800,
      },
      {
        // execute_tool span — must NOT appear in our results
        spanId: 'span-tool',
        sessionId: 'session-A',
        model: 'gpt-4o',
        inputTokens: 99,
        outputTokens: 99,
        cachedTokens: 0,
        cacheCreationAttr: null,
        startTimeMs: 4_000,
        endTimeMs: 4_100,
        operationName: 'execute_tool',
      },
    ]);
    reader = createOTelReader(fx.ourGlobalStorageUri);
  });
  afterEach(() => {
    reader.close();
    rmFixture(fx);
  });

  it('isAvailable() returns true', () => {
    expect(reader.isAvailable()).toBe(true);
  });

  it('readSpansSince(0, null) returns only chat spans', () => {
    const rows = bySpanId(reader.readSpansSince(0, null));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.sessionId)).toEqual([
      'session-A',
      'session-A',
      'session-B',
    ]);
  });

  it('coerces NULL cached_tokens to 0 (not NaN, not null)', () => {
    const rows = reader.readSpansSince(0, null);
    const span2 = rows.find((r) => r.endTimeMs === 2_400)!;
    expect(span2.cachedTokens).toBe(0);
    expect(Number.isNaN(span2.cachedTokens)).toBe(false);
  });

  it('coerces missing cache_creation attribute row to 0', () => {
    const rows = reader.readSpansSince(0, null);
    const span2 = rows.find((r) => r.endTimeMs === 2_400)!;
    expect(span2.cacheCreationTokens).toBe(0);
  });

  it('honors cache_creation attribute when present', () => {
    const rows = reader.readSpansSince(0, null);
    const span1 = rows.find((r) => r.endTimeMs === 1_500)!;
    expect(span1.cacheCreationTokens).toBe(100);
    const span3 = rows.find((r) => r.endTimeMs === 3_800)!;
    expect(span3.cacheCreationTokens).toBe(200);
  });

  it('returns the full token shape for a populated span', () => {
    const rows = reader.readSpansSince(0, null);
    const span1 = rows.find((r) => r.endTimeMs === 1_500)!;
    expect(span1).toEqual({
      sessionId: 'session-A',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 750,
      cacheCreationTokens: 100,
      startTimeMs: 1_000,
      endTimeMs: 1_500,
    });
  });

  it('respects sinceMs filter', () => {
    const rows = reader.readSpansSince(2_500, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe('session-B');
  });

  it('respects sessionIds filter', () => {
    const rowsA = reader.readSpansSince(0, ['session-A']);
    expect(rowsA.map((r) => r.sessionId)).toEqual(['session-A', 'session-A']);

    const rowsB = reader.readSpansSince(0, ['session-B']);
    expect(rowsB.map((r) => r.sessionId)).toEqual(['session-B']);

    const rowsBoth = reader.readSpansSince(0, ['session-A', 'session-B']);
    expect(rowsBoth).toHaveLength(3);
  });

  it('returns [] for an empty session-id array (distinct from null)', () => {
    expect(reader.readSpansSince(0, [])).toEqual([]);
  });

  it('returns [] for a session id that does not match any span', () => {
    expect(reader.readSpansSince(0, ['nonexistent'])).toEqual([]);
  });

  it('getLatestTimestamp returns max(end_time_ms) over chat spans', () => {
    // The execute_tool span has the largest end_time_ms but must be excluded.
    expect(reader.getLatestTimestamp()).toBe(3_800);
  });

  it('close() is idempotent and re-opens lazily on next call', () => {
    expect(() => reader.close()).not.toThrow();
    expect(() => reader.close()).not.toThrow();
    // After close, a fresh query still works (lazy re-open).
    expect(reader.readSpansSince(0, null)).toHaveLength(3);
    reader.close();
  });
});

describe('diagnoseUnavailable', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture('diagnose');
  });
  afterEach(() => rmFixture(fx));

  it('returns null when upstream setting is off (DB presence irrelevant)', () => {
    expect(diagnoseUnavailable(fx.ourGlobalStorageUri, false)).toBeNull();
    seedSpans(fx.dbPath, []);
    expect(diagnoseUnavailable(fx.ourGlobalStorageUri, false)).toBeNull();
  });

  it('returns null when upstream enabled AND DB present', () => {
    seedSpans(fx.dbPath, []);
    expect(diagnoseUnavailable(fx.ourGlobalStorageUri, true)).toBeNull();
  });

  it('returns a diagnostic string when upstream enabled but DB missing', () => {
    const msg = diagnoseUnavailable(fx.ourGlobalStorageUri, true);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/agent-traces\.db/);
    expect(msg).toMatch(/remote-host/);
  });
});
