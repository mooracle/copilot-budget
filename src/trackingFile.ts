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
  return path.join(gitDir, 'tokentrack');
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

export function readTrackingFile(): TrackingStats | null {
  const filePath = getTrackingFilePath();
  if (!filePath) return null;

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  if (!content.trim()) return null;

  let totalTokens = 0;
  let interactions = 0;
  let since = '';
  const models: { [model: string]: { inputTokens: number; outputTokens: number } } = {};

  for (const line of content.split('\n')) {
    if (line.startsWith('TOTAL_TOKENS=')) {
      totalTokens = parseInt(line.slice('TOTAL_TOKENS='.length), 10) || 0;
    } else if (line.startsWith('INTERACTIONS=')) {
      interactions = parseInt(line.slice('INTERACTIONS='.length), 10) || 0;
    } else if (line.startsWith('SINCE=')) {
      since = line.slice('SINCE='.length);
    } else if (line.startsWith('MODEL ')) {
      const parts = line.split(' ');
      if (parts.length >= 4) {
        models[parts[1]] = {
          inputTokens: parseInt(parts[2], 10) || 0,
          outputTokens: parseInt(parts[3], 10) || 0,
        };
      }
    }
  }

  return {
    since,
    lastUpdated: new Date().toISOString(),
    models,
    totalTokens,
    interactions,
  };
}

export function resetTrackingFile(): boolean {
  const filePath = getTrackingFilePath();
  if (!filePath) return false;

  try {
    fs.writeFileSync(filePath, '', 'utf-8');
    return true;
  } catch {
    return false;
  }
}
