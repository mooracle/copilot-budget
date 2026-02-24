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

validate_num() {
  case "$1" in
    ''|.|*[!0-9.]*|*.*.*) echo 0 ; return ;;
  esac
  echo "$1"
}

CURRENT_PREMIUM=$(grep '^PREMIUM_REQUESTS=' "$TRACKING_FILE" | cut -d= -f2)
CURRENT_PREMIUM=$(validate_num "$CURRENT_PREMIUM")
CURRENT_COST=$(grep '^ESTIMATED_COST=' "$TRACKING_FILE" | cut -d= -f2)
CURRENT_COST=$(validate_num "$CURRENT_COST")

[ "$CURRENT_PREMIUM" = "0" ] || [ "$CURRENT_PREMIUM" = "0.00" ] && exit 0

PREV_PREMIUM=$(git log -1 --format='%(trailers:key=AI-Premium-Requests,valueonly)' 2>/dev/null | tr -d ' ')
PREV_PREMIUM=$(validate_num "$PREV_PREMIUM")
PREV_COST=$(git log -1 --format='%(trailers:key=AI-Est-Cost,valueonly)' 2>/dev/null | tr -d ' $')
PREV_COST=$(validate_num "$PREV_COST")

TOTAL_PREMIUM=$(awk "BEGIN {printf \\"%.2f\\", \${PREV_PREMIUM} + \${CURRENT_PREMIUM}}")
TOTAL_COST=$(awk "BEGIN {printf \\"%.2f\\", \${PREV_COST} + \${CURRENT_COST}}")

printf '\\n\\nAI-Premium-Requests: %s\\n' "$TOTAL_PREMIUM" >> "$COMMIT_MSG_FILE"
printf 'AI-Est-Cost: $%s\\n' "$TOTAL_COST" >> "$COMMIT_MSG_FILE"

# Accumulate per-model totals (previous + current)
{
  git log -1 --format='%(trailers:key=AI-Model,valueonly)' 2>/dev/null
  grep '^MODEL ' "$TRACKING_FILE" | while read _ name inp out pr; do
    case "$inp" in *[!0-9]*) continue ;; esac
    case "$out" in *[!0-9]*) continue ;; esac
    pr=$(validate_num "$pr")
    printf '%s %s/%s/%s\\n' "$name" "$inp" "$out" "$pr"
  done
} | awk -F'[ /]' '
  \$2 ~ /^[0-9]+$/ && \$3 ~ /^[0-9]+$/ {
    inp[\$1] += \$2; out[\$1] += \$3
    pr[\$1] += (\$4 ~ /^[0-9]*\\.?[0-9]+$/ ? \$4 : 0)
  }
  END {
    for (m in inp) printf "AI-Model: %s %d/%d/%.2f\\n", m, inp[m], out[m], pr[m]
  }
' >> "$COMMIT_MSG_FILE"

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
