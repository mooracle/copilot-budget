import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
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

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    if (isNonSessionFile(entry.name)) continue;
    const full = path.join(chatSessionsDir, entry.name);
    try {
      if (fs.statSync(full).size > 0) {
        files.push(full);
      }
    } catch {
      // skip inaccessible files
    }
  }

  log(`Discovery complete: ${files.length} files`);
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
