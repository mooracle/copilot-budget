import { computeCost, normalizeModelId, stripModelPrefix } from './tokenRates';
import { OTelReader, PerModelAggregate } from './otelReader';
import { log } from './logger';

export interface ModelStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costAic: number;
}

export interface TrackingStats {
  since: string;
  lastUpdated: string;
  models: { [model: string]: ModelStats };
  totalTokens: number;
  interactions: number;
  totalAiCredits: number;
  // Transitional: pinned to 'telemetry' until Task 10 removes the field
  // entirely. Kept on the type so downstream consumers (statusBar, trailer
  // writer, panel) keep compiling during the migration window.
  mode: 'files' | 'telemetry';
}

export interface RestoredStats {
  since: string;
  interactions: number;
  models: { [model: string]: ModelStats };
}

interface ModelTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface Snapshot {
  interactions: number;
  modelTokens: { [model: string]: ModelTokens };
}

type StatsListener = (stats: TrackingStats) => void;

function emptyModelTokens(): ModelTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function emptyModelStats(): ModelStats {
  return {
    ...emptyModelTokens(),
    costAic: 0,
  };
}

function accumulateModelStats(
  models: { [key: string]: ModelStats },
  key: string,
  contrib: ModelStats,
): void {
  let entry = models[key];
  if (!entry) {
    entry = emptyModelStats();
    models[key] = entry;
  }
  entry.inputTokens += contrib.inputTokens;
  entry.outputTokens += contrib.outputTokens;
  entry.cacheReadTokens += contrib.cacheReadTokens;
  entry.cacheCreationTokens += contrib.cacheCreationTokens;
  entry.costAic += contrib.costAic;
}

function emptySnapshot(): Snapshot {
  return { interactions: 0, modelTokens: {} };
}

// Convert reader rows into a per-model token snapshot. Strips Copilot's
// request-routing prefixes (`copilot/`, `copilotcli/`, `claude-code/`) and
// normalizes so the same model surfaces under one key regardless of how the
// span tagged it. `request_model = NULL` aggregates under 'unknown' — the
// downstream rate-card lookup returns null for that key and the cost stays 0.
function rowsToSnapshot(rows: PerModelAggregate[]): Snapshot {
  const modelTokens: { [model: string]: ModelTokens } = {};
  let interactions = 0;
  for (const row of rows) {
    interactions += row.chats;
    const modelKey = row.model
      ? normalizeModelId(stripModelPrefix(row.model))
      : 'unknown';
    // OTel GenAI semantics: `input_tokens` is the full prompt token count
    // (cache-read + cache-creation + fresh). Subtract cached buckets to get
    // the non-cached prompt portion before pricing. Clamp at 0 in case the
    // provider mis-reports (input < cached).
    const pureInput = Math.max(
      0,
      row.inputTokens - row.cacheReadTokens - row.cacheCreationTokens,
    );
    let tokens = modelTokens[modelKey];
    if (!tokens) {
      tokens = emptyModelTokens();
      modelTokens[modelKey] = tokens;
    }
    tokens.inputTokens += pureInput;
    tokens.outputTokens += row.outputTokens;
    tokens.cacheReadTokens += row.cacheReadTokens;
    tokens.cacheCreationTokens += row.cacheCreationTokens;
  }
  return { interactions, modelTokens };
}

export class Tracker {
  private baseline: Snapshot = emptySnapshot();
  // The snapshot that produced lastStats. consume() uses this as the new
  // baseline so any activity not yet reflected in lastStats (and therefore
  // not in the trailer the hook just consumed) is preserved as the next
  // commit's delta.
  private lastSnapshot: Snapshot | null = null;
  private since: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: StatsListener[] = [];
  private lastStats: TrackingStats | null = null;
  private previousStats: RestoredStats | null = null;
  private readonly reader: OTelReader;
  private readonly sessionIdsFn: () => string[];
  // Construction-time high-water mark. Every scan reads spans whose end_time
  // is strictly greater than this value, so pre-activation usage doesn't
  // leak into session totals.
  private readonly baselineMs: number;
  // Sticky session-id set: every id ever returned by sessionIdsFn() stays in
  // the filter. Without this, a session aging out of discovery or a transient
  // read failure would drop its spans from `current` while baseline still
  // counted them — shrinking the reported delta.
  private readonly seenSessionIds = new Set<string>();
  private disposed = false;

  constructor(reader: OTelReader, sessionIdsFn: () => string[]) {
    this.since = new Date().toISOString();
    this.reader = reader;
    this.sessionIdsFn = sessionIdsFn;
    this.baselineMs = reader.getLatestTimestamp();
  }

  setPreviousStats(restored: RestoredStats): void {
    this.previousStats = restored;
    this.since = restored.since;
    // Pre-render restored stats so the status bar reflects the prior session
    // immediately, before the first async scan completes. Without this, the
    // bar would briefly show 0 AIC after activation on accounts with large
    // chat histories where the initial scan takes seconds.
    this.lastStats = this.computeStats(emptySnapshot());
  }

  onStatsChanged(listener: StatsListener): { dispose: () => void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(listener);
        if (idx >= 0) this.listeners.splice(idx, 1);
      },
    };
  }

  private scan(): Snapshot {
    for (const id of this.sessionIdsFn()) this.seenSessionIds.add(id);
    const sessionIds = Array.from(this.seenSessionIds);
    const rows = this.reader.aggregateSince(this.baselineMs, sessionIds);
    return rowsToSnapshot(rows);
  }

  private computeStats(current: Snapshot): TrackingStats {
    const baseline = this.baseline;
    const deltaModels: { [model: string]: ModelStats } = {};

    for (const [model, usage] of Object.entries(current.modelTokens)) {
      const base = baseline.modelTokens[model] ?? emptyModelTokens();
      const deltaInput = Math.max(0, usage.inputTokens - base.inputTokens);
      const deltaOutput = Math.max(0, usage.outputTokens - base.outputTokens);
      const deltaCacheRead = Math.max(
        0,
        usage.cacheReadTokens - base.cacheReadTokens,
      );
      const deltaCacheCreation = Math.max(
        0,
        usage.cacheCreationTokens - base.cacheCreationTokens,
      );

      if (
        deltaInput === 0 &&
        deltaOutput === 0 &&
        deltaCacheRead === 0 &&
        deltaCacheCreation === 0
      ) {
        continue;
      }

      const costAic = computeCost(model, {
        input: deltaInput,
        output: deltaOutput,
        cacheRead: deltaCacheRead,
        cacheCreation: deltaCacheCreation,
      });

      accumulateModelStats(deltaModels, model, {
        inputTokens: deltaInput,
        outputTokens: deltaOutput,
        cacheReadTokens: deltaCacheRead,
        cacheCreationTokens: deltaCacheCreation,
        costAic,
      });
    }

    if (this.previousStats) {
      for (const [model, prev] of Object.entries(this.previousStats.models)) {
        accumulateModelStats(deltaModels, model, prev);
      }
    }

    let totalTokens = 0;
    let totalAiCredits = 0;
    for (const m of Object.values(deltaModels)) {
      totalTokens +=
        m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
      totalAiCredits += m.costAic;
    }

    const interactions =
      Math.max(0, current.interactions - baseline.interactions) +
      (this.previousStats ? this.previousStats.interactions : 0);

    return {
      since: this.since,
      lastUpdated: new Date().toISOString(),
      models: deltaModels,
      totalTokens,
      interactions,
      totalAiCredits,
      mode: 'telemetry',
    };
  }

  async initialize(): Promise<void> {
    const snapshot = this.scan();
    if (this.disposed) return;
    this.baseline = snapshot;
    this.lastSnapshot = snapshot;
    log(
      `initialize: baseline set at ${snapshot.interactions} interactions across ${Object.keys(snapshot.modelTokens).length} model(s)`,
    );
    this.lastStats = this.computeStats(snapshot);
  }

  private notifyListeners(stats: TrackingStats): void {
    for (const listener of [...this.listeners]) {
      listener(stats);
    }
  }

  async update(): Promise<void> {
    const current = this.scan();
    if (this.disposed) return;
    const stats = this.computeStats(current);
    this.lastSnapshot = current;

    if (
      !this.lastStats ||
      stats.totalTokens !== this.lastStats.totalTokens ||
      stats.interactions !== this.lastStats.interactions ||
      stats.totalAiCredits !== this.lastStats.totalAiCredits
    ) {
      this.lastStats = stats;
      this.notifyListeners(stats);
    }
  }

  // Kicks off the initial scan, then installs the periodic poll. Async so
  // callers can await baseline completion if they need stats immediately, but
  // most callers fire-and-forget — `initialize()` can take real time on
  // accounts with large histories.
  async start(intervalMs: number = 30_000): Promise<void> {
    // Catch the initial scan failure rather than letting it propagate. The
    // caller in activation fires-and-forgets `start()`; without the catch, a
    // transient OTel-DB lock at activation would short-circuit the poll-timer
    // install and the tracker would stay silent forever. Logging surfaces the
    // failure; the timer then drives `update()` retries every 30s, which
    // recover automatically once the DB can be read again.
    try {
      await this.initialize();
    } catch (err) {
      log(`initialize failed (will retry via poll): ${String(err)}`);
    }
    // dispose() may have been called while initialize() was suspended; if so,
    // skip installing the timer — otherwise the disposed tracker would keep
    // polling on a closed reader forever.
    if (this.disposed) return;
    this.timer = setInterval(() => {
      this.update().catch(() => {});
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async reset(): Promise<void> {
    const snapshot = this.scan();
    if (this.disposed) return;
    this.previousStats = null;
    this.baseline = snapshot;
    this.lastSnapshot = snapshot;
    this.since = new Date().toISOString();
    const stats = this.computeStats(snapshot);
    this.lastStats = stats;
    this.notifyListeners(stats);
  }

  // Hook-truncate handler. Unlike reset(), which zeros everything by
  // rebaselining to the current scan, consume() rebases to the snapshot that
  // produced the stats the hook just appended as trailers. Anything beyond
  // that snapshot — pre-commit activity that hadn't been written yet, plus
  // any post-commit Copilot usage that landed before we noticed the
  // truncation — survives as the next commit's delta.
  //
  // Returns `true` when the rebase happened. Always `true` in the OTel-only
  // design; kept as a boolean return for API stability with callers that
  // expected the previous source-swap bail path.
  async consume(): Promise<boolean> {
    const baselineSnapshot = this.lastSnapshot ?? this.scan();
    if (this.disposed) return false;
    const current = this.scan();
    if (this.disposed) return false;
    this.previousStats = null;
    this.baseline = baselineSnapshot;
    this.lastSnapshot = current;
    this.since = new Date().toISOString();
    const stats = this.computeStats(current);
    this.lastStats = stats;
    this.notifyListeners(stats);
    return true;
  }

  getStats(): TrackingStats {
    if (!this.lastStats) {
      return {
        since: this.since,
        lastUpdated: new Date().toISOString(),
        models: {},
        totalTokens: 0,
        interactions: 0,
        totalAiCredits: 0,
        mode: 'telemetry',
      };
    }
    return this.lastStats;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners = [];
    this.reader.close();
    this.previousStats = null;
    this.lastSnapshot = null;
  }
}
