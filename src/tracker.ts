import * as fs from 'fs';
import * as vscode from 'vscode';
import { discoverSessionFiles } from './sessionDiscovery';
import {
  applyDeltaLines,
  aggregateFromState,
  createParserState,
  ModelUsage,
  ParserState,
} from './sessionParser';
import { computeCost, normalizeModelId, stripModelPrefix } from './tokenRates';
import { OTelReader } from './otelReader';
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
  // Source of the numbers: 'files' = derived from chatSessions/*.jsonl with the
  // cache heuristic dropped (upper bound); 'telemetry' = measured via Copilot's
  // OTel SQLite store. Threaded into status bar, tooltip, and trailer value so
  // the audit signal (tilde prefix in files mode) propagates end-to-end.
  mode: 'files' | 'telemetry';
}

export interface RestoredStats {
  since: string;
  interactions: number;
  models: { [model: string]: ModelStats };
}

export interface FileDiagnostics {
  path: string;
  mtime: number;
  interactions: number;
  modelInteractions: { [model: string]: number };
  modelUsage: ModelUsage;
  inBaseline: boolean;
}

// Per-scan raw counts the Tracker aggregates into TrackingStats. JsonlSource
// produces this from chatSessions/*.jsonl. The forthcoming OTelSource (Task 5b)
// produces the same shape from agent-traces.db so Tracker stays source-agnostic.
export interface RawAggregateBatch {
  interactions: number;
  modelUsage: ModelUsage;
  modelInteractions: { [model: string]: number };
}

// Strategy interface lifting source-of-truth out of Tracker. Implementations
// own discovery, parsing, and any per-source caching; Tracker only handles
// baseline/delta arithmetic and listener fan-out.
export interface Source {
  scan(): Promise<RawAggregateBatch>;
  dispose(): void;
}

interface FileCache {
  mtime: number;
  interactions: number;
  modelUsage: ModelUsage;
  modelInteractions: { [model: string]: number };
  // JS string code-unit index (NOT bytes) into the decoded file content
  // marking the position immediately after the last \n successfully parsed.
  // Used as the start of the next incremental slice. Resets on truncation.
  // Mixing byte offsets with string.slice() corrupts on any multi-byte
  // character, so this must stay string-indexed end-to-end.
  lastOffset: number;
  // Cached parser state allowing incremental delta application. Null when
  // evicted by LRU (Task 4) or before first parse.
  parserState: ParserState | null;
}

type StatsListener = (stats: TrackingStats) => void;

function emptyModelTokens() {
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

function mergeModelUsage(target: ModelUsage, source: ModelUsage): void {
  for (const [model, usage] of Object.entries(source)) {
    let entry = target[model];
    if (!entry) {
      entry = emptyModelTokens();
      target[model] = entry;
    }
    entry.inputTokens += usage.inputTokens;
    entry.outputTokens += usage.outputTokens;
    entry.cacheReadTokens += usage.cacheReadTokens;
    entry.cacheCreationTokens += usage.cacheCreationTokens;
  }
}

function mergeModelInteractions(
  target: { [model: string]: number },
  source: { [model: string]: number },
): void {
  for (const [model, count] of Object.entries(source)) {
    target[model] = (target[model] || 0) + count;
  }
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

// Yield to the event loop so the extension host can service UI/I-O between
// files. `setImmediate` fires after the current poll phase, which is what we
// want; `Promise.resolve()` would only flush microtasks and starve I/O.
function yieldEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export class JsonlSource implements Source {
  // Cap on the number of `parserState` objects retained at once. Aggregates and
  // lastOffset survive eviction unchanged — only the incremental-parse anchor
  // is dropped, forcing a full re-parse on the next mtime change for that file.
  // TODO: surface as `copilot-budget.parserStateCacheSize` config if heavy
  // multi-chat users ever need to tune this.
  private static readonly MAX_PARSER_STATES = 3;
  private fileCache = new Map<string, FileCache>();
  // Paths in least-recently-touched order whose `parserState` is currently
  // retained. Tail = most recently used. Touched whenever a scan creates or
  // applies deltas to a parserState. Over the cap, the head is evicted —
  // its cache entry survives with parserState=null.
  private parserStateLru: string[] = [];
  // Snapshot of file paths present at the moment baseline was captured.
  // Used by getFileDiagnostics() to flag which files were already on disk
  // at session start (and therefore have their existing contents folded
  // into the baseline) versus files that appeared mid-session (whose
  // entire contents count toward the session delta).
  private baselineFiles = new Set<string>();
  // Single-flight mutex for scan(). The 30s timer can fire while a previous
  // scan is still in progress (large chat histories, slow disks). Without
  // this, overlapping scans would each parse every file and contend on the
  // fileCache. With it, the second caller awaits the in-flight scan's result.
  private scanInFlight: Promise<RawAggregateBatch> | null = null;
  private readonly storageUri: vscode.Uri | undefined;

  constructor(storageUri: vscode.Uri | undefined) {
    this.storageUri = storageUri;
  }

  scan(): Promise<RawAggregateBatch> {
    if (this.scanInFlight) return this.scanInFlight;
    this.scanInFlight = this.doScan();
    // Clear the slot once the scan settles (success or failure) so the next
    // caller starts a fresh scan rather than reusing a stale result. The
    // returned `.finally()` Promise propagates any rejection from doScan();
    // awaiters already see that rejection via `scanInFlight` itself, so we
    // swallow the duplicate to prevent an unhandled rejection warning.
    this.scanInFlight
      .finally(() => {
        this.scanInFlight = null;
      })
      .catch(() => {});
    return this.scanInFlight;
  }

  // Snapshot the current file-cache key set as the baseline. Called by Tracker
  // after initialize/consume/reset so getFileDiagnostics() can flag which files
  // were already present when the session started (their existing contents are
  // folded into the baseline) versus files that appeared mid-session.
  markBaseline(): void {
    this.baselineFiles = new Set(this.fileCache.keys());
  }

  // Per-file breakdown for diagnostics. Reflects the most recent successful
  // scan of each file (the same data the delta computation consumed), plus
  // a flag indicating whether the file was already present when the baseline
  // was captured. New files that appeared mid-session have their entire
  // contents — including the very first request — attributed to the session
  // delta, since baseline contributes 0 for them.
  getFileDiagnostics(): FileDiagnostics[] {
    const out: FileDiagnostics[] = [];
    for (const [path, entry] of this.fileCache.entries()) {
      out.push({
        path,
        mtime: entry.mtime,
        interactions: entry.interactions,
        modelInteractions: entry.modelInteractions,
        modelUsage: entry.modelUsage,
        inBaseline: this.baselineFiles.has(path),
      });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  dispose(): void {
    this.fileCache.clear();
    this.parserStateLru = [];
    this.baselineFiles.clear();
  }

  private touchParserStateLru(path: string): void {
    const idx = this.parserStateLru.indexOf(path);
    if (idx >= 0) this.parserStateLru.splice(idx, 1);
    this.parserStateLru.push(path);
    while (this.parserStateLru.length > JsonlSource.MAX_PARSER_STATES) {
      const evicted = this.parserStateLru.shift();
      if (!evicted) break;
      const entry = this.fileCache.get(evicted);
      if (entry) entry.parserState = null;
    }
  }

  private dropParserStateLru(path: string): void {
    const idx = this.parserStateLru.indexOf(path);
    if (idx >= 0) this.parserStateLru.splice(idx, 1);
  }

  private async doScan(): Promise<RawAggregateBatch> {
    const files = discoverSessionFiles(this.storageUri);
    log(`scan: discovered ${files.length} session file(s)`);

    // Union discovered ∪ cached. Discovery may filter out files that have aged
    // past `sessionMaxAgeDays`, but files already in the cache contributed to
    // baseline and must keep being scanned — otherwise their tokens would
    // silently drop out of `current` and skew the delta.
    const filesToScan = new Set<string>(files);
    for (const cached of this.fileCache.keys()) {
      filesToScan.add(cached);
    }

    const totals: RawAggregateBatch = {
      interactions: 0,
      modelUsage: {},
      modelInteractions: {},
    };

    const fileList = Array.from(filesToScan);
    for (let i = 0; i < fileList.length; i++) {
      // Yield between files so a long scan doesn't block the extension host.
      // Mtime-cached hits still take this yield — they're cheap individually
      // but on a 1000-file cache a tight loop still adds up.
      if (i > 0) await yieldEventLoop();
      const file = fileList[i];

      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        // File no longer on disk (deleted/moved) — evict from cache.
        this.fileCache.delete(file);
        this.dropParserStateLru(file);
        continue;
      }

      const mtime = stat.mtimeMs;
      const cached = this.fileCache.get(file);

      if (cached && cached.mtime === mtime) {
        totals.interactions += cached.interactions;
        mergeModelUsage(totals.modelUsage, cached.modelUsage);
        mergeModelInteractions(totals.modelInteractions, cached.modelInteractions);
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      // Incremental requires a live cached parser state plus a strict size
      // increase (in JS string code-units — matches lastOffset). Truncation
      // and same-size in-place rewrites both fall to full re-parse.
      const canIncremental =
        cached?.parserState != null && content.length > cached.lastOffset;

      let parsed;
      let parserState: ParserState | null;
      let nextLastOffset: number;
      try {
        if (canIncremental) {
          parserState = cached!.parserState!;
          const newTail = content.slice(cached!.lastOffset);
          const lastNewline = newTail.lastIndexOf('\n');
          if (lastNewline < 0) {
            // Partial trailing line — no \n yet. Hold off on parsing so the
            // line completes atomically next scan. Bump mtime so we don't
            // re-enter this branch until the file changes again. Touch the
            // LRU so an actively-accumulating file isn't evicted between
            // partial scans (which would force a needless full re-parse).
            cached!.mtime = mtime;
            this.touchParserStateLru(file);
            totals.interactions += cached!.interactions;
            mergeModelUsage(totals.modelUsage, cached!.modelUsage);
            mergeModelInteractions(totals.modelInteractions, cached!.modelInteractions);
            continue;
          }
          const newLines = newTail
            .slice(0, lastNewline)
            .split(/\r?\n/)
            .filter((l) => l.trim());
          applyDeltaLines(newLines, parserState);
          nextLastOffset = cached!.lastOffset + lastNewline + 1;
          parsed = aggregateFromState(parserState);
        } else {
          const freshState = createParserState();
          // Match the incremental branch's atomicity guarantee: only parse
          // lines that are terminated by a \n we have actually seen. If the
          // file ends mid-write, the partial trailing line stays unparsed and
          // lastOffset stops at the last newline, so the next scan picks it
          // up atomically once the completion bytes arrive.
          const lastNewline = content.lastIndexOf('\n');
          const completePrefix = lastNewline < 0 ? '' : content.slice(0, lastNewline + 1);
          const lines = completePrefix.split(/\r?\n/).filter((l) => l.trim());
          applyDeltaLines(lines, freshState);
          parsed = aggregateFromState(freshState);
          if (freshState.hasReceivedDelta) {
            parserState = freshState;
            nextLastOffset = lastNewline < 0 ? 0 : lastNewline + 1;
          } else {
            // The parser refused the entire batch (corrupted first line, or
            // first line isn't a delta object with numeric kind). Caching the
            // un-primed parserState would let the next mtime change feed only
            // the appended tail into the incremental path; the still-fresh
            // guard would then accept the first appended kind:1/kind:2 line
            // and fabricate a requests tree from a file `main` would keep
            // rejecting on every scan. Drop the state and reset lastOffset
            // so subsequent scans repeat the full re-parse (and keep
            // rejecting until the bad prefix is rewritten).
            parserState = null;
            nextLastOffset = 0;
          }
        }
      } catch {
        log(`scan: failed to parse session file: ${file}`);
        continue;
      }

      const entry = {
        interactions: parsed.interactions,
        modelUsage: parsed.modelUsage,
        modelInteractions: parsed.modelInteractions,
      };
      this.fileCache.set(file, {
        mtime,
        ...entry,
        lastOffset: nextLastOffset,
        parserState,
      });
      if (parserState !== null) {
        this.touchParserStateLru(file);
      } else {
        // Drop from LRU too — a prior successful parse may have inserted us,
        // but we no longer hold a state worth keeping warm.
        this.dropParserStateLru(file);
      }
      totals.interactions += entry.interactions;
      mergeModelUsage(totals.modelUsage, entry.modelUsage);
      mergeModelInteractions(totals.modelInteractions, entry.modelInteractions);
    }

    log(
      `scan: total ${totals.interactions} interactions across ${Object.keys(totals.modelUsage).length} model(s)`,
    );

    return totals;
  }
}

// Source-of-truth strategy backed by Copilot Chat's OTel SQLite store. Reads
// measured per-span token counts (input / output / cache_read / cache_creation)
// from `agent-traces.db` so we never apply the 75% Files-mode heuristic. The
// session-id filter is best-effort window scoping: it accepts whichever
// session IDs the resolver can see on disk now. Same-repo dual-window remains
// last-writer-wins on the tracking file (pre-existing limitation, per
// CLAUDE.md). A span whose JSONL companion hasn't materialized yet is
// excluded — acceptable tradeoff. The session-id filter test in
// tracker.test.ts ("passes the construction-time baseline and resolver-
// provided session ids to readSpansSince") confirms this scoping behavior.
export class OTelSource implements Source {
  private readonly reader: OTelReader;
  private readonly sessionIdsFn: () => string[];
  // Construction-time high-water mark. Every scan reads spans whose
  // start_time_ms is at or after this value. Tracker's baseline arithmetic
  // does the rest: initialize()'s scan captures whatever already lived above
  // this mark as the baseline, and subsequent scans surface only the post-
  // construction delta on top of it.
  private readonly baselineMs: number;

  constructor(reader: OTelReader, sessionIdsFn: () => string[]) {
    this.reader = reader;
    this.sessionIdsFn = sessionIdsFn;
    this.baselineMs = reader.getLatestTimestamp();
  }

  async scan(): Promise<RawAggregateBatch> {
    const sessionIds = this.sessionIdsFn();
    const spans = this.reader.readSpansSince(this.baselineMs, sessionIds);

    const modelUsage: ModelUsage = {};
    const modelInteractions: { [model: string]: number } = {};
    let interactions = 0;

    for (const span of spans) {
      interactions += 1;
      // Match JsonlSource canonicalization: strip Copilot's request-routing
      // prefixes (`copilot/`, `copilotcli/`, `claude-code/`) before lowercasing.
      // Without this, OTel spans reporting `copilot/gpt-4o` would aggregate
      // under a different key than JSONL data and split totals on swap.
      const modelKey = span.model
        ? normalizeModelId(stripModelPrefix(span.model))
        : 'unknown';
      let usage = modelUsage[modelKey];
      if (!usage) {
        usage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        modelUsage[modelKey] = usage;
      }
      // OTel GenAI semantics: `input_tokens` is the full prompt token count
      // (cache-read + cache-creation + fresh). Subtract cached buckets to get
      // the non-cached prompt portion, matching sessionParser's model. Clamp
      // at 0 in case the provider mis-reports (input < cached).
      const cacheRead = span.cachedTokens;
      const cacheCreation = span.cacheCreationTokens;
      const pureInput = Math.max(
        0,
        span.inputTokens - cacheRead - cacheCreation,
      );
      usage.inputTokens += pureInput;
      usage.outputTokens += span.outputTokens;
      usage.cacheReadTokens += cacheRead;
      usage.cacheCreationTokens += cacheCreation;
      modelInteractions[modelKey] = (modelInteractions[modelKey] || 0) + 1;
    }

    return { interactions, modelUsage, modelInteractions };
  }

  dispose(): void {
    this.reader.close();
  }
}

export class Tracker {
  private baseline: RawAggregateBatch = {
    interactions: 0,
    modelUsage: {},
    modelInteractions: {},
  };
  // The scan that produced lastStats. consume() uses this as the new baseline
  // so any activity not yet reflected in lastStats (and therefore not in the
  // trailer the hook just consumed) is preserved as the next commit's delta.
  private lastSnapshot: RawAggregateBatch | null = null;
  private since: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: StatsListener[] = [];
  private lastStats: TrackingStats | null = null;
  private previousStats: RestoredStats | null = null;
  private source: Source;
  // mode is mutable so swapSource can flip 'files' ↔ 'telemetry' without
  // re-wiring the rest of the extension. Status bar and trailer file read this
  // on every render, so the swap takes effect on the next listener fire.
  mode: 'files' | 'telemetry';
  // Set by dispose(). Honored by start() after the initial async scan resolves
  // so a dispose() that lands during initialize() doesn't install the polling
  // timer on a disposed tracker (it would otherwise leak forever).
  private disposed = false;

  constructor(source: Source, mode: 'files' | 'telemetry' = 'files') {
    this.since = new Date().toISOString();
    this.source = source;
    this.mode = mode;
  }

  setPreviousStats(restored: RestoredStats): void {
    this.previousStats = restored;
    this.since = restored.since;
    // Pre-render restored stats so the status bar reflects the prior session
    // immediately, before the first async scan completes. Without this, the
    // bar would briefly show 0 AIC after activation on accounts with large
    // chat histories where the initial scan takes seconds. Once scan lands,
    // computeStats merges current delta with previousStats and overwrites.
    this.lastStats = this.computeStats({
      interactions: 0,
      modelUsage: {},
      modelInteractions: {},
    });
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

  private markSourceBaseline(): void {
    if (this.source instanceof JsonlSource) {
      this.source.markBaseline();
    }
  }

  private computeStats(current: RawAggregateBatch): TrackingStats {
    const baseline = this.baseline;

    const deltaModels: { [model: string]: ModelStats } = {};

    for (const [model, usage] of Object.entries(current.modelUsage)) {
      const base = baseline.modelUsage[model] ?? emptyModelTokens();
      const deltaInput = Math.max(0, usage.inputTokens - base.inputTokens);
      const deltaOutput = Math.max(0, usage.outputTokens - base.outputTokens);
      const deltaCacheRead = Math.max(0, usage.cacheReadTokens - base.cacheReadTokens);
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
      mode: this.mode,
    };
  }

  async initialize(): Promise<void> {
    const snapshot = await this.source.scan();
    this.baseline = snapshot;
    this.lastSnapshot = snapshot;
    this.markSourceBaseline();
    log(
      `initialize: baseline set at ${snapshot.interactions} interactions across ${Object.keys(snapshot.modelUsage).length} model(s)`,
    );
    this.lastStats = this.computeStats(snapshot);
  }

  private notifyListeners(stats: TrackingStats): void {
    for (const listener of [...this.listeners]) {
      listener(stats);
    }
  }

  async update(): Promise<void> {
    const current = await this.source.scan();
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
  // most callers fire-and-forget — initialize() can take seconds on accounts
  // with large chat histories and we don't want to block activation.
  async start(intervalMs: number = 30_000): Promise<void> {
    await this.initialize();
    // dispose() may have been called while initialize() was suspended; if so,
    // skip installing the timer — otherwise the disposed tracker would keep
    // polling on a cleared cache forever.
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
    this.previousStats = null;
    const snapshot = await this.source.scan();
    this.baseline = snapshot;
    this.lastSnapshot = snapshot;
    this.markSourceBaseline();
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
  // truncation — survives as the next commit's delta. Without this, a 5s
  // detection window would silently absorb that activity into a fresh
  // baseline and the next commit would underreport.
  async consume(): Promise<void> {
    this.previousStats = null;
    this.baseline = this.lastSnapshot ?? (await this.source.scan());
    this.markSourceBaseline();
    this.since = new Date().toISOString();
    const current = await this.source.scan();
    this.lastSnapshot = current;
    const stats = this.computeStats(current);
    this.lastStats = stats;
    this.notifyListeners(stats);
  }

  // Swap the source-of-truth on the fly. Used when the user enables OTel
  // (Files → Telemetry) or disables it via VS Code settings (Telemetry →
  // Files). Cumulative stats carry over by folding the current `lastStats`
  // into `previousStats`: the new source contributes only its own delta on
  // top of the carried total. `since` is preserved (the user has been
  // tracking since activation; the data source changed, not the session).
  async swapSource(
    newSource: Source,
    newMode: 'files' | 'telemetry',
  ): Promise<void> {
    const carried: RestoredStats | null = this.lastStats
      ? {
          since: this.since,
          interactions: this.lastStats.interactions,
          models: {},
        }
      : null;
    if (carried && this.lastStats) {
      for (const [model, stats] of Object.entries(this.lastStats.models)) {
        carried.models[model] = { ...stats };
      }
    }

    this.source.dispose();
    this.source = newSource;
    this.mode = newMode;
    this.previousStats = carried;
    this.baseline = { interactions: 0, modelUsage: {}, modelInteractions: {} };
    this.lastSnapshot = null;

    const snapshot = await newSource.scan();
    this.baseline = snapshot;
    this.lastSnapshot = snapshot;
    this.markSourceBaseline();
    const stats = this.computeStats(snapshot);
    this.lastStats = stats;
    this.notifyListeners(stats);
  }

  getFileDiagnostics(): FileDiagnostics[] {
    if (this.source instanceof JsonlSource) {
      return this.source.getFileDiagnostics();
    }
    return [];
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
        mode: this.mode,
      };
    }
    return this.lastStats;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners = [];
    this.source.dispose();
    this.previousStats = null;
    this.lastSnapshot = null;
  }
}
