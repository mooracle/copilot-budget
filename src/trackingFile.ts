import * as vscode from 'vscode';
import { TrackingStats, RestoredStats } from './tracker';
import { resolveGitDir } from './gitDir';
import { readTextFile, writeTextFile } from './fsUtils';
import { getTrailerConfig } from './config';

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
    `TOTAL_TOKENS=${stats.totalTokens}`,
    `INTERACTIONS=${stats.interactions}`,
    `PREMIUM_REQUESTS=${stats.premiumRequests.toFixed(2)}`,
    `ESTIMATED_COST=${stats.estimatedCost.toFixed(2)}`,
    `SINCE=${stats.since}`,
  ];

  for (const [model, usage] of Object.entries(stats.models)) {
    const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '_');
    lines.push(`MODEL ${safeModel} ${usage.inputTokens} ${usage.outputTokens} ${usage.premiumRequests.toFixed(2)}`);
  }

  // Write TR_ lines for the commit hook
  const trailers = getTrailerConfig();
  if (trailers.premiumRequests) {
    lines.push(`TR_${trailers.premiumRequests}=${stats.premiumRequests.toFixed(2)}`);
  }
  if (trailers.estimatedCost) {
    lines.push(`TR_${trailers.estimatedCost}=$${stats.estimatedCost.toFixed(2)}`);
  }
  if (trailers.model) {
    for (const [model, usage] of Object.entries(stats.models)) {
      const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '_');
      lines.push(`TR_${trailers.model}=${safeModel} ${usage.inputTokens}/${usage.outputTokens}/${usage.premiumRequests.toFixed(2)}`);
    }
  }

  try {
    await writeTextFile(uri, lines.join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}

export function parseTrackingFileContent(content: string): RestoredStats | null {
  if (!content.trim()) return null;

  const lines = content.split('\n');
  let since: string | undefined;
  let interactions = 0;
  const models: RestoredStats['models'] = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('SINCE=')) {
      const val = trimmed.slice('SINCE='.length);
      if (!isNaN(Date.parse(val))) {
        since = val;
      }
    } else if (trimmed.startsWith('INTERACTIONS=')) {
      const val = parseInt(trimmed.slice('INTERACTIONS='.length), 10);
      if (!isNaN(val)) interactions = val;
    } else if (trimmed.startsWith('MODEL ')) {
      const parts = trimmed.split(' ');
      if (parts.length >= 5) {
        const name = parts[1];
        const inputTokens = parseInt(parts[2], 10);
        const outputTokens = parseInt(parts[3], 10);
        const premiumRequests = parseFloat(parts[4]);
        if (!isNaN(inputTokens) && !isNaN(outputTokens) && !isNaN(premiumRequests)) {
          models[name] = { inputTokens, outputTokens, premiumRequests };
        }
      }
    }
  }

  if (!since) return null;

  return { since, interactions, models };
}

export async function readTrackingFile(): Promise<RestoredStats | null> {
  const uri = await getTrackingFileUri();
  if (!uri) return null;

  const content = await readTextFile(uri);
  if (!content) return null;

  return parseTrackingFileContent(content);
}
