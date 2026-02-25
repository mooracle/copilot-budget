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
