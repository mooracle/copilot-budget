# AIC-native display (drop USD as primary unit)

## Overview

Make AI Credits (AIC) the sole cost unit anywhere in the extension's code and user-facing surfaces. USD survives only as an opt-in commit trailer (`Copilot-Est-Cost`, off by default).

GitHub Copilot's post-2026-06-01 billing is plan-independent and AIC-denominated (1 AIC = $0.01 is a fixed structural identity). Plan-detection code was already deleted in commit `3472ad2`. With pricing direct and identical across plans, USD adds no information beyond AIC — it's redundant display surface.

This change:
- Converts USD → AIC at rate-card load time, so `computeCost()` returns AIC directly. The rate-card YAML on disk stays USD (byte-identical mirror of upstream — `data/models-and-pricing.yml` is untouched).
- Renames `ModelStats.costUsd` → `costAic` and removes `TrackingStats.totalCostUsd`.
- Drops USD from status bar text, tooltip, quick pick, diagnostics output, and tracking-file keys.
- Flips `commitHook.trailers.estimatedCost` default from `"Copilot-Est-Cost"` to `false`. The USD trailer is still available as an opt-in; when enabled, USD is computed inline from AIC at trailer-write time.
- Status bar shows integer AIC with a ceil-rule (`Math.ceil` for any non-zero amount; `0 AIC` only when truly zero) and no "Est" suffix.

Out of scope: status-bar USD opt-in, per-model USD anywhere user-facing, quota/balance UI, any change to `data/models-and-pricing.yml` or `scripts/update-rates.sh`, backwards-compat shims beyond the legacy-tracking-file tolerance in Task 3.

## Context (from discovery)

Version: `0.6.0` (CHANGELOG already has a `## [0.6.0] - 2026-05-14` entry; that release has not shipped to the marketplace yet, so this work amends the existing 0.6.0 entry rather than adding a new version).

Files involved (verified against current source 2026-05-14):

- `src/tokenRates.ts` — loads `dist/models-and-pricing.yml`, exports `getRateCard`, `computeCost`, `getDisplayName`, `getAllRates`. `computeCost` currently returns USD; JSDoc at lines 173-177 says "Compute USD cost".
- `src/tracker.ts` — `ModelStats.costUsd` (line 13), `TrackingStats.totalCostUsd` (line 22), aggregation loop (lines 326-345), change-detection comparator (line 373), `totalAiCredits: totalCostUsd * 100` (line 344), `RestoredStats` type, zero-stats default block (lines 430-431).
- `src/statusBar.ts` — `formatUsdShort`, `formatUsdLong`, `formatAic`, status-bar text `$X.XX Est` (line 67), tooltip rendering both USD and AIC per model, quick pick total + per-model rows showing both.
- `src/statusBar.test.ts` — exists (~307 lines, 13 cases); USD-heavy: fixtures use `costUsd` / `totalCostUsd`, assertions expect `$0.02`/`$0.0173`/`$1.23` style text and tooltip content.
- `src/trackingFile.ts` — writes `TOTAL_COST_USD` (line 36), per-model `_COST_USD` (line 50), TR_-line gate `if (stats.totalCostUsd > 0)` (line 56), `TR_Copilot-Est-Cost=$...` (line 59), per-model trailer derivation `usage.costUsd * 100` (line 66), parse regex includes `COST_USD` (line 84), `emptyRestoredModel.costUsd = 0` (line 92), `TOTAL_COST_USD` check (line 125), per-model `COST_USD` branch (lines 141-143).
- `src/trackingFile.test.ts` — fixtures + parse tests reference `TOTAL_COST_USD` / `_COST_USD`.
- `src/config.ts` — `TrailerConfig` interface; defaults `estimatedCost: "Copilot-Est-Cost"` (line 33), `aiCredits: "Copilot-AI-Credits"`, `aiCreditsPerModel: false`.
- `src/extension.ts:189-190` — diagnostics output prints `Total cost: $...` and `AI Credits: ...`.
- `src/extension.test.ts` — `SAMPLE_STATS` fixture at line 93 has `costUsd: 0.01` + `totalCostUsd: 0.01` (line 98), another `costUsd: 0` at line 484, diagnostics assertion `'  Total cost: $0.0100'` at line 574.
- `package.json` — `contributes.configuration` defaults for the three trailer settings.
- `README.md` — references USD on lines ~7, 8, 9, 21, 40, 46, 48, 109, 118, 152. Lines 109 and 118 show `Copilot-Est-Cost: $0.42`-style example commit-message blocks.
- `CHANGELOG.md` — has existing `## [0.6.0] - 2026-05-14` entry (unreleased; amend in place).
- `CLAUDE.md` — module summaries reference both units.

Patterns reused:
- `sanitizeModelName` from `src/utils.ts` for `MODEL_*` keys.
- `TR_<name>=value` protocol → POSIX hook converts to git trailers via sed (no hook changes needed).
- Jest tests alongside source files; `vscode` mocked via `src/__mocks__/vscode.ts`.

## Development Approach

- **Testing approach**: Regular (code first, tests after) — matches existing codebase pattern (`docs/plans/completed/20260514-aic-token-cost-tracking.md`).
- Complete each task fully before moving to the next.
- Make small, focused changes; run `npm test` after each task.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** — no exceptions.
- **CRITICAL: update this plan file when scope changes during implementation**.

### Compile-state strategy

Tasks 2 and 3 are interdependent (`ModelStats.costUsd` is read across `tracker.ts`, `statusBar.ts`, `trackingFile.ts`, `extension.ts`, and their test files). To keep the build green between task boundaries, **Task 2 is a single atomic type-rename pass** that updates *every* read/write site in source AND test files. Subsequent tasks (3–6) then make semantic changes to one surface at a time without touching types.

## Testing Strategy

- **Unit tests**: required for every task (alongside source files, `*.test.ts`).
- **No e2e tests**: this extension has no Playwright/Cypress suite; UI verification happens manually in the Extension Development Host (F5) and lives under Post-Completion.
- For the status-bar ceil-rule: explicit table-driven cases at `0`, `1e-6`, `0.0001`, `0.4`, `0.5`, `1.0`, `14.5`, `15.0`, negative — including the `1e-6 → 1 AIC` boundary that motivates ceil over round.
- For tracking-file parse: feed legacy 0.6.x content (with `TOTAL_COST_USD` + `_COST_USD` keys) and assert tokens restore, cost keys are ignored, AIC restored from `TOTAL_AI_CREDITS`; follow up with a tracker scan and assert `totalAiCredits` ends at the freshly recomputed value (not 0, not double-counted).
- For trailers: assert `Copilot-Est-Cost` line is absent under default config; present only when explicitly enabled.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]`): code, types, tests, in-repo doc updates.
- **Post-Completion** (no checkboxes): manual smoke in Extension Development Host, marketplace publish (part of the future 0.6.0 release, not this PR).

## Implementation Steps

### Task 1: Convert rate card USD → AIC at load time

**Files:**
- Modify: `src/tokenRates.ts`
- Modify: `src/tokenRates.test.ts` (if present — create if not)

- [x] In `loadRateCard()` inside `src/tokenRates.ts`, multiply each parsed rate field (`input`, `cachedInput`, `output`, and `cacheCreation` when present) by 100 so the stored `RateCard` values are AIC per 1M tokens. Do NOT modify `data/models-and-pricing.yml`.
- [x] Update the `RateCard` interface JSDoc/comment to state fields are "AIC per 1M tokens".
- [x] Update the JSDoc on `computeCost` (currently "Compute USD cost for a model invocation") to say "Compute AIC cost for a model invocation".
- [x] `computeCost(modelId, tokens)` body returns AIC directly (math unchanged; only the units of the multipliers shifted — verify the function does NOT multiply by 100 itself, since the rate fields already carry the conversion).
- [x] If `tokenRates.test.ts` exists, update expected values × 100. If absent, add a minimal test exercising `computeCost()` for one known model and asserting the AIC result.
- [x] run `npm test` — must pass before next task.

### Task 2: Atomic type-rename pass — `costUsd` → `costAic`, drop `totalCostUsd`

This task touches every file that reads/writes the renamed fields, including test fixtures, so the build stays green for Tasks 3–6 to make per-surface semantic changes.

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/tracker.test.ts`
- Modify: `src/trackingFile.ts`
- Modify: `src/trackingFile.test.ts`
- Modify: `src/statusBar.ts`
- Modify: `src/statusBar.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

- [x] `src/tracker.ts`: rename `ModelStats.costUsd` → `ModelStats.costAic` on the interface and at every read/write site. Remove `TrackingStats.totalCostUsd` from the interface. In the aggregation loop (lines 326-345), accumulate into `costAic` directly from `computeCost()` and sum into `totalAiCredits` (drop the `* 100` derivation — already baked in by Task 1). Update change-detection comparator (line 373) to compare `totalAiCredits` instead of `totalCostUsd`. Update `RestoredStats` type. Update zero-stats default block (lines 430-431).
- [x] `src/trackingFile.ts`: rename `usage.costUsd` reads to `usage.costAic` at the write site (line 50), the trailer-emit USD inline derivation (line 59), the per-model trailer derivation (line 66). Change the `if (stats.totalCostUsd > 0)` gate (line 56) to `if (stats.totalAiCredits > 0)`. Change `emptyRestoredModel.costUsd: 0` (line 92) to `costAic: 0`. Change the per-model parse branch (lines 141-143) to write into `entry.costAic` for both legacy `_COST_USD` keys (kept for now, removed in Task 3) and any new `_COST_AIC` keys. Note: Task 2 keeps the file's schema-write/parse logic literally USD-named — only the in-memory type names change. Task 3 then changes the schema.
- [x] `src/statusBar.ts`: rename every `costUsd`/`totalCostUsd` read to `costAic`/`totalAiCredits`. Keep the existing `$X.XX Est` formatting intact for now — Task 5 changes the display logic.
- [x] `src/extension.ts`: rename any reads on `ModelStats`/`TrackingStats`. The diagnostics line (lines 189-190) keeps its current "Total cost: $..." text for now, derived as `(stats.totalAiCredits / 100).toFixed(4)` to preserve the existing assertion behavior — Task 6 removes the line entirely.
- [x] `src/tracker.test.ts`: rename `costUsd` → `costAic` in every fixture and assertion. Drop `totalCostUsd` from fixtures and assertions. Where tests hard-code expected values, multiply by 100 (since rate card now emits AIC). Spot-check lines 116, 152, 231-233, 262, 301, 341, 376, 436-438, 502, 540, 544, 558, 563, 566, 673, 687, 692, 695, 898 — verify each updates correctly.
- [x] `src/trackingFile.test.ts`: rename fixtures' `costUsd` → `costAic`, drop `totalCostUsd` from `TrackingStats` fixtures. Keep file-content assertions (`TOTAL_COST_USD=...`, `_COST_USD=...`) intact — Task 3 changes those.
- [x] `src/statusBar.test.ts`: rename `costUsd` → `costAic`, drop `totalCostUsd` from `makeStats` helper and every call site (lines 23, 30, 35, 111, 163, 169, 272). Keep the `$0.02` / `$0.0173` / `$1.23` text-format assertions — Task 5 rewrites those.
- [x] `src/extension.test.ts`: rename `costUsd: 0.01` (line 93) → `costAic: 1.00`, replace `totalCostUsd: 0.01` (line 98) with `totalAiCredits: 1.00`. Update `costUsd: 0` (line 484) → `costAic: 0`. Keep the `'  Total cost: $0.0100'` assertion at line 574 — Task 6 removes it.
- [x] run `npm test` — all assertions still pass with renamed-but-otherwise-unchanged behavior; build is green.

### Task 3: Drop USD from tracking-file schema

**Files:**
- Modify: `src/trackingFile.ts`
- Modify: `src/trackingFile.test.ts`

- [ ] `writeTrackingFile()`: remove the `TOTAL_COST_USD=` line (was line 36). Rename per-model `MODEL_<x>_COST_USD=` key to `MODEL_<x>_COST_AIC=` (was line 50). Keep `TOTAL_AI_CREDITS=` and `*_TOKENS` keys unchanged.
- [ ] `parseTrackingFileContent()`:
  - Change `MODEL_KEY_PATTERN` regex (line 84) to accept `COST_AIC` instead of `COST_USD`. Files written with legacy `_COST_USD` keys no longer match the per-model regex — those lines fall through to the silent-ignore branch, which is the desired tolerance behavior.
  - Remove the `key === 'TOTAL_COST_USD'` arm of the conditional at line 125. The remaining `TOTAL_AI_CREDITS` arm stays.
  - Update the per-model field branch (was lines 141-143) to handle `COST_AIC` and write into `entry.costAic`.
  - Update the validity gate to require `SINCE` + `TOTAL_AI_CREDITS` only (drop any requirement on `TOTAL_COST_USD`).
- [ ] `trackingFile.test.ts`:
  - Update written-file assertions: no `TOTAL_COST_USD` line; per-model line uses `_COST_AIC` with appropriate AIC value (was USD × 100).
  - Add a legacy-tolerance parse test: feed a string containing `SINCE=...`, `TOTAL_AI_CREDITS=15.30`, `TOTAL_COST_USD=0.1530`, and per-model `_COST_USD` keys plus `_TOKENS` keys. Assert: restored `totalAiCredits === 15.30`, token counts restored correctly, restored per-model `costAic === 0` (no per-model cost restored since legacy keys are silently dropped).
  - Add a follow-up assertion to that legacy test: pass the restored stats through a tracker scan with a freshly parsed session JSONL and verify `totalAiCredits` ends at the freshly recomputed value (not 0, not the legacy value, and not double-counted).
- [ ] run `npm test` — must pass before next task.

### Task 4: Flip `estimatedCost` trailer to opt-in

**Files:**
- Modify: `src/config.ts`
- Modify: `package.json` (`contributes.configuration` defaults)
- Modify: `src/trackingFile.ts` (USD inline derivation site)
- Modify: `src/trackingFile.test.ts`

- [ ] `src/config.ts` line 33: change the `commitHook.trailers.estimatedCost` default from `'Copilot-Est-Cost'` to `false` in the `getTrailerConfig()` call. Leave `aiCredits` and `aiCreditsPerModel` defaults unchanged.
- [ ] `package.json` `contributes.configuration`: change the default for `copilot-budget.commitHook.trailers.estimatedCost` to `false`. Update the setting's `description` to note it's an opt-in trailer for users who want USD in commit history.
- [ ] `src/trackingFile.ts` trailer-emit block: when `trailers.estimatedCost` is enabled, compute `usd = stats.totalAiCredits / 100` inline and emit `TR_<name>=$<usd-with-2dp>`. Do NOT reintroduce a `costUsd` field anywhere. (After Task 2, this site already reads `totalAiCredits`; this task confirms the inline `/ 100` derivation is in place.)
- [ ] `src/trackingFile.test.ts`: assert `Copilot-Est-Cost` line absent when config defaults active; assert it appears with the expected `$X.XX` value (computed from AIC ÷ 100) only when `estimatedCost` is explicitly set in the test config.
- [ ] run `npm test` — must pass before next task.

### Task 5: Status bar / tooltip / quick pick — AIC only

**Files:**
- Modify: `src/statusBar.ts`
- Modify: `src/statusBar.test.ts`

- [ ] Delete `formatUsdShort` and `formatUsdLong` helpers.
- [ ] Add `formatAicShort(n: number): string`: if `n <= 0` return `'0 AIC'`; else return `Math.ceil(n) + ' AIC'`.
- [ ] In `updateText()` (line 67): change item text to `'$(credit-card) ' + formatAicShort(stats.totalAiCredits)`. No "Est" suffix.
- [ ] In `buildTooltip()`: total row uses `formatAic(stats.totalAiCredits)` only (drop USD). Per-model rows show `getDisplayName(model) + ': ' + formatAic(usage.costAic)` only. Keep heuristic note.
- [ ] In `showStatsQuickPick()`: total row label becomes `'$(credit-card) Total: ' + formatAic(stats.totalAiCredits)`; drop the USD `description`. Per-model rows: `description` becomes `formatAic(usage.costAic)` only. Per-model token-breakdown `detail` line preserved unchanged.
- [ ] `src/statusBar.test.ts`: rewrite all 13 existing test cases to drop USD assertions:
  - `'sets initial text with USD cost and Est suffix'` → rename to `'sets initial text with AIC integer'`, update expected text (e.g. `'$(credit-card) 1 AIC'` for the existing 1.73 AIC fixture).
  - Empty-state cases: expect `'$(credit-card) 0 AIC'`.
  - Tooltip assertions: replace `$0.0173 (1.73 AIC)` with `1.73 AIC`; per-model rows similarly.
  - Quick pick assertions: replace `$0.0173` + `1.73 AIC` description with `1.73 AIC` description; per-model rows similarly.
  - Fires-on-change test (line 161-176): expect `'123 AIC'` text, tooltip `123.40 AIC`.
- [ ] Add table-driven test for `formatAicShort` covering `0` → `'0 AIC'`, `1e-6` → `'1 AIC'`, `0.0001` → `'1 AIC'`, `0.4` → `'1 AIC'`, `0.5` → `'1 AIC'`, `1.0` → `'1 AIC'`, `14.5` → `'15 AIC'`, `15.0` → `'15 AIC'`, negative → `'0 AIC'`.
- [ ] run `npm test` — must pass before next task.

### Task 6: Drop USD line from diagnostics output

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

- [ ] In the `showDiagnostics` command body (around `src/extension.ts:189-190`), remove the `Total cost: $...` line. Keep the `AI Credits:` line.
- [ ] `src/extension.test.ts:574`: update the assertion — replace the `expect(appendCalls).toContain('  Total cost: $0.0100')` with `expect(appendCalls).not.toContain('Total cost:')`. Keep the `AI Credits:` assertion.
- [ ] If the test's title at the `it()` mentions "USD", rename to drop USD.
- [ ] run `npm test` — must pass before next task.

### Task 7: Verify acceptance criteria

- [ ] Source-tree USD residue grep: `grep -rE "costUsd|totalCostUsd|formatUsd|COST_USD|TOTAL_COST_USD|Total cost:" src/` returns no matches.
- [ ] Test-tree USD residue grep: `grep -rE "costUsd|totalCostUsd|formatUsd|COST_USD|TOTAL_COST_USD|Total cost:" src/**/*.test.ts` returns only the legacy-tolerance fixture string inside `trackingFile.test.ts` (the literal test input that includes `TOTAL_COST_USD=` / `_COST_USD=`).
- [ ] README + CLAUDE.md USD residue: `grep -nE 'USD|\\$[0-9]|Copilot-Est-Cost' README.md CLAUDE.md` returns only intentional opt-in documentation references (the `estimatedCost` setting description).
- [ ] `data/models-and-pricing.yml` is unchanged vs. main: `git diff main -- data/models-and-pricing.yml` is empty.
- [ ] `npm run lint` clean.
- [ ] `npm test` — full suite passes.
- [ ] `npm run compile` — bundles without error.

### Task 8: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] `README.md`: replace USD examples with AIC. Specifically:
  - Lines ~7, 8, 9, 21, 40, 46, 48 (intro / feature blurb): swap `$X.XX Est` → `N AIC`.
  - Line ~109 (default commit-message example block): show `Copilot-AI-Credits: 42.31` only. Remove the `Copilot-Est-Cost: $0.42` line from the default example.
  - Line ~118 (opt-in / per-model commit example): keep `Copilot-AI-Credits`, optionally show `Copilot-Est-Cost` as an enabled-via-settings example. Make clear it's opt-in.
  - Line ~152 (settings section): document `copilot-budget.commitHook.trailers.estimatedCost` as opt-in for users who want USD in commit history; default `false`.
- [ ] `CLAUDE.md`: update module summaries for:
  - `tokenRates.ts`: USD→AIC conversion at load time, `computeCost()` returns AIC.
  - `tracker.ts`: drop `totalCostUsd` mention; `ModelStats.costAic` is the cost field.
  - `statusBar.ts`: `formatAicShort` ceil-rule, no `formatUsd*` helpers, AIC-only surfaces.
  - `trackingFile.ts`: schema uses `TOTAL_AI_CREDITS` + `_COST_AIC`; legacy `_COST_USD` keys silently ignored on parse.
  - `config.ts`: `estimatedCost` default is `false`; AIC trailer is the primary trailer.
- [ ] `CHANGELOG.md`: amend the existing `## [0.6.0] - 2026-05-14` entry (do NOT add a new section — this work stays in the same unreleased train):
  - Under `### Changed`: "Status bar and tooltip now display AI Credits (AIC) only; USD removed from all in-extension surfaces."
  - Under `### Changed`: "`Copilot-Est-Cost` trailer default flipped from on to off; users who want USD in commit history must explicitly set `copilot-budget.commitHook.trailers.estimatedCost`."
  - If a `### Schema` or similar section exists: note that `TOTAL_COST_USD` and per-model `_COST_USD` keys are removed from the `copilot-budget` tracking file; legacy files are tolerated on parse.
- [ ] Move this plan to `docs/plans/completed/`: `mkdir -p docs/plans/completed && mv docs/plans/20260514-aic-native-display.md docs/plans/completed/`.

## Technical Details

**Unit conversion site.** The rate card YAML is the only source of truth for prices and stays USD per 1M tokens (byte-identical mirror of `github/docs:data/tables/copilot/models-and-pricing.yml`). At YAML-load time in `loadRateCard()`, we multiply by 100 once. From that moment on, every `RateCard` value in memory is AIC per 1M tokens, and `computeCost()` math is unchanged but emits AIC. This keeps unit conversion confined to a single function.

**USD opt-in semantics.** USD is no longer stored anywhere — not on `ModelStats`, not on `TrackingStats`, not in the tracking file. The opt-in `Copilot-Est-Cost` trailer is derived from `totalAiCredits / 100` at trailer-write time, formatted as `$X.XX` (2dp). Per-model USD does not exist anywhere user-facing.

**Status-bar rounding.** `formatAicShort` uses `Math.ceil` so any non-zero AIC value shows ≥1, avoiding the misleading `0 AIC` reading after small sessions. The 2dp formatter (`formatAic`) is used in tooltip, quick pick, and trailer values where precision is appropriate.

**Tracking-file backwards compatibility.** Legacy 0.6.x dev-host tracking files (written before this change) have `TOTAL_COST_USD` and `_COST_USD` keys. The new parser tolerates these by silently ignoring them (the regex no longer matches `_COST_USD` per-model keys, and the `TOTAL_COST_USD` branch is removed). `TOTAL_AI_CREDITS` and the token-count keys are sufficient to restore state. Per-model `costAic` will be `0` after restore but is repopulated on the next scan because cost is always re-derived from tokens × rate card. Pre-0.6 files (no `TOTAL_AI_CREDITS`) still return `null`. Since 0.6.0 hasn't shipped to the marketplace, this tolerance is defensive against developer dev-host runs spanning the change — not a production migration path.

**Compile-state strategy.** The type rename (`costUsd` → `costAic`, removal of `totalCostUsd`) cuts across multiple source files and their tests. Task 2 performs that rename atomically across the entire tree so no intermediate state has a broken type signature. Tasks 3–6 then make per-surface semantic changes (schema, trailer config, display formatting, diagnostics line) with the type names already settled.

## Post-Completion

*Items requiring manual intervention or external systems — informational only, no checkboxes.*

**Manual verification** (in Extension Development Host, F5):
- Status bar shows integer AIC (e.g., `$(credit-card) 15 AIC`), no `$`, no `Est` suffix.
- Tooltip shows 2dp AIC + per-model rows without `$`.
- Quick pick shows total + per-model AIC, token breakdown preserved, no `$`.
- `Show Diagnostics` command output has the `AI Credits:` line and no `Total cost:` line.
- Make a commit with the hook enabled and confirm the commit message has `Copilot-AI-Credits:` trailer only (no `Copilot-Est-Cost:`).
- Manually enable `copilot-budget.commitHook.trailers.estimatedCost = "Copilot-Est-Cost"` in settings, commit again, confirm both trailers appear (`Copilot-AI-Credits: N.NN` and `Copilot-Est-Cost: $X.XX`).

**Release**:
- This change is part of the unreleased 0.6.0 train. No separate release is cut for this PR.
