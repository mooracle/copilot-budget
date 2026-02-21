import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

/**
 * Discover all Copilot session files from standard locations on disk.
 * Returns an array of absolute file paths.
 */
export function discoverSessionFiles(): string[] {
  const files: string[] = [];
  const userPaths = getVSCodeUserPaths();

  // Filter to paths that actually exist
  const existing = userPaths.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  for (const userPath of existing) {
    // 1. workspaceStorage/*/chatSessions/
    const wsStorage = path.join(userPath, 'workspaceStorage');
    try {
      if (fs.existsSync(wsStorage)) {
        for (const wsDir of fs.readdirSync(wsStorage)) {
          const chatDir = path.join(wsStorage, wsDir, 'chatSessions');
          try {
            if (fs.existsSync(chatDir)) {
              const sessionFiles = fs
                .readdirSync(chatDir)
                .filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'))
                .map((f) => path.join(chatDir, f));
              files.push(...sessionFiles);
            }
          } catch {
            // skip inaccessible workspace dirs
          }
        }
      }
    } catch {
      // skip
    }

    // 2. globalStorage/emptyWindowChatSessions/
    const emptyWindow = path.join(userPath, 'globalStorage', 'emptyWindowChatSessions');
    try {
      if (fs.existsSync(emptyWindow)) {
        const sessionFiles = fs
          .readdirSync(emptyWindow)
          .filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'))
          .map((f) => path.join(emptyWindow, f));
        files.push(...sessionFiles);
      }
    } catch {
      // skip
    }

    // 3. globalStorage/github.copilot-chat/ (recursive scan)
    const copilotChat = path.join(userPath, 'globalStorage', 'github.copilot-chat');
    try {
      if (fs.existsSync(copilotChat)) {
        scanDirectory(copilotChat, files);
      }
    } catch {
      // skip
    }
  }

  return files;
}
