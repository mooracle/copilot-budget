# Plan: Hybrid Copilot Plan Detection for Accurate Cost Attribution

## Context

The extension hardcodes `PREMIUM_REQUEST_COST = 0.04` (the overage rate) for all cost calculations. This overstates costs for users within their plan's included allowance. The goal is to enable accurate cost aggregation across commits/PRs/repos/teams — e.g., "25 features by 5 devs cost $45 in Copilot this month."

The fix: replace the hardcoded cost with a plan-aware effective rate (subscription / included requests), auto-detected via GitHub's internal API or manually configured.

Additionally, simplify the commit hook to be a dumb pipe: read values from `.git/copilot-budget`, write them as git trailers, reset the file. All calculation (including accumulation of previous commit totals) moves into the extension.

## Plan-to-Cost Mapping

| Plan       | $/month | Included PRs | Effective $/PR |
|------------|---------|-------------|----------------|
| free       | $0      | 50          | $0.00          |
| pro        | $10     | 300         | $0.0333        |
| pro+       | $39     | 1500        | $0.0260        |
| business   | $19     | 300         | $0.0633        |
| enterprise | $39     | 1000        | $0.0390        |

Overage (beyond plan limit): $0.04/PR — used as fallback when plan is unknown.

## Detection Strategy (Hybrid)

1. **Primary: Internal API** — `GET https://api.github.com/copilot_internal/user` via `vscode.authentication.getSession("github", ["user:email"], { createIfNone: false })`. Parse `copilot_plan` field to determine plan type.
2. **Fallback: User config** — New setting `copilot-budget.plan` (enum: auto/free/pro/pro+/business/enterprise, default: auto).
3. **Graceful degradation** — If API fails and setting is "auto", use current $0.04 rate (overage rate as conservative default).

## Implementation Steps

### Task 1: New module `src/planDetector.ts`

- [x] Create `src/planDetector.ts` with PlanInfo type, PLAN_COSTS map, DEFAULT_COST_PER_REQUEST, detectPlan(), getPlanInfo(), onPlanChanged(), startPeriodicRefresh()/stopPeriodicRefresh(), disposePlanDetector(), parseApiResponse()
- [x] Create `src/planDetector.test.ts` with tests for parseApiResponse, detectPlan with mocked auth/fetch/config, listener pattern, periodic refresh
- [x] Add `authentication` mock to `src/__mocks__/vscode.ts`

New file. Exports:
- `PlanInfo` type: `{ planName, costPerRequest, source: 'api'|'config'|'default' }`
- `PLAN_COSTS` map: plan name → `{ costPerRequest, monthlyPrice, includedRequests }`
- `DEFAULT_COST_PER_REQUEST = 0.04`
- `detectPlan(): Promise<PlanInfo>` — tries API, then config, then default ($0.04)
- `getPlanInfo(): PlanInfo` — returns cached result
- `onPlanChanged(listener): Disposable` — listener pattern (same as Tracker)
- `startPeriodicRefresh() / stopPeriodicRefresh()` — re-detect every 15 min
- `disposePlanDetector()`
- `parseApiResponse(data): PlanInfo | null` — exported for testability

API detection: uses `fetch()` (Node 18 built-in) with `createIfNone: false` (never prompts user). Maps API's `copilot_plan` string (e.g. `"individual_pro"`) to our plan names.

### Task 2: Update `src/tokenEstimator.ts`

- [x] Remove the `PREMIUM_REQUEST_COST = 0.04` constant export (moved to planDetector as `DEFAULT_COST_PER_REQUEST`)
- [x] Update all imports across the codebase

### Task 3: Update `src/tracker.ts`

- [ ] Add `setPlanInfoProvider(provider: () => PlanInfo)` method to Tracker
- [ ] In `computeStats()`, replace `premiumRequests * PREMIUM_REQUEST_COST` with `premiumRequests * planInfo.costPerRequest`
- [ ] Update `src/tracker.test.ts` with tests for setPlanInfoProvider affecting estimatedCost

### Task 4: Update `src/statusBar.ts`

- [ ] Import `DEFAULT_COST_PER_REQUEST` from planDetector instead of `PREMIUM_REQUEST_COST` from tokenEstimator
- [ ] Per-model cost in quick pick: derive cost-per-request from plan info or stats ratio
- [ ] Add plan name to quick pick header when detected
- [ ] Update `src/statusBar.test.ts` with plan name display tests

### Task 5: Add config setting in `package.json` and `src/config.ts`

- [ ] `package.json`: Add `copilot-budget.plan` enum setting with descriptions
- [ ] `config.ts`: Add `getPlanSetting(): PlanSetting` accessor
- [ ] Update `src/config.test.ts` with `getPlanSetting()` tests

### Task 6: Simplify commit hook — make it a dumb pipe

- [ ] Replace HOOK_SCRIPT in `src/commitHook.ts` with simplified dumb-pipe version
- [ ] Update `src/commitHook.test.ts` with updated hook script assertions

**Current hook behavior** (to be replaced):
- Reads `PREMIUM_REQUESTS` and `ESTIMATED_COST` from tracking file
- Reads previous commit's `AI-Premium-Requests` and `AI-Est-Cost` trailers via `git log`
- Accumulates: `total = previous + current`
- Runs awk to merge per-model data from previous trailers + current tracking file
- Writes accumulated totals as trailers
- Resets tracking file

**New hook behavior** (dumb pipe):
- Reads all key=value pairs and MODEL lines from `.git/copilot-budget`
- Writes them directly as trailers (no accumulation, no calculation)
- Resets tracking file

**Move accumulation to the extension**: `src/trackingFile.ts` already writes the tracking file. To accumulate previous commit totals, the extension should:
1. On `writeTrackingFile()`, read the last commit's trailers via `git log` (or pre-read them on activation)
2. Add accumulated totals to the tracking file output

OR simpler: the tracking file already gets the correct session-delta values. The hook just copies them. If accumulation across commits is needed, the extension handles it. This is a design choice — accumulation can be a separate follow-up since the primary goal is cost accuracy.

**Recommended approach**: For this PR, simplify the hook to a dumb pipe that copies values as trailers. Drop accumulation for now (it can be re-added in the extension layer later if needed). The tracking file already contains `ESTIMATED_COST` with the correct plan-aware rate.

**New HOOK_SCRIPT**:
```sh
#!/bin/sh
# Copilot Budget prepare-commit-msg hook
COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"
case "$COMMIT_SOURCE" in merge|squash|commit) exit 0 ;; esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
TRACKING_FILE="$REPO_ROOT/.git/copilot-budget"
[ -f "$TRACKING_FILE" ] || exit 0

PREMIUM=$(grep '^PREMIUM_REQUESTS=' "$TRACKING_FILE" | cut -d= -f2)
COST=$(grep '^ESTIMATED_COST=' "$TRACKING_FILE" | cut -d= -f2)

# Skip if no premium requests
case "$PREMIUM" in ''|0|0.00) exit 0 ;; esac

printf '\n\nAI-Premium-Requests: %s\n' "$PREMIUM" >> "$COMMIT_MSG_FILE"
printf 'AI-Est-Cost: $%s\n' "$COST" >> "$COMMIT_MSG_FILE"

# Per-model trailers
grep '^MODEL ' "$TRACKING_FILE" | while read _ name inp out pr; do
  printf 'AI-Model: %s %s/%s/%s\n' "$name" "$inp" "$out" "$pr" >> "$COMMIT_MSG_FILE"
done

: > "$TRACKING_FILE"
```

### Task 7: Wire up in `src/extension.ts`

- [ ] Import and call `detectPlan()` during activation (before `tracker.start()`)
- [ ] Call `tracker.setPlanInfoProvider(getPlanInfo)`
- [ ] Call `startPeriodicRefresh()`
- [ ] Subscribe `onPlanChanged` → `tracker.update()` (recompute stats with new rate)
- [ ] Subscribe config changes → `detectPlan()` (re-detect when plan setting changes)
- [ ] Add plan info to diagnostics output
- [ ] Call `disposePlanDetector()` in `deactivate()`
- [ ] Update `src/extension.test.ts` with plan detection wiring tests

## Key Files

| File | Change |
|------|--------|
| `src/planDetector.ts` | **NEW** — core plan detection module |
| `src/planDetector.test.ts` | **NEW** — tests for plan detection |
| `src/tokenEstimator.ts` | Remove `PREMIUM_REQUEST_COST` (moved to planDetector) |
| `src/tracker.ts` | Add `setPlanInfoProvider()`, use plan rate in `computeStats()` |
| `src/statusBar.ts` | Show plan name in quick pick, update cost import source |
| `src/config.ts` | Add `getPlanSetting()` |
| `src/commitHook.ts` | Simplify to dumb pipe — no accumulation/calculation |
| `src/extension.ts` | Wire plan detection into lifecycle |
| `src/__mocks__/vscode.ts` | Add `authentication` mock |
| `package.json` | Add `copilot-budget.plan` setting |

## Verification

1. `npm run compile` — builds without errors
2. `npm test` — all tests pass
3. Manual: Set `copilot-budget.plan` to "pro" → status bar shows cost at ~$0.033/request instead of $0.04
4. Manual: With GitHub auth available and setting on "auto" → diagnostics show detected plan
5. Manual: With no auth and "auto" → falls back to $0.04 (overage rate)
6. Manual: Commit with hook enabled → trailers match tracking file values exactly (no hook-side calculation)
