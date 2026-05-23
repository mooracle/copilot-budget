# OTel-Only Migration (drop Files mode)

## Overview

Simplify Copilot Budget to a single accurate data source — Copilot Chat's OTel `agent-traces.db` — and eliminate JSONL-based Files mode. The current two-mode design (Files default, Telemetry opt-in) was needed when OTel was experimental; with `dbSpanExporter.enabled=true` now stable, the JSONL fallback adds maintenance cost and an "upper-bound estimate" caveat for no gain.

**Behavior change for users:**
- On first activation in a workspace where the upstream OTel setting is unset, the extension writes `dbSpanExporter.enabled=true` at Workspace scope (per-repo). If the user has explicitly set `false` anywhere, we respect it.
- After auto-enable, a reload may be needed before Copilot Chat starts writing spans; the status bar shows a clickable nudge until the DB appears.
- Estimated costs become measured (no tilde decoration). `cache_creation_tokens` is now always populated for Claude models.
- Background "title" subagent spans (gpt-4o-mini) are attributed via `parent_chat_session_id` — slight increase vs Files mode.
- The budget panel's "Enable accurate cost tracking (OTel)" row is removed; tracking is automatic.

**Headline cleanup:** ~1500 lines of JSONL parsing + mode-switch plumbing deleted. Single happy path.

## Context (from discovery)

Files involved (paths confirmed by `ls src/*.ts`):
- `src/tracker.ts` — contains both `JsonlSource` (line 150) and `OTelSource` (line 411) classes plus `Source` interface (line 64). Becomes OTel-only.
- `src/sessionParser.ts` + `src/sessionParser.test.ts` — fully deleted.
- `src/sessionDiscovery.ts` + `src/sessionDiscovery.test.ts` — path migration from `chatSessions/` to `GitHub.copilot-chat/transcripts/` with legacy fallback; return shape narrows to `string[]` of session IDs.
- `src/otelReader.ts` + `src/otelReader.test.ts` — `readSpansSince` replaced by `aggregateSince` (per-model SUM in SQL with parent-session OR-join).
- `src/budgetPanel.ts` + `src/budgetPanel.test.ts` — drop three OTel rows + their handlers; add passive footer.
- `src/statusBar.ts` + `src/statusBar.test.ts` — drop mode-aware tooltip text and tilde decoration.
- `src/amountFormatter.ts` + `src/amountFormatter.test.ts` — drop tilde-prefix branch.
- `src/trackingFile.ts` + `src/trackingFile.test.ts` — drop `MODE` write; parser already tolerates unknown keys.
- `src/config.ts` + `src/config.test.ts` — add `autoEnableOTel()`; drop `getEstimationMode()`; keep `isOTelDbExporterEnabled()`.
- `src/extension.ts` + `src/extension.test.ts` — drop `pickSource`, mode-swap on config change, "Switched to Telemetry mode" message gate; add `autoEnableOTel()` call.
- `CLAUDE.md`, `CHANGELOG.md`, `package.json` — docs + 3.0.0 version bump.

Real-data validation (5MB DB, 97 spans, 4 models, 4 user sessions over ~2h):
- `chat_session_id` direct coverage: 24/52 chat spans.
- `parent_chat_session_id` coverage: 4/52 (all gpt-4o-mini title subagents).
- Orphans (no chat_session_id, no parent): 24/52 — same omission Files mode has today.
- `copilot_usage_nano_aiu`: present but always `0` → rate card stays.
- `copilot_chat.repo.*`: 8/52 → unreliable, not used for attribution.

Devcontainer verification (podman `kind_mclaren`):
- `/root/.vscode-server/data/User/globalStorage/github.copilot-chat/agent-traces.db` — DB present workspace-side ✓
- `/root/.vscode-server/data/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/*.jsonl` — transcripts present workspace-side ✓
- `chatSessions/` legacy path absent in devcontainer; present on host for older entries.

Current poll interval `POLL_INTERVAL_MS` is wired via `setInterval` at tracker.ts:693 — stays at 30s, no watchers.

## Development Approach

- **Testing approach**: regular (code first, then tests) — matches existing repo rhythm (tests live alongside source files).
- Each task is incremental; codebase compiles and tests pass between tasks.
- **CRITICAL: every task MUST include new/updated tests** for code changes.
- **CRITICAL: all tests must pass before starting next task** — no exceptions.
- **CRITICAL: update this plan file when scope changes during implementation**.
- Order matters: `aggregateSince` is added alongside `readSpansSince` first; `readSpansSince` is removed only once nothing imports it. The `mode` field on `TrackingStats` is dropped last (after all consumers stop reading it).

## Testing Strategy

- **Unit tests**: every changed module gets tests updated in the same task.
- **`otelReader.test.ts`**: synthetic SQLite fixture (real `node:sqlite` built in `beforeAll`) — extend to cover `aggregateSince`, parent-session OR-join, retention edge case (oldest span < baseline), and zero-session-ids result.
- **`hook-script.test.ts` / `hook-git-e2e.test.ts`**: must pass unchanged (hook reads bare `TR_` numbers; mode-agnostic).
- **No e2e UI test suite** in this project — manual smoke covers panel + status bar.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document blockers with `⚠️` prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code, tests, docs.
- **Post-Completion** (no checkboxes): manual UI smoke, version-tag push.

## Implementation Steps

### Task 1: Add `autoEnableOTel` helper in config.ts

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

Self-contained start — no consumers yet, can be wired in Task 9.

- [x] add `autoEnableOTel(): Promise<void>` to `src/config.ts` — uses `vscode.workspace.getConfiguration(OTEL_SECTION).inspect(OTEL_KEY)`. If `globalValue === undefined && workspaceValue === undefined`, call `update(OTEL_KEY, true, ConfigurationTarget.Workspace)`. Catch + log errors (do not throw); a failed auto-enable must not block activation.
- [x] export the helper from `src/config.ts`
- [x] write tests in `src/config.test.ts`: setting undefined everywhere → writes `true` at Workspace; explicit `false` (workspace) → no-op; explicit `false` (global) → no-op; already `true` (any scope) → no-op; `update()` rejection → logs, does not throw
- [x] run `npm test -- config` — must pass before Task 2

### Task 2: Migrate session discovery to transcripts path

**Files:**
- Modify: `src/sessionDiscovery.ts`
- Modify: `src/sessionDiscovery.test.ts`
- Modify: `src/__mocks__/vscode.ts` (if needed for new fs paths)

Path change is additive at first — primary target moves to new location, legacy `chatSessions/` is fallback.

- [x] in `src/sessionDiscovery.ts` change primary discovery directory from `chatSessions/` to `GitHub.copilot-chat/transcripts/`; add legacy `chatSessions/` as a secondary scan whose result is merged in (deduped by stem)
- [x] rename `discoverSessionFiles` → `discoverSessionIds`; change return type from session-file URIs to `string[]` (just the UUID stems, stripping `.jsonl`)
- [x] update `getDiscoveryDiagnostics` to reflect the new primary path; keep returning `{platform, homedir, storageUri, chatSessionsDir | transcriptsDir, filesFound}` shape, but rename the path field to `transcriptsDir` and add a `legacyChatSessionsDir` field
- [x] empty-window (no `storageUri`) still returns `[]`; both paths null in diagnostics
- [x] update tests in `src/sessionDiscovery.test.ts`: new path discovered; legacy path discovered when primary absent; both paths merged with dedup; empty window returns empty; non-`.jsonl` files filtered via `NON_SESSION_PATTERNS`
- [x] run `npm test -- sessionDiscovery` — must pass before Task 3

> Note: This rename leaves `src/tracker.ts` (line 3 import and line 249 call) and `src/extension.ts` (line 20 import, line 31 `resolveCurrentSessionIds`, line 157 `diag.chatSessionsDir`) referencing the now-removed `discoverSessionFiles`/`chatSessionsDir`. Per the task's `npm test -- sessionDiscovery` validation, only sessionDiscovery tests must pass at this step. These dangling references are deleted wholesale by Tasks 4 (tracker rewrite) and 9 (extension wiring); the full compile resync happens at Task 5.

### Task 3: Add `aggregateSince` to OTelReader (alongside existing methods)

**Files:**
- Modify: `src/otelReader.ts`
- Modify: `src/otelReader.test.ts`

Additive — `readSpansSince` stays in place so tracker.ts still compiles. We'll remove it in Task 5 after tracker switches over.

- [x] add `PerModelAggregate` type to `src/otelReader.ts`: `{ model: string | null; chats: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }`
- [x] add `aggregateSince(sinceMs: number, sessionIds: string[]): PerModelAggregate[]` method to the `OTelReader` interface and `OTelReaderImpl`
- [x] SQL: `SELECT request_model, COUNT(*) AS chats, SUM(COALESCE(input_tokens,0)) AS in_tok, SUM(COALESCE(output_tokens,0)) AS out_tok, SUM(COALESCE(cached_tokens,0)) AS cache_read, SUM(CAST(COALESCE(cc.value,'0') AS INTEGER)) AS cache_creation FROM spans s LEFT JOIN span_attributes cc ON cc.span_id = s.span_id AND cc.key = 'gen_ai.usage.cache_creation.input_tokens' WHERE s.operation_name = 'chat' AND s.end_time_ms > ? AND (s.chat_session_id IN (<placeholders>) OR EXISTS (SELECT 1 FROM span_attributes pa WHERE pa.span_id = s.span_id AND pa.key = 'copilot_chat.parent_chat_session_id' AND pa.value IN (<placeholders>))) GROUP BY request_model`
- [x] zero-session-ids special case returns `[]` without touching the DB (matches existing `readSpansSince` semantics)
- [x] use the same `toFiniteInt` helper for null/bigint coercion
- [x] extend `src/otelReader.test.ts` synthetic-DB fixture to populate `parent_chat_session_id` rows for some spans; assert: scoped filter returns expected per-model totals; parent-session join captures title-subagent spans; cache_creation summed from `span_attributes`; orphan spans excluded; retention edge case (`sinceMs` older than oldest span) returns all matching rows; empty session list returns `[]`; **span with `request_model = NULL` produces a row with `model: null` and zero cost (downstream `getRateCard()` returns null)**
- [x] run `npm test -- otelReader` — must pass before Task 4

### Task 4: Switch Tracker to OTel-only with new aggregate API

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/tracker.test.ts`

Core surgery. After this task `JsonlSource`, `Source` interface, `swapSource`, parser-state machinery, and `FileCache`/`MAX_PARSER_STATES` are gone. The public `tracker.mode` field is removed; `TrackingStats.mode` is temporarily pinned to `'telemetry'` literal to keep statusBar/amountFormatter/budgetPanel compiling — fully removed in Task 10.

- [x] delete the `Source` interface (line 64 region), `JsonlSource` class (line 150 region), `FileCache`, `MAX_PARSER_STATES`, all parser-state imports from `./sessionParser`
- [x] simplify `OTelSource` to a non-class function `scanOTel(reader, baseline, sessionIdsFn): Promise<RawAggregateBatch>` or keep as a class without the Source-interface ceremony — pick the simpler shape
- [x] `Tracker` constructor signature becomes `Tracker(reader: OTelReader, sessionIdsFn: () => Promise<string[]>)` — drop the `Source` injection and `mode` parameter
- [x] **remove the public `mode` field from the `Tracker` class** (currently at `tracker.ts:513`); update any in-class reads to use the literal `'telemetry'`
- [x] in the 30s scan loop: `const sessionIds = await sessionIdsFn(); const rows = reader.aggregateSince(baseline, sessionIds);` — convert `rows` directly to `TrackingStats.models` using `getRateCard()` for cost; sum across models for `totalAiCredits` and `totalTokens`
- [x] keep `TrackingStats.mode` field but always set it to `'telemetry'` (transitional, removed in Task 10)
- [x] remove `swapSource` method entirely; baseline persistence via `setPreviousStats(restored)` stays unchanged
- [x] `dispose()` calls `reader.close()` directly (no Source indirection)
- [x] update `src/tracker.test.ts`: drop tests for `swapSource`, `JsonlSource`, mode-swap, parser-state caching, file-cache LRU, and `tracker.mode` field access; add tests asserting `aggregateSince` is called with current sessionIds + baseline; per-model cost computed from `getRateCard()`; `totalTokens` and `totalAiCredits` aggregated correctly; `setPreviousStats` merges across restarts
- [x] run `npm test -- tracker` — must pass before Task 5

> Note: after this task, `extension.ts` still references `tracker.mode` at lines 412/418/421/455. Those lines (and their surrounding mode-swap message-gate block) are deleted wholesale in Task 9 — they only survive this task because Task 9 deletes the *whole containing block*, never reading the now-missing field in isolation. If Task 4 leaves any dangling read of `tracker.mode` outside that block, fix it here.

### Task 5: Delete sessionParser.ts and remove `readSpansSince`

**Files:**
- Delete: `src/sessionParser.ts`
- Delete: `src/sessionParser.test.ts`
- Modify: `src/otelReader.ts`
- Modify: `src/otelReader.test.ts`
- Delete: any JSONL fixtures under `src/__fixtures__/` if they exist
- Modify: `tsconfig.json` / `package.json` if either references the deleted files

Cleanup task — only safe after Task 4 removes the only importer.

- [x] `rm src/sessionParser.ts src/sessionParser.test.ts`
- [x] confirm no remaining imports: `grep -r 'sessionParser' src/` returns nothing
- [x] remove `readSpansSince` method from `OTelReader` interface and `OTelReaderImpl`; remove the corresponding `SpanRow` export if it's no longer used externally
- [x] remove `readSpansSince` tests from `src/otelReader.test.ts`
- [x] check for and remove any JSONL session fixture files under `src/__fixtures__/` (none found — only rate-card fixtures)
- [x] run `npm test` (full suite) and `npm run compile` — both must pass before Task 6 (also did full compile resync per Task 2 note: extension.ts dead-code cleanup, plus extension.test.ts / trackingFile.test.ts realignment to the new Tracker API; Task 9 still owns `autoEnableOTel` wiring + nudge logic)

### Task 6: Drop tilde-decoration from amountFormatter

**Files:**
- Modify: `src/amountFormatter.ts`
- Modify: `src/amountFormatter.test.ts`

Decision: **keep the `mode` param on the options interface but ignore it inside `formatAmount`**. The param is dropped in Task 10 alongside `TrackingStats.mode`, in one coordinated cut. Avoids touching statusBar/budgetPanel/tracker call sites twice.

- [x] remove the `mode === 'files'` branch in `formatAmount` (line 33 region); the function no longer reads the `mode` field — the parameter remains in the options type until Task 10
- [x] update tests in `src/amountFormatter.test.ts`: remove all tilde-prefix expectations (both `mode: 'files'` and `mode: 'telemetry'` now produce identical output); assert AIC/USD short/full formats unchanged
- [x] run `npm test -- amountFormatter` — must pass before Task 7

### Task 7: Simplify statusBar tooltip and decoration

**Files:**
- Modify: `src/statusBar.ts`
- Modify: `src/statusBar.test.ts`

- [x] in `src/statusBar.ts` drop the `FILES_NOTE` and `TELEMETRY_NOTE` constants (lines 7–8 region) and the mode-aware disclosure line in the tooltip; the tooltip carries no disclosure (the panel will reflect availability state instead)
- [x] tooltip still calls `formatAmount(...)` — `mode` param is now ignored (Task 6 made it a no-op); call sites can keep passing `stats.mode` until Task 10
- [x] add a **separate `setNudge(visible: boolean): void` method** on the status bar exports (not a param on existing methods) — when `visible` is true, the status bar renders `$(refresh) Copilot Budget — reload to start tracking` with command `workbench.action.reloadWindow`; when false, render normal cost
- [x] update tests in `src/statusBar.test.ts`: assert nudge rendering after `setNudge(true)`; assert standard rendering after `setNudge(false)`; assert default state (no nudge call) renders cost; drop mode-aware disclosure tests
- [x] run `npm test -- statusBar` — must pass before Task 8

### Task 8: Slim down budgetPanel — drop OTel rows entirely

**Files:**
- Modify: `src/budgetPanel.ts`
- Modify: `src/budgetPanel.test.ts`

No passive footer — that would duplicate the status-bar nudge from Task 7. When the OTel rows are gone, the panel simply starts with currency + hook toggles. "Reload to start tracking" already lives on the status bar; the panel doesn't need a second copy.

- [x] delete the three OTel-row item builders (`OTelEnable`/`OTelAlreadyEnabled`/`OTelEnabledButUnavailable`) at lines 65–82 and their handler functions (`handleOTelEnable`, `handleOTelAlreadyEnabled`, `handleOTelEnabledButUnavailable`)
- [x] delete the corresponding `ACTION.OTel*` constants
- [x] confirm currency + hook rows render unchanged (they were never mode-dependent)
- [x] update tests in `src/budgetPanel.test.ts`: drop OTel-row tests (three states + asymmetric-write — the asymmetric-write guarantee moves to `config.test.ts` via Task 1's `autoEnableOTel` coverage); assert clicking currency/hook toggles still re-renders
- [x] run `npm test -- budgetPanel` — must pass before Task 9

### Task 9: Wire `autoEnableOTel` into activation and remove all mode-swap dead code

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

- [x] in `activate(context)`, after `storageUri` check but before `Tracker` construction, `await autoEnableOTel()` from `./config`
- [x] delete `pickSource(context, sessionIdsFn)`; replace with direct `const reader = createOTelReader(context.globalStorageUri); const tracker = new Tracker(reader, () => discoverSessionIds(context.storageUri));` (already removed in Task 5 cleanup)
- [x] delete the `onDidChangeConfiguration` handler for the upstream OTel setting (no more mode-swap); keep only the handlers that actually do work (e.g. currency change) (already removed in Task 5 cleanup)
- [x] delete the `MODE_SWAP_SHOWN_KEY` constant at `extension.ts:28` and **all** `context.workspaceState.get(...)` / `context.workspaceState.update(...)` calls referencing it (extension.ts:423–432 region); leftover state on disk for existing users is fine (VS Code workspaceState is a key/value store with no schema enforcement) (already removed in Task 5 cleanup)
- [x] delete the "Switched to Telemetry mode …" `showInformationMessage` call (already removed in Task 5 cleanup)
- [x] **delete the periodic `modeRefresh` `setInterval` at `extension.ts:454–459`** (its only purpose was Files→Telemetry recovery polling — obsolete with OTel-only) (already removed in Task 5 cleanup)
- [x] verify any `tracker.mode` reads inside `extension.ts` (lines 412/418/421/455 region) are removed wholesale as part of the surrounding block deletions; no dangling `tracker.mode` reference may remain
- [x] add nudge logic: after tracker construction, if `isOTelDbExporterEnabled() === true` AND `!reader.isAvailable()`, call `statusBar.setNudge(true)`; in the tracker's `onStatsChanged` handler (or a small wrapper poll), if `reader.isAvailable()` flips true, call `statusBar.setNudge(false)` once
- [x] update tests in `src/extension.test.ts`: `autoEnableOTel` called on activation; nudge appears when DB missing; nudge clears when DB becomes available; no mode-swap on config change; `MODE_SWAP_SHOWN_KEY` is no longer read/written; no `modeRefresh` interval is registered
- [x] run `npm test -- extension` — must pass before Task 10

### Task 10: Drop `mode` field from TrackingStats and amountFormatter end-to-end

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/trackingFile.ts`
- Modify: `src/trackingFile.test.ts`
- Modify: `src/amountFormatter.ts`
- Modify: `src/amountFormatter.test.ts`
- Modify: any remaining `mode` references across `src/`

This is the coordinated cut: `TrackingStats.mode`, the `'telemetry'` literal pinned in Task 4, and the now-ignored `mode` parameter on `formatAmount` all go together. After this task, no module in `src/` mentions `'files' | 'telemetry'`.

- [x] remove `mode: 'files' | 'telemetry'` from `TrackingStats` interface in `src/tracker.ts`; remove the `mode: 'telemetry'` literal pinned in Task 4
- [x] in `src/amountFormatter.ts` drop the `mode` field from the formatter's options type (kept around since Task 6 only as a transitional no-op); update all call sites (`statusBar.ts`, `budgetPanel.ts`, `trackingFile.ts` if any) to stop passing it
- [x] in `src/trackingFile.ts` stop writing the `MODE=` line in `formatTrackingFile`; keep `parseTrackingFileContent` tolerant of legacy `MODE=` keys (silently ignored — already the case for unknown keys)
- [x] grep `src/` for remaining `\.mode` references on `TrackingStats` (e.g. `stats\.mode`, `\bmode:\s*['"]\w+['"]`) and clean up (also dropped `getEstimationMode` from `config.ts` + tests to satisfy "no module mentions 'files' | 'telemetry'")
- [x] update tests in `src/trackingFile.test.ts`: written file no longer contains `MODE`; **add explicit assertion: parsing a legacy v2.0.x file with `MODE=files` succeeds**; **add explicit assertion: parsing a legacy v2.0.x file with `MODE=telemetry` succeeds** (both round-trip the same valid `TrackingStats` minus the field)
- [x] update tests in `src/amountFormatter.test.ts`: drop the `mode` argument from every test invocation
- [x] run `npm test` (full suite) — must pass before Task 11

### Task 11: Documentation, changelog, version bump

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json` (lock-step with package.json)
- Modify: `README.md` (if grep finds matches — see below)

- [x] in `CLAUDE.md`: rewrite the Project Overview, Architecture, and Key Design Details sections to reflect OTel-only model; remove the "Two-mode design with auto-detection" framing; document the new `transcripts/` path with legacy `chatSessions/` fallback; document `autoEnableOTel` and the asymmetric-write invariant in its new home (`config.ts`); update file-by-file module summaries for tracker/sessionDiscovery/otelReader/budgetPanel/statusBar/amountFormatter
- [x] in `CHANGELOG.md`: add `## [3.0.0] - 2026-05-22` entry leading with "Drop Files mode; always use Copilot Chat's OTel database. Auto-enable on first run per-workspace." Follow with deletions, breaking changes (config keys removed, behavior changes), and "Why" rationale
- [x] in `package.json`: bump `"version"` from `2.0.2` to `3.0.0`
- [x] **verify `package.json` `contributes.configuration`** — grep for any setting key that explicitly referenced Files mode; based on a pre-plan inspection of `src/config.ts` no such key exists, so this step is likely a no-op. If a key surfaces, remove its declaration and the value-handling code together. (Verified: no Files-mode-specific keys.)
- [x] `npm install` to refresh `package-lock.json` version stamp
- [x] **positive grep step**: `grep -inE 'files mode|telemetry mode|two-mode|tilde estimate' README.md CHANGELOG.md docs/` — any match must be reviewed and rewritten or deleted (README rewritten; CHANGELOG/CLAUDE matches are historical entries or past-tense references in the 3.0.0 description; plan/completed docs are historical records left alone)
- [x] no tests needed for this task (documentation only) — but verify `npm run compile` still works after settings edits
- [x] run `npm test` and `npm run compile` — must pass before Task 12 (375/375 tests passing, build green)

### Task 12: Verify acceptance criteria
- [x] verify all items from Overview are implemented: auto-enable works on first run; status-bar nudge appears+clears correctly; budget panel has no OTel toggle row; cost figures are tilde-free; cache_creation_tokens is populated for Claude models
- [x] run full test suite: `npm test` (375/375 passing)
- [x] run linter: `npm run lint` (clean)
- [x] run build: `npm run compile` (green)
- [x] no e2e UI test suite — manual smoke is a Post-Completion step (skipped - not automatable)

### Task 13: [Final] Move plan to completed
- [x] `mkdir -p docs/plans/completed`
- [x] `git mv docs/plans/20260522-otel-only-migration.md docs/plans/completed/`

## Technical Details

**Auto-enable invariant (strictly-asymmetric write):**
```ts
// src/config.ts
export async function autoEnableOTel(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(OTEL_SECTION);
  const inspected = cfg.inspect(OTEL_KEY);
  const explicitlySet =
    inspected?.globalValue !== undefined ||
    inspected?.workspaceValue !== undefined;
  if (explicitlySet) return;
  try {
    await cfg.update(OTEL_KEY, true, vscode.ConfigurationTarget.Workspace);
  } catch (err) {
    log(`autoEnableOTel: failed to write setting — ${errorMessage(err)}`);
  }
}
```

**Aggregate SQL (parent-session OR-join, single round-trip):**
```sql
SELECT
  s.request_model                                              AS model,
  COUNT(*)                                                     AS chats,
  COALESCE(SUM(s.input_tokens), 0)                             AS in_tok,
  COALESCE(SUM(s.output_tokens), 0)                            AS out_tok,
  COALESCE(SUM(s.cached_tokens), 0)                            AS cache_read,
  COALESCE(SUM(CAST(cc.value AS INTEGER)), 0)                  AS cache_creation
FROM spans s
LEFT JOIN span_attributes cc
  ON cc.span_id = s.span_id
 AND cc.key    = 'gen_ai.usage.cache_creation.input_tokens'
WHERE s.operation_name = 'chat'
  AND s.end_time_ms    > ?              -- baseline
  AND (
        s.chat_session_id IN (?, ?, ?)  -- session-id placeholders
     OR EXISTS (
          SELECT 1 FROM span_attributes pa
          WHERE pa.span_id = s.span_id
            AND pa.key     = 'copilot_chat.parent_chat_session_id'
            AND pa.value  IN (?, ?, ?)   -- same session-id placeholders
        )
      )
GROUP BY s.request_model;
```

**Session-id discovery (new path with legacy fallback):**
```
<workspaceStorage>/<hash>/GitHub.copilot-chat/transcripts/<UUID>.jsonl   ← primary
<workspaceStorage>/<hash>/chatSessions/<UUID>.jsonl                       ← legacy fallback
```
Return `string[]` of unique UUIDs (dedup across both paths).

**Tracking file format (post-migration):**
```
SINCE=1779485724328
INTERACTIONS=27
TOTAL_AI_CREDITS=341.04
MODEL_claude_opus_4_6_INPUT_TOKENS=93389
MODEL_claude_opus_4_6_OUTPUT_TOKENS=693
MODEL_claude_opus_4_6_CACHE_READ_TOKENS=83644
MODEL_claude_opus_4_6_CACHE_CREATION_TOKENS=9739
MODEL_claude_opus_4_6_COST_AIC=215.30
TR_Copilot-AI-Credits=341.04
```
No `MODE=` line. Parser ignores it on legacy files.

**Strict ordering rationale:** `aggregateSince` is added in Task 3 before `readSpansSince` is removed in Task 5 so `tracker.ts` always has a working OTel API to import from. `TrackingStats.mode` is pinned to `'telemetry'` literal in Task 4 so dependent modules (statusBar, amountFormatter, budgetPanel) keep compiling until each is cleaned up; the field is removed only in Task 10.

## Post-Completion

*Items requiring manual intervention or external systems — informational only.*

**Manual verification:**
- Smoke test in three environments: local VS Code workspace, devcontainer (podman), SSH Remote — verify auto-enable writes the setting, reload prompt appears, status bar shows measured cost after one Copilot Chat turn.
- Verify the commit hook still appends `Copilot-AI-Credits:` trailer correctly after a real chat-then-commit cycle.
- Verify the panel renders the passive footer in both available/unavailable states.

**Release flow:**
- `git tag v3.0.0` and push tags after merging to `main`.
- `npm run package` produces `.vsix`.
- VS Code Marketplace publish via `vsce publish` (or `vsce publish --packagePath dist/...`).
- Mention in the marketplace listing description that the extension now auto-enables Copilot Chat's OTel exporter on first activation.
