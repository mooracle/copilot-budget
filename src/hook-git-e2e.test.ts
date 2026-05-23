import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOOK_SCRIPT } from './commitHook';
import { formatTrackingFile } from './trackingFile';
import { TrackingStats, ModelStats } from './tracker';
import { __configStore } from './__mocks__/vscode';

// Require git >= 2.28: `git init -b <branch>` (used in setupRepo) landed in
// 2.28 (Jul 2020). Older versions parse `git --version` fine but fail at
// `init -b main`, so gating only on `git --version` would let the suite
// hard-fail during setup instead of skipping per its contract.
function gitAvailable(): boolean {
  try {
    const out = execFileSync('git', ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const m = out.match(/git version (\d+)\.(\d+)/);
    if (!m) return false;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major > 2 || (major === 2 && minor >= 28);
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
// (which may force commit.gpgsign=true on CI hosts). GIT_DIR / GIT_WORK_TREE /
// GIT_INDEX_FILE are scrubbed so a parent process running inside a git
// operation (alias, `rebase --exec`, hook) cannot redirect our `-C <tmpdir>`
// commands to its own repo. GIT_TEMPLATE_DIR is scrubbed because it would
// inject a `prepare-commit-msg` template at `git init` time, running before
// our hook is installed. LC_ALL=C forces English git messages — assertions
// like /^Revert / depend on git's untranslated subject template, which
// gettext otherwise localizes from the parent locale.
function gitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_EDITOR: 'true',
    LC_ALL: 'C',
    LANG: 'C',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_NAMESPACE;
  delete env.GIT_TEMPLATE_DIR;
  return env;
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
function commit(repo: Repo, message: string): void {
  // A normal `git commit` needs a tree change; create a unique file each time
  // so commits don't no-op.
  const filename = `file-${dummyCounter++}.txt`;
  fs.writeFileSync(path.join(repo.dir, filename), String(Math.random()));
  execFileSync('git', ['-C', repo.dir, 'add', filename], {
    env: repo.env,
    stdio: 'pipe',
  });
  execFileSync('git', ['-C', repo.dir, 'commit', '-m', message], {
    env: repo.env,
    stdio: 'pipe',
  });
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

// `git rebase -i HEAD~n` driven headlessly via GIT_SEQUENCE_EDITOR (the
// editor that rewrites the rebase todo list) and GIT_EDITOR=true (from
// gitEnv, which auto-accepts the prepared commit message file).
//
// - 'squash' / 'fixup' / 'reword': rewrite all entries after the first
//   from `pick` to the named action.
// - 'pick': no-op editor (leaves the todo list alone). Per githooks docs,
//   `pick` actions during rebase do NOT invoke prepare-commit-msg.
//
// `sed -i.bak` is portable across BSD (macOS) and GNU sed; the .bak file
// is cleaned up so a repeated invocation in the same repo stays clean.
// The sed address `2,$` (single-quoted so the shell doesn't expand `$`)
// rewrites every line from the second through the last, skipping line 1
// so the first pick stays as the base of the squash/fixup/reword sequence.
function rebaseInteractive(
  repo: Repo,
  n: number,
  action: 'squash' | 'fixup' | 'reword' | 'pick',
): void {
  let sequenceEditor: string;
  if (action === 'pick') {
    sequenceEditor = 'true';
  } else {
    const scriptPath = path.join(repo.dir, `seq-editor-${action}.sh`);
    fs.writeFileSync(
      scriptPath,
      `#!/bin/sh\nsed -i.bak '2,$ s/^pick /${action} /' "$1" && rm -f "$1.bak"\n`,
    );
    fs.chmodSync(scriptPath, 0o755);
    sequenceEditor = scriptPath;
  }
  const env = { ...repo.env, GIT_SEQUENCE_EDITOR: sequenceEditor };
  execFileSync('git', ['-C', repo.dir, 'rebase', '-i', `HEAD~${n}`], {
    env,
    stdio: 'pipe',
  });
}

function commitMessageAt(repo: Repo, ref: string): string {
  return execFileSync('git', ['-C', repo.dir, 'log', '-1', '--format=%B', ref], {
    env: repo.env,
    encoding: 'utf8',
  });
}

function cherryPick(repo: Repo, ref: string): void {
  execFileSync('git', ['-C', repo.dir, 'cherry-pick', ref], {
    env: repo.env,
    stdio: 'pipe',
  });
}

function revert(repo: Repo, ref: string, ...extraFlags: string[]): void {
  const args = ['-C', repo.dir, 'revert', ...extraFlags, ref];
  execFileSync('git', args, { env: repo.env, stdio: 'pipe' });
}

function mergeNoFf(repo: Repo, branch: string, message: string): void {
  execFileSync(
    'git',
    ['-C', repo.dir, 'merge', '--no-ff', '-m', message, branch],
    { env: repo.env, stdio: 'pipe' },
  );
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
    expect(msg).toMatch(/^Copilot-AI-Credits: 5\.00$/m);
    // If the awk dedup ever regressed, the indented inherited copies from
    // SQUASH_MSG would survive in the body — the un-indented count assertion
    // above would still pass at 1, so we also assert their absence.
    expect(msg).not.toMatch(/^[ \t]+Copilot-AI-Credits:/m);
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
    expect(msg).toMatch(/^Copilot-AI-Credits: 5\.00$/m);
    expect(msg).not.toMatch(/^[ \t]+Copilot-AI-Credits:/m);
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
    expect(msg).toMatch(/^Copilot-AI-Credits: 3\.00$/m);
    expect(msg).not.toMatch(/^[ \t]+Copilot-AI-Credits:/m);
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
    // Exactly one summed AI-Credits trailer, with no surviving indented copies.
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^Copilot-AI-Credits: 5\.00$/m);
    expect(msg).not.toMatch(/^[ \t]+Copilot-AI-Credits: [0-9]/m);
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
    expect(msg).toMatch(/^Copilot-AI-Credits: 5\.00$/m);
    expect(msg).not.toMatch(/^[ \t]+Copilot-AI-Credits: [0-9]/m);
    // Two Copilot-Est-Cost lines preserved (one per source, unchanged).
    expect(countTrailers(msg, 'Copilot-Est-Cost')).toBe(2);
  });

  // `git rebase -i` is the case the existing shell-only suite has to fake.
  // Here we drive the real workflow: each squash step fires the hook with
  // $COMMIT_SOURCE=message (the documented gotcha — see commitHook.ts:56-64),
  // and the hook's `$GIT_DIR/rebase-merge` directory probe routes it into
  // the sum branch even without $2=squash.
  it('git rebase -i squash sums three commit trailers into one', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    commit(repo, 'chore: init');
    writeStats(repo.gitDir, makeStats(5.0));
    commit(repo, 'feat: a');
    writeStats(repo.gitDir, makeStats(3.0));
    commit(repo, 'feat: b');
    writeStats(repo.gitDir, makeStats(2.0));
    commit(repo, 'feat: c');

    rebaseInteractive(repo, 3, 'squash');

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^Copilot-AI-Credits: 10\.00$/m);
    expect(msg).not.toMatch(/^[ \t]+Copilot-AI-Credits:/m);
  });

  // Per githooks(5): `prepare-commit-msg` is invoked by `git rebase` only
  // for `reword` and `squash`, NOT for `pick` or `fixup`. With fixup, git
  // reuses the first commit's message verbatim and the secondary commit
  // bodies (and their trailers) are discarded before the hook would have
  // run — so only the base commit's trailer survives in the final message.
  it('git rebase -i fixup keeps only the first commit trailer', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    commit(repo, 'chore: init');
    writeStats(repo.gitDir, makeStats(5.0));
    commit(repo, 'feat: a');
    writeStats(repo.gitDir, makeStats(3.0));
    commit(repo, 'feat: b');
    writeStats(repo.gitDir, makeStats(2.0));
    commit(repo, 'feat: c');

    rebaseInteractive(repo, 3, 'fixup');

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^[ \t]*Copilot-AI-Credits: 5\.00$/m);
  });

  // No-op confirmation: a pure-pick rebase doesn't fire prepare-commit-msg,
  // so each commit's body — including its single trailer — is preserved.
  // This is the "acceptable alternative" called out in the plan: it doesn't
  // exercise the per-commit sum branch with no duplicates, but it confirms
  // the rebase-i path doesn't accidentally mutate single-trailer commits.
  it('git rebase -i with all picks preserves each commit trailer', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    commit(repo, 'chore: init');
    writeStats(repo.gitDir, makeStats(5.0));
    commit(repo, 'feat: a');
    writeStats(repo.gitDir, makeStats(3.0));
    commit(repo, 'feat: b');
    writeStats(repo.gitDir, makeStats(2.0));
    commit(repo, 'feat: c');

    rebaseInteractive(repo, 3, 'pick');

    const msgA = commitMessageAt(repo, 'HEAD~2');
    const msgB = commitMessageAt(repo, 'HEAD~1');
    const msgC = commitMessageAt(repo, 'HEAD');

    expect(countAiCreditsTrailers(msgA)).toBe(1);
    expect(msgA).toMatch(/^[ \t]*Copilot-AI-Credits: 5\.00$/m);
    expect(countAiCreditsTrailers(msgB)).toBe(1);
    expect(msgB).toMatch(/^[ \t]*Copilot-AI-Credits: 3\.00$/m);
    expect(countAiCreditsTrailers(msgC)).toBe(1);
    expect(msgC).toMatch(/^[ \t]*Copilot-AI-Credits: 2\.00$/m);
  });

  // `git cherry-pick` invokes prepare-commit-msg with COMMIT_SOURCE=message
  // (verified against git 2.50). The hook's early-exit only matches `merge` or
  // `commit`, so `message` falls through. With the tracking file truncated by
  // the preceding commit (0 bytes), the TR_ grep returns empty and the hook
  // exits before appending. The cherry-picked commit body already contains
  // the source commit's trailer verbatim (cherry-pick copies the message), so
  // the resulting commit ends up with exactly one trailer — inherited, not
  // appended by the hook.
  it('git cherry-pick of a commit with a trailer preserves it (no local tracking)', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    commit(repo, 'chore: init');
    branchWithCommits(repo, 'feature', [makeStats(4.0)]);

    checkout(repo, 'main');
    cherryPick(repo, 'feature');

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(1);
    expect(msg).toMatch(/^Copilot-AI-Credits: 4\.00$/m);
  });

  // Same cherry-pick path, but a local tracking file exists. The hook falls
  // through to the TR_ append branch and adds a *second* trailer on top of the
  // one inherited from the source commit's body. The hook does NOT sum on the
  // normal-commit path — that summing only happens on rebase/squash sources —
  // so the resulting message carries TWO `Copilot-AI-Credits:` lines and the
  // tracking file is truncated. If summing here is ever desired, that's a
  // separate scope change (flag with ⚠️ and discuss).
  it('git cherry-pick with a local tracking file appends a second trailer', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    commit(repo, 'chore: init');
    branchWithCommits(repo, 'feature', [makeStats(4.0)]);

    checkout(repo, 'main');
    writeStats(repo.gitDir, makeStats(1.0));
    cherryPick(repo, 'feature');

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(2);
    expect(msg).toMatch(/^Copilot-AI-Credits: 4\.00$/m);
    expect(msg).toMatch(/^Copilot-AI-Credits: 1\.00$/m);
    // Tracking file truncated on the append path (normal-commit branch).
    expect(fs.statSync(trackingFilePath(repo)).size).toBe(0);
  });

  // `git revert --no-edit` invokes prepare-commit-msg with COMMIT_SOURCE=message
  // (verified against git 2.50 — same as cherry-pick). The hook falls through,
  // and with the tracking file truncated by the preceding commit the TR_ grep
  // returns empty, so the hook exits before appending. Git's default revert
  // message is `Revert "<subject>"\n\nThis reverts commit <sha>.` and does NOT
  // inline the reverted commit's body, so no inherited trailer arrives in the
  // message file either. Final message has zero Copilot-AI-Credits lines.
  it('git revert --no-edit produces no Copilot-AI-Credits trailer (no local tracking)', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    commit(repo, 'chore: init');
    writeStats(repo.gitDir, makeStats(4.0));
    commit(repo, 'feat: x');

    revert(repo, 'HEAD', '--no-edit');

    const msg = lastCommitMessage(repo);
    expect(countAiCreditsTrailers(msg)).toBe(0);
    expect(msg).toMatch(/^Revert /m);
  });

  // `git merge --no-ff` with `-m` fires prepare-commit-msg with $2=merge, so
  // the hook exits at the `case` statement before reading any tracking file.
  // The merge commit message is exactly the `-m` text — git does NOT inline
  // feature-branch commit bodies into a normal merge commit message — so the
  // inherited trailer from the feature commit never reaches the merge commit.
  // The local tracking file remains untouched because the hook exits before
  // the truncation step.
  it('git merge --no-ff writes no trailer and leaves the tracking file intact', () => {
    repo = setupRepo();
    installHook(repo.gitDir);

    commit(repo, 'chore: init');
    branchWithCommits(repo, 'feature', [makeStats(3.0)]);
    checkout(repo, 'main');

    writeStats(repo.gitDir, makeStats(7.0));
    const sizeBefore = fs.statSync(trackingFilePath(repo)).size;

    mergeNoFf(repo, 'feature', 'merge feature');

    const msg = lastCommitMessage(repo);
    expect(msg).toContain('merge feature');
    expect(countAiCreditsTrailers(msg)).toBe(0);
    // Tracking file unchanged: hook exited on $2=merge before truncation.
    expect(fs.statSync(trackingFilePath(repo)).size).toBe(sizeBefore);
    const trackingContent = fs.readFileSync(trackingFilePath(repo), 'utf8');
    expect(trackingContent).toContain('TR_Copilot-AI-Credits=7.00');
  });
});
