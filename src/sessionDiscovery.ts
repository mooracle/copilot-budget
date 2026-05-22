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
  transcriptsDir: string | null;
  legacyChatSessionsDir: string | null;
  filesFound: string[];
}

/**
 * Resolve the primary transcripts directory for the current window from the
 * extension's per-workspace storageUri. `storageUri` points at the extension's
 * subfolder inside `<workspaceStorage>/<hash>/`; the sibling
 * `GitHub.copilot-chat/transcripts/` directory is one `..` away.
 */
function resolveTranscriptsDir(storageUri: vscode.Uri): string {
  return vscode.Uri.joinPath(
    storageUri,
    '..',
    'GitHub.copilot-chat',
    'transcripts',
  ).fsPath;
}

/**
 * Resolve the legacy chatSessions directory used by older Copilot Chat
 * versions. Same parent as the transcripts dir.
 */
function resolveLegacyChatSessionsDir(storageUri: vscode.Uri): string {
  return vscode.Uri.joinPath(storageUri, '..', 'chatSessions').fsPath;
}

interface ScanResult {
  ids: string[];
  skippedOld: number;
}

function scanDirectoryForSessionIds(dir: string, cutoffMs: number): ScanResult {
  log(`Session discovery scanning: ${dir}`);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    log(`  MISSING or unreadable: ${dir}`);
    return { ids: [], skippedOld: 0 };
  }

  const ids: string[] = [];
  let skippedOld = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    if (isNonSessionFile(entry.name)) continue;
    const full = path.join(dir, entry.name);
    try {
      const s = fs.statSync(full);
      if (s.size === 0) continue;
      if (cutoffMs > 0 && s.mtimeMs < cutoffMs) {
        skippedOld += 1;
        continue;
      }
      ids.push(entry.name.replace(/\.jsonl$/i, ''));
    } catch {
      // skip inaccessible files
    }
  }
  return { ids, skippedOld };
}

/**
 * Discover Copilot chat session IDs (UUID stems) for the current window only.
 *
 * Scans the primary `GitHub.copilot-chat/transcripts/` directory first, then
 * merges in any IDs from the legacy `chatSessions/` directory (deduped by
 * stem). When `storageUri` is undefined (empty window) returns `[]`.
 */
export function discoverSessionIds(
  storageUri: vscode.Uri | undefined,
): string[] {
  if (!storageUri) {
    log('Session discovery skipped: no storageUri (empty window)');
    return [];
  }

  const transcriptsDir = resolveTranscriptsDir(storageUri);
  const legacyDir = resolveLegacyChatSessionsDir(storageUri);

  // Mtime filter — old sessions are stable; their tokens are already folded
  // into the tracker's baseline on first scan, so re-reading them every poll
  // gains nothing and is what makes activation hang on accounts with many
  // historical chats. Set sessionMaxAgeDays=0 to disable.
  const maxAgeDays = getSessionMaxAgeDays();
  const cutoffMs = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : 0;

  const seen = new Set<string>();
  const ids: string[] = [];
  let totalSkippedOld = 0;

  for (const dir of [transcriptsDir, legacyDir]) {
    const result = scanDirectoryForSessionIds(dir, cutoffMs);
    totalSkippedOld += result.skippedOld;
    for (const id of result.ids) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }

  if (totalSkippedOld > 0) {
    log(
      `Discovery complete: ${ids.length} sessions (${totalSkippedOld} skipped — older than ${maxAgeDays}d)`,
    );
  } else {
    log(`Discovery complete: ${ids.length} sessions`);
  }
  return ids;
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
      transcriptsDir: null,
      legacyChatSessionsDir: null,
      filesFound: [],
    };
  }
  return {
    platform,
    homedir,
    storageUri: storageUri.fsPath,
    transcriptsDir: resolveTranscriptsDir(storageUri),
    legacyChatSessionsDir: resolveLegacyChatSessionsDir(storageUri),
    filesFound: discoverSessionIds(storageUri),
  };
}
