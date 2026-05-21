import * as fs from 'fs';
import * as vscode from 'vscode';
import { log } from './logger';
import { resolveGitCommonDir } from './gitDir';
import { readTextFile, writeTextFile } from './fsUtils';
import { errorMessage } from './utils';

const MARKER = '# Copilot Budget prepare-commit-msg hook';

const HOOK_SCRIPT = `#!/bin/sh
${MARKER}
COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"
case "$COMMIT_SOURCE" in merge|squash|commit) exit 0 ;; esac

GIT_DIR="$(git rev-parse --git-dir)"
TRACKING_FILE="$GIT_DIR/copilot-budget"
[ -f "$TRACKING_FILE" ] || exit 0

TR_LINES=$(grep '^TR_' "$TRACKING_FILE") || true
case "$TR_LINES" in '') exit 0 ;; esac

{
printf '\\n\\n'
echo "$TR_LINES" | sed 's/^TR_\\([^=]*\\)=/\\1: /'
} >> "$COMMIT_MSG_FILE" && : > "$TRACKING_FILE"
`;

async function getHookUri(): Promise<vscode.Uri | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    log('[commitHook] getHookUri: no workspace folders');
    return null;
  }
  const gitCommonDir = await resolveGitCommonDir(folders[0].uri);
  if (!gitCommonDir) {
    log(`[commitHook] getHookUri: could not resolve git directory for ${folders[0].uri.path}`);
    return null;
  }
  const hookUri = vscode.Uri.joinPath(gitCommonDir, 'hooks', 'prepare-commit-msg');
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
  const hookUri = await getHookUri();
  if (!hookUri) return false;

  const content = await readTextFile(hookUri);
  if (!content) return false;
  return content.includes(MARKER);
}

export async function installHook(): Promise<boolean> {
  const hookUri = await getHookUri();
  log(`[commitHook] installHook called, hookUri=${hookUri?.path}`);
  if (!hookUri) {
    log('[commitHook] No workspace folder found');
    return false;
  }

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
      log(`[commitHook] Failed to stat hook file: ${msg}`);
      vscode.window.showErrorMessage(
        `Copilot Budget: Failed to check commit hook file: ${msg}`,
      );
      return false;
    }
  }

  let existing: string | null = null;
  if (hookExists) {
    existing = await readTextFile(hookUri);
    if (existing === null) {
      // Stat succeeded but read failed — file is on disk, contents opaque.
      // Refuse to write so we don't risk overwriting a non-Copilot hook.
      log('[commitHook] Hook file exists but is unreadable');
      vscode.window.showErrorMessage(
        'Copilot Budget: Failed to read commit hook file (permission or filesystem error).',
      );
      return false;
    }
    if (existing.trim()) {
      log(`[commitHook] Existing hook found (${existing.length} bytes)`);
      if (!existing.includes(MARKER)) {
        log('[commitHook] Existing hook is NOT ours, aborting');
        vscode.window.showWarningMessage(
          'Copilot Budget: A prepare-commit-msg hook already exists. Remove it first or install Copilot Budget manually.',
        );
        return false;
      }
      log('[commitHook] Existing hook is ours, will refresh');
    }
  }

  try {
    const hooksDirUri = vscode.Uri.joinPath(hookUri, '..');
    await vscode.workspace.fs.createDirectory(hooksDirUri);
    await writeTextFile(hookUri, HOOK_SCRIPT);
    await makeExecutable(hookUri);
    log(`[commitHook] Hook written successfully (refresh=${existing?.includes(MARKER)})`);
    if (!existing?.includes(MARKER)) {
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

export async function uninstallHook(): Promise<boolean> {
  const hookUri = await getHookUri();
  log(`[commitHook] uninstallHook called, hookUri=${hookUri?.path}`);
  if (!hookUri) {
    log('[commitHook] No workspace folder found');
    return false;
  }

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
      log(`[commitHook] Failed to stat hook file: ${msg}`);
      vscode.window.showErrorMessage(
        `Copilot Budget: Failed to check commit hook file: ${msg}`,
      );
      return false;
    }
  }

  if (!hookExists) {
    // No hook on disk — the user's intent (no Copilot Budget hook present) is
    // already satisfied. Return true so the caller can safely persist
    // commitHook.enabled = false without drifting out of sync with disk state.
    log('[commitHook] No hook on disk; uninstall is a no-op');
    vscode.window.showInformationMessage('Copilot Budget: No commit hook to remove.');
    return true;
  }

  const content = await readTextFile(hookUri);
  if (content === null) {
    log('[commitHook] Hook file exists but is unreadable');
    vscode.window.showErrorMessage(
      'Copilot Budget: Failed to read commit hook file (permission or filesystem error).',
    );
    return false;
  }

  if (!content.includes(MARKER)) {
    log('[commitHook] Hook file exists but is not ours');
    vscode.window.showWarningMessage(
      'Copilot Budget: The prepare-commit-msg hook was not installed by Copilot Budget.',
    );
    return false;
  }

  try {
    await vscode.workspace.fs.delete(hookUri);
    log('[commitHook] Hook removed successfully');
    vscode.window.showInformationMessage('Copilot Budget: Commit hook removed.');
    return true;
  } catch (err) {
    const msg = errorMessage(err);
    log(`[commitHook] Failed to remove hook: ${msg}`);
    vscode.window.showErrorMessage(`Copilot Budget: Failed to remove commit hook: ${msg}`);
    return false;
  }
}
