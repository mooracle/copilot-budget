import * as fs from 'fs';
import { discoverSessionFiles, discoverVscdbFiles } from './sessionDiscovery';
import { parseSessionFileContent, ModelUsage } from './sessionParser';
import { readSessionsFromVscdb, isSqliteReady } from './sqliteReader';
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
  private since: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: StatsListener[] = [];
  private lastStats: TrackingStats | null = null;
  private previousStats: RestoredStats | null = null;

  constructor() {
    this.since = new Date().toISOString();
  }

  setPreviousStats(restored: RestoredStats): void {
    this.previousStats = restored;
    this.since = restored.since;
    // Keep lastStats.since in sync when setPreviousStats is called after
    // initialize() (i.e. after activation, during unread-recovery). Without
    // this, a zero-state restore (INTERACTIONS=0, totalAiCredits=0) wouldn't
    // trip the update() comparator on totalTokens/interactions/totalAiCredits,
    // and the activation-time since would silently persist into the next
    // tracking-file write and the status-bar tooltip.
    if (this.lastStats) {
      this.lastStats = { ...this.lastStats, since: restored.since };
    }
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

  private processFileWithCache(
    file: string,
    parseFn: () => Omit<FileCache, 'mtime'> | null,
    totals: {
      interactions: number;
      modelUsage: ModelUsage;
      modelInteractions: { [model: string]: number };
    },
  ): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }

    const mtime = stat.mtimeMs;
    const cached = this.fileCache.get(file);

    if (cached && cached.mtime === mtime) {
      totals.interactions += cached.interactions;
      mergeModelUsage(totals.modelUsage, cached.modelUsage);
      mergeModelInteractions(totals.modelInteractions, cached.modelInteractions);
      return;
    }

    const result = parseFn();
    if (!result) return;

    this.fileCache.set(file, { mtime, ...result });
    totals.interactions += result.interactions;
    mergeModelUsage(totals.modelUsage, result.modelUsage);
    mergeModelInteractions(totals.modelInteractions, result.modelInteractions);
  }

  private scanAll(): {
    interactions: number;
    modelUsage: ModelUsage;
    modelInteractions: { [model: string]: number };
  } {
    const files = discoverSessionFiles();
    const vscdbFiles = isSqliteReady() ? discoverVscdbFiles() : [];
    log(
      `scanAll: discovered ${files.length} session file(s), ${vscdbFiles.length} vscdb file(s)`,
    );

    const currentFiles = new Set([...files, ...vscdbFiles]);
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
      this.processFileWithCache(
        file,
        () => {
          let content: string;
          try {
            content = fs.readFileSync(file, 'utf-8');
          } catch {
            return null;
          }
          try {
            const result = parseSessionFileContent(file, content);
            return {
              interactions: result.interactions,
              modelUsage: result.modelUsage,
              modelInteractions: result.modelInteractions,
            };
          } catch {
            log(`scanAll: failed to parse session file: ${file}`);
            return null;
          }
        },
        totals,
      );
    }

    for (const vscdbFile of vscdbFiles) {
      this.processFileWithCache(
        vscdbFile,
        () => {
          const jsonStrings = readSessionsFromVscdb(vscdbFile);
          let fileInteractions = 0;
          const fileModelUsage: ModelUsage = {};
          const fileModelInteractions: { [model: string]: number } = {};

          for (const jsonStr of jsonStrings) {
            let sessions: unknown[];
            try {
              const parsed = JSON.parse(jsonStr);
              sessions = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              continue;
            }

            for (const session of sessions) {
              if (typeof session !== 'object' || session === null) {
                continue;
              }
              const sessionContent = JSON.stringify(session);
              try {
                const result = parseSessionFileContent(vscdbFile, sessionContent);
                fileInteractions += result.interactions;
                mergeModelUsage(fileModelUsage, result.modelUsage);
                mergeModelInteractions(fileModelInteractions, result.modelInteractions);
              } catch {
                continue;
              }
            }
          }

          return {
            interactions: fileInteractions,
            modelUsage: fileModelUsage,
            modelInteractions: fileModelInteractions,
          };
        },
        totals,
      );
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

  start(intervalMs: number = 120_000): void {
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
    this.since = new Date().toISOString();
    const current = this.scanAll();
    this.lastSnapshot = current;
    const stats = this.computeStats(current);
    this.lastStats = stats;
    this.notifyListeners(stats);
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
    this.previousStats = null;
    this.lastSnapshot = null;
  }
}
