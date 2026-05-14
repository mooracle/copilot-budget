import * as fs from 'fs';
import { discoverSessionFiles, discoverVscdbFiles } from './sessionDiscovery';
import { parseSessionFileContent, ModelUsage } from './sessionParser';
import { readSessionsFromVscdb, isSqliteReady } from './sqliteReader';
import { computeCost } from './tokenRates';
import { PlanInfo, DEFAULT_COST_PER_REQUEST } from './planDetector';
import { log } from './logger';

export interface ModelStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** @deprecated retained as 0 for downstream compile-compat; removed in Task 5/6/7. */
  premiumRequests: number;
}

export interface TrackingStats {
  since: string;
  lastUpdated: string;
  models: { [model: string]: ModelStats };
  totalTokens: number;
  interactions: number;
  totalCostUsd: number;
  totalAiCredits: number;
  /** @deprecated retained as 0 for downstream compile-compat; removed in Task 5/6/7. */
  premiumRequests: number;
  /** @deprecated retained as 0 for downstream compile-compat; removed in Task 5/6/7. */
  estimatedCost: number;
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
    costUsd: 0,
    premiumRequests: 0,
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
  entry.costUsd += contrib.costUsd;
}

export class Tracker {
  private baseline: {
    interactions: number;
    modelUsage: ModelUsage;
    modelInteractions: { [model: string]: number };
  } = { interactions: 0, modelUsage: {}, modelInteractions: {} };
  private fileCache = new Map<string, FileCache>();
  private since: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: StatsListener[] = [];
  private lastStats: TrackingStats | null = null;
  private previousStats: RestoredStats | null = null;

  constructor() {
    this.since = new Date().toISOString();
  }

  /**
   * @deprecated Plan detection is being removed (premium-request pricing model
   * deprecated 2026-06-01). Kept as a no-op for caller compile-compat until
   * Task 7 deletes the planDetector module and call sites.
   */
  setPlanInfoProvider(_provider: () => PlanInfo): void {
    // no-op
    void _provider;
    void DEFAULT_COST_PER_REQUEST;
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

      const costUsd = computeCost(model, {
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
        costUsd,
        premiumRequests: 0,
      });
    }

    if (this.previousStats) {
      for (const [model, prev] of Object.entries(this.previousStats.models)) {
        accumulateModelStats(deltaModels, model, prev);
      }
    }

    let totalTokens = 0;
    let totalCostUsd = 0;
    for (const m of Object.values(deltaModels)) {
      totalTokens +=
        m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
      totalCostUsd += m.costUsd;
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
      totalCostUsd,
      totalAiCredits: totalCostUsd * 100,
      premiumRequests: 0,
      estimatedCost: 0,
    };
  }

  initialize(): void {
    const snapshot = this.scanAll();
    this.baseline = snapshot;
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

    if (
      !this.lastStats ||
      stats.totalTokens !== this.lastStats.totalTokens ||
      stats.interactions !== this.lastStats.interactions ||
      stats.totalCostUsd !== this.lastStats.totalCostUsd
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
    this.since = new Date().toISOString();
    const stats = this.computeStats(snapshot);
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
        totalCostUsd: 0,
        totalAiCredits: 0,
        premiumRequests: 0,
        estimatedCost: 0,
      };
    }
    return this.lastStats;
  }

  dispose(): void {
    this.stop();
    this.listeners = [];
    this.fileCache.clear();
    this.previousStats = null;
  }
}
