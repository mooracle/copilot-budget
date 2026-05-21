# Real-Git E2E Tests for Commit Hook

## Overview

Add an end-to-end test suite that exercises the `prepare-commit-msg` hook by
driving **real `git`** against a throwaway repository, instead of the current
approach in `src/hook-script.test.ts` which simulates rebase/squash by hand
(creating `.git/rebase-merge/` and invoking `sh` with `$2=squash` directly).

The new suite is intentionally a black-box test of the contract:

1. Extension writes `<gitdir>/copilot-budget` (via `writeTrackingFile`).
2. User runs a `git` command (`commit`, `commit --amend`, `merge --squash`,
   `rebase -i`, `cherry-pick`, `revert`, `merge --no-ff`).
3. Hook fires; the resulting commit message in `git log -1 --format=%B` must
   contain the expected trailers (and duplicates must be summed where the
   hook documents that behavior).

This catches drift between the writer's `TR_` format and the hook's parser, and
catches incorrect assumptions about which `$COMMIT_SOURCE` values git actually
passes (the known gotcha: `git rebase -i` with squash fires with `$2=message`,
not `squash`; the hook relies on rebase-dir detection instead — see
`CLAUDE.md`).

## Context (from discovery)

- **Hook script**: `src/commitHook.ts:10-82` (`HOOK_SCRIPT` constant, already
  exported). Installed to `$GIT_COMMON_DIR/hooks/prepare-commit-msg`.
- **Tracking writer**: `src/trackingFile.ts:29-84` (`writeTrackingFile`).
  Currently entangled with `vscode.Uri` + `vscode.workspace.fs` via `fsUtils`,
  which means the real Jest run sees the vscode mock and never touches disk.
  Needs a pure formatter extracted so E2E tests can produce the on-disk file
  with real `fs`.
- **Existing hook tests**:
  - `src/commitHook.test.ts` — install/uninstall, mocked fs/vscode. Untouched
    by this plan.
  - `src/hook-script.test.ts` — runs `HOOK_SCRIPT` via `execFileSync('sh',
    ...)` against a synthesized `$GIT_DIR`. Kept as fast shell-only coverage
    (per user choice). No deletions.
- **Tmp-dir pattern in use**: `fs.mkdtempSync(path.join(os.tmpdir(),
  'cb-hook-'))` with `afterEach` cleanup (`src/hook-script.test.ts:15,32`).
- **Test runner**: `npm test` → Jest with `ts-jest`, Node env (jest.config.js).
- **No real `git` invocation anywhere in the suite yet.**

## Development Approach

- **Testing approach**: Regular (user choice). This plan IS the test work —
  every task adds tests as its primary deliverable. The single production-code
  change (extracting `formatTrackingFile`) gets its own unit-test coverage
  alongside the existing `writeTrackingFile` tests.
- Skip the E2E suite gracefully if `git --version` fails (CI without git, or
  sandboxed environments). Use `describe.skip` with a `console.warn` so the
  skip is visible.
- Set `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (and committer equivalents) via
  `env` on each `execFileSync` call — do NOT touch the user's `~/.gitconfig`.
- Use `git init -b main` for a stable default branch name across git versions.
- Each test gets its own `mkdtempSync` repo and `afterEach` cleanup.
- **CRITICAL: every task ends with passing tests before the next task starts.**

## Testing Strategy

- **Unit tests**: Task 1 adds a unit test for the new pure `formatTrackingFile`
  function (snapshot-style: feed in synthetic `TrackingStats`, assert exact
  string output for the `TR_` lines that the hook will consume).
- **E2E tests**: Tasks 2–5 add scenario tests in
  `src/hook-git-e2e.test.ts`. Each test: scaffold repo → install hook → write
  tracking file → run real git command(s) → assert on `git log`'s message
  output. This is the project's first real-git E2E coverage; same Jest run,
  no separate runner (per user choice).
- No UI / Playwright — this extension has no UI-based e2e suite.

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): test file + small refactor in
  `src/trackingFile.ts`, all in-repo.
- **Post-Completion** (no checkboxes): manual smoke verification on a real
  repo with an actual Copilot session, CI runtime sanity check.

## Implementation Steps

### Task 1: Extract pure `formatTrackingFile` and build the E2E harness

**Files:**
- Modify: `src/trackingFile.ts`
- Modify: `src/trackingFile.test.ts`
- Create: `src/hook-git-e2e.test.ts`

- [x] In `src/trackingFile.ts`, extract a new exported pure function
      `export function formatTrackingFile(stats: TrackingStats): string` from
      the body of `writeTrackingFile` (lines 33–76 → returns
      `lines.join('\n') + '\n'`). `writeTrackingFile` becomes a 4-line wrapper:
      resolve uri, call formatter, `writeTextFile`, return.
- [x] Add unit test in `src/trackingFile.test.ts` for `formatTrackingFile`:
      one case with cost > 0 (asserts `TR_Copilot-AI-Credits=...` line
      present), one case with `totalAiCredits === 0` (asserts NO `TR_` line),
      one case with `aiCreditsPerModel` enabled.
- [x] Create `src/hook-git-e2e.test.ts` with the harness:
      - top-level `describe('hook E2E (real git)', () => { ... })`, gated on a
        `gitAvailable()` helper (`execFileSync('git', ['--version'])` in
        try/catch) — use `describe.skip` with `console.warn(...)` if false.
      - `setupRepo(): { dir: string, gitDir: string, env: NodeJS.ProcessEnv }`
        — `mkdtempSync`, `git init -b main`, returns paths + `env` containing
        `GIT_AUTHOR_NAME=Test`, `GIT_AUTHOR_EMAIL=test@example.com` (+
        COMMITTER equivalents), `GIT_EDITOR=true`, `HOME=<tmpdir>` (isolate
        from user's gitconfig), `GIT_CONFIG_GLOBAL=/dev/null`,
        `GIT_CONFIG_SYSTEM=/dev/null` (isolate from CI host's `/etc/gitconfig`,
        e.g. enforced gpg signing). See full env block in Technical Details.
      - `installHook(gitDir)` — write `HOOK_SCRIPT` to
        `<gitDir>/hooks/prepare-commit-msg`, `chmod 0755`.
      - `writeStats(gitDir, stats)` — call `formatTrackingFile(stats)` and
        `fs.writeFileSync(<gitDir>/copilot-budget, ...)`.
      - `commit(dir, env, msg, ...flags)` — thin `execFileSync('git', ...)`
        wrapper that creates a dummy file change before each commit.
      - `lastCommitMessage(dir, env): string` — `git log -1 --format=%B`.
      - `afterEach` cleanup via `fs.rmSync(dir, { recursive: true, force:
        true })`.
- [x] Add a single smoke `it` that exercises the harness: scaffold repo,
      install hook, do nothing (no tracking file), `git commit --allow-empty
      -m 'init'`, assert the commit succeeds and has no trailer. Purpose is
      to validate the harness wiring, not hook behavior — the *real* normal-
      commit scenarios live in Task 2.
- [x] Run `npm test` — all tests (existing + new) must pass before Task 2.

### Task 2: Normal commit + amend scenarios

**Files:**
- Modify: `src/hook-git-e2e.test.ts`

- [x] **Scenario: normal commit appends trailer and truncates tracking file.**
      Write stats with `totalAiCredits = 5.00`, `git commit -m 'feat: x'`,
      assert `Copilot-AI-Credits: 5.00` in message and tracking file size === 0.
- [x] **Scenario: empty tracking file produces no trailer.** After Task 2.1
      runs the hook leaves an empty file. Make another commit without writing
      stats → assert NO `Copilot-AI-Credits:` line in the new commit.
- [x] **Scenario: no tracking file at all → no trailer.** Fresh repo, install
      hook, do NOT write tracking file, `git commit` → assert no
      `Copilot-AI-Credits:` line.
- [x] **Scenario: `git commit --amend --no-edit` does NOT duplicate the
      trailer.** Setup: stats written, normal commit (trailer present, file
      truncated). Then write a *new* tracking file with `3.00`, run `git
      commit --amend --no-edit -m 'feat: x'`. Git passes `$2=commit`. Per the
      hook (`src/commitHook.ts:51`), source `commit` exits early. Assert: the
      message still has exactly one `Copilot-AI-Credits:` line with the
      ORIGINAL value (5.00, not 3.00 or 8.00), AND the new tracking file is
      still intact (not truncated, because the hook short-circuited).
- [x] **Scenario: `git commit --amend` with new stats and editor change** —
      same as above but with `--no-edit` removed and `GIT_EDITOR=true`. Same
      expectations (amend is amend regardless of `-m`/`--no-edit`).
- [x] Run `npm test` — must pass before Task 3.

### Task 3: `git merge --squash` scenarios (`$COMMIT_SOURCE=squash`)

**Files:**
- Modify: `src/hook-git-e2e.test.ts`

- [x] **Helper**: add `branchWithCommits(repo, branchName, statsArray)` —
      checkout `-b`, then for each stats entry: write stats, make a file
      change, `git commit -m "...."`. Each individual commit runs the hook on
      the normal path so each commit ends up with its own
      `Copilot-AI-Credits:` trailer. Returns when done; tracking file is
      empty.
- [x] **Scenario: squash-merge sums two source commits' trailers.** Setup:
      branch `feature` with two commits (3.00, 2.00). Switch to main. `git
      merge --squash feature` populates `.git/SQUASH_MSG` with both commit
      bodies (including their trailers). `git commit` (no `-m`, with
      `GIT_EDITOR=true`) fires hook with `$2=squash`. ⚠️ Discovered during
      implementation: `git commit -m '...'` after `merge --squash` sets
      `$2=message`, NOT `squash` (verified empirically); the squash source
      only fires when git is allowed to read SQUASH_MSG into COMMIT_EDITMSG
      via the editor. Per hook's awk sum (`src/commitHook.ts:21-47`), the
      duplicate `Copilot-AI-Credits: 3.00` / `Copilot-AI-Credits: 2.00`
      lines collapse to a single `Copilot-AI-Credits: 5.00`. Assert exactly
      one such line with value `5.00`.
- [x] **Scenario: squash with concurrent local tracking file is NOT
      consumed.** Same setup, but before the final `git commit`, write a
      tracking file with `9.99`. Hook on squash path does NOT consult the
      tracking file (per CLAUDE.md). Assert: trailer total is still `5.00`
      (sum of squashed commits only), and the local tracking file is
      *unchanged* (still contains `9.99`, not truncated).
- [x] **Scenario: squash of three commits, two of which lack the trailer.**
      Branch with commits A (with trailer 1.00), B (no tracking file at
      commit time → no trailer), C (trailer 2.00). After squash: assert
      exactly one trailer line `Copilot-AI-Credits: 3.00`.
- [x] **Scenario: `Copilot-AI-Credits-Models:` aggregate trailer is NOT
      summed during squash (regex match, non-numeric value).** Per
      `commitHook.ts:23,35` the awk regex matches the name
      `Copilot-AI-Credits(-[A-Za-z0-9._-]+)?:` but requires a purely numeric
      value (`[0-9]+(\.[0-9]+)?`). The per-model aggregate has comma-separated
      `name=N` pairs and fails the value match, so the line is preserved
      verbatim — meaning it appears once per source commit, NOT summed. Setup:
      enable `copilot-budget.trailers.aiCreditsPerModel`, write two commits
      on a branch each producing both a numeric `Copilot-AI-Credits:` line
      and a `Copilot-AI-Credits-Models: gpt-4=A,…` line, then `merge --squash`
      + `commit`. Assert: exactly ONE numeric `Copilot-AI-Credits:` (summed),
      and TWO `Copilot-AI-Credits-Models:` lines (one per source commit,
      unchanged). Build the stats with synthetic `models: { 'gpt-4': {...} }`
      so the writer emits the aggregate.
- [x] **Scenario: `Copilot-Est-Cost:` trailer is NOT summed (regex doesn't
      match name).** The awk regex name pattern is anchored at
      `Copilot-AI-Credits`, so `Copilot-Est-Cost:` lines pass through
      untouched even though their value is numeric. Setup: enable
      `copilot-budget.trailers.estimatedCost`, two source commits with
      both `Copilot-AI-Credits:` and `Copilot-Est-Cost:` lines, squash-merge.
      Assert: ONE summed `Copilot-AI-Credits:` line, TWO `Copilot-Est-Cost:`
      lines (one per source, unchanged).
- [x] **Indented-trailer assertion** (covered implicitly by the scenarios
      above — `git merge --squash` writes inherited commit bodies with
      4-space indentation in `.git/SQUASH_MSG`, so the leading `[ \t]*` in
      the awk regex is exercised). No new test needed; document this in a
      comment on the squash-sum scenario.
- [x] Run `npm test` — must pass before Task 4.

### Task 4: `git rebase -i` squash/fixup scenarios (the real gap)

**Files:**
- Modify: `src/hook-git-e2e.test.ts`

- [ ] **Helper**: `rebaseSquash(repo, env, n)` — runs `git rebase -i HEAD~n`
      with `GIT_SEQUENCE_EDITOR` set to a small inline `sed` invocation that
      rewrites all but the first `pick` to `squash` (use a shell snippet like
      `sed -i.bak '2,$s/^pick /squash /' "$1"` written to a tmp file +
      chmod). `GIT_EDITOR=true` to auto-accept the combined commit message.
      Tracker note: `sed -i` flags differ between BSD and GNU; use `sed -i.bak`
      and then `rm` the `.bak` file inside the helper script for portability.
- [ ] **Scenario: rebase -i squashes three commits into one with summed
      trailer.** Three commits on `main` with trailers 5.00, 3.00, 2.00 (each
      via normal-commit hook path on separate commits, so each has its own
      `Copilot-AI-Credits:` line and the tracking file is empty between
      commits). `rebaseSquash(repo, env, 3)`. During rebase, prepare-commit-msg
      fires with `$2=message` (NOT squash — the documented gotcha) but the
      `.git/rebase-merge/` dir exists, so hook enters the sum branch
      (`src/commitHook.ts:61-64`). Assert: final commit has exactly one
      `Copilot-AI-Credits: 10.00` line.
- [ ] **Scenario: rebase -i with `fixup` instead of `squash`.** Same setup,
      but rewrite to `fixup`. `git fixup` discards the secondary commit
      messages — but the `COMMIT_MSG_FILE` still passes through
      prepare-commit-msg with rebase dir present. Document expected behavior:
      with `fixup`, only the first commit's trailer survives in the message
      file (the message is reused verbatim). Assert: final commit has one
      `Copilot-AI-Credits: 5.00` (the first commit's value only). If observed
      behavior differs, add ⚠️ note and discuss with user before changing the
      hook.
- [ ] **Scenario: rebase -i that rewrites each commit individually (e.g.,
      reword or `--exec`) keeps each commit's single trailer intact.** A pure
      no-op `pick` rebase may not fire prepare-commit-msg at all (git skips
      the hook when there is no message rewrite), so this scenario would
      pass trivially. To actually exercise the per-commit sum branch with
      no duplicates, force a rewrite: use `git rebase -i HEAD~3` with
      `GIT_SEQUENCE_EDITOR` rewriting each `pick` to `reword`, and a
      `GIT_EDITOR` script that appends a newline (forcing a real edit) but
      preserves the existing trailer. Assert each rebased commit still has
      exactly one `Copilot-AI-Credits:` line with its original value.
      (Acceptable alternative: rename this scenario to "no-op confirmation —
      pick-only rebase produces no hook fires" and just assert the commits'
      messages are byte-identical to pre-rebase via `git log --format=%B`.)
- [ ] Run `npm test` — must pass before Task 5.

### Task 5: cherry-pick, revert, real merge

**Files:**
- Modify: `src/hook-git-e2e.test.ts`

- [ ] **Scenario: `git cherry-pick` of a commit carrying a trailer.** Setup:
      branch `feature` with one commit (trailer 4.00). Switch to main, `git
      cherry-pick feature`. (Note: `$COMMIT_SOURCE` for cherry-pick is empty
      `""` in modern git, not `message`. Either way, the case statement at
      `commitHook.ts:50-52` only short-circuits on `merge` or `commit`, so
      cherry-pick falls through to the tracking-file branch.) With NO local
      tracking file, hook reads no `TR_` lines → no append. The cherry-picked
      commit message already has its trailer from the source commit. Assert:
      cherry-picked commit has exactly one `Copilot-AI-Credits: 4.00`
      (original, no duplicate, no second append).
- [ ] **Scenario: `git cherry-pick` WITH a local tracking file → trailer
      ADDED on top.** Same as above but write tracking file with `1.00`
      before the cherry-pick. Hook reads `TR_` line → appends. Assert: commit
      message ends up with TWO `Copilot-AI-Credits:` lines (4.00 from source,
      1.00 newly appended) — the hook does NOT sum on normal-commit path.
      Document this as expected behavior. (If user wants summing here, that's
      a separate scope discussion — flag with ⚠️ and stop.)
- [ ] **Scenario: `git revert --no-edit` of a commit carrying a trailer.**
      Revert fires hook with `$COMMIT_SOURCE` empty (or `message` if
      `--edit` is used) — neither matches the early-exit case, so it falls
      through to the tracking-file branch like cherry-pick. With no tracking
      file: revert commit's auto-generated message includes the reverted
      commit's body (and thus its trailer). Assert: revert commit has
      exactly one `Copilot-AI-Credits:` line (the inherited one from the
      reverted commit's body).
- [ ] **Scenario: real merge commit (`git merge --no-ff`) writes no
      trailer.** Setup: branch `feature` with one commit (trailer 3.00).
      Switch to main, write local tracking file `7.00`, `git merge --no-ff
      feature -m 'merge feature'`. Merge commit fires hook with `$2=merge` →
      hook exits early (`src/commitHook.ts:51`). The auto-generated merge
      message is `Merge branch 'feature'` and does NOT inline feature commit
      bodies, so no inherited trailer arrives via the message file either.
      Assert: merge commit message has NO `Copilot-AI-Credits:` line, AND
      the local tracking file is UNCHANGED (`7.00` intact, not truncated).
- [ ] Run `npm test` — must pass before Task 6.

### Task 6: Verify acceptance criteria

- [ ] Verify every scenario group from Overview has at least one passing test:
      normal+amend (Task 2), merge --squash (Task 3), rebase -i (Task 4),
      cherry-pick + revert + real merge (Task 5).
- [ ] Run full suite: `npm test`. All tests pass.
- [ ] Run `npm run lint`. Clean.
- [ ] Measure E2E suite runtime: `npx jest src/hook-git-e2e.test.ts
      --verbose`. If it exceeds ~10s, note in plan whether to gate behind an
      env var; otherwise leave on by default.
- [ ] Confirm `hook-script.test.ts` still passes unchanged (no overlap
      regressions).

### Task 7: Update docs and archive plan

- [ ] If anything *surprising* was learned about hook behavior (e.g., the
      cherry-pick "two trailers" case), add a one-line note to CLAUDE.md
      under "Key Design Details" or to the `commitHook.ts` description in
      CLAUDE.md. If nothing surprising, skip — do NOT pad CLAUDE.md with
      narration.
- [ ] Move plan: `mv docs/plans/20260522-real-git-e2e-commit-hook.md
      docs/plans/completed/`.

## Technical Details

**`formatTrackingFile` signature**:
```ts
export function formatTrackingFile(stats: TrackingStats): string;
```
Returns the exact string that currently goes to `writeTextFile` (newline-
terminated `KEY=VALUE` lines). `writeTrackingFile` becomes:
```ts
const uri = await getTrackingFileUri();
if (!uri) return false;
try {
  await writeTextFile(uri, formatTrackingFile(stats));
  return true;
} catch { return false; }
```

**Harness env block** (every `execFileSync` call):
```ts
const env = {
  ...process.env,
  HOME: dir,                              // avoid ~/.gitconfig
  GIT_CONFIG_GLOBAL: '/dev/null',         // belt + suspenders
  GIT_CONFIG_SYSTEM: '/dev/null',         // CI hosts may set commit.gpgsign=true
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_EDITOR: 'true',
};
```

**TrackingStats fixture builder**: small helper inside the test file that
returns a fully-populated `TrackingStats` from a single number (`totalAiCredits`),
defaulting `mode: 'files'`, `since: '2026-05-22'`, `interactions: 1`,
`models: {}`. Per-model scenarios in Task 3/4 if needed can pass a richer
object.

**Assertion style**: `expect(message).toMatch(/^Copilot-AI-Credits: 5\.00$/m)`
to be precise about whole-line matching; count occurrences via
`(message.match(/^Copilot-AI-Credits:/gm) ?? []).length` for "exactly N
trailers" assertions.

## Post-Completion

**Manual verification** (recommended after merge):
- Run a real Copilot Chat session in a workspace, perform `git commit`,
  `git rebase -i HEAD~3` with squash. Confirm trailer ends up correctly in
  the resulting commit. (E2E tests cover the protocol, but a smoke check
  against a live extension catches integration issues with the actual
  tracking-file writer cadence.)

**CI runtime sanity** (informational):
- The E2E suite forks `git` ~3–5 times per scenario × ~10 scenarios → roughly
  30–50 git processes. On macOS this is typically 3–6s. If CI shows >15s,
  consider an opt-in env gate (`E2E_HOOK=1`) — but only if measured pain,
  not preemptively.

**No external systems** affected — this is pure local testing.
