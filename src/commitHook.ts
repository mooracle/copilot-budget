import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './logger';
import { resolveGitCommonDir } from './gitDir';

const MARKER = '# Copilot Budget prepare-commit-msg hook';

const HOOK_SCRIPT = `#!/bin/sh
${MARKER}
COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"
case "$COMMIT_SOURCE" in merge|squash|commit) exit 0 ;; esac

GIT_DIR="$(git rev-parse --git-dir)"
TRACKING_FILE="$GIT_DIR/copilot-budget"
[ -f "$TRACKING_FILE" ] || exit 0

PREMIUM=$(grep '^PREMIUM_REQUESTS=' "$TRACKING_FILE" | cut -d= -f2)
COST=$(grep '^ESTIMATED_COST=' "$TRACKING_FILE" | cut -d= -f2)

# Skip if no premium requests
case "$PREMIUM" in ''|0|0.00) exit 0 ;; esac

{
printf '\\n\\nAI-Premium-Requests: %s\\n' "$PREMIUM"
printf 'AI-Est-Cost: $%s\\n' "$COST"

# Per-model trailers
grep '^MODEL ' "$TRACKING_FILE" | while read _ name inp out pr; do
  printf 'AI-Model: %s %s/%s/%s\\n' "$name" "$inp" "$out" "$pr"
done
} >> "$COMMIT_MSG_FILE" && : > "$TRACKING_FILE"
`;

function getHookPath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    log('[commitHook] getHookPath: no workspace folders');
    return null;
  }
  const gitDir = resolveGitCommonDir(folders[0].uri.fsPath);
  if (!gitDir) {
    log('[commitHook] getHookPath: could not resolve git directory');
    return null;
  }
  const p = path.join(gitDir, 'hooks', 'prepare-commit-msg');
  log(`[commitHook] getHookPath: ${p}`);
  return p;
}

export function isHookInstalled(): boolean {
  const hookPath = getHookPath();
  if (!hookPath) return false;

  try {
    const content = fs.readFileSync(hookPath, 'utf-8');
    return content.includes(MARKER);
  } catch {
    return false;
  }
}

export function installHook(): boolean {
  const hookPath = getHookPath();
  log(`[commitHook] installHook called, hookPath=${hookPath}`);
  if (!hookPath) {
    log('[commitHook] No workspace folder found');
    vscode.window.showErrorMessage('Copilot Budget: No workspace folder found.');
    return false;
  }

  // Check if a non-Copilot Budget hook already exists
  let isRefresh = false;
  try {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    log(`[commitHook] Existing hook found (${existing.length} bytes)`);
    if (existing.trim()) {
      if (existing.includes(MARKER)) {
        isRefresh = true; // Our hook — will overwrite with latest code
        log('[commitHook] Existing hook is ours, will refresh');
      } else {
        log('[commitHook] Existing hook is NOT ours, aborting');
        vscode.window.showWarningMessage(
          'Copilot Budget: A prepare-commit-msg hook already exists. Remove it first or install Copilot Budget manually.',
        );
        return false;
      }
    }
  } catch (err) {
    log(`[commitHook] No existing hook file: ${err instanceof Error ? err.message : err}`);
  }

  try {
    const hooksDir = path.dirname(hookPath);
    if (!fs.existsSync(hooksDir)) {
      log(`[commitHook] Creating hooks directory: ${hooksDir}`);
      fs.mkdirSync(hooksDir, { recursive: true });
    }
    fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
    log(`[commitHook] Hook written successfully (refresh=${isRefresh})`);
    if (!isRefresh) {
      vscode.window.showInformationMessage('Copilot Budget: Commit hook installed.');
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[commitHook] Failed to install hook: ${msg}`);
    vscode.window.showErrorMessage(`Copilot Budget: Failed to install commit hook: ${msg}`);
    return false;
  }
}

export function uninstallHook(): boolean {
  const hookPath = getHookPath();
  log(`[commitHook] uninstallHook called, hookPath=${hookPath}`);
  if (!hookPath) {
    vscode.window.showErrorMessage('Copilot Budget: No workspace folder found.');
    return false;
  }

  try {
    const content = fs.readFileSync(hookPath, 'utf-8');
    if (!content.includes(MARKER)) {
      log('[commitHook] Hook file exists but is not ours');
      vscode.window.showWarningMessage(
        'Copilot Budget: The prepare-commit-msg hook was not installed by Copilot Budget.',
      );
      return false;
    }
  } catch (err) {
    log(`[commitHook] Cannot read hook for uninstall: ${err instanceof Error ? err.message : err}`);
    vscode.window.showInformationMessage('Copilot Budget: No commit hook to remove.');
    return false;
  }

  try {
    fs.unlinkSync(hookPath);
    log('[commitHook] Hook removed successfully');
    vscode.window.showInformationMessage('Copilot Budget: Commit hook removed.');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[commitHook] Failed to remove hook: ${msg}`);
    vscode.window.showErrorMessage(`Copilot Budget: Failed to remove commit hook: ${msg}`);
    return false;
  }
}
