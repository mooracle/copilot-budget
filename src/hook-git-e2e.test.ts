import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOOK_SCRIPT } from './commitHook';
import { formatTrackingFile } from './trackingFile';
import { TrackingStats } from './tracker';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

interface Repo {
  dir: string;
  gitDir: string;
  env: NodeJS.ProcessEnv;
}

// Isolation env: HOME + GIT_CONFIG_GLOBAL=/dev/null guards against the user's
// ~/.gitconfig; GIT_CONFIG_SYSTEM=/dev/null guards against /etc/gitconfig
// (which may force commit.gpgsign=true on CI hosts).
function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_EDITOR: 'true',
  };
}

function setupRepo(): Repo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-git-e2e-'));
  const env = gitEnv(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { env, stdio: 'pipe' });
  const gitDir = path.join(dir, '.git');
  return { dir, gitDir, env };
}

function installHook(gitDir: string): void {
  const hookPath = path.join(gitDir, 'hooks', 'prepare-commit-msg');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, HOOK_SCRIPT);
  fs.chmodSync(hookPath, 0o755);
}

function writeStats(gitDir: string, stats: TrackingStats): void {
  fs.writeFileSync(path.join(gitDir, 'copilot-budget'), formatTrackingFile(stats));
}

let dummyCounter = 0;
function commit(
  repo: Repo,
  message: string,
  ...extraFlags: string[]
): void {
  // A normal `git commit` needs a tree change; create a unique file each time
  // so commits don't no-op. Callers using --allow-empty can pass it via flags.
  if (!extraFlags.includes('--allow-empty')) {
    const filename = `file-${dummyCounter++}.txt`;
    fs.writeFileSync(path.join(repo.dir, filename), String(Math.random()));
    execFileSync('git', ['-C', repo.dir, 'add', filename], {
      env: repo.env,
      stdio: 'pipe',
    });
  }
  const args = ['-C', repo.dir, 'commit', '-m', message, ...extraFlags];
  execFileSync('git', args, { env: repo.env, stdio: 'pipe' });
}

function lastCommitMessage(repo: Repo): string {
  return execFileSync('git', ['-C', repo.dir, 'log', '-1', '--format=%B'], {
    env: repo.env,
    encoding: 'utf8',
  });
}

function makeStats(totalAiCredits: number): TrackingStats {
  return {
    since: '2026-05-22T00:00:00Z',
    lastUpdated: '2026-05-22T00:00:00Z',
    models: {},
    totalTokens: 0,
    interactions: 1,
    totalAiCredits,
    mode: 'files',
  };
}

const describeE2E = gitAvailable() ? describe : describe.skip;
if (!gitAvailable()) {
  console.warn(
    'hook E2E (real git): skipping — `git --version` failed. Install git to run the real-git E2E suite.',
  );
}

describeE2E('hook E2E (real git)', () => {
  let repo: Repo;

  afterEach(() => {
    if (repo) {
      fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  // Smoke test: harness wires up correctly. The real scenarios live in Task 2+.
  it('smoke: empty commit with no tracking file produces no Copilot trailer', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    execFileSync(
      'git',
      ['-C', repo.dir, 'commit', '--allow-empty', '-m', 'init'],
      { env: repo.env, stdio: 'pipe' },
    );

    const msg = lastCommitMessage(repo);
    expect(msg).toContain('init');
    expect(msg).not.toMatch(/Copilot-AI-Credits:/);
  });
});

// Helpers exported for subsequent E2E task files (Task 2–5 add scenarios here
// in the same test file; these reusable pieces live near the top so adding a
// scenario only needs `repo = setupRepo(); ...`).
export {
  gitAvailable,
  setupRepo,
  installHook,
  writeStats,
  commit,
  lastCommitMessage,
  makeStats,
};
