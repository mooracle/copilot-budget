import * as vscode from 'vscode';
import { TrackingStats, ModelStats, RestoredStats } from './tracker';
import { resolveGitDir } from './gitDir';
import { readTextFile, writeTextFile, stat } from './fsUtils';
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

// The commit hook truncates the file to 0 bytes after appending trailers,
// signalling "I consumed the accumulated cost". Detecting that lets the
// extension reset the tracker so the next commit only attributes new usage
// (per-commit attribution, per README). Distinguishing 0 bytes from missing
// matters: a missing file is "no tracking yet"; a 0-byte file is "hook ran".
export async function isTrackingFileTruncated(): Promise<boolean> {
  const uri = await getTrackingFileUri();
  if (!uri) return false;
  const fileStat = await stat(uri);
  return fileStat !== null && fileStat.size === 0;
}

export async function writeTrackingFile(stats: TrackingStats): Promise<boolean> {
  const uri = await getTrackingFileUri();
  if (!uri) return false;

  const lines: string[] = [
    `SINCE=${stats.since}`,
    `INTERACTIONS=${stats.interactions}`,
    `TOTAL_COST_USD=${(stats.totalAiCredits / 100).toFixed(4)}`,
    `TOTAL_AI_CREDITS=${stats.totalAiCredits.toFixed(2)}`,
  ];

  for (const [model, usage] of Object.entries(stats.models)) {
    const safe = sanitizeModelName(model);
    lines.push(`MODEL_${safe}_INPUT_TOKENS=${usage.inputTokens}`);
    lines.push(`MODEL_${safe}_OUTPUT_TOKENS=${usage.outputTokens}`);
    lines.push(`MODEL_${safe}_CACHE_READ_TOKENS=${usage.cacheReadTokens}`);
    lines.push(`MODEL_${safe}_CACHE_CREATION_TOKENS=${usage.cacheCreationTokens}`);
    // Higher precision than display so per-model costs round-trip exactly:
    // on restore, totals are rebuilt by summing these values, and 4-decimal
    // rounding would zero out tiny entries (e.g. a handful of input tokens
    // against a $2/M rate ≈ $0.00002).
    lines.push(`MODEL_${safe}_COST_USD=${(usage.costAic / 100).toFixed(8)}`);
  }

  // Only emit TR_ lines when there is real cost to report. The hook is
  // presence-gated on TR_ lines, so writing zero-valued trailers would
  // append "Copilot-Est-Cost: $0.00" to every commit on idle sessions.
  if (stats.totalAiCredits > 0) {
    const trailers = getTrailerConfig();
    if (trailers.estimatedCost) {
      lines.push(`TR_${trailers.estimatedCost}=$${(stats.totalAiCredits / 100).toFixed(2)}`);
    }
    if (trailers.aiCredits) {
      lines.push(`TR_${trailers.aiCredits}=${stats.totalAiCredits.toFixed(2)}`);
    }
    if (trailers.aiCreditsPerModel) {
      const entries = Object.entries(stats.models)
        .map(([id, usage]) => ({ name: getDisplayName(id), credits: usage.costAic }))
        .sort((a, b) => b.credits - a.credits);
      if (entries.length > 0) {
        const value = entries.map((e) => `${e.name}=${e.credits.toFixed(2)}`).join(',');
        lines.push(`TR_${trailers.aiCreditsPerModel}=${value}`);
      }
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
    costAic: 0,
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
      if (!isNaN(v)) entry.costAic = v * 100;
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

export type TrackingFileResult =
  | { kind: 'restored'; stats: RestoredStats }
  | { kind: 'legacy' }
  | { kind: 'absent' };

export async function readTrackingFile(): Promise<TrackingFileResult> {
  const uri = await getTrackingFileUri();
  if (!uri) return { kind: 'absent' };

  const content = await readTextFile(uri);
  // readTextFile returns null for both ENOENT and transient I/O errors —
  // we can't tell them apart, so treat as absent and don't overwrite.
  if (content === null) return { kind: 'absent' };
  if (!content.trim()) return { kind: 'absent' };

  const stats = parseTrackingFileContent(content);
  if (stats) return { kind: 'restored', stats };

  // File has content but didn't parse — almost certainly legacy v0.5.x.
  // Caller should overwrite to clear stale TR_ lines.
  return { kind: 'legacy' };
}
