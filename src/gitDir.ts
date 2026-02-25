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
  if (path.posix.isAbsolute(gitdir)) {
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
  if (path.posix.isAbsolute(trimmed)) {
    return gitDir.with({ path: trimmed });
  }
  return vscode.Uri.joinPath(gitDir, trimmed);
}
