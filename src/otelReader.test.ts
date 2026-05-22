import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

import {
  createOTelReader,
  diagnoseUnavailable,
  OTelReader,
  PerModelAggregate,
  resolveOTelDbUri,
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
  parentChatSessionId?: string; // optional copilot_chat.parent_chat_session_id attr
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
    if (s.parentChatSessionId !== undefined) {
      insertAttr.run(
        s.spanId,
        'copilot_chat.parent_chat_session_id',
        s.parentChatSessionId,
      );
    }
  }
  db.close();
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

  it('aggregateSince returns [] without throwing', () => {
    const reader = createOTelReader(fx.ourGlobalStorageUri);
    expect(reader.aggregateSince(0, ['session-A'])).toEqual([]);
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

  it('aggregateSince returns []', () => {
    expect(reader.aggregateSince(0, ['session-A'])).toEqual([]);
  });

  it('getLatestTimestamp returns 0', () => {
    expect(reader.getLatestTimestamp()).toBe(0);
  });
});

describe('createOTelReader — DB with spans (close + getLatestTimestamp)', () => {
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

  it('getLatestTimestamp returns max(end_time_ms) over chat spans', () => {
    // The execute_tool span has the largest end_time_ms but must be excluded.
    expect(reader.getLatestTimestamp()).toBe(3_800);
  });

  it('close() is idempotent and re-opens lazily on next call', () => {
    expect(() => reader.close()).not.toThrow();
    expect(() => reader.close()).not.toThrow();
    // After close, a fresh query still works (lazy re-open).
    expect(reader.aggregateSince(0, ['session-A', 'session-B'])).toHaveLength(2);
    reader.close();
  });
});

describe('aggregateSince', () => {
  let fx: Fixture;
  let reader: OTelReader;

  beforeEach(() => {
    fx = makeFixture('aggregate');
    seedSpans(fx.dbPath, [
      // session-A: two gpt-4o chat spans
      {
        spanId: 'span-A1',
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
        spanId: 'span-A2',
        sessionId: 'session-A',
        model: 'gpt-4o',
        inputTokens: 500,
        outputTokens: 80,
        cachedTokens: null,
        cacheCreationAttr: null,
        startTimeMs: 2_000,
        endTimeMs: 2_400,
      },
      // session-B: one claude span
      {
        spanId: 'span-B1',
        sessionId: 'session-B',
        model: 'claude-sonnet-4',
        inputTokens: 2000,
        outputTokens: 500,
        cachedTokens: 1500,
        cacheCreationAttr: 200,
        startTimeMs: 3_000,
        endTimeMs: 3_800,
      },
      // Title subagent — chat_session_id is NULL, but parent points at session-A
      {
        spanId: 'span-A-title',
        sessionId: null,
        model: 'gpt-4o-mini',
        inputTokens: 50,
        outputTokens: 10,
        cachedTokens: 0,
        cacheCreationAttr: null,
        startTimeMs: 1_100,
        endTimeMs: 1_200,
        parentChatSessionId: 'session-A',
      },
      // Orphan — no session, no parent. Must be excluded.
      {
        spanId: 'span-orphan',
        sessionId: null,
        model: 'gpt-4o',
        inputTokens: 9999,
        outputTokens: 9999,
        cachedTokens: 9999,
        cacheCreationAttr: 9999,
        startTimeMs: 1_500,
        endTimeMs: 1_600,
      },
      // execute_tool span on session-A — must NOT appear (operation_name filter)
      {
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
      // Span with NULL model — must produce a row with model: null
      {
        spanId: 'span-nullmodel',
        sessionId: 'session-A',
        model: null,
        inputTokens: 7,
        outputTokens: 3,
        cachedTokens: 0,
        cacheCreationAttr: null,
        startTimeMs: 5_000,
        endTimeMs: 5_100,
      },
    ]);
    reader = createOTelReader(fx.ourGlobalStorageUri);
  });
  afterEach(() => {
    reader.close();
    rmFixture(fx);
  });

  function findByModel(
    rows: PerModelAggregate[],
    model: string | null,
  ): PerModelAggregate | undefined {
    return rows.find((r) => r.model === model);
  }

  it('returns [] for an empty session-id list without touching the DB', () => {
    // Even if DB is present and has matching spans, an empty list short-circuits.
    expect(reader.aggregateSince(0, [])).toEqual([]);
  });

  it('returns scoped per-model totals filtered by session id', () => {
    const rows = reader.aggregateSince(0, ['session-A']);
    // Expect: gpt-4o (2 chat spans), gpt-4o-mini (title subagent via parent join),
    // and a NULL-model row (1 chat span). orphan and execute_tool excluded.
    expect(rows).toHaveLength(3);

    const gpt = findByModel(rows, 'gpt-4o');
    expect(gpt).toEqual({
      model: 'gpt-4o',
      chats: 2,
      inputTokens: 1500,
      outputTokens: 280,
      cacheReadTokens: 750,
      cacheCreationTokens: 100,
    });

    const titleAgent = findByModel(rows, 'gpt-4o-mini');
    expect(titleAgent).toEqual({
      model: 'gpt-4o-mini',
      chats: 1,
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    const nullModel = findByModel(rows, null);
    expect(nullModel).toEqual({
      model: null,
      chats: 1,
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('parent-session OR-join captures title-subagent spans', () => {
    const rows = reader.aggregateSince(0, ['session-A']);
    // The title span has chat_session_id = NULL but parent_chat_session_id =
    // session-A, so the parent OR-join must surface it.
    const titleAgent = findByModel(rows, 'gpt-4o-mini');
    expect(titleAgent).toBeDefined();
    expect(titleAgent!.chats).toBe(1);
  });

  it('orphan spans (no chat_session_id, no parent) are excluded', () => {
    // session-B does not own the orphan span — only its own claude span.
    const rows = reader.aggregateSince(0, ['session-B']);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('claude-sonnet-4');
    // gpt-4o would appear if the orphan leaked through; assert it doesn't.
    expect(findByModel(rows, 'gpt-4o')).toBeUndefined();
  });

  it('merges sessions when multiple ids are passed', () => {
    const rows = reader.aggregateSince(0, ['session-A', 'session-B']);
    // Expect: gpt-4o, gpt-4o-mini, claude-sonnet-4, null-model = 4 rows
    expect(rows).toHaveLength(4);
    expect(findByModel(rows, 'claude-sonnet-4')).toEqual({
      model: 'claude-sonnet-4',
      chats: 1,
      inputTokens: 2000,
      outputTokens: 500,
      cacheReadTokens: 1500,
      cacheCreationTokens: 200,
    });
  });

  it('returns [] when no session id matches any span', () => {
    expect(reader.aggregateSince(0, ['nonexistent'])).toEqual([]);
  });

  it('respects sinceMs (end_time > sinceMs strict)', () => {
    // Cut off everything <= 1_500. Drops span-A1 (1_500) and the title span
    // (1_200); span-A2, the orphan (excluded anyway), null-model survive.
    const rows = reader.aggregateSince(1_500, ['session-A']);
    const gpt = findByModel(rows, 'gpt-4o');
    expect(gpt).toEqual({
      model: 'gpt-4o',
      chats: 1,
      inputTokens: 500,
      outputTokens: 80,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // The title subagent ended at 1_200, before the cutoff — excluded.
    expect(findByModel(rows, 'gpt-4o-mini')).toBeUndefined();
  });

  it('retention edge case — sinceMs older than oldest span returns all matching rows', () => {
    // sinceMs = -1 is older than any seeded span. Equivalent to "no time floor".
    const rows = reader.aggregateSince(-1, ['session-A', 'session-B']);
    expect(rows).toHaveLength(4);
  });

  it('sums cache_creation from span_attributes across rows', () => {
    const rows = reader.aggregateSince(0, ['session-A', 'session-B']);
    const totalCacheCreation = rows.reduce(
      (n, r) => n + r.cacheCreationTokens,
      0,
    );
    // 100 (span-A1) + 0 (span-A2 missing) + 200 (span-B1) + 0 (title) + 0 (null-model) = 300
    expect(totalCacheCreation).toBe(300);
  });

  it('excludes spans whose end_time equals sinceMs (strict boundary)', () => {
    // span-A1 ends at 1_500 exactly; with sinceMs=1_500 it must NOT appear.
    const rows = reader.aggregateSince(1_500, ['session-A']);
    const gpt = findByModel(rows, 'gpt-4o');
    // Only span-A2 (1500 tokens dropped, 500 remain) survives.
    expect(gpt!.inputTokens).toBe(500);
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
