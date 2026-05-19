import * as fs from 'fs';
import * as vscode from 'vscode';
import { discoverSessionFiles } from './sessionDiscovery';
import { parseSessionFileContent, ModelUsage } from './sessionParser';
import { computeCost } from './tokenRates';
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

interface FileCache {
  mtime: number;
  interactions: number;
  modelUsage: ModelUsage;
  modelInteractions: { [model: string]: number };
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

type Snapshot = {
  interactions: number;
  modelUsage: ModelUsage;
  modelInteractions: { [model: string]: number };
};

export class Tracker {
  private baseline: Snapshot = {
    interactions: 0,
    modelUsage: {},
    modelInteractions: {},
  };
  // The scan that produced lastStats. consume() uses this as the new baseline
  // so any activity not yet reflected in lastStats (and therefore not in the
  // trailer the hook just consumed) is preserved as the next commit's delta.
  private lastSnapshot: Snapshot | null = null;
  private fileCache = new Map<string, FileCache>();
  // Snapshot of file paths present at the moment baseline was captured.
  // Used by getFileDiagnostics() to flag which files were already on disk
  // at session start (and therefore have their existing contents folded
  // into the baseline) versus files that appeared mid-session (whose
  // entire contents count toward the session delta).
  private baselineFiles = new Set<string>();
  private since: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: StatsListener[] = [];
  private lastStats: TrackingStats | null = null;
  private previousStats: RestoredStats | null = null;
  private readonly storageUri: vscode.Uri | undefined;

  constructor(storageUri: vscode.Uri | undefined) {
    this.since = new Date().toISOString();
    this.storageUri = storageUri;
  }

  setPreviousStats(restored: RestoredStats): void {
    this.previousStats = restored;
    this.since = restored.since;
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

  private scanAll(): {
    interactions: number;
    modelUsage: ModelUsage;
    modelInteractions: { [model: string]: number };
  } {
    const files = discoverSessionFiles(this.storageUri);
    log(`scanAll: discovered ${files.length} session file(s)`);

    const currentFiles = new Set(files);
    const totals = {
      interactions: 0,
      modelUsage: {} as ModelUsage,
      modelInteractions: {} as { [model: string]: number },
    };

    for (const cached of this.fileCache.keys()) {
      if (!currentFiles.has(cached)) {
        this.fileCache.delete(cached);
      }
    }

    for (const file of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
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

      let parsed;
      try {
        parsed = parseSessionFileContent(content);
      } catch {
        log(`scanAll: failed to parse session file: ${file}`);
        continue;
      }

      const entry = {
        interactions: parsed.interactions,
        modelUsage: parsed.modelUsage,
        modelInteractions: parsed.modelInteractions,
      };
      this.fileCache.set(file, { mtime, ...entry });
      totals.interactions += entry.interactions;
      mergeModelUsage(totals.modelUsage, entry.modelUsage);
      mergeModelInteractions(totals.modelInteractions, entry.modelInteractions);
    }

    log(
      `scanAll: total ${totals.interactions} interactions across ${Object.keys(totals.modelUsage).length} model(s)`,
    );

    return totals;
  }

  private computeStats(current: {
    interactions: number;
    modelUsage: ModelUsage;
    modelInteractions: { [model: string]: number };
  }): TrackingStats {
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
    };
  }

  initialize(): void {
    const snapshot = this.scanAll();
    this.baseline = snapshot;
    this.lastSnapshot = snapshot;
    this.baselineFiles = new Set(this.fileCache.keys());
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

  update(): void {
    const current = this.scanAll();
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

  start(intervalMs: number = 30_000): void {
    this.initialize();
    this.timer = setInterval(() => this.update(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.previousStats = null;
    const snapshot = this.scanAll();
    this.baseline = snapshot;
    this.lastSnapshot = snapshot;
    this.baselineFiles = new Set(this.fileCache.keys());
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
  consume(): void {
    this.previousStats = null;
    this.baseline = this.lastSnapshot ?? this.scanAll();
    this.baselineFiles = new Set(this.fileCache.keys());
    this.since = new Date().toISOString();
    const current = this.scanAll();
    this.lastSnapshot = current;
    const stats = this.computeStats(current);
    this.lastStats = stats;
    this.notifyListeners(stats);
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

  getStats(): TrackingStats {
    if (!this.lastStats) {
      return {
        since: this.since,
        lastUpdated: new Date().toISOString(),
        models: {},
        totalTokens: 0,
        interactions: 0,
        totalAiCredits: 0,
      };
    }
    return this.lastStats;
  }

  dispose(): void {
    this.stop();
    this.listeners = [];
    this.fileCache.clear();
    this.baselineFiles.clear();
    this.previousStats = null;
    this.lastSnapshot = null;
  }
}
