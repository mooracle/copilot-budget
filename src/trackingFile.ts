import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TrackingStats } from './tracker';

function getTrackingFilePath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const gitDir = path.join(folders[0].uri.fsPath, '.git');
  try {
    const stat = fs.statSync(gitDir);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return path.join(gitDir, 'copilot-budget');
}

export function writeTrackingFile(stats: TrackingStats): boolean {
  const filePath = getTrackingFilePath();
  if (!filePath) return false;

  const lines: string[] = [
    `TOTAL_TOKENS=${stats.totalTokens}`,
    `INTERACTIONS=${stats.interactions}`,
    `SINCE=${stats.since}`,
  ];

  for (const [model, usage] of Object.entries(stats.models)) {
    lines.push(`MODEL ${model} ${usage.inputTokens} ${usage.outputTokens}`);
  }

  try {
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}
