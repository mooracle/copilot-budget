import * as fs from 'fs';
import { discoverSessionFiles } from './sessionDiscovery';
import { parseSessionFileContent, ModelUsage } from './sessionParser';
import { estimateTokensFromText } from './tokenEstimator';
import { log } from './logger';

export interface TrackingStats {
  since: string;
  lastUpdated: string;
  models: { [model: string]: { inputTokens: number; outputTokens: number } };
  totalTokens: number;
  interactions: number;
}

interface FileCache {
  mtime: number;
  tokens: number;
  interactions: number;
  modelUsage: ModelUsage;
}

type StatsListener = (stats: TrackingStats) => void;

function mergeModelUsage(target: ModelUsage, source: ModelUsage): void {
  for (const [model, usage] of Object.entries(source)) {
    if (!target[model]) {
      target[model] = { inputTokens: 0, outputTokens: 0 };
    }
    target[model].inputTokens += usage.inputTokens;
    target[model].outputTokens += usage.outputTokens;
  }
}

export class Tracker {
  private baseline: {
    tokens: number;
    interactions: number;
    modelUsage: ModelUsage;
  } | null = null;
  private fileCache = new Map<string, FileCache>();
  private since: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: StatsListener[] = [];
  private lastStats: TrackingStats | null = null;

  constructor() {
    this.since = new Date().toISOString();
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
    tokens: number;
    interactions: number;
    modelUsage: ModelUsage;
  } {
    const files = discoverSessionFiles();
    log(`scanAll: discovered ${files.length} session file(s)`);
    const currentFiles = new Set(files);
    let totalTokens = 0;
    let totalInteractions = 0;
    const mergedModels: ModelUsage = {};

    // Evict cache entries for files that no longer exist
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
        totalTokens += cached.tokens;
        totalInteractions += cached.interactions;
        mergeModelUsage(mergedModels, cached.modelUsage);
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      const result = parseSessionFileContent(
        file,
        content,
        estimateTokensFromText,
      );

      this.fileCache.set(file, {
        mtime,
        tokens: result.tokens,
        interactions: result.interactions,
        modelUsage: result.modelUsage,
      });

      totalTokens += result.tokens;
      totalInteractions += result.interactions;
      mergeModelUsage(mergedModels, result.modelUsage);
    }

    log(`scanAll: total ${totalTokens} tokens, ${totalInteractions} interactions`);

    return {
      tokens: totalTokens,
      interactions: totalInteractions,
      modelUsage: mergedModels,
    };
  }

  private computeStats(current: {
    tokens: number;
    interactions: number;
    modelUsage: ModelUsage;
  }): TrackingStats {
    const baseline = this.baseline || {
      tokens: 0,
      interactions: 0,
      modelUsage: {},
    };

    const deltaModels: {
      [model: string]: { inputTokens: number; outputTokens: number };
    } = {};
    for (const [model, usage] of Object.entries(current.modelUsage)) {
      const base = baseline.modelUsage[model] || {
        inputTokens: 0,
        outputTokens: 0,
      };
      const deltaInput = Math.max(0, usage.inputTokens - base.inputTokens);
      const deltaOutput = Math.max(0, usage.outputTokens - base.outputTokens);
      if (deltaInput > 0 || deltaOutput > 0) {
        deltaModels[model] = {
          inputTokens: deltaInput,
          outputTokens: deltaOutput,
        };
      }
    }

    const totalTokens = Object.values(deltaModels).reduce(
      (sum, m) => sum + m.inputTokens + m.outputTokens,
      0,
    );
    const interactions = Math.max(
      0,
      current.interactions - baseline.interactions,
    );

    return {
      since: this.since,
      lastUpdated: new Date().toISOString(),
      models: deltaModels,
      totalTokens,
      interactions,
    };
  }

  initialize(): void {
    const snapshot = this.scanAll();
    this.baseline = snapshot;
    log(`initialize: baseline set at ${snapshot.tokens} tokens, ${snapshot.interactions} interactions`);
    this.lastStats = this.computeStats(snapshot);
  }

  update(): void {
    const current = this.scanAll();
    const stats = this.computeStats(current);

    if (
      !this.lastStats ||
      stats.totalTokens !== this.lastStats.totalTokens ||
      stats.interactions !== this.lastStats.interactions
    ) {
      this.lastStats = stats;
      for (const listener of this.listeners) {
        listener(stats);
      }
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
    const snapshot = this.scanAll();
    this.baseline = snapshot;
    this.since = new Date().toISOString();
    const stats = this.computeStats(snapshot);
    this.lastStats = stats;
    for (const listener of this.listeners) {
      listener(stats);
    }
  }

  getStats(): TrackingStats {
    if (!this.lastStats) {
      return {
        since: this.since,
        lastUpdated: new Date().toISOString(),
        models: {},
        totalTokens: 0,
        interactions: 0,
      };
    }
    return this.lastStats;
  }

  dispose(): void {
    this.stop();
    this.listeners = [];
    this.fileCache.clear();
  }
}
