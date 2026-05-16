import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

/** VS Code editor variants to scan */
const VSCODE_VARIANTS = [
  'Code',               // Stable
  'Code - Insiders',    // Insiders
  'Code - Exploration', // Exploration builds
  'VSCodium',           // VSCodium
  'Cursor',             // Cursor editor
];

function isNonSessionFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return NON_SESSION_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Returns VS Code User directories for all variants on the current platform.
 */
export function getVSCodeUserPaths(): string[] {
  const platform = os.platform();
  const home = os.homedir();
  const paths: string[] = [];

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const v of VSCODE_VARIANTS) {
      paths.push(path.join(appData, v, 'User'));
    }
  } else if (platform === 'darwin') {
    for (const v of VSCODE_VARIANTS) {
      paths.push(path.join(home, 'Library', 'Application Support', v, 'User'));
    }
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const v of VSCODE_VARIANTS) {
      paths.push(path.join(xdg, v, 'User'));
    }
  }

  // Remote / server paths (Codespaces, WSL, SSH)
  paths.push(
    path.join(home, '.vscode-server', 'data', 'User'),
    path.join(home, '.vscode-server-insiders', 'data', 'User'),
    path.join(home, '.vscode-remote', 'data', 'User'),
  );

  return paths;
}

/**
 * If `dirPath` exists, scan it for session files and log the count.
 * Silently ignores missing or inaccessible paths.
 */
function scanPathSafe(dirPath: string, label: string, files: string[]): void {
  try {
    if (fs.existsSync(dirPath)) {
      const before = files.length;
      scanDirectory(dirPath, files);
      log(`  ${label}: ${files.length - before} files`);
    }
  } catch {
    // skip inaccessible paths
  }
}

/**
 * Recursively scan a directory for .json / .jsonl session files,
 * excluding known non-session files.
 */
function scanDirectory(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(full, out);
    } else if (
      (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) &&
      !isNonSessionFile(entry.name)
    ) {
      try {
        if (fs.statSync(full).size > 0) {
          out.push(full);
        }
      } catch {
        // skip inaccessible files
      }
    }
  }
}

export interface DiscoveryDiagnostics {
  platform: string;
  homedir: string;
  candidatePaths: { path: string; exists: boolean }[];
  filesFound: string[];
}

/**
 * Discover all Copilot session files from standard locations on disk.
 * Returns an array of unique absolute file paths.
 */
export function discoverSessionFiles(): string[] {
  const files: string[] = [];
  const userPaths = getVSCodeUserPaths();

  log(`Session discovery starting on platform=${os.platform()}, home=${os.homedir()}`);
  log(`Candidate user paths: ${userPaths.length}`);

  // Filter to paths that actually exist
  const existing = userPaths.filter((p) => {
    try {
      const exists = fs.existsSync(p);
      log(`  ${exists ? 'EXISTS' : 'MISSING'}: ${p}`);
      return exists;
    } catch {
      log(`  ERROR checking: ${p}`);
      return false;
    }
  });

  log(`Found ${existing.length} existing user paths`);

  for (const userPath of existing) {
    const wsStorage = path.join(userPath, 'workspaceStorage');
    try {
      if (fs.existsSync(wsStorage)) {
        for (const wsDir of fs.readdirSync(wsStorage)) {
          const subPath = path.join(wsStorage, wsDir, 'chatSessions');
          try {
            if (fs.existsSync(subPath)) {
              const before = files.length;
              scanDirectory(subPath, files);
              log(`  workspaceStorage chatSessions (${wsDir}): ${files.length - before} files`);
            }
          } catch {
            // skip inaccessible workspace dirs
          }
        }
      }
    } catch {
      // skip
    }

    scanPathSafe(
      path.join(userPath, 'globalStorage', 'emptyWindowChatSessions'),
      'globalStorage/emptyWindowChatSessions',
      files,
    );
  }

  // Deduplicate using a Set
  const unique = [...new Set(files)];
  log(`Discovery complete: ${unique.length} unique files (${files.length} before dedup)`);

  return unique;
}

/**
 * Returns diagnostic information about session discovery.
 */
export function getDiscoveryDiagnostics(): DiscoveryDiagnostics {
  const userPaths = getVSCodeUserPaths();
  const candidatePaths = userPaths.map((p) => {
    let exists = false;
    try {
      exists = fs.existsSync(p);
    } catch {
      // treat errors as missing
    }
    return { path: p, exists };
  });

  return {
    platform: os.platform(),
    homedir: os.homedir(),
    candidatePaths,
    filesFound: discoverSessionFiles(),
  };
}
