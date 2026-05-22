import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { stat, readTextFile } from './fsUtils';

/**
 * Resolves the real git directory for a workspace root.
 * Handles both normal repos (.git is a directory) and
 * worktrees/submodules/devcontainers (.git is a file with `gitdir: <path>`).
 */
export async function resolveGitDir(workspaceRoot: vscode.Uri): Promise<vscode.Uri | null> {
  const gitUri = vscode.Uri.joinPath(workspaceRoot, '.git');
  const fileStat = await stat(gitUri);
  if (!fileStat) return null;

  if (fileStat.type & vscode.FileType.Directory) {
    return gitUri;
  }

  // .git exists but is not a directory — read it as a file
  const content = await readTextFile(gitUri);
  if (!content) return null;

  const match = content.trim().match(/^gitdir:\s*(.+)$/);
  if (!match) return null;

  const gitdir = match[1];
  if (path.isAbsolute(gitdir)) {
    return workspaceRoot.with({ path: gitdir });
  }
  return vscode.Uri.joinPath(workspaceRoot, gitdir);
}

/**
 * Resolves the common (shared) git directory for a workspace root.
 * In a regular repo or submodule, this is the same as resolveGitDir().
 * In a worktree, this follows the `commondir` file to the main git dir
 * so that shared resources like hooks are found in the right place.
 */
export async function resolveGitCommonDir(workspaceRoot: vscode.Uri): Promise<vscode.Uri | null> {
  const gitDir = await resolveGitDir(workspaceRoot);
  if (!gitDir) return null;

  const commondirUri = vscode.Uri.joinPath(gitDir, 'commondir');
  const commondir = await readTextFile(commondirUri);
  if (!commondir) {
    // No commondir file — this is the main git dir (or a submodule)
    return gitDir;
  }

  const trimmed = commondir.trim();
  if (path.isAbsolute(trimmed)) {
    return gitDir.with({ path: trimmed });
  }
  return vscode.Uri.joinPath(gitDir, trimmed);
}

/**
 * Reads a single git config value (`git config --get <key>`) scoped to
 * `cwd`. Returns null when the key is unset, when git is unavailable, or
 * when the invocation fails for any other reason — callers fall back to
 * defaults rather than treating these as hard errors.
 *
 * Spans every config source git itself consults (worktree, local, global,
 * system, env), so values set via `husky install` / `lefthook install` —
 * which write to local config — are picked up alongside any `--global`
 * overrides a user may have.
 */
export function getGitConfigValue(cwd: string, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'config', '--get', key],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) {
          // exit 1 = key unset; ENOENT = git not on PATH; both treated as null
          resolve(null);
          return;
        }
        const trimmed = stdout.toString().trim();
        resolve(trimmed || null);
      },
    );
  });
}

/**
 * Resolves the directory git will look in for hook scripts when the user
 * commits from this worktree. Honors `core.hooksPath` (set by husky,
 * lefthook, and similar frameworks) so installing into the returned
 * directory means our hook actually fires.
 *
 * Resolution order matches git's own behavior:
 *   1. `core.hooksPath` (any config scope), absolute or relative to the
 *      worktree root.
 *   2. `<gitCommonDir>/hooks` (the default).
 */
export async function resolveHooksDir(workspaceRoot: vscode.Uri): Promise<vscode.Uri | null> {
  const customPath = await getGitConfigValue(workspaceRoot.fsPath, 'core.hooksPath');
  if (customPath) {
    const absolute = path.isAbsolute(customPath)
      ? customPath
      : path.join(workspaceRoot.fsPath, customPath);
    return vscode.Uri.file(absolute);
  }
  const gitCommonDir = await resolveGitCommonDir(workspaceRoot);
  if (!gitCommonDir) return null;
  return vscode.Uri.joinPath(gitCommonDir, 'hooks');
}
