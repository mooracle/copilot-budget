import * as vscode from 'vscode';
import { TrackingStats, ModelStats, RestoredStats } from './tracker';
import { resolveGitDir } from './gitDir';
import { readTextFile, writeTextFile } from './fsUtils';
import { getTrailerConfig } from './config';
import { sanitizeModelName } from './utils';
import { getDisplayName } from './tokenRates';

async function getTrackingFileUri(): Promise<vscode.Uri | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const gitDir = await resolveGitDir(folders[0].uri);
  if (!gitDir) return null;
  return vscode.Uri.joinPath(gitDir, 'copilot-budget');
}

export async function writeTrackingFile(stats: TrackingStats): Promise<boolean> {
  const uri = await getTrackingFileUri();
  if (!uri) return false;

  const lines: string[] = [
    `SINCE=${stats.since}`,
    `INTERACTIONS=${stats.interactions}`,
    `TOTAL_COST_USD=${stats.totalCostUsd.toFixed(4)}`,
    `TOTAL_AI_CREDITS=${stats.totalAiCredits.toFixed(2)}`,
  ];

  for (const [model, usage] of Object.entries(stats.models)) {
    const safe = sanitizeModelName(model);
    lines.push(`MODEL_${safe}_INPUT_TOKENS=${usage.inputTokens}`);
    lines.push(`MODEL_${safe}_OUTPUT_TOKENS=${usage.outputTokens}`);
    lines.push(`MODEL_${safe}_CACHE_READ_TOKENS=${usage.cacheReadTokens}`);
    lines.push(`MODEL_${safe}_CACHE_CREATION_TOKENS=${usage.cacheCreationTokens}`);
    lines.push(`MODEL_${safe}_COST_USD=${usage.costUsd.toFixed(4)}`);
  }

  const trailers = getTrailerConfig();
  if (trailers.estimatedCost) {
    lines.push(`TR_${trailers.estimatedCost}=$${stats.totalCostUsd.toFixed(2)}`);
  }
  if (trailers.aiCredits) {
    lines.push(`TR_${trailers.aiCredits}=${stats.totalAiCredits.toFixed(2)}`);
  }
  if (trailers.aiCreditsPerModel) {
    const entries = Object.entries(stats.models)
      .map(([id, usage]) => ({ name: getDisplayName(id), credits: usage.costUsd * 100 }))
      .sort((a, b) => b.credits - a.credits);
    if (entries.length > 0) {
      const value = entries.map((e) => `${e.name}=${e.credits.toFixed(2)}`).join(',');
      lines.push(`TR_${trailers.aiCreditsPerModel}=${value}`);
    }
  }

  try {
    await writeTextFile(uri, lines.join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}

const MODEL_KEY_PATTERN =
  /^MODEL_(.+)_(INPUT_TOKENS|OUTPUT_TOKENS|CACHE_READ_TOKENS|CACHE_CREATION_TOKENS|COST_USD)$/;

function emptyRestoredModel(): ModelStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
}

export function parseTrackingFileContent(content: string): RestoredStats | null {
  if (!content.trim()) return null;

  const lines = content.split('\n');
  let since: string | undefined;
  let interactions = 0;
  let hasNewFormatKey = false;
  const models: RestoredStats['models'] = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('TR_')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);

    if (key === 'SINCE') {
      if (!isNaN(Date.parse(value))) {
        since = value;
      }
      continue;
    }
    if (key === 'INTERACTIONS') {
      const n = parseInt(value, 10);
      if (!isNaN(n)) interactions = n;
      continue;
    }
    if (key === 'TOTAL_COST_USD' || key === 'TOTAL_AI_CREDITS') {
      hasNewFormatKey = true;
      continue;
    }

    const match = key.match(MODEL_KEY_PATTERN);
    if (!match) continue;

    hasNewFormatKey = true;
    const modelName = match[1];
    const field = match[2];
    let entry = models[modelName];
    if (!entry) {
      entry = emptyRestoredModel();
      models[modelName] = entry;
    }
    if (field === 'COST_USD') {
      const v = parseFloat(value);
      if (!isNaN(v)) entry.costUsd = v;
    } else {
      const v = parseInt(value, 10);
      if (!isNaN(v)) {
        if (field === 'INPUT_TOKENS') entry.inputTokens = v;
        else if (field === 'OUTPUT_TOKENS') entry.outputTokens = v;
        else if (field === 'CACHE_READ_TOKENS') entry.cacheReadTokens = v;
        else if (field === 'CACHE_CREATION_TOKENS') entry.cacheCreationTokens = v;
      }
    }
  }

  if (!since || !hasNewFormatKey) return null;

  return { since, interactions, models };
}

export async function readTrackingFile(): Promise<RestoredStats | null> {
  const uri = await getTrackingFileUri();
  if (!uri) return null;

  const content = await readTextFile(uri);
  if (!content) return null;

  return parseTrackingFileContent(content);
}
