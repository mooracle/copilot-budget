import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const MARKER = '# Copilot Budget prepare-commit-msg hook';

const HOOK_SCRIPT = `#!/bin/sh
${MARKER}
COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"
case "$COMMIT_SOURCE" in merge|squash|commit) exit 0 ;; esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
TRACKING_FILE="$REPO_ROOT/.git/copilot-budget"
[ -f "$TRACKING_FILE" ] || exit 0

TOTAL=$(grep '^TOTAL_TOKENS=' "$TRACKING_FILE" | cut -d= -f2)
[ -z "$TOTAL" ] || [ "$TOTAL" = "0" ] && exit 0

MODELS=""
while read _ name inp out; do
  MODELS="\${MODELS}\${MODELS:+, }\${name} $((inp + out))"
done <<EOF
$(grep '^MODEL ' "$TRACKING_FILE")
EOF

printf '\\n\\nAI Budget: %s | total: %s tokens' "$MODELS" "$TOTAL" >> "$COMMIT_MSG_FILE"
: > "$TRACKING_FILE"
`;

function getHookPath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return path.join(folders[0].uri.fsPath, '.git', 'hooks', 'prepare-commit-msg');
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
  if (!hookPath) {
    vscode.window.showErrorMessage('Copilot Budget: No workspace folder found.');
    return false;
  }

  // Check if a non-Copilot Budget hook already exists
  try {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.trim() && !existing.includes(MARKER)) {
      vscode.window.showWarningMessage(
        'Copilot Budget: A prepare-commit-msg hook already exists. Remove it first or install Copilot Budget manually.',
      );
      return false;
    }
  } catch {
    // File doesn't exist, safe to create
  }

  try {
    const hooksDir = path.dirname(hookPath);
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }
    fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
    vscode.window.showInformationMessage('Copilot Budget: Commit hook installed.');
    return true;
  } catch {
    vscode.window.showErrorMessage('Copilot Budget: Failed to install commit hook.');
    return false;
  }
}

export function uninstallHook(): boolean {
  const hookPath = getHookPath();
  if (!hookPath) {
    vscode.window.showErrorMessage('Copilot Budget: No workspace folder found.');
    return false;
  }

  try {
    const content = fs.readFileSync(hookPath, 'utf-8');
    if (!content.includes(MARKER)) {
      vscode.window.showWarningMessage(
        'Copilot Budget: The prepare-commit-msg hook was not installed by Copilot Budget.',
      );
      return false;
    }
  } catch {
    vscode.window.showInformationMessage('Copilot Budget: No commit hook to remove.');
    return false;
  }

  try {
    fs.unlinkSync(hookPath);
    vscode.window.showInformationMessage('Copilot Budget: Commit hook removed.');
    return true;
  } catch {
    vscode.window.showErrorMessage('Copilot Budget: Failed to remove commit hook.');
    return false;
  }
}
