import * as vscode from 'vscode';
import { TrackingStats } from './tracker';
import { resolveGitDir } from './gitDir';
import { writeTextFile } from './fsUtils';

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

  try {
    await writeTextFile(uri, lines.join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}
