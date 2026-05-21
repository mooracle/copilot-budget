import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOOK_SCRIPT } from './commitHook';
import { formatTrackingFile } from './trackingFile';
import { TrackingStats, ModelStats } from './tracker';
import { __configStore } from './__mocks__/vscode';

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

// Amend rewrites the existing commit; no tree change is required, so this
// stays distinct from `commit` to avoid restaging an unrelated dummy file.
function amend(repo: Repo, ...extraFlags: string[]): void {
  const args = ['-C', repo.dir, 'commit', '--amend', ...extraFlags];
  execFileSync('git', args, { env: repo.env, stdio: 'pipe' });
}

function lastCommitMessage(repo: Repo): string {
  return execFileSync('git', ['-C', repo.dir, 'log', '-1', '--format=%B'], {
    env: repo.env,
    encoding: 'utf8',
  });
}

function trackingFilePath(repo: Repo): string {
  return path.join(repo.gitDir, 'copilot-budget');
}

function countAiCreditsTrailers(message: string): number {
  return (message.match(/^Copilot-AI-Credits:/gm) ?? []).length;
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

function makeModelStats(costAic: number): ModelStats {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costAic,
  };
}

// Build TrackingStats whose models map has a single synthetic entry, so the
// per-model aggregate trailer emits a `name=N` value when enabled. The total
// is set equal to the model cost so totalAiCredits > 0 (gate for any TR_
// lines).
function makeStatsWithModel(modelId: string, costAic: number): TrackingStats {
  return {
    ...makeStats(costAic),
    models: { [modelId]: makeModelStats(costAic) },
  };
}

function checkout(repo: Repo, branch: string, create = false): void {
  const args = ['-C', repo.dir, 'checkout'];
  if (create) args.push('-b');
  args.push(branch);
  execFileSync('git', args, { env: repo.env, stdio: 'pipe' });
}

// Creates `branchName` off the current HEAD, then walks `statsArray`: for
// each entry, writes the tracking file (when non-null) and makes a regular
// commit. Each commit fires the hook on the normal-commit path, so its
// trailer ends up in the commit message and the tracking file is truncated
// before the next iteration. A `null` entry means "commit without writing
// stats first" — i.e. an empty/missing tracking file → no trailer on that
// commit. Returns with the working tree on `branchName`.
function branchWithCommits(
  repo: Repo,
  branchName: string,
  statsArray: (TrackingStats | null)[],
): void {
  checkout(repo, branchName, true);
  statsArray.forEach((stats, i) => {
    if (stats) writeStats(repo.gitDir, stats);
    commit(repo, `feat: ${branchName}-${i}`);
  });
}

// `git merge --squash <branch>` stages branch changes and writes
// `.git/SQUASH_MSG`. The follow-up `git commit` only fires the hook with
// $2=squash when no `-m` is passed: with `-m`, git treats the commit as a
// `message` source and ignores SQUASH_MSG entirely (verified empirically
// against git 2.x — same gotcha is described for rebase -i in CLAUDE.md).
// We rely on `GIT_EDITOR=true` (set in `gitEnv`) to accept the SQUASH_MSG
// content as-is, so the message file actually contains the inherited
// commit bodies the hook needs to sum.
function squashMerge(repo: Repo, branch: string): void {
  execFileSync('git', ['-C', repo.dir, 'merge', '--squash', branch], {
    env: repo.env,
    stdio: 'pipe',
  });
  execFileSync('git', ['-C', repo.dir, 'commit'], {
    env: repo.env,
    stdio: 'pipe',
  });
}

// Tolerate the 4-space indentation git applies to inherited body lines in
// SQUASH_MSG: any preserved (non-summed) trailer keeps that indentation in
// the final message, so the matcher has to accept it.
function countTrailers(message: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^[ \\t]*${escaped}:`, 'gm');
  return (message.match(re) ?? []).length;
}

const describeE2E = gitAvailable() ? describe : describe.skip;
if (!gitAvailable()) {
  console.warn(
    'hook E2E (real git): skipping — `git --version` failed. Install git to run the real-git E2E suite.',
  );
}

describeE2E('hook E2E (real git)', () => {
  let repo: Repo;

  beforeEach(() => {
    // Some scenarios mutate the vscode config mock to enable optional
    // trailers; reset between tests so the defaults are restored. Existing
    // scenarios rely on defaults, so this is a no-op for them.
    for (const k of Object.keys(__configStore)) delete __configStore[k];
  });

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

  it('normal commit appends trailer and truncates tracking file', () => {
    repo = setupRepo();
    installHook(repo.gitDir);
    writeStats(repo.gitDir, makeStats(5.0));
    commit(repo, 'feat: x');

    const msg = lastCommitMessage(repo);
    expect(msg).toMatch(/^Copilot-AI-Credits: 5\.00$/m);
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(fs.statSync(trackingFilePath(repo)).size).toBe(0);
  });

  it('empty tracking file produces no trailer on the next commit', () => {
    repo = setupRepo();
    installHook(repo.gitDir);
    writeStats(repo.gitDir, makeStats(5.0));
    commit(repo, 'feat: first');
    // Hook truncated the tracking file; second commit must not append anything.
    commit(repo, 'feat: second');

    const msg = lastCommitMessage(repo);
    expect(msg).toContain('feat: second');
    expect(msg).not.toMatch(/Copilot-AI-Credits:/);
  });

  it('no tracking file at all produces no trailer', () => {
    repo = setupRepo();
    installHook(repo.gitDir);
    commit(repo, 'feat: x');

    const msg = lastCommitMessage(repo);
    expect(msg).not.toMatch(/Copilot-AI-Credits:/);
  });

  it('git commit --amend --no-edit does not duplicate the trailer', () => {
    repo = setupRepo();
    installHook(repo.gitDir);
    writeStats(repo.gitDir, makeStats(5.0));
    commit(repo, 'feat: x');

    // New stats arrive between commit and amend. The hook gets $2=commit and
    // exits early, leaving both the message trailer and the tracking file alone.
    writeStats(repo.gitDir, makeStats(3.0));
    amend(repo, '--no-edit');

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^Copilot-AI-Credits: 5\.00$/m);

    const trackingContent = fs.readFileSync(trackingFilePath(repo), 'utf8');
    expect(trackingContent).toContain('TR_Copilot-AI-Credits=3.00');
    expect(fs.statSync(trackingFilePath(repo)).size).toBeGreaterThan(0);
  });

  it('git commit --amend (editor path) does not duplicate the trailer', () => {
    repo = setupRepo();
    installHook(repo.gitDir);
    writeStats(repo.gitDir, makeStats(5.0));
    commit(repo, 'feat: x');

    writeStats(repo.gitDir, makeStats(3.0));
    // No --no-edit; rely on GIT_EDITOR=true to accept the existing message.
    amend(repo);

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^Copilot-AI-Credits: 5\.00$/m);

    const trackingContent = fs.readFileSync(trackingFilePath(repo), 'utf8');
    expect(trackingContent).toContain('TR_Copilot-AI-Credits=3.00');
    expect(fs.statSync(trackingFilePath(repo)).size).toBeGreaterThan(0);
  });

  // `git merge --squash` inlines each squashed commit's body into the
  // SQUASH_MSG that prepare-commit-msg sees, with 4-space indentation on
  // every body line. The `[ \t]*` prefix in the awk regex (commitHook.ts:23)
  // tolerates that indentation; this scenario exercises that tolerance
  // implicitly — if the prefix were removed, the sum would silently fall
  // back to the un-indented case and leave the inherited trailers untouched.
  it('git merge --squash sums two source commits trailers', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    // Initial commit on main so feature has a divergence point.
    commit(repo, 'chore: init');

    branchWithCommits(repo, 'feature', [makeStats(3.0), makeStats(2.0)]);

    checkout(repo, 'main');
    squashMerge(repo, 'feature');

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^[ \t]*Copilot-AI-Credits: 5\.00$/m);
  });

  it('git merge --squash does not consume a concurrent local tracking file', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    commit(repo, 'chore: init');
    branchWithCommits(repo, 'feature', [makeStats(3.0), makeStats(2.0)]);
    checkout(repo, 'main');

    // Write a fresh tracking file just before the squash commit. The squash
    // path in the hook never touches TRACKING_FILE — the only state it cares
    // about is the SQUASH_MSG already written into COMMIT_MSG_FILE. Per
    // CLAUDE.md: "The sum path does NOT consult the tracking file or reset
    // it, so usage accumulated during a rebase carries forward to the next
    // normal commit."
    writeStats(repo.gitDir, makeStats(9.99));
    const sizeBefore = fs.statSync(trackingFilePath(repo)).size;

    squashMerge(repo, 'feature');

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^[ \t]*Copilot-AI-Credits: 5\.00$/m);
    // Tracking file is unchanged (not truncated, value still 9.99).
    expect(fs.statSync(trackingFilePath(repo)).size).toBe(sizeBefore);
    const trackingContent = fs.readFileSync(trackingFilePath(repo), 'utf8');
    expect(trackingContent).toContain('TR_Copilot-AI-Credits=9.99');
  });

  it('git merge --squash skips source commits without a trailer', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    commit(repo, 'chore: init');

    // Branch with three commits: A has stats (1.00), B has no tracking file
    // at commit time (the prior commit truncated it → no trailer on B),
    // C has stats (2.00). After squash: 1.00 + 2.00 = 3.00.
    branchWithCommits(repo, 'feature', [
      makeStats(1.0),
      null,
      makeStats(2.0),
    ]);

    checkout(repo, 'main');
    squashMerge(repo, 'feature');

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^[ \t]*Copilot-AI-Credits: 3\.00$/m);
  });

  it('git merge --squash preserves Copilot-AI-Credits-Models lines (non-numeric value)', () => {
    // The awk regex matches `Copilot-AI-Credits(-<suffix>)?:` for the NAME
    // but requires a bare numeric VALUE. The per-model aggregate trailer
    // emits comma-separated `name=N` pairs, so its value fails the numeric
    // match and the line is preserved verbatim — meaning one per source
    // commit, NOT summed.
    __configStore['copilot-budget.commitHook.trailers.aiCreditsPerModel'] =
      'Copilot-AI-Credits-Models';

    repo = setupRepo();
    installHook(repo.gitDir);
    commit(repo, 'chore: init');

    branchWithCommits(repo, 'feature', [
      makeStatsWithModel('gpt-4', 3.0),
      makeStatsWithModel('gpt-4', 2.0),
    ]);

    checkout(repo, 'main');
    squashMerge(repo, 'feature');

    const msg = lastCommitMessage(repo);
    // Exactly one summed AI-Credits trailer.
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^[ \t]*Copilot-AI-Credits: 5\.00$/m);
    // Two per-model lines preserved (one per source commit, unchanged).
    expect(countTrailers(msg, 'Copilot-AI-Credits-Models')).toBe(2);
  });

  it('git merge --squash preserves Copilot-Est-Cost lines (name does not match regex)', () => {
    // The awk name pattern is anchored at `Copilot-AI-Credits` plus an
    // optional `-<suffix>`. `Copilot-Est-Cost` does not start with
    // `Copilot-AI-Credits`, so even though its value is numeric, the line
    // passes through untouched — one copy per squashed source commit.
    __configStore['copilot-budget.commitHook.trailers.estimatedCost'] =
      'Copilot-Est-Cost';

    repo = setupRepo();
    installHook(repo.gitDir);
    commit(repo, 'chore: init');

    branchWithCommits(repo, 'feature', [makeStats(3.0), makeStats(2.0)]);

    checkout(repo, 'main');
    squashMerge(repo, 'feature');

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^[ \t]*Copilot-AI-Credits: 5\.00$/m);
    // Two Copilot-Est-Cost lines preserved (one per source, unchanged).
    expect(countTrailers(msg, 'Copilot-Est-Cost')).toBe(2);
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
  makeStatsWithModel,
  branchWithCommits,
  squashMerge,
  checkout,
};
