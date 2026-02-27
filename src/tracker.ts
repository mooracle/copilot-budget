import * as fs from 'fs';
import { discoverSessionFiles, discoverVscdbFiles } from './sessionDiscovery';
import { parseSessionFileContent, ModelUsage } from './sessionParser';
import { readSessionsFromVscdb, isSqliteReady } from './sqliteReader';
import { estimateTokensFromText, getPremiumMultiplier } from './tokenEstimator';
import { DEFAULT_COST_PER_REQUEST, PlanInfo } from './planDetector';
import { log } from './logger';

export interface TrackingStats {
  since: string;
  lastUpdated: string;
  models: { [model: string]: { inputTokens: number; outputTokens: number; premiumRequests: number } };
  totalTokens: number;
  interactions: number;
  premiumRequests: number;
  estimatedCost: number;
}

export interface RestoredStats {
  since: string;
  interactions: number;
  models: { [model: string]: { inputTokens: number; outputTokens: number; premiumRequests: number } };
}

interface FileCache {
  mtime: number;
  tokens: number;
  interactions: number;
  modelUsage: ModelUsage;
  modelInteractions: { [model: string]: number };
}

type StatsListener = (stats: TrackingStats) => void;

function sanitizeModelName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function mergeModelUsage(target: ModelUsage, source: ModelUsage): void {
  for (const [model, usage] of Object.entries(source)) {
    if (!target[model]) {
      target[model] = { inputTokens: 0, outputTokens: 0 };
    }
    target[model].inputTokens += usage.inputTokens;
    target[model].outputTokens += usage.outputTokens;
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

export class Tracker {
  private baseline: {
    tokens: number;
    interactions: number;
    modelUsage: ModelUsage;
    modelInteractions: { [model: string]: number };
  } = { tokens: 0, interactions: 0, modelUsage: {}, modelInteractions: {} };
  private fileCache = new Map<string, FileCache>();
  private since: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: StatsListener[] = [];
  private lastStats: TrackingStats | null = null;
  private planInfoProvider: () => PlanInfo = () => ({
    planName: 'unknown',
    costPerRequest: DEFAULT_COST_PER_REQUEST,
    source: 'default' as const,
  });
  private previousStats: RestoredStats | null = null;

  constructor() {
    this.since = new Date().toISOString();
  }

  setPlanInfoProvider(provider: () => PlanInfo): void {
    this.planInfoProvider = provider;
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
    tokens: number;
    interactions: number;
    modelUsage: ModelUsage;
    modelInteractions: { [model: string]: number };
  } {
    const files = discoverSessionFiles();
    const vscdbFiles = isSqliteReady() ? discoverVscdbFiles() : [];
    log(`scanAll: discovered ${files.length} session file(s), ${vscdbFiles.length} vscdb file(s)`);

    const currentFiles = new Set([...files, ...vscdbFiles]);
    let totalTokens = 0;
    let totalInteractions = 0;
    const mergedModels: ModelUsage = {};
    const mergedModelInteractions: { [model: string]: number } = {};

    // Evict cache entries for files that no longer exist
    for (const cached of this.fileCache.keys()) {
      if (!currentFiles.has(cached)) {
        this.fileCache.delete(cached);
      }
    }

    // Process JSON/JSONL files
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
        mergeModelInteractions(mergedModelInteractions, cached.modelInteractions);
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      let result;
      try {
        result = parseSessionFileContent(
          file,
          content,
          estimateTokensFromText,
        );
      } catch {
        log(`scanAll: failed to parse session file: ${file}`);
        continue;
      }

      this.fileCache.set(file, {
        mtime,
        tokens: result.tokens,
        interactions: result.interactions,
        modelUsage: result.modelUsage,
        modelInteractions: result.modelInteractions,
      });

      totalTokens += result.tokens;
      totalInteractions += result.interactions;
      mergeModelUsage(mergedModels, result.modelUsage);
      mergeModelInteractions(mergedModelInteractions, result.modelInteractions);
    }

    // Process vscdb files
    for (const vscdbFile of vscdbFiles) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(vscdbFile);
      } catch {
        continue;
      }

      const mtime = stat.mtimeMs;
      const cached = this.fileCache.get(vscdbFile);

      if (cached && cached.mtime === mtime) {
        totalTokens += cached.tokens;
        totalInteractions += cached.interactions;
        mergeModelUsage(mergedModels, cached.modelUsage);
        mergeModelInteractions(mergedModelInteractions, cached.modelInteractions);
        continue;
      }

      const jsonStrings = readSessionsFromVscdb(vscdbFile);
      let fileTokens = 0;
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
          let result;
          try {
            result = parseSessionFileContent(
              vscdbFile,
              sessionContent,
              estimateTokensFromText,
            );
          } catch {
            continue;
          }
          fileTokens += result.tokens;
          fileInteractions += result.interactions;
          mergeModelUsage(fileModelUsage, result.modelUsage);
          mergeModelInteractions(fileModelInteractions, result.modelInteractions);
        }
      }

      this.fileCache.set(vscdbFile, {
        mtime,
        tokens: fileTokens,
        interactions: fileInteractions,
        modelUsage: fileModelUsage,
        modelInteractions: fileModelInteractions,
      });

      totalTokens += fileTokens;
      totalInteractions += fileInteractions;
      mergeModelUsage(mergedModels, fileModelUsage);
      mergeModelInteractions(mergedModelInteractions, fileModelInteractions);
    }

    log(`scanAll: total ${totalTokens} tokens, ${totalInteractions} interactions`);

    return {
      tokens: totalTokens,
      interactions: totalInteractions,
      modelUsage: mergedModels,
      modelInteractions: mergedModelInteractions,
    };
  }

  private computeStats(current: {
    tokens: number;
    interactions: number;
    modelUsage: ModelUsage;
    modelInteractions: { [model: string]: number };
  }): TrackingStats {
    const baseline = this.baseline;

    const deltaModels: {
      [model: string]: { inputTokens: number; outputTokens: number; premiumRequests: number };
    } = {};

    // Compute per-model delta interactions for premium request calculation
    const deltaModelInteractions: { [model: string]: number } = {};
    for (const [model, count] of Object.entries(current.modelInteractions)) {
      const baseCount = baseline.modelInteractions[model] || 0;
      const delta = Math.max(0, count - baseCount);
      if (delta > 0) {
        deltaModelInteractions[model] = delta;
      }
    }

    for (const [model, usage] of Object.entries(current.modelUsage)) {
      const base = baseline.modelUsage[model] || {
        inputTokens: 0,
        outputTokens: 0,
      };
      const deltaInput = Math.max(0, usage.inputTokens - base.inputTokens);
      const deltaOutput = Math.max(0, usage.outputTokens - base.outputTokens);
      const modelPremium = (deltaModelInteractions[model] || 0) * getPremiumMultiplier(model);
      if (deltaInput > 0 || deltaOutput > 0 || modelPremium > 0) {
        const key = sanitizeModelName(model);
        if (deltaModels[key]) {
          deltaModels[key].inputTokens += deltaInput;
          deltaModels[key].outputTokens += deltaOutput;
          deltaModels[key].premiumRequests += modelPremium;
        } else {
          deltaModels[key] = {
            inputTokens: deltaInput,
            outputTokens: deltaOutput,
            premiumRequests: modelPremium,
          };
        }
      }
    }

    // Also handle models with interactions but no token usage
    for (const [model, delta] of Object.entries(deltaModelInteractions)) {
      const key = sanitizeModelName(model);
      if (!deltaModels[key] && delta > 0) {
        deltaModels[key] = {
          inputTokens: 0,
          outputTokens: 0,
          premiumRequests: delta * getPremiumMultiplier(model),
        };
      }
    }

    // Merge previousStats (restored from prior session) into delta
    if (this.previousStats) {
      for (const [model, prev] of Object.entries(this.previousStats.models)) {
        if (deltaModels[model]) {
          deltaModels[model].inputTokens += prev.inputTokens;
          deltaModels[model].outputTokens += prev.outputTokens;
          deltaModels[model].premiumRequests += prev.premiumRequests;
        } else {
          deltaModels[model] = {
            inputTokens: prev.inputTokens,
            outputTokens: prev.outputTokens,
            premiumRequests: prev.premiumRequests,
          };
        }
      }
    }

    const totalTokens = Object.values(deltaModels).reduce(
      (sum, m) => sum + m.inputTokens + m.outputTokens,
      0,
    );
    const interactions = Math.max(
      0,
      current.interactions - baseline.interactions,
    ) + (this.previousStats ? this.previousStats.interactions : 0);
    const premiumRequests = Object.values(deltaModels).reduce(
      (sum, m) => sum + m.premiumRequests,
      0,
    );
    const costPerRequest = this.planInfoProvider().costPerRequest;
    const estimatedCost = premiumRequests * costPerRequest;

    return {
      since: this.since,
      lastUpdated: new Date().toISOString(),
      models: deltaModels,
      totalTokens,
      interactions,
      premiumRequests,
      estimatedCost,
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
      stats.interactions !== this.lastStats.interactions ||
      stats.premiumRequests !== this.lastStats.premiumRequests ||
      stats.estimatedCost !== this.lastStats.estimatedCost
    ) {
      this.lastStats = stats;
      for (const listener of [...this.listeners]) {
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
    this.previousStats = null;
    const snapshot = this.scanAll();
    this.baseline = snapshot;
    this.since = new Date().toISOString();
    const stats = this.computeStats(snapshot);
    this.lastStats = stats;
    for (const listener of [...this.listeners]) {
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
