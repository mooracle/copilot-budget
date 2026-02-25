import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves the real git directory for a workspace root.
 * Handles both normal repos (.git is a directory) and
 * worktrees/submodules/devcontainers (.git is a file with `gitdir: <path>`).
 */
export function resolveGitDir(workspaceRoot: string): string | null {
  const gitPath = path.join(workspaceRoot, '.git');
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }
  } catch {
    return null;
  }

  // .git exists but is not a directory — read it as a file
  try {
    const content = fs.readFileSync(gitPath, 'utf-8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return null;
    const gitdir = match[1];
    if (path.isAbsolute(gitdir)) {
      return gitdir;
    }
    return path.resolve(workspaceRoot, gitdir);
  } catch {
    return null;
  }
}

/**
 * Resolves the common (shared) git directory for a workspace root.
 * In a regular repo or submodule, this is the same as resolveGitDir().
 * In a worktree, this follows the `commondir` file to the main git dir
 * so that shared resources like hooks are found in the right place.
 */
export function resolveGitCommonDir(workspaceRoot: string): string | null {
  const gitDir = resolveGitDir(workspaceRoot);
  if (!gitDir) return null;

  const commondirPath = path.join(gitDir, 'commondir');
  try {
    const commondir = fs.readFileSync(commondirPath, 'utf-8').trim();
    if (path.isAbsolute(commondir)) {
      return commondir;
    }
    return path.resolve(gitDir, commondir);
  } catch {
    // No commondir file — this is the main git dir (or a submodule)
    return gitDir;
  }
}
