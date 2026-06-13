import * as fs from 'fs';
import * as vscode from 'vscode';
import { log } from './logger';
import { resolveHooksDir } from './gitDir';
import { readTextFile, writeTextFile } from './fsUtils';
import { errorMessage } from './utils';

// Recognition marker shared by every hook script we install. Both the
// prepare-commit-msg and post-commit scripts carry a comment line that starts
// with this string, and historical installs used the longer
// "# Copilot Budget prepare-commit-msg hook" line — all of which contain it.
// install/uninstall treat a hook as ours iff it contains this marker, so an
// upgrade refreshes our own scripts (including older ones) while a third-party
// hook is left untouched.
const MARKER = '# Copilot Budget';

export const HOOK_SCRIPT = `#!/bin/sh
# Copilot Budget prepare-commit-msg hook
COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"

squash_sum_trailers() {
  msg_file="$1"
  tmp="$(mktemp "\${TMPDIR:-/tmp}/copilot-budget.XXXXXX")" || exit 0
  # Leading [ \\t]* tolerates the 4-space indentation git applies to inherited
  # commit bodies in SQUASH_MSG (git merge --squash) and other places where a
  # trailer may appear inside an indented log-format block.
  awk '
    NR == FNR {
      if ($0 ~ /^[ \\t]*Copilot-AI-Credits(-[A-Za-z0-9._-]+)?:[ \\t]*[0-9]+(\\.[0-9]+)?[ \\t]*$/) {
        colon = index($0, ":")
        name = substr($0, 1, colon - 1)
        sub(/^[ \\t]+/, "", name)
        val  = substr($0, colon + 1)
        sub(/^[ \\t]+/, "", val)
        sub(/[ \\t]+$/, "", val)
        sums[name] += val + 0
      }
      next
    }
    {
      if ($0 ~ /^[ \\t]*Copilot-AI-Credits(-[A-Za-z0-9._-]+)?:[ \\t]*[0-9]+(\\.[0-9]+)?[ \\t]*$/) {
        colon = index($0, ":")
        name  = substr($0, 1, colon - 1)
        sub(/^[ \\t]+/, "", name)
        if (!(name in printed)) {
          printf "%s: %.2f\\n", name, sums[name]
          printed[name] = 1
        }
        next
      }
      print
    }
  ' "$msg_file" "$msg_file" > "$tmp" && mv "$tmp" "$msg_file"
}

GIT_DIR="$(git rev-parse --git-dir)"
PENDING="$GIT_DIR/copilot-budget.pending"

# Every path that does NOT append a fresh trailer from the tracking file clears
# a possibly-stale pending marker, so the post-commit hook never truncates
# usage that was never attributed to a commit.
case "$COMMIT_SOURCE" in
  merge|commit) rm -f "$PENDING"; exit 0 ;;
esac

# git rebase -i (squash/fixup/reword) invokes prepare-commit-msg with
# source=message, NOT source=squash. Detect rebase state via the standard
# state directories and route those invocations to the sum path. Skip the
# tracking-file logic entirely during rebase so transient rebase commits
# don't consume usage destined for the next real commit.
if [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ]; then
  rm -f "$PENDING"
  squash_sum_trailers "$COMMIT_MSG_FILE"
  exit 0
fi

# git merge --squash + git commit invokes with source=squash.
if [ "$COMMIT_SOURCE" = squash ]; then
  rm -f "$PENDING"
  squash_sum_trailers "$COMMIT_MSG_FILE"
  exit 0
fi

TRACKING_FILE="$GIT_DIR/copilot-budget"
if [ ! -f "$TRACKING_FILE" ]; then
  rm -f "$PENDING"
  exit 0
fi

TR_LINES=$(grep '^TR_' "$TRACKING_FILE") || true
case "$TR_LINES" in '') rm -f "$PENDING"; exit 0 ;; esac

# Append the trailers now, but defer truncating the tracking file to the
# post-commit hook. prepare-commit-msg runs before the commit is finalized, so
# truncating here resets the counter even when the commit is cancelled — git
# gui's Commit dialog, a rejected commit-msg hook, or quitting the editor on an
# empty message (issue #10). Instead drop a marker; post-commit truncates only
# once the commit is actually created.
{
printf '\\n\\n'
echo "$TR_LINES" | sed 's/^TR_\\([^=]*\\)=/\\1: /'
} >> "$COMMIT_MSG_FILE" && : > "$PENDING"
`;

export const POST_COMMIT_SCRIPT = `#!/bin/sh
# Copilot Budget post-commit hook
GIT_DIR="$(git rev-parse --git-dir)"

# Never reset mid-rebase: replayed commits inherit trailers, but the local
# tracking file's usage belongs to the next real commit, not a rebase step.
if [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ]; then
  exit 0
fi

PENDING="$GIT_DIR/copilot-budget.pending"

# The marker is written only by prepare-commit-msg's trailer-append path, so
# its presence means the commit just created carries the usage trailer and the
# accumulated usage has now been attributed. Truncating the tracking file is
# the signal the extension watches to rebase its counter. With no marker
# (merge, squash, amend, or a no-trailer commit) leave the tracking file alone.
[ -f "$PENDING" ] || exit 0
rm -f "$PENDING"
: > "$GIT_DIR/copilot-budget"
`;

// The hooks Copilot Budget owns, written in this order. prepare-commit-msg is
// the primary (appends the trailer); post-commit performs the deferred
// truncation. Both must be installed for per-commit attribution to work.
interface HookDef {
  filename: string;
  script: string;
}

const HOOK_DEFS: HookDef[] = [
  { filename: 'prepare-commit-msg', script: HOOK_SCRIPT },
  { filename: 'post-commit', script: POST_COMMIT_SCRIPT },
];

async function getHookUri(filename: string): Promise<vscode.Uri | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    log('[commitHook] getHookUri: no workspace folders');
    return null;
  }
  const hooksDir = await resolveHooksDir(folders[0].uri);
  if (!hooksDir) {
    log(`[commitHook] getHookUri: could not resolve hooks directory for ${folders[0].uri.path}`);
    return null;
  }
  const hookUri = vscode.Uri.joinPath(hooksDir, filename);
  log(`[commitHook] getHookUri: ${hookUri.path}`);
  return hookUri;
}

async function makeExecutable(uri: vscode.Uri): Promise<void> {
  // In remote development the extension host runs on the remote machine,
  // so fs.chmodSync works regardless of URI scheme.
  try {
    fs.chmodSync(uri.fsPath, 0o755);
    return;
  } catch {
    log('[commitHook] chmodSync failed, falling back to shell task');
  }
  // Fallback: run chmod via a VS Code shell task
  const task = new vscode.Task(
    { type: 'copilot-budget', task: 'chmod' }, vscode.TaskScope.Workspace,
    'chmod-hook', 'copilot-budget',
    new vscode.ShellExecution('chmod', ['+x', uri.fsPath]),
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent };
  let disposable: vscode.Disposable | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        disposable = vscode.tasks.onDidEndTaskProcess((e: any) => {
          if (e.execution.task === task) {
            disposable?.dispose();
            if (e.exitCode === 0) { resolve(); } else { reject(new Error(`chmod exit ${e.exitCode}`)); }
          }
        });
        vscode.tasks.executeTask(task).then(undefined, reject);
      }),
      new Promise<void>((resolve) => setTimeout(() => {
        log('[commitHook] chmod task timed out, hook may not be executable');
        resolve();
      }, 5000)),
    ]);
  } finally {
    disposable?.dispose();
  }
}

export async function isHookInstalled(): Promise<boolean> {
  // The prepare-commit-msg hook is the primary; treat its presence as "the
  // Copilot Budget hook is installed". installHook always refreshes both, so
  // post-commit travels with it.
  const hookUri = await getHookUri('prepare-commit-msg');
  if (!hookUri) return false;

  const content = await readTextFile(hookUri);
  if (!content) return false;
  return content.includes(MARKER);
}

// Pre-write validation for a single hook file. `'abort'` means a hard failure
// was already surfaced to the user (third-party hook, unreadable file, or a
// non-FileNotFound stat error) and install must not proceed. Otherwise reports
// whether the hook is new (so the caller can show the one-time "installed"
// toast only when something was actually added).
type HookCheck = { wasNew: boolean } | 'abort';

async function checkHookWritable(
  hookUri: vscode.Uri,
  filename: string,
): Promise<HookCheck> {
  // Distinguish "no hook exists" from "hook exists but we cannot read it".
  // The marker check below is the only thing protecting a third-party hook
  // (husky, lefthook, hand-written) from being overwritten. If the read
  // collapses every failure to null (the fsUtils default), a transient
  // permission/IO error would silently bypass the marker check and let
  // writeTextFile clobber a hook we cannot identify. Stat first so the
  // FileNotFound case (genuinely no hook) stays the only "proceed without
  // marker check" path; any other stat or read failure aborts.
  let hookExists: boolean;
  try {
    await vscode.workspace.fs.stat(hookUri);
    hookExists = true;
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      hookExists = false;
    } else {
      const msg = errorMessage(err);
      log(`[commitHook] Failed to stat ${filename}: ${msg}`);
      vscode.window.showErrorMessage(
        `Copilot Budget: Failed to check commit hook file: ${msg}`,
      );
      return 'abort';
    }
  }

  if (!hookExists) return { wasNew: true };

  const existing = await readTextFile(hookUri);
  if (existing === null) {
    // Stat succeeded but read failed — file is on disk, contents opaque.
    // Refuse to write so we don't risk overwriting a non-Copilot hook.
    log(`[commitHook] ${filename} exists but is unreadable`);
    vscode.window.showErrorMessage(
      'Copilot Budget: Failed to read commit hook file (permission or filesystem error).',
    );
    return 'abort';
  }
  if (existing.trim() && !existing.includes(MARKER)) {
    log(`[commitHook] Existing ${filename} is NOT ours, aborting`);
    vscode.window.showWarningMessage(
      `Copilot Budget: A ${filename} hook already exists. Remove it first or install Copilot Budget manually.`,
    );
    return 'abort';
  }
  // Exists and is ours (or empty): refresh. An empty file counts as new so the
  // first real install still shows the toast.
  return { wasNew: !existing.trim() };
}

export async function installHook(): Promise<boolean> {
  // Validate every hook before writing any, so a third-party collision on the
  // second hook can't leave a half-installed pair on disk.
  const targets: { uri: vscode.Uri; script: string }[] = [];
  let anyNew = false;
  for (const def of HOOK_DEFS) {
    const hookUri = await getHookUri(def.filename);
    log(`[commitHook] installHook checking ${def.filename}=${hookUri?.path}`);
    if (!hookUri) {
      log('[commitHook] No workspace folder found');
      return false;
    }
    const check = await checkHookWritable(hookUri, def.filename);
    if (check === 'abort') return false;
    if (check.wasNew) anyNew = true;
    targets.push({ uri: hookUri, script: def.script });
  }

  try {
    const hooksDirUri = vscode.Uri.joinPath(targets[0].uri, '..');
    await vscode.workspace.fs.createDirectory(hooksDirUri);
    for (const { uri, script } of targets) {
      await writeTextFile(uri, script);
      await makeExecutable(uri);
    }
    log(`[commitHook] Hooks written successfully (anyNew=${anyNew})`);
    if (anyNew) {
      vscode.window.showInformationMessage('Copilot Budget: Commit hook installed.');
    }
    return true;
  } catch (err) {
    const msg = errorMessage(err);
    log(`[commitHook] Failed to install hook: ${msg}`);
    vscode.window.showErrorMessage(`Copilot Budget: Failed to install commit hook: ${msg}`);
    return false;
  }
}

type UninstallResult = 'removed' | 'absent' | 'abort';

async function uninstallOneHook(
  hookUri: vscode.Uri,
  filename: string,
): Promise<UninstallResult> {
  // Distinguish "file doesn't exist" from "stat failed for another reason":
  // only FileNotFound means "uninstall is a no-op". Permission/transient/
  // provider errors must surface as failure so callers don't persist
  // commitHook.enabled=false while the hook file may still be on disk
  // (which would let `onConfigChanged` re-install it on the next config tick
  // — see budgetPanel.handleHookToggle and the toggleCommitHook command).
  // Calling vscode.workspace.fs.stat directly (instead of fsUtils.stat) so
  // we can inspect the error code; the wrapper collapses every failure to null.
  let hookExists: boolean;
  try {
    await vscode.workspace.fs.stat(hookUri);
    hookExists = true;
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      hookExists = false;
    } else {
      const msg = errorMessage(err);
      log(`[commitHook] Failed to stat ${filename}: ${msg}`);
      vscode.window.showErrorMessage(
        `Copilot Budget: Failed to check commit hook file: ${msg}`,
      );
      return 'abort';
    }
  }

  if (!hookExists) return 'absent';

  const content = await readTextFile(hookUri);
  if (content === null) {
    log(`[commitHook] ${filename} exists but is unreadable`);
    vscode.window.showErrorMessage(
      'Copilot Budget: Failed to read commit hook file (permission or filesystem error).',
    );
    return 'abort';
  }

  if (!content.includes(MARKER)) {
    log(`[commitHook] ${filename} exists but is not ours`);
    vscode.window.showWarningMessage(
      `Copilot Budget: The ${filename} hook was not installed by Copilot Budget.`,
    );
    return 'abort';
  }

  try {
    await vscode.workspace.fs.delete(hookUri);
    log(`[commitHook] ${filename} removed successfully`);
    return 'removed';
  } catch (err) {
    const msg = errorMessage(err);
    log(`[commitHook] Failed to remove ${filename}: ${msg}`);
    vscode.window.showErrorMessage(`Copilot Budget: Failed to remove commit hook: ${msg}`);
    return 'abort';
  }
}

export async function uninstallHook(): Promise<boolean> {
  let anyRemoved = false;
  for (const def of HOOK_DEFS) {
    const hookUri = await getHookUri(def.filename);
    log(`[commitHook] uninstallHook checking ${def.filename}=${hookUri?.path}`);
    if (!hookUri) {
      log('[commitHook] No workspace folder found');
      return false;
    }
    const result = await uninstallOneHook(hookUri, def.filename);
    if (result === 'abort') return false;
    if (result === 'removed') anyRemoved = true;
  }

  if (anyRemoved) {
    vscode.window.showInformationMessage('Copilot Budget: Commit hook removed.');
  } else {
    // No hook on disk — the user's intent (no Copilot Budget hook present) is
    // already satisfied. Return true so the caller can safely persist
    // commitHook.enabled = false without drifting out of sync with disk state.
    log('[commitHook] No hook on disk; uninstall is a no-op');
    vscode.window.showInformationMessage('Copilot Budget: No commit hook to remove.');
  }
  return true;
}
