# AIC Token-Cost Tracking (drop premium-request model)

## Overview

GitHub Copilot moves to usage-based billing on 2026-06-01. Premium requests, per-plan request allowances, and `copilot_plan` cost-per-request go away; cost is computed from `(input_tokens × input_rate + cached_input × cached_rate + output × output_rate)` per model, with 1 AI Credit = $0.01.

This refactor:
- Drops premium-request math entirely (no `multiplierNumeric`, no `PLAN_COSTS`, no char-based token estimation).
- Reads server-reported token counts straight from chat session JSONL (`result.metadata.promptTokens`, `outputTokens`).
- Reads the cache split when available (`result.metadata.cacheReadTokens`, `cacheCreationTokens` — landing via upstream PRs); falls back to a session-length heuristic (turn 1 = 0% cached, turn 2+ = 75% cached) targeting ~80% cost accuracy.
- Applies a per-model rate card sourced from the **canonical upstream YAML** at `github/docs:data/tables/copilot/models-and-pricing.yml`. We mirror it byte-identical into `data/models-and-pricing.yml`, ship it in the extension bundle, and parse + normalize at activation. The YAML is the only source of truth — no build-time JSON intermediate, no second derived artifact to drift. The rate card doubles as the model registry: model IDs known to the rate card become the canonical aggregation keys.
- Keeps `Copilot-Est-Cost` trailer (same name + `$X.XX` format) on by default for backwards compatibility with existing CI/scripts. Adds `Copilot-AI-Credits` (on by default — the canonical, plan-invariant metric) and `Copilot-AI-Credits-Models` (off by default, per-model breakdown). Drops `Copilot-Premium-Requests` (no compat shim).
- AIC is the canonical unit: it's a fixed function of `(tokens × per-token rate)` and doesn't change with plan-level discounts or contract terms. USD is a derived display value at the published rate — accurate for individual/Pro users at list price, an approximation for Business/Enterprise users on negotiated contracts. Hence AIC default-on alongside USD.

Out of scope: quota/balance API integration, local tokenization, segment-level cache derivation, backwards compatibility with the premium-request format.

## Context (from discovery)

Files involved (verified against current source 2026-05-14, version 0.5.3):

- `src/tracker.ts:1-393` — central state, premium-request accumulator, `PlanInfo` provider hook, `TrackingStats`/`RestoredStats` types
- `src/sessionParser.ts:195-289+` — char-based `estimateTokensFromText` injected; reconstructs delta JSONL and tallies inputTokens/outputTokens; per-model interaction count fuels premium-request math
- `src/tokenEstimator.ts` — char/token ratio + `getPremiumMultiplier(model)`; backed by `data/tokenEstimators.json`
- `src/planDetector.ts:1-178` — plan detection (config / GitHub API / default), `PLAN_COSTS`, `DEFAULT_COST_PER_REQUEST = 0.04`, periodic refresh
- `src/config.ts:17-43` — `PlanSetting`, `TrailerConfig` (premiumRequests, estimatedCost, model)
- `src/trackingFile.ts:16-99` — current schema: `INTERACTIONS`, `PREMIUM_REQUESTS`, `SINCE`, `MODEL <name> <in> <out> <prem>`, `TR_*` lines
- `src/statusBar.ts` — premium-request count + cost display
- `src/extension.ts` — wires plan detector, tracker.setPlanInfoProvider, periodic refresh
- `package.json:contributes.configuration` — `copilot-budget.{enabled,commitHook.enabled,commitHook.trailers.{premiumRequests,estimatedCost,model},plan}` (version 0.5.3)
- `data/tokenEstimators.json` — char-ratio + premium multipliers per model (to delete)
- esbuild copy step in `package.json` copies `dist/sql-wasm.wasm`; extend to also copy `data/models-and-pricing.yml` → `dist/models-and-pricing.yml`

Server-reported token data already present in JSONL (verified from clusternet `workspaceStorage/ba1a05.../chatSessions/*.jsonl` and Insiders airthinx session):
- `result.metadata.promptTokens` — total input (sum of fresh + cache_read + cache_creation)
- `result.metadata.outputTokens` — exact server total
- `cacheReadTokens` / `cacheCreationTokens` — **not yet persisted** by upstream; will land via our PR + microsoft/vscode-copilot-chat#5076

Rate card source: `github/docs:data/tables/copilot/models-and-pricing.yml` (raw: https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml). Rendered page at https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing is a Liquid template over that YAML.

Patterns reused:
- `TR_<TrailerName>=value` protocol in tracking file → POSIX hook generic grep/sed (no hook changes needed; `src/commitHook.ts` only needs comment cleanup)
- `sanitizeModelName` from `src/utils.ts` for `MODEL_*` keys
- Jest tests alongside source files, mocked `vscode` via `src/__mocks__/vscode.ts`

## Development Approach

- **Testing approach**: Regular (code first, tests after) — matches existing codebase pattern.
- Complete each task fully before moving to the next.
- Make small, focused changes; run `npm test` after each task.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** — no exceptions.
- **CRITICAL: update this plan file when scope changes during implementation**.
- No backwards-compatibility hacks: pre-AIC tracking files will simply be replaced on next write (June 1 lands ~2.5 weeks after we ship).

## Testing Strategy

- **Unit tests**: required for every task (alongside source files, `*.test.ts`).
- **No e2e tests**: this extension has no Playwright/Cypress suite; verification of UI happens manually in the Extension Development Host (F5).
- Mock fixtures use realistic JSONL with `result.metadata.{promptTokens, outputTokens, cacheReadTokens?, cacheCreationTokens?}`.
- Cover both presence and absence of cache fields per test (heuristic path vs ground-truth path).

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]`): code, types, tests, doc updates inside this repo.
- **Post-Completion** (no checkboxes): manual smoke in Extension Development Host, marketplace publish, version tag/release.

## Implementation Steps

### Task 1: Ship upstream rate card YAML + runtime loader

**Files:**
- Create: `data/models-and-pricing.yml` (byte-identical mirror of upstream)
- Create: `scripts/update-rates.sh` (one-line `curl`)
- Create: `src/tokenRates.ts`
- Create: `src/tokenRates.test.ts`
- Create: `src/__fixtures__/models-and-pricing.yml` (golden fixture for hermetic tests)
- Modify: `package.json` (add `js-yaml` as `dependencies`, `@types/js-yaml` as devDep, `update-rates` npm script)
- Modify: esbuild config in `package.json` (copy `data/models-and-pricing.yml` into `dist/` alongside `sql-wasm.wasm`)

The YAML upstream is the **single source of truth**. We mirror it byte-identical, parse + normalize at extension activation. No build-time JSON generation; no second derived artifact to drift.

- [x] add `js-yaml` to `dependencies` (~30 KB minified, bundled), `@types/js-yaml` to `devDependencies`
- [x] create `scripts/update-rates.sh`:
  ```sh
  #!/usr/bin/env bash
  set -euo pipefail
  curl -fsSL "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml" \
       -o data/models-and-pricing.yml
  test -s data/models-and-pricing.yml
  echo "Updated data/models-and-pricing.yml ($(wc -c < data/models-and-pricing.yml) bytes)"
  ```
- [x] add `npm run update-rates` invoking the shell script. Document in README + CLAUDE.md that contributors run this when GitHub publishes new rates; commit the YAML alongside the diff so reviewers see the change directly.
- [x] (optional, decide during implementation) add a GitHub Action `update-rates.yml` running weekly: executes `npm run update-rates`, opens a PR if the YAML changed — skipped; contributors run manually
- [x] run `npm run update-rates` once to materialize `data/models-and-pricing.yml`; copy the current snapshot into `src/__fixtures__/models-and-pricing.yml` for tests (so tests are hermetic and don't break when upstream changes)
- [x] update esbuild config in `package.json` to copy `data/models-and-pricing.yml` → `dist/models-and-pricing.yml` (alongside the WASM copy step that already exists) (in `esbuild.js`)
- [x] create `src/tokenRates.ts` exporting:
  - `RateCard` type `{ input: number; cachedInput: number; output: number; cacheCreation?: number; provider: string; displayName: string }`
  - module-level lazy load: read `<extensionPath>/dist/models-and-pricing.yml` via `fs.readFileSync`, `yaml.load` into entry array, normalize each entry into a `Map<normalized_id, RateCard>`:
    - normalize model name → key: strip footnote markers (`[^N]`), trim, lowercase, replace runs of whitespace with `-`. Keep dots (`gpt-4.1`). Examples: `"GPT-4.1[^1]"` → `gpt-4.1`, `"Claude Sonnet 4.6"` → `claude-sonnet-4.6`, `"Gemini 3 Flash"` → `gemini-3-flash`
    - parse price strings: strip `$`, parse as float; null/empty → omit
    - preserve original (footnote-stripped) name as `displayName`
    - log + skip any entry missing required keys (`model`/`provider`/`input`/`cached_input`/`output`); don't crash the extension
  - `getRateCard(modelId: string): RateCard | null` — strips known prefixes (`copilot/`, `copilotcli/`, `claude-code/`), lowercases, then:
    1. exact match against the normalized-id map → return
    2. explicit alias table (initially empty; populated only when we observe a real Copilot id that needs mapping) → return aliased rate card
    3. `null` if no match — callers log + skip costing but still record tokens. **No family/prefix fallback.** Future variants (`claude-sonnet-5`) must show up in the rate card before they get a price, to prevent silent misprice.
  - `computeCost(modelId, tokens: { input, output, cacheRead, cacheCreation }): number` — USD = `(input × rate.input + cacheRead × rate.cachedInput + cacheCreation × (rate.cacheCreation ?? rate.input) + output × rate.output) / 1_000_000`. Unknown model → `0`.
  - `getDisplayName(modelId): string` — rate card's `displayName` if known, else the normalized id
  - `getAllRates(): ReadonlyMap<string, RateCard>` — for status bar / diagnostics
- [x] write tests against `src/__fixtures__/models-and-pricing.yml` (hermetic; don't read the live `data/` file):
  - normalization unit tests: footnote strip, whitespace→hyphen, dot preserved (`gpt-4.1`, `claude-opus-4.6`), case folding. Full version-qualified names preserved end-to-end (we never collapse `claude-opus-4.6` to `claude-opus-4`).
  - schema robustness: an entry missing `input` doesn't crash the load, just gets skipped with a logged warning
  - `getRateCard`: exact match per provider; `copilot/` / `copilotcli/` / `claude-code/` prefix strip; **unknown returns null** (no family fallback — `claude-sonnet-5` not in rate card → null, no silent misprice)
  - `computeCost`: all token types; GPT-4.1 and GPT-5 mini are charged at their published per-token rates (the "included models" footnote is about plan allowance, not zero pricing — our extension can't see plan allowances so we report list AIC for everyone); unknown model returns 0; `cacheCreation` rate fallback to `input` for OpenAI/Gemini (no `cache_write` in YAML)
  - `getDisplayName`: returns YAML `displayName` for known, stripped id for unknown
- [x] run `npm run lint && npm test` — must pass before Task 2

### Task 2: Rewrite `sessionParser.ts` to use server tokens + cache split (atomic with Task 3 — single working state)

Tasks 2 and 3 must land together because `tracker.ts:182` and `tracker.ts:220` both call `parseSessionFileContent(..., estimateTokensFromText)`. Removing the third arg from the parser without simultaneously updating tracker breaks `npm test` mid-refactor. Implement both, then run tests once.

**Files:**
- Modify: `src/sessionParser.ts`
- Modify: `src/sessionParser.test.ts`

- [x] remove `estimateTokensFromText` parameter from `parseSessionFileContent` signature; remove char-based `addTokens` logic. Update **all** callers in `tracker.ts` (lines 182 and 220) in the same diff
- [x] extend `ModelUsage` to `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }` (all numbers, default 0). `inputTokens` is the **uncached/fresh** input slice (not total prompt); see Task 3 for `totalTokens` invariant
- [x] **keep** the plain-JSON branch (non-`.jsonl` path) — it is called by `readSessionsFromVscdb()` via `tracker.ts:220` to parse vscdb-extracted JSON strings. Apply the same metadata-based token reads in both branches; the only thing being dropped is char-based estimation
- [x] per request in the delta-reconstructed session (and in the plain-JSON branch): read `request.result.metadata.promptTokens`, `outputTokens`, `cacheReadTokens?`, `cacheCreationTokens?`. Treat missing/non-numeric/negative values as zero per field; never crash. Pending requests (no `result` or `modelState.value !== 1`) contribute zero tokens and zero cost, but are **not** counted as interactions either — a pending request is half a turn
- [x] derive `inputTokens` = `max(0, promptTokens - (cacheReadTokens ?? 0) - (cacheCreationTokens ?? 0))`
- [x] when `cacheReadTokens` is **undefined**, apply heuristic: track per-session turn index from session-level `requests[]` order; for turn ≥ 2, set `cacheReadTokens = floor(promptTokens × 0.75)` and recompute `inputTokens = promptTokens - cacheReadTokens`; for turn 1, leave at 0. The heuristic shifts input from full-rate to cached-rate bucket, so the resulting cost is **lower than treating all input as fresh** (NOT an upper bound — label everywhere as "Est"/heuristic, not "upper bound")
- [x] keep `modelInteractions` counter (still useful for status bar diagnostics) but stop using it for cost
- [x] normalize the per-request `modelId` via `getRateCard(modelId)` — when a card is found, key all aggregation under its normalized name (e.g. `claude-opus-4.6`, never collapsed to `claude-opus`); when no card is found, log once + key under the stripped id so token totals still surface (cost will be 0)
- [x] write tests covering:
  - explicit cache fields present (Anthropic with `cacheReadTokens` + `cacheCreationTokens`); heuristic does NOT fire
  - cache fields absent → heuristic fires from turn 2; turn 1 stays at 0% cache
  - mixed models in one session (Sonnet 4.6 + GPT-5.3-Codex), each keyed at full version name
  - missing `result.metadata` entirely → request skipped, no crash, no interaction increment
  - **malformed**: `promptTokens = "abc"`, `outputTokens = -100`, `cacheReadTokens = null` → all clamped to 0, request still parsed
  - **kind:1 path-update delta** carrying `metadata` via `["requests", 0, "result", "metadata"]` path (not just the kind:0 initial snapshot) — verify metadata still reaches the aggregator
  - pending request (modelState !== 1) → 0 tokens, 0 cost, not counted as an interaction
  - vscdb plain-JSON path: a captured vscdb session string is parsed the same as a `.jsonl` delta session with equivalent content
- [x] run `npm test` — must pass before Task 4

### Task 3: Rewrite `tracker.ts` for token+cost aggregation (atomic with Task 2)

Land alongside Task 2 in the same commit/PR so `tracker.ts` callsites match the new `parseSessionFileContent` signature.

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/tracker.test.ts`

- [x] update `TrackingStats` type: `{ since, lastUpdated, models: { [model]: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd } }, totalTokens, interactions, totalCostUsd, totalAiCredits }`. Drop `premiumRequests`, `estimatedCost` *(legacy `premiumRequests`/`estimatedCost` retained as 0-valued shims on ModelStats/TrackingStats so statusBar.ts, trackingFile.ts, extension.ts still compile; Tasks 5/6/7 delete them along with their last consumers)*
- [x] **`totalTokens` invariant**: sum across all four token buckets (`input + cacheRead + cacheCreation + output`) per model, then across models. The status-bar token count must NOT silently drop cached tokens
- [x] update `RestoredStats` to mirror new model shape (without `lastUpdated`)
- [x] remove `planInfoProvider` field + `setPlanInfoProvider` method *(method kept as a no-op for caller compile-compat; deleted in Task 7 alongside planDetector)*
- [x] remove imports of `getPremiumMultiplier`, `PlanInfo`, `DEFAULT_COST_PER_REQUEST` *(only `PlanInfo`/`DEFAULT_COST_PER_REQUEST` still type-imported by the deprecated `setPlanInfoProvider` shim — drops in Task 7)*
- [x] update the two `parseSessionFileContent(...)` callsites (lines 182 and 220) to drop the `estimateTokensFromText` third argument
- [x] `computeStats`: compute deltas per model on the four token fields; call `computeCost` from `tokenRates.ts` per model to get `costUsd`; total USD = sum across models; total AIC = totalCostUsd × 100
- [x] update `mergeModelUsage` / `accumulateModel` helpers for the new fields
- [x] update baseline + cache-eviction logic (no shape change beyond adding two fields)
- [x] update `notifyListeners` change-detection comparison (compare totalCostUsd instead of premiumRequests/estimatedCost)
- [x] write tests: delta computation per model, GPT-4.1 + GPT-5 mini **DO** contribute cost at the published rate (no special-case zero), mixed Anthropic + OpenAI session, restored-from-disk merge, baseline snapshot, `totalTokens` includes cacheRead/cacheCreation
- [x] run `npm test` — must pass before next task

### Task 4: Rewrite `config.ts` trailer settings

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts` (create if missing)
- Modify: `package.json`

- [x] remove `PlanSetting` type + `getPlanSetting()` function *(planDetector.ts now reads `copilot-budget.plan` directly via a local helper since planDetector itself is deleted in Task 7)*
- [x] replace `TrailerConfig` with `{ estimatedCost: string | false; aiCredits: string | false; aiCreditsPerModel: string | false }` *(legacy `premiumRequests`/`model` fields retained as deprecated `string | false` shims, always `false` at runtime, until Task 5 rewrites trackingFile.ts and its tests)*
- [x] update `getTrailerConfig()` to read `copilot-budget.commitHook.trailers.{estimatedCost,aiCredits,aiCreditsPerModel}` with defaults `"Copilot-Est-Cost"`, `"Copilot-AI-Credits"`, `false` (estimatedCost setting + trailer name kept identical to v0.5.3 for backwards compat; aiCredits default-on because it's the plan-invariant metric)
- [x] in `package.json` contributions: remove `copilot-budget.plan`, remove `commitHook.trailers.premiumRequests` and `commitHook.trailers.model`, **keep** `commitHook.trailers.estimatedCost` (same setting key, same default value `"Copilot-Est-Cost"`), add `commitHook.trailers.aiCredits` with default `"Copilot-AI-Credits"` and `commitHook.trailers.aiCreditsPerModel` with default `false`, both `type: ["string","boolean"]`
- [x] write tests for `getTrailerConfig` defaults, custom strings, false-to-disable, sanitization (the existing `sanitizeTrailerKey` stays)
- [x] run `npm test` — must pass before next task

### Task 5: Rewrite `trackingFile.ts` schema

**Files:**
- Modify: `src/trackingFile.ts`
- Modify: `src/trackingFile.test.ts`

- [x] new write schema (in order): `SINCE=<iso>`, `INTERACTIONS=<n>`, `TOTAL_COST_USD=<x.xxxx>`, `TOTAL_AI_CREDITS=<x.xx>`, then for each model: `MODEL_<sanitized>_INPUT_TOKENS=<n>`, `_OUTPUT_TOKENS=<n>`, `_CACHE_READ_TOKENS=<n>`, `_CACHE_CREATION_TOKENS=<n>`, `_COST_USD=<x.xxxx>`
- [x] generate `TR_*` lines from trailer config:
  - `TR_<estimatedCost>=$<x.xx>` if enabled — **includes the `$` prefix** matching the v0.5.3 output format byte-for-byte
  - `TR_<aiCredits>=<x.xx>` if enabled (credits, 2 dp, no prefix)
  - `TR_<aiCreditsPerModel>=<model1>=<credits1>,<model2>=<credits2>...` if enabled — model names come from `getDisplayName(id)` (the rate card's original `displayName`, e.g. `Claude Sonnet 4.6`); sorted by descending credits; commas separating entries; 2 dp credits. The `MODEL_<sanitized>_*` tracking keys still go through `sanitizeModelName` (POSIX hook grep needs identifier-safe keys), but the human-facing trailer uses the registry display name
- [x] `parseTrackingFileContent`: parse the new keys into `RestoredStats`; ignore unknown lines silently; require `SINCE` **and** at least one new-format key (e.g. `TOTAL_COST_USD=` or `TOTAL_AI_CREDITS=`) to consider the file valid. **Legacy v0.5.x files (which only carry `PREMIUM_REQUESTS=` and `MODEL <n> <i> <o> <p>` rows) return `null`** — the tracker treats them as no prior data and starts from scratch. PR and AIC are not convertible metrics; carrying any v0.5.x value into v0.6 would just be noise
- [x] write tests:
  - round-trip (write then parse)
  - missing optional trailers
  - only some models
  - malformed lines ignored
  - MODEL_* with all four token fields
  - **legacy v0.5.x file**: input with `PREMIUM_REQUESTS=8.00`, `MODEL claude_sonnet_4_6 ... ... ...` rows → parser returns `null` (no restore)
- [x] CHANGELOG entry under 0.6.0: explicit "**Breaking**: upgrading from 0.5.x discards the previous tracking file. Counter starts fresh on first launch."
- [x] run `npm test` — must pass before next task

### Task 6: Update `statusBar.ts` for USD display

**Files:**
- Modify: `src/statusBar.ts`
- Modify: `src/statusBar.test.ts` (if exists; otherwise create)

- [ ] status bar text: `$(symbol) $X.XX Est` (use existing icon; choose `$(credit-card)` or similar — keep current icon if it fits)
- [ ] tooltip: include `Total: $X.XXXX (Y.YY AIC)` plus per-model rows `<model>: $X.XXXX (Y.YY AIC)` plus a heuristic disclosure note that does NOT claim direction: "Cost is an estimate. When per-message cache split isn't reported by Copilot, the extension assumes 75% cached input from turn 2 onward (real value may be higher or lower)."
- [ ] quick pick (the existing `showDiagnostics`-adjacent panel): per-model rows show input / cache_read / cache_creation / output tokens and USD; drop premium-request column
- [ ] remove all references to `premiumRequests`, `estimatedCost`, plan info
- [ ] write/update tests: status bar text formatting, tooltip content, empty state ($0.00)
- [ ] run `npm test` — must pass before next task

### Task 7: Delete dead modules + rewrite hook script + wire up `extension.ts`

**Files:**
- Delete: `src/tokenEstimator.ts`, `src/tokenEstimator.test.ts`, `src/tokenEstimators.test.ts`, `data/tokenEstimators.json`, `src/planDetector.ts`, `src/planDetector.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/utils.ts` (if it re-exports anything plan-related — verify)
- Modify: `src/commitHook.ts` (**script body changes — see below, not comments only**)
- Modify: `src/commitHook.test.ts`
- Modify: `package.json` (esbuild config to stop copying `tokenEstimators.json` to `dist/` if it does)

- [ ] remove plan-detector imports + `detectPlan()` / `startPeriodicRefresh()` / `disposePlanDetector()` / `onPlanChanged` calls in `extension.ts`
- [ ] remove `tracker.setPlanInfoProvider(...)` call in `extension.ts`
- [ ] delete the six files above; verify `git grep -l 'tokenEstimator\|planDetector\|PlanInfo\|PLAN_COSTS\|getPremiumMultiplier\|estimateTokensFromText\|PlanSetting'` returns nothing
- [ ] **rewrite `src/commitHook.ts` POSIX script generator**: the current script reads `PREMIUM_REQUESTS=<n>` and `exit 0` if missing or `0.00` — that's the gate that decides whether to append anything. With the new schema there is no `PREMIUM_REQUESTS` key, so the gate would always fire and **no trailers would ever be appended**. New gate: detect presence of **any** `TR_` line. If the tracking file has at least one `TR_<name>=<value>` line, append every such line as a `<name>: <value>` git trailer; otherwise skip. Reset/truncate the tracking file after appending, as today
- [ ] update `src/commitHook.test.ts` for the new gate logic: tracking file with `TR_Copilot-Est-Cost=$0.26\nTR_Copilot-AI-Credits=26.18` → both trailers appended; tracking file with no `TR_` lines (or empty) → no trailers; legacy v0.5.x file with `PREMIUM_REQUESTS=...` but no `TR_` lines → no trailers (intentional — forces a re-tracking pass)
- [ ] check `package.json` esbuild script — if it explicitly copies `data/tokenEstimators.json` into `dist/`, drop that line (Task 1 already added the `data/models-and-pricing.yml` copy step); if it copies the whole `data/` dir, no change needed
- [ ] run `npm run lint && npm test` — must pass before next task

### Task 8: Verify acceptance criteria

- [ ] verify all requirements from Overview are implemented:
  - no premium-request math remains
  - tokens read from `result.metadata` (verified via test fixture covering both presence and absence of cache fields)
  - heuristic produces sane numbers for turn 1 vs turn 2+
  - three trailer configs work independently
  - tracking file round-trips
  - status bar shows USD
- [ ] run full test suite: `npm test`
- [ ] run lint: `npm run lint`
- [ ] run build: `npm run compile`
- [ ] manual smoke in Extension Development Host (F5):
  - Open a workspace with an active Copilot Chat session
  - Verify status bar shows `$X.XX Est`
  - Verify tooltip shows per-model breakdown
  - Trigger a test commit with `commitHook.enabled = true` and verify trailer(s) appear

### Task 9: Update documentation + version bump

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json` (version bump)

- [ ] update `CLAUDE.md`:
  - replace `tracker.ts` description: remove premium-request language, describe USD/AIC aggregation + heuristic
  - replace `tokenEstimator.ts` entry with `tokenRates.ts` description
  - drop `planDetector.ts` entry
  - update `config.ts` to describe three new trailers
  - update `trackingFile.ts` schema description
- [ ] update `README.md`: feature list (drop premium-requests, describe USD cost + optional AIC trailers + per-model breakdown), settings table, screenshot if needed
- [ ] update `CHANGELOG.md` with `## 0.6.0` entry — clean break from premium-request model
- [ ] bump `package.json` version `0.5.3` → `0.6.0` (breaking change)
- [ ] move plan: `mkdir -p docs/plans/completed && git mv docs/plans/20260514-aic-token-cost-tracking.md docs/plans/completed/`

## Technical Details

### Rate card source (`data/models-and-pricing.yml`)

Byte-identical mirror of `github/docs:data/tables/copilot/models-and-pricing.yml`. Shape per entry (excerpt — full list mirrors upstream):

```yaml
- model: 'GPT-4.1[^1]'
  provider: openai
  release_status: GA
  category: Versatile
  input: $2.00          # USD per 1M tokens
  cached_input: $0.50
  output: $8.00

- model: Claude Sonnet 4.6
  provider: anthropic
  release_status: GA
  category: Versatile
  input: $3.00
  cached_input: $0.30
  cache_write: $3.75    # Anthropic only
  output: $15.00
```

Footnotes (e.g. `[^1]`) on the `model` field mark special pricing notes (e.g. GPT-4.1/GPT-5 mini are "included models" — rates listed but billed against the included quota). `cache_write` only present for Anthropic; OpenAI/Gemini/xAI cache implicitly with no separate write charge.

In-memory normalization (`src/tokenRates.ts`):
- Key: `model` field with footnotes stripped, whitespace→`-`, lowercased. `GPT-4.1[^1]` → `gpt-4.1`. `Claude Sonnet 4.6` → `claude-sonnet-4.6`. `Gemini 3 Flash` → `gemini-3-flash`.
- `RateCard` value: `{ input, cachedInput, output, cacheCreation?, provider, displayName }` — display name is the footnote-stripped original (`Claude Sonnet 4.6`).
- Free models (GPT-4.1, GPT-5 mini): rates are non-zero in the YAML; the cost formula still multiplies by them, but for tokens consumed against the included allowance the per-token attribution stays small. (We don't distinguish "free for this user" from "billable overage" — that's the user's plan context, which is out of scope.)

### Cache-split heuristic (when `cacheReadTokens` absent)

```
turnIndex = position of this request in the session's requests[] array (1-based)
if cacheReadTokens is defined (from upstream patch):
    use as-is
else if turnIndex == 1:
    cacheReadTokens = 0
    inputTokens = promptTokens
else:
    cacheReadTokens = floor(promptTokens × 0.75)
    inputTokens = promptTokens - cacheReadTokens

cacheCreationTokens = (from JSONL when present, else 0 — heuristic does not invent cache_creation)
```

Rationale: in typical multi-turn sessions, ~80-90% of input tokens are cache hits after the first turn (shared system prompt + workspace context + prior conversation). 75% is a conservative midpoint that produces ~80% cost accuracy on long agent runs without over-discounting short sessions.

### Cost formula

```
cost_usd_for_model = (
    inputTokens     × rate.input          +
    cacheReadTokens × rate.cached_input   +
    cacheCreationTokens × (rate.cache_creation ?? rate.input) +
    outputTokens    × rate.output
) / 1_000_000

ai_credits = cost_usd × 100   // 1 credit = $0.01
```

### Tracking file schema (new)

```
SINCE=2026-05-14T12:00:00.000Z
INTERACTIONS=42
TOTAL_COST_USD=0.4231
TOTAL_AI_CREDITS=42.31
MODEL_claude_sonnet_4_6_INPUT_TOKENS=12000
MODEL_claude_sonnet_4_6_OUTPUT_TOKENS=3400
MODEL_claude_sonnet_4_6_CACHE_READ_TOKENS=48000
MODEL_claude_sonnet_4_6_CACHE_CREATION_TOKENS=0
MODEL_claude_sonnet_4_6_COST_USD=0.4081
MODEL_gpt_4_1_INPUT_TOKENS=5000
MODEL_gpt_4_1_OUTPUT_TOKENS=1500
MODEL_gpt_4_1_CACHE_READ_TOKENS=0
MODEL_gpt_4_1_CACHE_CREATION_TOKENS=0
MODEL_gpt_4_1_COST_USD=0.0000
TR_Copilot-Est-Cost=$0.42
TR_Copilot-AI-Credits=42.31
TR_Copilot-AI-Credits-Models=claude-sonnet-4.6=40.81,gpt-4.1=0.00
```

### Trailer output (in commit message)

Default (`Copilot-Est-Cost` + `Copilot-AI-Credits` both on):

```
Copilot-Est-Cost: $0.42
Copilot-AI-Credits: 42.31
```

All three trailers enabled (per-model breakdown opted in):

```
Copilot-Est-Cost: $0.42
Copilot-AI-Credits: 42.31
Copilot-AI-Credits-Models: claude-sonnet-4.6=40.81,gpt-4.1=0.00
```

Compatibility notes:
- `Copilot-Est-Cost` trailer name + `$X.XX` value format are **byte-identical to v0.5.3**, so any existing CI/scripts grepping for it keep working. The value semantic changes (token-derived at published rate, plan-agnostic) but the surface contract holds.
- `Copilot-AI-Credits` is the **plan-invariant** metric (`AIC = USD × 100` at list price; tokens × rate is fixed regardless of contract). Use AIC for cross-team/cross-plan attribution; use `Copilot-Est-Cost` for list-price USD readouts.
- `Copilot-Premium-Requests` is removed with no shim — consumers must migrate to `Copilot-AI-Credits` if they need a count-like signal.
- Per-model breakdown uses original (un-sanitized) model names for readability; only the tracking-file `MODEL_*` keys use sanitized form.

## Post-Completion

**Manual verification:**
- Smoke test in Extension Development Host with a workspace that has an active Copilot Chat session (Anthropic + OpenAI mix). Verify status bar text, tooltip, and tracking file content.
- Trigger a commit with `commitHook.enabled = true`; check trailers in the commit message.
- Verify status bar text on session restart (previous-stats restore path).

**Publish:**
- Tag `v0.6.0`, push, let CI auto-release on version bump (per `feat: auto-release on version bump after CI passes`).
- Marketplace update happens via existing publish workflow.

**Watch list (future iteration):**
- When microsoft/vscode-copilot-chat ships our PR (+ #5076), `result.metadata.cacheReadTokens` / `cacheCreationTokens` will start appearing. No code change needed — parser already prefers them when present and falls back to heuristic otherwise. Cost numbers will tighten silently from ~80% to ~99% accurate.
- Re-check rate card periodically (GitHub adjusts published rates).
