# Rebase / Squash / Fixup Trailers

## Overview

Two coupled changes so `Copilot-AI-Credits` trailers behave correctly across rebase, squash, and fixup. The branch hasn't shipped yet, so the in-flight 2.0.0 entry is amended in place — no version bump, no parser compatibility for the soon-to-be-removed `~` decoration.

1. **Strip decoration from tracking-file `TR_` lines and commit-message trailers.** Today the writer injects `~` into `TR_Copilot-AI-Credits` and `TR_Copilot-AI-Credits-<Model>` in Files mode, and prefixes `TR_Copilot-Est-Cost` with `$`. Both go away. Trailers and tracking-file `TR_` lines become bare numeric values (e.g. `Copilot-AI-Credits: 42.31`, `Copilot-Est-Cost: 0.42`). Decoration (`~`, currency symbol, unit label) is editor-surface-only.

2. **Sum duplicate trailers on squash.** Today the hook short-circuits on `$2 == squash` (`src/commitHook.ts:14`), so when N commits are squashed via `git rebase -i`, the resulting commit body contains N `Copilot-AI-Credits:` lines (one inherited from each squashed message). The hook will detect `$2 == squash`, sum any duplicate `Copilot-AI-Credits:` and `Copilot-AI-Credits-<Model>:` trailers, rewrite each as a single line at the position of its first occurrence, NOT add a fresh trailer from the tracking file, and NOT reset the tracking file.

Amend / reword / edit (`$2 == commit`) and merge (`$2 == merge`) are already correctly handled by the current short-circuit — no change. Fixup is handled implicitly: git discards the fixup commit's message before the hook runs, so the fixup's own contribution stays in the tracking file and flushes on the next normal commit.

## Context (from discovery)

- **`src/trackingFile.ts:60-78`** — the only places decoration is added at trailer-write time:
  - `const tilde = stats.mode === 'files' ? '~' : '';`
  - `TR_Copilot-AI-Credits` value: `${tilde}${stats.totalAiCredits.toFixed(2)}`
  - per-model trailer value: `${e.name}=${tilde}${e.credits.toFixed(2)}`
  - `TR_Copilot-Est-Cost` value: `$${(totalAiCredits / 100).toFixed(2)}`

  Note: no `AIC` suffix exists in trailer output (that suffix is added only by `amountFormatter.ts` for editor surfaces). Only `~` and `$` need stripping.
- **`src/commitHook.ts:10-27`** — the embedded `HOOK_SCRIPT` template literal. The line `case "$COMMIT_SOURCE" in merge|squash|commit) exit 0 ;; esac` includes `squash`, which is the gap. After that line, the script greps `TR_` lines from the tracking file, appends them as trailers via `sed`, then truncates the tracking file. **Decision:** keep the script embedded; export the constant for tests so the test suite can write it to a tmp file and exec via `child_process.execFileSync('sh', [hookPath, msgFile, source], …)`. No `.sh` extraction, no esbuild changes.
- **`src/amountFormatter.ts`** — editor-surface formatter (status bar, tooltip, panel). Unchanged. The trailer path does not use this helper.
- **`src/trackingFile.test.ts`** — uses a `sampleStats` fixture with `mode: 'files'`; existing tilde/AIC assertions flip to bare-number.
- **`src/commitHook.test.ts`** — tests install/uninstall lifecycle, not runtime script behaviour. New `src/hook-script.test.ts` covers runtime behaviour via tmp-file exec.
- **`CLAUDE.md` lines 9, 45, 48, 51** — four spots that describe tilde-in-trailer. All flip to "bare number".
- **`CHANGELOG.md`** — current 2.0.0 entry (dated 2026-05-21) explicitly advertised `~` in the trailer. Since the branch hasn't shipped, we amend the 2.0.0 entry in place: remove tilde-in-trailer claims, add a Changed/Fixed sub-entry describing squash-sum.
- **`package.json`** — stays at `2.0.0`. No bump.
- **Trade-off accepted:** trailer matching is a free-form line match, not strict git-style trailer-block parsing. Squashed commit messages have trailer lines scattered between original subjects/bodies — they are NOT in a single trailing block — so git's strict parser wouldn't find them. Free-form match catches them all. False-positive risk: a commit body line that literally reads `Copilot-AI-Credits: 1234` would be summed. Rare and specific enough that we accept it. Pinned by a test case.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task** — no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change

## Testing Strategy

- **unit tests**: required for every task. `trackingFile.test.ts` covers the writer-side decoration change.
- **hook script behavior**: tested via `child_process.execFileSync('sh', [scriptPath, msgFile, source])` in a temp dir. New test file `src/hook-script.test.ts` imports the exported `HOOK_SCRIPT` from `commitHook.ts`, writes it to a tmp file with `chmod +x`, and runs it against fixture commit-message files.
- **e2e tests**: project has no UI-based e2e harness; n/a.
- The squash-sum awk gets table-driven cases for: zero duplicates, two same-name duplicates, three-way sum, mixed total + per-model, same-model multi-occurrence, whitespace variation, non-matching body text containing the trailer name in prose, empty message, no-trailer message.

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): all code, test, and doc changes in this repo.
- **Post-Completion** (no checkboxes): manual verification scenarios in a sandbox repo.

## Implementation Steps

### Task 1: Strip `~` and `$` from tracking-file `TR_` lines

**Files:**
- Modify: `src/trackingFile.ts`
- Modify: `src/trackingFile.test.ts`

- [x] In `src/trackingFile.ts`, in the `writeTrackingFile` block that emits `TR_` lines (the `if (stats.totalAiCredits > 0)` body): delete the `tilde` const and all `${tilde}` interpolations. `TR_Copilot-AI-Credits` value becomes `${stats.totalAiCredits.toFixed(2)}`; per-model trailer values become `${e.credits.toFixed(2)}` (two-decimal bare numbers)
- [x] In the same block, remove the `$` prefix from the `estimatedCost` trailer value. New form: `TR_<estimatedCost>=${(stats.totalAiCredits / 100).toFixed(2)}`
- [x] Replace the multi-line tilde explanation comment (the block immediately before `const tilde = …`) with a brief one-liner: `// Trailer values are bare numbers; decoration is editor-surface-only (see amountFormatter.ts).`
- [x] Update `src/trackingFile.test.ts`: flip existing `TR_Copilot-AI-Credits` assertions to expect `42.31` (no `~`); add a parallel test with `mode: 'telemetry'` asserting the same bare-number output so future readers see that mode no longer affects trailer value
- [x] Add a test asserting `TR_<estimatedCost>=0.42` (no `$`) when the `estimatedCost` config is enabled
- [x] Add a test asserting the per-model trailer is `Model A=12.50,Model B=8.20` (no `~` either side of `=`)
- [x] Run tests: `npm test -- trackingFile` — must pass before next task

### Task 2: Add squash-sum to the hook script + behavioural tests

**Files:**
- Modify: `src/commitHook.ts`
- Create: `src/hook-script.test.ts`

- [x] In `src/commitHook.ts`, change `const HOOK_SCRIPT = …` to `export const HOOK_SCRIPT = …` so tests can write it to a tmp file
- [x] Replace `case "$COMMIT_SOURCE" in merge|squash|commit) exit 0 ;; esac` with:
  ```sh
  case "$COMMIT_SOURCE" in
    merge|commit) exit 0 ;;
    squash) squash_sum_trailers "$COMMIT_MSG_FILE"; exit 0 ;;
  esac
  ```
- [x] Add a `squash_sum_trailers()` shell function (defined before the case statement) using the two-pass awk template in Technical Details. Atomic write via `mktemp` + `mv`. POSIX-portable form: `mktemp "${TMPDIR:-/tmp}/copilot-budget.XXXXXX"`. Failure to create tmp file → `exit 0` (never block a commit on bookkeeping failure)
- [x] Create `src/hook-script.test.ts`:
  - per-test `tmpDir` via `fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hook-'))`
  - suite setup writes `HOOK_SCRIPT` to `${tmpDir}/prepare-commit-msg` and `chmod +x`
  - per-test setup creates `${tmpDir}/.git/` (mkdir -p was insufficient: `git rev-parse --git-dir` validates GIT_DIR even when the env var is set, so the setup also writes `HEAD` and creates `objects/` + `refs/` to satisfy the validator)
  - **Required env contract for every `runHook` call**: `GIT_DIR=${tmpDir}/.git` set on the spawned process. With the minimum scaffolding above in place, `git rev-parse --git-dir` echoes the env value, so the non-squash path resolves the tracking file correctly without a real repo. Pinned in the helper signature
  - helper `runHook(msgContent, source, { trackingFile? })` writes optional tracking-file content to `${tmpDir}/.git/copilot-budget`, invokes `execFileSync('sh', [hookPath, msgFile, source], { env: { ...process.env, GIT_DIR: gitDir } })`, returns `{ message: <new msg file content>, tracking: <tracking file content or null if absent> }`
- [x] **Squash test cases**:
  - [x] two identical totals: `Copilot-AI-Credits: 10.00\n\nCopilot-AI-Credits: 5.00` → exactly one `Copilot-AI-Credits: 15.00` at the position of the first occurrence
  - [x] three-way sum: 10.00 + 5.00 + 3.50 → 18.50
  - [x] mixed total + per-model: two `Copilot-AI-Credits: 10.00` AND two `Copilot-AI-Credits-Claude-Sonnet-4-6: 8.00` → one of each, summed (20.00 and 16.00)
  - [x] same-model multi-occurrence: three `Copilot-AI-Credits-GPT-4o: 4.00` lines → one `Copilot-AI-Credits-GPT-4o: 12.00`
  - [x] whitespace variation: `Copilot-AI-Credits:  10.00` (two spaces after colon) and `Copilot-AI-Credits: 10.00 ` (trailing space) both sum correctly
  - [x] body text containing the pattern: a commit body line `Copilot-AI-Credits: 9999` is summed in — assert the behaviour with an inline comment noting the documented accepted trade-off
  - [x] no Copilot trailers in message → message unchanged byte-for-byte
  - [x] empty message → empty output
  - [x] tracking file present but `$2 == squash` → tracking file NOT truncated, no fresh trailer appended from tracking file
- [x] **Non-squash regression cases**:
  - [x] `$2 == ""` (normal commit) with tracking file containing `TR_Copilot-AI-Credits=12.50` → message gets `Copilot-AI-Credits: 12.50` appended, tracking file truncated to 0 bytes
  - [x] `$2 == "commit"` (amend) → message unchanged, tracking file untouched
  - [x] `$2 == "merge"` → message unchanged, tracking file untouched
  - [x] no tracking file + `$2 == ""` → message unchanged
- [x] Run tests: `npm test -- hook-script` and `npm test -- commitHook` — must pass before next task

### Task 3: Update CLAUDE.md to reflect bare-number trailers + squash-sum

**Files:**
- Modify: `CLAUDE.md`

- [x] **Line 9** (Two-mode design paragraph): replace "Cost displays carry a `~` prefix end-to-end (status bar, tooltip, panel, `Copilot-AI-Credits` trailer) so the upper-bound signal travels with the number." with "Editor surfaces (status bar, tooltip, panel) carry a `~` prefix in Files mode to flag the upper-bound estimate. The tracking file's `TR_` lines and the resulting commit trailers carry bare numeric values regardless of mode — decoration is editor-only."
- [x] **Line 45** (`amountFormatter.ts` section): append a clarifier sentence: "Used by editor surfaces only — the trailer writer in `trackingFile.ts` formats numbers directly without this helper."
- [x] **Line 48** (`trackingFile.ts` section): replace "In Files mode the `TR_Copilot-AI-Credits` value (and per-model `TR_Copilot-AI-Credits-<Model>` values) carry a leading `~` so the tilde signal reaches the commit trailer; the `_COST_AIC` machine-readable keys stay unprefixed." with "All `TR_` trailer values are bare two-decimal numbers (no `~`, no `$`) — the trailer name conveys the unit. The `_COST_AIC` machine-readable keys stay unprefixed as before."
- [x] **Line 51** (`commitHook.ts` section): replace the example "`TR_Copilot-AI-Credits=~42` becomes `Copilot-AI-Credits: ~42` in Files mode, or `Copilot-AI-Credits: 42` in Telemetry mode" with "`TR_Copilot-AI-Credits=42.31` becomes `Copilot-AI-Credits: 42.31` (mode-independent)". Also scope the existing trailing sentence "Resets the tracking file after appending." to "Resets the tracking file after appending (non-squash path only)." so the squash branch's non-reset semantics are explicit. Append: "On `$2 == squash` the hook sums duplicate `Copilot-AI-Credits` and `Copilot-AI-Credits-<Model>` trailers already present in the in-progress squash message — it does NOT consult the tracking file or reset it."
- [x] Run lint + tests: `npm run lint && npm test`

### Task 4: Amend the 2.0.0 CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [x] In the existing 2.0.0 entry, **edit the headline paragraph** (currently at the top of the section, mentions "cost displays carry a `~` prefix end-to-end ... including into the `Copilot-AI-Credits` git trailer"): remove "including into the `Copilot-AI-Credits` git trailer" and clarify that the tilde is editor-only. Reword roughly as: "… and cost displays carry a `~` prefix in editor surfaces (status bar, tooltip, panel) so the upper-bound signal travels with the number. Commit trailers and the tracking-file `TR_` lines carry bare numeric values regardless of mode."
- [x] **Edit the "Files mode tilde signal" Added entry** to remove the trailer claim. Reword roughly as: "Status bar, tooltip, and panel carry a leading `~` when the value comes from JSONL (Files mode). The trailer and the tracking file's `TR_` lines stay bare numbers so they remain unambiguous to downstream tooling."
- [x] **Remove the Breaking bullet at `CHANGELOG.md:36`** that reads "Files mode AIC trailer values now carry a leading `~`. Downstream parsers that expect a bare number after `Copilot-AI-Credits:` must strip the optional `~`. Telemetry mode trailers are unchanged." — that bullet contradicts the rewritten Added entries above and would leave the CHANGELOG internally inconsistent. The other Breaking bullets (minimum VS Code version, panel/showStats) stay
- [x] **Add a new "Added" bullet for the squash-sum behaviour**, e.g.: "Squash sums trailers — `git rebase -i` with `squash`/`fixup` lines now leaves one `Copilot-AI-Credits:` trailer per name in the resulting commit (sum of the originals), instead of N duplicates."
- [x] Verify the rest of the 2.0.0 entry (Currency toggle, OTel toggle, Mode-swap signal, Cache-hit heuristic removed, etc.) is unchanged
- [x] No tests for CHANGELOG edits
- [x] Run `npm run compile` and verify the bundle builds cleanly

### Task 5: Verify acceptance criteria

- [ ] Confirm `writeTrackingFile` emits bare-number trailer values in both Files and Telemetry modes (no `~`, no `$`)
- [ ] Confirm `squash_sum_trailers` correctly merges duplicates without touching unrelated lines
- [ ] Confirm amend/reword/edit/merge still preserve the existing trailer untouched (regression)
- [ ] Confirm fixup leaves the tracking file accumulating (manual sandbox test in Post-Completion)
- [ ] Confirm the hook script is POSIX-portable: run `sh -n` on a written copy as a minimum gate; if `shellcheck` is available, also run `shellcheck -s sh <hookPath>`
- [ ] Run full test suite: `npm test`
- [ ] Run lint: `npm run lint`
- [ ] Build: `npm run compile`

### Task 6: [Final] Mark complete

- [ ] Move this plan to `docs/plans/completed/20260521-rebase-squash-trailers.md`
- [ ] Confirm CLAUDE.md and CHANGELOG edits match the final code

## Technical Details

### Trailer value format (before → after)

| Trailer | Before (Files / Telemetry) | After (both modes) |
|---|---|---|
| `Copilot-AI-Credits` | `~42.31` / `42.31` | `42.31` |
| `Copilot-AI-Credits-<Model>` | `Model A=~12.50,Model B=~8.20` / `Model A=12.50,Model B=8.20` | `Model A=12.50,Model B=8.20` |
| `Copilot-Est-Cost` (opt-in USD) | `$0.42` / `$0.42` | `0.42` |

### Hook script structure (after)

```sh
#!/bin/sh
# Copilot Budget prepare-commit-msg hook
COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"

squash_sum_trailers() {
  msg_file="$1"
  tmp="$(mktemp "${TMPDIR:-/tmp}/copilot-budget.XXXXXX")" || exit 0
  awk '
    # Pass 1: scan the message, sum trailer values by name.
    NR == FNR {
      if ($0 ~ /^Copilot-AI-Credits(-[A-Za-z0-9._-]+)?:[ \t]*[0-9]+(\.[0-9]+)?[ \t]*$/) {
        colon = index($0, ":")
        name = substr($0, 1, colon - 1)
        val  = substr($0, colon + 1)
        sub(/^[ \t]+/, "", val)
        sub(/[ \t]+$/, "", val)
        sums[name] += val + 0
      }
      next
    }
    # Pass 2: emit non-trailer lines verbatim; emit each summed trailer
    # once at the position of its first occurrence; drop subsequent dupes.
    {
      if ($0 ~ /^Copilot-AI-Credits(-[A-Za-z0-9._-]+)?:[ \t]*[0-9]+(\.[0-9]+)?[ \t]*$/) {
        colon = index($0, ":")
        name  = substr($0, 1, colon - 1)
        if (!(name in printed)) {
          printf "%s: %.2f\n", name, sums[name]
          printed[name] = 1
        }
        next
      }
      print
    }
  ' "$msg_file" "$msg_file" > "$tmp" && mv "$tmp" "$msg_file"
}

case "$COMMIT_SOURCE" in
  merge|commit) exit 0 ;;
  squash) squash_sum_trailers "$COMMIT_MSG_FILE"; exit 0 ;;
esac

GIT_DIR="$(git rev-parse --git-dir)"
TRACKING_FILE="$GIT_DIR/copilot-budget"
[ -f "$TRACKING_FILE" ] || exit 0

TR_LINES=$(grep '^TR_' "$TRACKING_FILE") || true
case "$TR_LINES" in '') exit 0 ;; esac

{
  printf '\n\n'
  echo "$TR_LINES" | sed 's/^TR_\([^=]*\)=/\1: /'
} >> "$COMMIT_MSG_FILE" && : > "$TRACKING_FILE"
```

### Why two-pass awk?

In-order first-occurrence emission requires knowing the total sum *before* emitting the first occurrence. Single-pass with a deferred-write buffer is possible but adds bookkeeping. Two-pass keeps each pass linear and obvious: pass 1 collects sums, pass 2 walks the file again and rewrites. `NR == FNR` (true only during the first file) is a POSIX-portable idiom.

### Awk regex notes

- `[A-Za-z0-9._-]` matches model-name segments like `Claude-Sonnet-4-6`, `GPT-4o`, `gpt-4.1`. Underscore is included because `sanitizeModelName` replaces non-alphanumerics with underscores.
- `[ \t]*` handles arbitrary whitespace between colon and value, and trailing whitespace.
- Anchored `^…$` matches the WHOLE line — we deliberately do NOT match lines with extra text after the value.
- No `~?` in the regex: we don't support legacy values because the branch hasn't shipped a `~`-in-trailer release.

### False-positive trade-off

Free-form line matching could incorrectly sum a commit body line that literally reads `Copilot-AI-Credits: 1234`. We accept this because:

1. The format is specific enough that accidental matches are rare.
2. Squashed commit messages do NOT have a clean trailing trailer block — original trailers are scattered throughout the message, so strict git-trailer-block parsing would miss them.
3. Implementing git's exact trailer-parsing rules in awk would significantly increase complexity for marginal benefit.

A test case pins this behaviour so it doesn't drift silently.

### `mktemp` portability

`mktemp "${TMPDIR:-/tmp}/copilot-budget.XXXXXX"` works on macOS/BSD and GNU. `|| exit 0` instead of `|| exit 1` because the hook should never block a commit on its own bookkeeping failure — if we can't write the tmp file, we leave the message untouched.

## Post-Completion

**Manual verification** (sandbox repo):

1. Make 3 sequential commits, each preceded by manually writing `<gitdir>/copilot-budget` with a `TR_Copilot-AI-Credits=…` value. Confirm each commit gets one trailer with the correct bare-number value (no `~`, no `$`).
2. `git rebase -i HEAD~3`, mark commits 2 and 3 as `squash`. Confirm the resulting commit body contains exactly one `Copilot-AI-Credits:` trailer with the sum of all three values, at the position of the first occurrence.
3. Enable `copilot-budget.aiCreditsPerModel`. Repeat step 1 with per-model trailers and confirm per-model values also sum correctly under squash.
4. Test fixup: `git rebase -i HEAD~2`, mark the second commit as `fixup`. Confirm the original commit's trailer is preserved verbatim (git discarded the fixup's message). Any new Copilot usage during the rebase stays in the tracking file for the next normal commit.
5. Test reword: `git rebase -i HEAD~1`, mark `reword`, change the subject. Confirm the trailer is preserved unchanged and the tracking file is NOT reset.

**External system updates**: none.
