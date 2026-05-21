import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

// Upstream schema reference: see
// vscode-copilot-chat/src/platform/otel/node/sqlite/otelSqliteStore.ts
// The `spans` table denormalizes these OTel GenAI attributes into columns:
//   chat_session_id  (copilot_chat.chat_session_id)
//   request_model    (gen_ai.request.model)
//   input_tokens     (gen_ai.usage.input_tokens)
//   output_tokens    (gen_ai.usage.output_tokens)
//   cached_tokens    (gen_ai.usage.cache_read.input_tokens)
//   start_time_ms / end_time_ms / operation_name
// Cache-creation tokens are not denormalized — they live in `span_attributes`
// under key 'gen_ai.usage.cache_creation.input_tokens'. We LEFT JOIN so older
// spans that lack the attribute still appear (with cacheCreationTokens = 0).
// Filter `operation_name = 'chat'` matches upstream's GenAiOperationName.CHAT
// constant — the value used for billable LLM inferences. The `sessions` view
// in upstream sums tokens under the same filter, confirming this is the right
// row set for cost attribution (not 'execute_tool', 'invoke_agent', etc.).
//
// Time-boundary filter uses `end_time_ms > sinceMs` (strict) rather than
// `start_time_ms >= sinceMs`. OTel writers materialize a span row when the
// span ends (onEnd), so a request in flight at construction time isn't in the
// DB yet; its row appears later with a start_time that pre-dates our baseline.
// Filtering by start_time would silently drop those spans from both the
// baseline snapshot AND every subsequent scan. Filtering by end_time matches
// the natural arrival order and pairs cleanly with `MAX(end_time_ms)` as the
// high-water mark.
const OPERATION_NAME_CHAT = 'chat';
const ATTR_CACHE_CREATION = 'gen_ai.usage.cache_creation.input_tokens';

export interface SpanRow {
  sessionId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  startTimeMs: number;
  endTimeMs: number;
}

export interface OTelReader {
  isAvailable(): boolean;
  readSpansSince(sinceMs: number, sessionIds: string[] | null): SpanRow[];
  getLatestTimestamp(): number;
  close(): void;
}

/**
 * Resolve the upstream Copilot Chat OTel DB URI from our extension's
 * globalStorage URI. Both extensions live as siblings under the user's
 * globalStorage directory: `<base>/mooracle.copilot-budget/` (ours) and
 * `<base>/github.copilot-chat/` (upstream). Go up one and across.
 */
export function resolveOTelDbUri(ourGlobalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(
    ourGlobalStorageUri,
    '..',
    'github.copilot-chat',
    'agent-traces.db',
  );
}

/**
 * When the upstream `dbSpanExporter.enabled` setting reports true but the DB
 * file is missing locally, returns a diagnostic string for logging. The most
 * common cause is a remote-development mismatch: Copilot Chat is writing the
 * DB on the workspace host while our extension is running UI-side and so sees
 * a different filesystem. Returns null when the setting is off, or when both
 * the setting and the DB agree (true+present or false+absent are both fine).
 */
export function diagnoseUnavailable(
  ourGlobalStorageUri: vscode.Uri,
  upstreamSettingEnabled: boolean,
): string | null {
  if (!upstreamSettingEnabled) {
    return null;
  }
  const dbPath = resolveOTelDbUri(ourGlobalStorageUri).fsPath;
  if (fs.existsSync(dbPath)) {
    return null;
  }
  return `OTel exporter enabled upstream but agent-traces.db not found at ${dbPath} — possible remote-host mismatch; Telemetry mode will not activate.`;
}

class OTelReaderImpl implements OTelReader {
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  isAvailable(): boolean {
    return fs.existsSync(this.dbPath);
  }

  private ensureDb(): DatabaseSync | null {
    if (this.db) {
      return this.db;
    }
    if (!fs.existsSync(this.dbPath)) {
      return null;
    }
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 3000');
    } catch {
      // busy_timeout failure is non-fatal: the connection still works, we just
      // forgo the 3-second wait when the writer holds a brief lock.
    }
    this.db = db;
    return this.db;
  }

  readSpansSince(sinceMs: number, sessionIds: string[] | null): SpanRow[] {
    if (sessionIds !== null && sessionIds.length === 0) {
      // Caller asked for a specific empty set — return no rows without touching
      // the DB. (Distinct from `null`, which means "no session filter".)
      return [];
    }
    const db = this.ensureDb();
    if (!db) {
      return [];
    }

    let sql =
      'SELECT' +
      ' s.chat_session_id AS sessionId,' +
      ' s.request_model AS model,' +
      ' COALESCE(s.input_tokens, 0) AS inputTokens,' +
      ' COALESCE(s.output_tokens, 0) AS outputTokens,' +
      ' COALESCE(s.cached_tokens, 0) AS cachedTokens,' +
      " CAST(COALESCE(a.value, '0') AS INTEGER) AS cacheCreationTokens," +
      ' s.start_time_ms AS startTimeMs,' +
      ' s.end_time_ms AS endTimeMs' +
      ' FROM spans s' +
      ' LEFT JOIN span_attributes a' +
      ' ON a.span_id = s.span_id AND a.key = ?' +
      ' WHERE s.operation_name = ?' +
      ' AND s.end_time_ms > ?';
    const params: Array<string | number> = [
      ATTR_CACHE_CREATION,
      OPERATION_NAME_CHAT,
      sinceMs,
    ];

    if (sessionIds !== null) {
      const placeholders = sessionIds.map(() => '?').join(',');
      sql += ` AND s.chat_session_id IN (${placeholders})`;
      params.push(...sessionIds);
    }

    sql += ' ORDER BY s.end_time_ms';

    const rows = db.prepare(sql).all(...params) as Array<{
      sessionId: string | null;
      model: string | null;
      inputTokens: number | bigint | null;
      outputTokens: number | bigint | null;
      cachedTokens: number | bigint | null;
      cacheCreationTokens: number | bigint | null;
      startTimeMs: number | bigint | null;
      endTimeMs: number | bigint | null;
    }>;

    return rows.map((r) => ({
      sessionId: r.sessionId ?? '',
      model: r.model,
      inputTokens: toFiniteInt(r.inputTokens),
      outputTokens: toFiniteInt(r.outputTokens),
      cachedTokens: toFiniteInt(r.cachedTokens),
      cacheCreationTokens: toFiniteInt(r.cacheCreationTokens),
      startTimeMs: toFiniteInt(r.startTimeMs),
      endTimeMs: toFiniteInt(r.endTimeMs),
    }));
  }

  getLatestTimestamp(): number {
    const db = this.ensureDb();
    if (!db) {
      return 0;
    }
    const row = db
      .prepare(
        'SELECT MAX(end_time_ms) AS maxTs FROM spans WHERE operation_name = ?',
      )
      .get(OPERATION_NAME_CHAT) as { maxTs: number | bigint | null } | undefined;
    return toFiniteInt(row?.maxTs);
  }

  close(): void {
    if (!this.db) {
      return;
    }
    try {
      this.db.close();
    } catch {
      // idempotent — swallow double-close races
    }
    this.db = null;
  }
}

function toFiniteInt(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const n = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Construct an OTelReader rooted at the upstream agent-traces.db that lives
 * next to our extension's globalStorage folder. The reader is lazy — it does
 * not open the DB until `readSpansSince` / `getLatestTimestamp` is first
 * called, so wiring it at activation has no cost when OTel is off.
 */
export function createOTelReader(ourGlobalStorageUri: vscode.Uri): OTelReader {
  const dbPath = resolveOTelDbUri(ourGlobalStorageUri).fsPath;
  return new OTelReaderImpl(dbPath);
}
