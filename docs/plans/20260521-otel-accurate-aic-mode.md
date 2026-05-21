# OTel-Backed Accurate AIC Mode + Display Toggles

## Overview

Today the extension applies a 75% cache-hit heuristic on turn ≥ 2 because upstream Copilot Chat does not persist per-request cache splits in `chatSessions/*.jsonl`. The heuristic was calibrated for Anthropic; for OpenAI it lands within ±2× either direction, for Gemini and xAI it systematically undercounts by ~4× (those providers don't cache via Copilot's path at all). Per-commit AIC on the git trailer is therefore an unverifiable estimate.

This plan introduces a **two-mode design with auto-detection**:

- **Files mode** (default, zero-config): drop the heuristic entirely. Treat every prompt token as fresh `input`. Produces an *upper-bound* estimate — never undercounts, never silently mismodels new providers. Display with tilde prefix so the audit signal carries into the trailer (`Copilot-AI-Credits: ~42`).
- **Telemetry mode** (auto-detected): when `github.copilot.chat.otel.dbSpanExporter.enabled = true` AND `<globalStorage>/github.copilot-chat/agent-traces.db` exists, read measured `input_tokens` / `output_tokens` / `cached_tokens` per request from upstream's OTel SQLite store. No tilde — these are measured numbers.

A new QuickPick "Copilot Budget" panel surfaces three codicon-checkbox toggles: OTel mode, currency (AIC ↔ USD), and commit hook installation. Toggling OTel writes `dbSpanExporter.enabled = true` upstream (asymmetric — never writes false back) and prompts to reload. Toggling currency / hook is local-only.

## Context (from discovery)

**Files involved:**
- `src/sessionParser.ts` — owns the cache-read heuristic block (lines 240–250). Will treat `cacheReadTokens` as `0` when absent instead of computing the 75% fallback. `cacheCreationTokens` already defaults to 0 cleanly.
- `src/tracker.ts` — `Tracker` class drives discovery + polling + parsing. Needs to become mode-aware: source is either `chatSessions/*.jsonl` (existing JSONL path) or `agent-traces.db` (new OTel path). The baseline/delta model and per-session caching ideas transfer; the source-of-truth abstraction needs lifting.
- `src/statusBar.ts` — owns `formatAic` / `formatAicShort`. New `formatAmount(amountAic, mode, currency)` consolidates tilde-prefix + AIC/USD selection. Tooltip and quick-pick rows route through the same helper.
- `src/trackingFile.ts` — writes `Copilot-AI-Credits` trailer value. Adds tilde prefix when mode === files. Also writes per-model `_COST_AIC` values that the hook converts via `TR_` lines.
- `src/extension.ts` — activation. Detects OTel availability, picks Tracker variant, registers commands. Listens on `onDidChangeConfiguration` for hot-swap.
- `src/config.ts` — adds `getDisplayCurrency()`, `getEstimationMode()` (combines upstream OTel setting + DB availability to pick Files vs Telemetry), and helpers around the upstream OTel setting.
- `package.json` — adds `copilot-budget.displayCurrency` setting; bumps `engines.vscode` to the minimum that ships Node ≥ 22.5 (where `node:sqlite` is stable). This is a breaking change for users on older VS Code — release as a major version bump with explicit "minimum VS Code version" callout in the release notes.
- NEW `src/otelReader.ts` — opens `<copilot-chat globalStorage>/agent-traces.db` readonly via `node:sqlite`, exposes `readSpansSince(sinceMs, sessionIds): SpanRow[]` and `getLatestTimestamp(): number`. Filters by current window's `chat_session_id` set to preserve window-scoped invariant.
- NEW `src/budgetPanel.ts` — QuickPick UI with codicon checkbox toggles for OTel/currency/hook + per-model stats display rows. Replaces the body of the existing `showStats` command.

**Related patterns:**
- The existing `showStats` quick pick already renders per-model rows — we extend it rather than introduce a new command id, preserving keybindings and command palette references.
- The hook install / uninstall functions in `src/commitHook.ts` are async and idempotent; the panel toggle wires straight to them.
- `vscode.workspace.getConfiguration('...').update(key, value, ConfigurationTarget.Global)` is the standard write path; we already use it nowhere yet but it's plain VS Code API.
- Upstream's `OTelSqliteStore` (`vscode-copilot-chat/src/platform/otel/node/sqlite/otelSqliteStore.ts`) declares the schema we read: `spans` table with denormalized columns `chat_session_id, request_model, input_tokens, output_tokens, cached_tokens, reasoning_tokens, turn_index, ttft_ms, start_time_ms, end_time_ms, operation_name`. WAL mode + busy_timeout=3000ms guarantee safe concurrent readers.

**Dependencies:**
- `node:sqlite` (Node 22.5+ built-in, stable). No new npm packages. Do NOT reintroduce `sql.js` or `@vscode/sqlite3`.
- Existing `js-yaml` stays dev-only (rate card preserves YAML→JSON build step).

**Remote development (devcontainer / SSH / Codespaces) — known limitation:**
- `agent-traces.db` lives in the host where Copilot Chat runs (typically workspace-side in remote dev). Our extension currently declares `extensionKind: ["ui","workspace"]`. When we run UI-side and Copilot Chat runs workspace-side, the DB is on the wrong machine and OTel detection fails — Telemetry mode silently never activates. Mitigation: when the upstream setting is `true` but the DB file is missing, log a diagnostic ("OTel enabled upstream but DB not found locally — possible remote-host mismatch") and fall back to Files mode. README documents the limitation. Forcing `extensionKind: ["workspace"]` for all users would fix this but breaks empty-window activation; deferred unless real users hit the limitation.

## Development Approach

- **Testing approach:** Regular (code first, then tests in the same task). Tests are required deliverables per task, not deferred.
- Complete each task fully before moving to the next.
- Land Files mode (heuristic removal + formatter + tilde) first — it's correct on its own and ships independent value. OTel layer arrives behind a detection check so users see no regression while Telemetry mode is under construction.
- **CRITICAL: every task MUST include new/updated tests** covering both success and edge cases.
- **CRITICAL: all tests must pass before starting next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run `npm test` after each task.
- Backward compatibility: `Copilot-AI-Credits` trailer remains parseable by existing tooling; only adds an optional leading `~`. Per-model and total schemas in `<gitdir>/copilot-budget` unchanged.

## Testing Strategy

- **Unit tests:** required per task. Existing `src/__mocks__/vscode.ts` covers most surfaces; extend it for `vscode.workspace.getConfiguration().update()` and the QuickPick API.
- **OTel reader tests:** use a synthesized fixture SQLite file written in a `beforeAll` via `node:sqlite` (no separate fixture binary checked in). Tests assert query results match expected per-span aggregates including `cached_tokens`.
- **Panel tests:** assert the QuickPick item list shape and toggle behaviors via vscode mock. No live QuickPick rendering test.
- **Acceptance test:** with OTel mode auto-detected off, output matches current behavior minus the 75% heuristic (i.e., `cacheRead = 0` for every request). With OTel mode auto-detected on (mocked DB present), output reflects measured `cached_tokens`.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code changes, tests, plan-completion housekeeping.
- **Post-Completion** (no checkboxes): manual verification in Extension Development Host.

## Implementation Steps

### Task 1: Add displayCurrency setting + amount formatter

**Files:**
- Modify: `package.json`
- Create: `src/amountFormatter.ts`
- Create: `src/amountFormatter.test.ts`
- Modify: `src/config.ts`

Establish the formatting primitive used by status bar, tooltip, quick pick, and trailer. Pure function — no IO, easy to test exhaustively.

- [x] add `copilot-budget.displayCurrency` setting to `package.json` contributes block. Type `string`, enum `["aic", "usd"]`, default `"aic"`, scope `application` (User-global). MarkdownDescription explains 1 AIC = $0.01.
- [x] create `src/amountFormatter.ts` exporting `formatAmount(amountAic: number, opts: { mode: 'files' | 'telemetry'; currency: 'aic' | 'usd'; precision?: 'short' | 'full' }): string`. Tilde prefix when `mode === 'files'`. AIC short: `Math.ceil(amount)` → `42 AIC`. AIC full: `amount.toFixed(2)` → `42.31 AIC`. USD short: `Math.ceil(amountAic) / 100` → `$0.42` (rounds up to next whole AIC ≡ whole cent). USD full: `(amountAic / 100).toFixed(2)` → `$0.42`. Zero is always `0 AIC` / `$0.00` without tilde regardless of mode.
- [x] add `getDisplayCurrency(): 'aic' | 'usd'` to `src/config.ts` reading the new setting.
- [x] write `formatAmount` tests covering: files+aic short/full, files+usd short/full, telemetry+aic short/full, telemetry+usd short/full, zero in each mode, sub-cent USD rounding, very large amounts.
- [x] write `getDisplayCurrency` tests via the existing config mock.
- [x] run `npm test` — must pass before next task.

### Task 2: Drop cache heuristic from session parser

**Files:**
- Modify: `src/sessionParser.ts`
- Modify: `src/sessionParser.test.ts`

Remove the 75%-on-turn-2+ heuristic. When `cacheReadTokens` is absent in metadata, treat it as 0 (same as `cacheCreationTokens` already does).

- [x] in `extractRequestTokens` replace the branch at lines 238–250 with a single `clampNonNegInt(rawCacheRead ?? 0)`. Drop the `turnIndex` parameter from the `extractRequestTokens` signature; remove `let turnIndex = 0` and the `turnIndex += 1` from `processRequests`.
- [x] update the JSDoc above `extractRequestTokens` to remove the heuristic prose. Note that the parser is now purely passthrough: any cache split present in metadata is honored; missing fields default to 0.
- [x] remove or rewrite tests asserting the 75% heuristic. Replace with tests asserting that absent `cacheReadTokens` produces `cacheReadTokens: 0` in the output regardless of turn index.
- [x] add a test asserting that explicit `cacheReadTokens` in metadata is honored verbatim and explicit `cacheCreationTokens` likewise. Establishes that the parser is now pure passthrough: present fields are honored, missing fields default to 0. No heuristic anywhere.
- [x] run `npm test` — must pass before next task.

### Task 3: Route status bar, tooltip, and trailer through formatter

**Files:**
- Modify: `src/statusBar.ts`
- Modify: `src/statusBar.test.ts`
- Modify: `src/trackingFile.ts`
- Modify: `src/trackingFile.test.ts`

Connect the new formatter so user-visible AIC values reflect mode + currency immediately, even before OTel mode exists. Files mode is now end-to-end correct.

- [ ] in `src/statusBar.ts` replace `formatAic` / `formatAicShort` call sites with `formatAmount(amount, { mode, currency, precision })`. Mode is passed in from the Tracker (Tracker will start always-files in this task; OTel-aware tracker arrives in Task 5). Currency comes from `getDisplayCurrency()`.
- [ ] update the tooltip header line and per-model rows to use `formatAmount`. Update the heuristic-disclosure note: in Files mode read *"Estimate assumes no caching (upper bound)."*, in Telemetry mode read *"Measured via Copilot's OTel database."*.
- [ ] in `src/trackingFile.ts` `writeTrackingFile`, prepend tilde to the `Copilot-AI-Credits` trailer value (`TR_Copilot-AI-Credits=~42`) when `stats.mode === 'files'`. Also tilde-prepend the per-model `TR_Copilot-AI-Credits-<Model>` lines when present. The `_COST_AIC` and `_COST_USD` numeric keys in the tracking file (machine-readable, not trailers) stay unprefixed.
- [ ] add `mode: 'files' | 'telemetry'` to `TrackingStats` and thread it through `writeTrackingFile`. Tracker will set this; for Task 3 default to `'files'` everywhere.
- [ ] update existing trailer tests to cover both modes. Add specific tests asserting tilde presence in Files mode and absence in Telemetry mode.
- [ ] update existing status bar tests to cover currency switching + tilde presence.
- [ ] add `trackingFile.test.ts` case: `parseTrackingFileContent` silently ignores an unknown `MODE=` line (writes both `MODE=files` and `MODE=telemetry` fixtures, asserts other keys parse correctly).
- [ ] run `npm test` — must pass before next task.

**Release marker:** Tasks 1–3 form "Files mode v1" and are shippable as a standalone release. The heuristic is gone, the upper-bound estimate carries a tilde signal end-to-end, currency toggle works. If Tasks 4+ slip, release here as a minor version.

### Task 4: OTel SQLite reader module

**Files:**
- Create: `src/otelReader.ts`
- Create: `src/otelReader.test.ts`
- Modify: `package.json` (engines.vscode bump, esbuild target)

Read measured token counts from `<copilot-chat globalStorage>/agent-traces.db`. Pure data layer — Tracker integration is Task 5.

- [ ] **Pin minimum VS Code version.** `node:sqlite` is stable in Node 22.5+. Cross-reference VS Code release notes / Electron→Node mapping to identify the earliest VS Code release that bundles Node ≥ 22.5. Bump `engines.vscode` to that version exactly; do not over-bump. Document the chosen version in a comment in `package.json` near `engines`.
- [ ] **Bump esbuild target** to `--target=node22` (currently node18 per CLAUDE.md) so the build doesn't downcompile `node:sqlite` away. Update `esbuild.js`.
- [ ] **Verify upstream schema empirically.** Open a real `agent-traces.db` from a running Copilot Chat session. Run `SELECT DISTINCT operation_name, COUNT(*) FROM spans GROUP BY operation_name` and `SELECT name, COUNT(*) FROM spans WHERE input_tokens > 0 GROUP BY name`. Confirm `operation_name = 'chat'` is the right filter for billable inferences. Record the result in a comment in `otelReader.ts` so future maintainers know what schema we depend on. If the operation_name differs from `'chat'` in current upstream, update the SQL accordingly.
- [ ] create `src/otelReader.ts`. Export `interface SpanRow { sessionId: string; model: string | null; inputTokens: number; outputTokens: number; cachedTokens: number; cacheCreationTokens: number; startTimeMs: number; endTimeMs: number; }`.
- [ ] export `interface OTelReader { isAvailable(): boolean; readSpansSince(sinceMs: number, sessionIds: string[] | null): SpanRow[]; getLatestTimestamp(): number; close(): void; }`. Implementation uses `node:sqlite`'s `DatabaseSync` opened readonly via `file:<path>?mode=ro` URI form. SQL: `SELECT chat_session_id, request_model, COALESCE(input_tokens, 0) AS input_tokens, COALESCE(output_tokens, 0) AS output_tokens, COALESCE(cached_tokens, 0) AS cached_tokens, start_time_ms, end_time_ms FROM spans WHERE operation_name = ? AND start_time_ms >= ?` (operation_name passed as parameter from verification step above). When `sessionIds` is non-null, add `AND chat_session_id IN (?, ?, ...)`. Join `span_attributes` to recover `gen_ai.usage.cache_creation.input_tokens` per span (LEFT JOIN — older spans may not have it).
- [ ] DB path derivation: `vscode.Uri.joinPath(ourGlobalStorageUri, '..', 'github.copilot-chat', 'agent-traces.db')`. Export `resolveOTelDbUri(ourGlobalStorageUri: vscode.Uri): vscode.Uri`.
- [ ] `isAvailable()` returns true iff `fs.existsSync(dbPath)`. The upstream setting check happens in Tracker (Task 5) — the reader stays focused on file IO.
- [ ] **Remote-host diagnostic.** Export `diagnoseUnavailable(ourGlobalStorageUri, upstreamSettingEnabled): string | null` returning a one-line description when the DB is missing but upstream says enabled (probable remote-host mismatch). Tracker logs this once at activation when relevant.
- [ ] write tests: synthesize a fixture DB in `beforeAll` via `node:sqlite`. Insert canonical spans (mixed sessions; some with cached_tokens populated, some with NULL; some with cache_creation in `span_attributes`, some without). Assert `readSpansSince(0, null)` returns all rows. Assert NULL `cached_tokens` becomes `0` in result (not `NaN`, not `null`). Assert session-id filter limits results. Assert `getLatestTimestamp()` returns max(`end_time_ms`). Assert `close()` is idempotent and releases the DB handle (Tracker registers it on `context.subscriptions` for dispose-on-deactivate; non-optional in the interface to prevent handle leaks across reload-window cycles).
- [ ] write tests: nonexistent DB → `isAvailable() === false`; readSpansSince returns `[]`.
- [ ] write tests: DB present but spans table empty → `[]`.
- [ ] write tests: `diagnoseUnavailable` returns string when DB missing + upstream enabled, returns null otherwise.
- [ ] run `npm test` — must pass before next task.

### Task 5a: Refactor Tracker into Source-strategy abstraction (JSONL only)

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/tracker.test.ts`

Pure refactor — no behavior change, no OTel yet. Lift the source-of-truth concern so Task 5b can plug OTel in cleanly.

- [ ] introduce a `Source` interface in `src/tracker.ts`: `{ scan(): Promise<RawAggregateBatch>; dispose(): void; }`. Move existing scan logic (discovery + parse + per-file cache) into a `JsonlSource` class that satisfies the interface and accepts the existing constructor args (`storageUri`, etc).
- [ ] `Tracker` constructor accepts a `Source` instance. `Tracker.scan()` delegates to `source.scan()` and applies the existing aggregate-into-`TrackingStats` step. `Tracker.mode: 'files' | 'telemetry'` field — for Task 5a always reports the value passed at construction time (caller decides; will be `'files'` until Task 5b).
- [ ] tests: assert existing tracker behavior is preserved (all current `tracker.test.ts` cases pass without modification, just constructor-call updates). Add one test that injects a mock `Source` and verifies the Tracker calls `scan()` on its source.
- [ ] run `npm test` — must pass before next task. Justification check: the strategy pattern is earning its keep here because (a) two distinct scan implementations have very different cache semantics (mtime-based + LRU vs SQL-row-id-based), (b) it isolates the JSONL polling logic that already shipped in 1.0.1 — breaking the incremental-parsing work is a real regression risk, (c) tests benefit from injecting mock sources. **Concrete collapse trigger:** if `JsonlSource` ends up being a near-copy of current Tracker code with fewer than ~20 lines of net new abstraction (excluding interface declaration), collapse to `if (mode === 'telemetry') scanOTel() else scanJsonl()` inside `Tracker.scan()` and document the simplification in this plan's Progress Tracking section with a `➕` note.

### Task 5b: Add OTelSource + auto-detect on activation + hot-swap

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/tracker.test.ts`
- Modify: `src/config.ts`
- Modify: `src/extension.ts`

Plug the OTel reader into the Source abstraction. Wire detection at activation and config-change hot-swap.

- [ ] in `src/config.ts` add `isOTelDbExporterEnabled(): boolean` reading `github.copilot.chat.otel.dbSpanExporter.enabled`. Add `getEstimationMode(otelReader, configuration): 'files' | 'telemetry'` combining the upstream setting AND `OTelReader.isAvailable()`. Both must be true to return `'telemetry'`. Add `onDidChangeOTelSetting(cb)` thin wrapper over `onDidChangeConfiguration`.
- [ ] create `OTelSource` class in `src/tracker.ts` (or split to `src/otelSource.ts` if `tracker.ts` grows past 700 lines). Constructor accepts the `OTelReader` instance and the current window's session-id resolver (function returning `string[]`). `scan()` calls `readSpansSince(baselineTimestamp, sessionIds)`, aggregates per model into `RawAggregateBatch` (same shape `JsonlSource` produces). Baseline = `getLatestTimestamp()` at construction.
- [ ] **Window scoping caveat documented in code.** Add a comment above `OTelSource`: "Session-id filter is best-effort window scoping. Same-repo dual-window remains last-writer-wins on the tracking file (pre-existing limitation, per CLAUDE.md). A span whose JSONL companion hasn't materialized yet is excluded — acceptable tradeoff." Reference an existing test that confirms this behavior.
- [ ] wire activation in `src/extension.ts`: instantiate `OTelReader` early; call `getEstimationMode` to pick `JsonlSource` or `OTelSource`; construct Tracker with the chosen source + corresponding `mode`. On `onDidChangeOTelSetting` event: dispose old Source, evaluate mode again, construct new Source, swap into Tracker via new `Tracker.swapSource(newSource, newMode)` method. `previousStats` carries over (additive baseline preserved).
- [ ] **Mode-swap user signal.** On first Files→Telemetry auto-swap in a given window session, show a one-time info message: "Switched to Telemetry mode — historical totals stay as-is; new activity uses measured tokens." Store a workspaceState flag so the message appears only once per window.
- [ ] tests: source-swap path preserves cumulative interactions and AIC across swap; Telemetry mode with mocked reader returns measured `cached_tokens`; `getEstimationMode` returns `'files'` when upstream off, `'files'` when upstream on but DB missing (with diagnostic logged), `'telemetry'` when both on; config-change triggers Tracker.swapSource with no loss of `previousStats`; baseline timestamp delta correctness across two consecutive scans.
- [ ] run `npm test` — must pass before next task.

### Task 6: Budget panel QuickPick with toggles

**Files:**
- Modify: `src/extension.ts` (showStats body)
- Create: `src/budgetPanel.ts`
- Create: `src/budgetPanel.test.ts`
- Modify: `package.json` (command title)

Render the toggle panel via codicon-checkbox QuickPick items. Keeps existing `copilot-budget.showStats` command id so keybindings and command-palette references stay valid.

- [ ] create `src/budgetPanel.ts` exporting `showBudgetPanel(ctx: PanelContext): Promise<void>` where `PanelContext` carries the Tracker, current mode, current currency, and `OTelToggleHandler`.
- [ ] panel structure: three rows at top (OTel, currency, commit hook), separator, total + per-model stats rows, separator, "Refresh" action item. Dividers use `kind: vscode.QuickPickItemKind.Separator`. No "Open settings" item (low value; users can use the gear icon if needed).
- [ ] **OTel row — strictly asymmetric.** Read upstream setting `dbSpanExporter.enabled`. If `false`: render `$(circle-large-outline) Enable accurate cost tracking (OTel)`. On accept, call `vscode.workspace.getConfiguration('github.copilot.chat.otel').update('dbSpanExporter.enabled', true, vscode.ConfigurationTarget.Global)`, then show info message *"Accurate cost tracking enabled. Reload window now?"* with `Reload` / `Later` actions. `Reload` invokes `workbench.action.reloadWindow`. If `true`: render `$(check) Accurate cost tracking (OTel) — enabled`. On accept, show info message: *"OTel is already enabled. To disable, use VS Code settings: github.copilot.chat.otel.dbSpanExporter.enabled"* with `Open Settings` button that runs `vscode.commands.executeCommand('workbench.action.openSettings', 'github.copilot.chat.otel.dbSpanExporter.enabled')` — the second arg is the setting query string the command uses to pre-filter the Settings UI. **NEVER write `false` to the upstream setting from this extension.**
- [ ] currency toggle handler: `configuration.update('copilot-budget.displayCurrency', otherValue, ConfigurationTarget.Global)` then rebuild panel. Row label reflects current state: `$(symbol-numeric) Display: AIC (switch to $)` or `$(symbol-numeric) Display: $ (switch to AIC)`.
- [ ] commit hook toggle handler: read current state via `isHookInstalled`; render `$(check) Append AI Credits trailer to commits` or `$(circle-large-outline) Append AI Credits trailer to commits`. On accept, call `installHook` or `uninstallHook` accordingly; rebuild panel.
- [ ] update `package.json` command title for `copilot-budget.showStats` to `"Copilot Budget: Open Panel"` (was `"Show Token Stats"`).
- [ ] panel tests via vscode mock: assert QuickPick items list shape for OTel-off, OTel-on, AIC, USD, hook-installed, hook-not-installed states; assert toggle handlers call expected configuration updates / installHook / uninstallHook stubs; **explicit test: OTel accept path when upstream is already `true` does NOT call `configuration.update`** (the asymmetric invariant — has its own test); explicit test: currency toggle alternates correctly across multiple accepts.
- [ ] run `npm test` — must pass before next task.

### Task 7: Verify acceptance criteria

- [ ] verify Files mode end-to-end: launch Extension Development Host on the *minimum* supported VS Code version (per Task 4 engines.vscode pin), confirm status bar shows tilde-prefixed `~N AIC`, tooltip explains upper-bound estimate, commit trailer reads `Copilot-AI-Credits: ~N`.
- [ ] verify currency toggle: switch to USD via panel, confirm status bar / tooltip / trailer flip to `~$X.XX`; switch back to AIC.
- [ ] verify `node:sqlite` runtime import succeeds on the minimum supported VS Code. Run a small `console.log(require('node:sqlite'))` snippet in extension activation behind a guard, confirm no module-not-found error. Remove the snippet before commit.
- [ ] verify Telemetry mode detection: enable `github.copilot.chat.otel.dbSpanExporter.enabled` in upstream settings, force at least one Copilot Chat interaction to populate the DB, reload window, confirm panel shows OTel row as enabled, status bar drops tilde, tooltip changes wording.
- [ ] verify panel OTel-enable path: start with upstream setting off, click panel row, observe upstream setting becomes true, reload prompt appears.
- [ ] verify panel OTel already-enabled path: with upstream already on, click panel row, observe info message offering to open settings (does NOT write false).
- [ ] verify panel commit hook toggle: install via panel, observe hook file at `<gitdir>/hooks/prepare-commit-msg`; uninstall via panel, observe file removed.
- [ ] verify window-scoping behavior: open two VS Code windows on two *different* repos, run a chat in window A, confirm window B's panel does NOT show window A's spans. Same-repo dual-window remains last-writer-wins on the tracking file (pre-existing limitation — not asserting more than that).
- [ ] verify mode-swap signal: with extension already in Files mode, enable OTel upstream and reload. Confirm one-time info message *"Switched to Telemetry mode..."* appears. Reload again; confirm message does NOT reappear.
- [ ] verify EDH end-to-end: the `MODE=` tolerance test added in Task 3 already covers parser robustness; here just confirm no log spam or warnings when reading a tracking file with `MODE=` present.
- [ ] run full test suite: `npm test`.
- [ ] run lint: `npm run lint`.
- [ ] run build: `npm run compile`.

### Task 8: [Final] Update documentation

- [ ] update `README.md`: add "Accurate vs. estimated" section explaining the tilde signal and how to enable Telemetry mode (one toggle in the panel). Note that prompt content is never read — only aggregate token counts.
- [ ] update `CLAUDE.md`: revise `sessionParser.ts` description (heuristic removed); document new `otelReader.ts`, `budgetPanel.ts`, `amountFormatter.ts` modules; note Node 22 target bump.
- [ ] update the release notes / CHANGELOG headline to lead with *"Accurate cost tracking via Copilot's OTel database (opt-in upstream setting; auto-detected)"*. Internal refactors (heuristic removal, panel UX, currency toggle) listed under that.
- [ ] move this plan to `docs/plans/completed/`.

## Technical Details

**Data flow — Files mode:**
```
chatSessions/*.jsonl  →  sessionParser.ts (heuristic removed)
  → TokenCounts {input: promptTokens, output: outputTokens, cacheRead: 0, cacheCreation: 0}
  → computeCost (existing) → AIC
  → formatAmount(..., mode: 'files') → "~N AIC" or "~$X.XX"
```

**Data flow — Telemetry mode:**
```
agent-traces.db (spans table)
  → otelReader.readSpansSince(baseline, windowSessionIds)
  → SpanRow[] aggregated per model
  → computeCost (existing) → AIC
  → formatAmount(..., mode: 'telemetry') → "N AIC" or "$X.XX"
```

**Settings added:**
| Key | Type | Default | Scope | Purpose |
|---|---|---|---|---|
| `copilot-budget.displayCurrency` | `"aic" \| "usd"` | `"aic"` | application | Display unit |

**Upstream setting we write (strictly asymmetric):**
- `github.copilot.chat.otel.dbSpanExporter.enabled` — only ever set to `true` via our panel; never set to `false`. When OTel is already enabled upstream, our panel directs the user to VS Code settings for disable. No local "consume OTel?" override exists — if the user wants to stop using OTel data, they disable the upstream setting via VS Code settings.

**Tracking file schema changes:**
- `MODE=files|telemetry` line added (machine-readable; not converted to a `TR_` trailer). `parseTrackingFileContent` must silently ignore unknown keys — verify against the existing legacy-key tolerance pattern (per CLAUDE.md, the parser already tolerates legacy `TOTAL_COST_USD` keys by ignoring them; `MODE=` follows the same path).
- `TR_Copilot-AI-Credits` value gets `~` prefix when `mode === 'files'` (the hook copies the value verbatim into the trailer).
- All other keys unchanged. Pre-1.0.x legacy files still parsed.

## Post-Completion

**Manual verification:**
- Test with a freshly-installed Copilot Chat extension where the OTel DB does not yet exist. Confirm Files mode is selected without errors.
- Test enabling OTel via our panel, reloading, running a few chats, reloading again. Confirm Telemetry mode is selected on second load and tokens are measured.
- Test the per-model breakdown on a Gemini-only session in Files vs Telemetry mode — Files mode should overcount by ~4× the Telemetry number (this is the headline correctness improvement worth documenting).

**External system updates:**
- No downstream consumers. Tracking file format is consumed only by our own hook script.
- README screenshot update: status bar showing tilde in Files mode + plain number in Telemetry mode.

**Follow-up work (out of scope):**
- Upstream PR adding cache splits to `chatSessionOperationLog.ts` requestSchema. Would let us drop the OTel dependency entirely for users on a future VS Code release. Separate effort.
- Per-tool cost breakdown: data is in the OTel DB (`operation_name = 'execute_tool'`) but not in v1.1 scope.
