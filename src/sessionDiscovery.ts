import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { getSessionMaxAgeDays } from './config';
import { log } from './logger';

/** Known non-session filename patterns to exclude */
const NON_SESSION_PATTERNS = [
  'embeddings',
  'index',
  'cache',
  'preferences',
  'settings',
  'config',
];

function isNonSessionFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return NON_SESSION_PATTERNS.some((p) => lower.includes(p));
}

export interface DiscoveryDiagnostics {
  platform: string;
  homedir: string;
  storageUri: string | null;
  chatSessionsDir: string | null;
  filesFound: string[];
}

/**
 * Resolve the chatSessions directory for the current window from the extension's
 * per-workspace storageUri. `storageUri` points at the extension's subfolder
 * inside `<workspaceStorage>/<hash>/`; the sibling `chatSessions/` directory is
 * one `..` away.
 */
function resolveChatSessionsDir(storageUri: vscode.Uri): string {
  return vscode.Uri.joinPath(storageUri, '..', 'chatSessions').fsPath;
}

/**
 * Discover Copilot session files for the current window only.
 * When `storageUri` is undefined (empty window) returns `[]`.
 */
export function discoverSessionFiles(storageUri: vscode.Uri | undefined): string[] {
  if (!storageUri) {
    log('Session discovery skipped: no storageUri (empty window)');
    return [];
  }

  const chatSessionsDir = resolveChatSessionsDir(storageUri);
  log(`Session discovery scanning: ${chatSessionsDir}`);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(chatSessionsDir, { withFileTypes: true });
  } catch {
    log(`  MISSING or unreadable: ${chatSessionsDir}`);
    return [];
  }

  // Mtime filter — old sessions are stable; their tokens are already folded
  // into the tracker's baseline on first scan, so re-reading them every poll
  // gains nothing and is what makes activation hang on accounts with many
  // historical chats. Set sessionMaxAgeDays=0 to disable.
  const maxAgeDays = getSessionMaxAgeDays();
  const cutoffMs = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : 0;

  const files: string[] = [];
  let skippedOld = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    if (isNonSessionFile(entry.name)) continue;
    const full = path.join(chatSessionsDir, entry.name);
    try {
      const s = fs.statSync(full);
      if (s.size === 0) continue;
      if (cutoffMs > 0 && s.mtimeMs < cutoffMs) {
        skippedOld += 1;
        continue;
      }
      files.push(full);
    } catch {
      // skip inaccessible files
    }
  }

  if (skippedOld > 0) {
    log(
      `Discovery complete: ${files.length} files (${skippedOld} skipped — older than ${maxAgeDays}d)`,
    );
  } else {
    log(`Discovery complete: ${files.length} files`);
  }
  return files;
}

/**
 * Returns diagnostic information about session discovery for the current window.
 */
export function getDiscoveryDiagnostics(
  storageUri: vscode.Uri | undefined,
): DiscoveryDiagnostics {
  const platform = os.platform();
  const homedir = os.homedir();
  if (!storageUri) {
    return {
      platform,
      homedir,
      storageUri: null,
      chatSessionsDir: null,
      filesFound: [],
    };
  }
  const chatSessionsDir = resolveChatSessionsDir(storageUri);
  return {
    platform,
    homedir,
    storageUri: storageUri.fsPath,
    chatSessionsDir,
    filesFound: discoverSessionFiles(storageUri),
  };
}
