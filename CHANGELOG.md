# Changelog

All notable changes to Copilot Budget will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.3] - 2026-05-22

Accurate cost tracking via Copilot Chat's OTel database. On first activation in a workspace where `github.copilot.chat.otel.dbSpanExporter.enabled` is unset at both Global and Workspace scope, the extension writes `true` at Workspace scope so Copilot Chat starts emitting spans. An explicit user choice in either scope is respected — the write is strictly asymmetric (only unset → `true`, never any other transition). After auto-enable Copilot Chat typically needs a reload before spans start landing; the status bar renders a clickable `$(refresh) Copilot Budget — reload to start tracking` nudge until the database appears. Per-span `input_tokens` / `output_tokens` / `cached_tokens` / `cache_creation_tokens` are read from the OTel SQLite store at `<globalStorage>/github.copilot-chat/agent-traces.db` via `node:sqlite`.

### Added

- **`autoEnableOTel()` in `config.ts`** — runs once per activation; writes `github.copilot.chat.otel.dbSpanExporter.enabled = true` at Workspace scope only when both Global and Workspace are `undefined`. Failures are caught and logged so a settings-write error cannot block activation.
- **`OTelReader` (`src/otelReader.ts`)** — opens Copilot Chat's `agent-traces.db` readonly via `node:sqlite`. `aggregateSince(sinceMs, sessionIds)` is a single grouped SQL query that returns per-model token sums. Filter is `operation_name = 'chat' AND end_time_ms > ? AND (chat_session_id IN (?, ...) OR EXISTS (SELECT 1 FROM span_attributes WHERE key = 'copilot_chat.parent_chat_session_id' AND value IN (?, ...)))`. The OR-on-parent join captures background "title" subagent spans (gpt-4o-mini) that carry only a parent session id. Zero session ids returns `[]` without touching the DB.
- **Session discovery scans the modern transcripts path first** (`<workspaceStorage>/<hash>/GitHub.copilot-chat/transcripts/`) and merges in legacy `chatSessions/` results (deduped by stem). `discoverSessionIds` returns `string[]` of UUID stems for the OTel session-id SQL filter. Diagnostics surface both directories under `transcriptsDir` / `legacyChatSessionsDir`.
- **`statusBar.setNudge(visible: boolean)`** — renders `$(refresh) Copilot Budget — reload to start tracking` bound to `workbench.action.reloadWindow` when visible; otherwise the normal cost. Activation wires the nudge based on `isOTelDbExporterEnabled() && !reader.isAvailable()`; cleared exactly once via the `onStatsChanged` handler when the DB appears.
- **Squash sums trailers** — `git rebase -i` with `squash` lines now leaves a single summed `Copilot-AI-Credits:` trailer instead of N duplicates. The hook detects interactive rebase via `$GIT_DIR/rebase-merge` (and am-style rebase via `$GIT_DIR/rebase-apply`). `git merge --squash` + `git commit` follows the same sum path via `$2 == squash`. The tracking file is left untouched during a rebase so accumulated usage flushes on the next normal commit. The opt-in aggregate per-model trailer (`Copilot-AI-Credits-Models: A=N,B=M`), the `Copilot-Est-Cost` USD trailer, and renamed trailer keys are left as-is — only the default `Copilot-AI-Credits` total is summed. Plain `git commit --fixup=X` followed by `git rebase --autosquash` loses the fixup's tracked usage; use `--fixup=amend:X` or `--fixup=reword:X` for trailers that survive.
- **Copilot Budget panel** — single QuickPick with codicon-checkbox toggles (currency, commit hook), per-model breakdown, and Refresh. Replaces the old stats quick pick body; reuses the `copilot-budget.showStats` command id so existing keybindings continue to work. Command title is now *"Copilot Budget: Open Panel"*.
- **Currency toggle** — new `copilot-budget.displayCurrency` setting (`"aic"` | `"usd"`, default `"aic"`, application-scoped). All user-facing surfaces route through `formatAmount(amount, { currency, precision })`. USD short rounds up to the next whole cent (`Math.ceil(amountAic) / 100`).

### Changed

- **Cost is measured per-span via OTel.** Token counts come from Copilot Chat's `agent-traces.db`, scoped to the current window via session-id filters. `cache_creation_tokens` is always populated for Claude models.
- **Baseline filter** uses `end_time_ms > ?` (strict, not `>=`). OTel writers materialize spans on `onEnd`, so a request in flight at construction time appears later with a start time that pre-dates the baseline — filtering by end time matches arrival order and pairs cleanly with `MAX(end_time_ms)` as the high-water mark.
- **Commit hook respects `core.hooksPath`.** `resolveHooksDir` reads `core.hooksPath` (resolving relative paths against the worktree root, matching git's own behavior) and falls back to `<gitCommonDir>/hooks` when unset. Install, uninstall, and `isHookInstalled` all stay aligned with where git actually looks (husky, lefthook, custom shared hook dirs).
- **`extensionKind` reordered to `["workspace", "ui"]`** so VS Code prefers the workspace install in remote contexts (SSH, WSL, devcontainers, Codespaces), where both transcripts and the OTel DB live workspace-side. Empty-window activation still falls back to the UI host.
- **esbuild target bumped to Node 22** so `node:sqlite` isn't downcompiled away.

### Breaking

- **Minimum VS Code version is now 1.103** (was 1.85). VS Code 1.103 is the first release bundling Electron 37 / Node 22.17.0, where `node:sqlite` is stable. Pre-1.103 VS Code installs cannot load this extension.
- The old `copilot-budget.showStats` quick pick body is replaced by the Copilot Budget panel. The command id is preserved.
- Explicitly setting `github.copilot.chat.otel.dbSpanExporter.enabled` to `false` (Global or Workspace scope) means Copilot Budget will not have any data to report until you flip it back. The auto-enable does not override explicit `false`.

## [1.0.1] - 2026-05-19

### Fixed

- Extension host freeze reported on some accounts. Session scan is now async with per-file yields and a single-flight mutex; activation no longer blocks on the initial baseline. Files older than `copilot-budget.sessionMaxAgeDays` (default 7) are skipped on discovery.
- Active chat sessions are parsed incrementally — only the new tail is processed on each mtime change, with falls back to full re-parse on truncation or evicted state. Partial trailing lines are held until the next scan completes them.

### Added

- `copilot-budget.sessionMaxAgeDays` setting (default 7).

### Changed

- CI tests against Node 22 and 24; GitHub Actions upgraded.

## [1.0.0] - 2026-05-19

Aligns with GitHub Copilot's usage-based billing model (effective 2026-06-01). Premium-request math is gone; cost is now derived from server-reported token counts against the published per-million-token rate card and displayed in AI Credits (AIC; 1 AIC = $0.01).

### Changed

- Switched from premium-request math to Copilot's usage-based billing model. Cost is derived from server-reported `result.metadata.promptTokens` / `outputTokens` per model against the per-million-token rate card mirrored from `github/docs:data/tables/copilot/models-and-pricing.yml`. When per-message cache split is missing, a 75%-cached-after-turn-1 heuristic is applied.
- AI Credits (AIC; 1 AIC = $0.01) is now the sole cost unit in all in-extension surfaces. Status bar shows integer AIC (ceil-rounded, no "Est" suffix); tooltip, quick pick, and diagnostics output show AIC only. USD is removed from every user-facing surface.
- Rate card USD → AIC conversion happens once at load time in `tokenRates.ts`; `computeCost()` returns AIC directly. The on-disk `data/models-and-pricing.yml` is unchanged (still a byte-identical mirror of upstream USD).
- Rate card is baked at build time: `esbuild.js` converts `data/models-and-pricing.yml` to `dist/models-and-pricing.json` and `tokenRates.ts` loads via `JSON.parse`. `js-yaml` is dev-only and ships nothing in the runtime bundle.
- `Copilot-Est-Cost` USD trailer default flipped from on to off. Users who want USD in commit history must explicitly set `copilot-budget.commitHook.trailers.estimatedCost`. When enabled, the USD value is derived inline from AIC ÷ 100 at trailer-write time.
- Tracking file (`<gitdir>/copilot-budget`) schema replaced. New schema records `SINCE`, `INTERACTIONS`, `TOTAL_AI_CREDITS`, and per-model `MODEL_<name>_{INPUT,OUTPUT,CACHE_READ,CACHE_CREATION}_TOKENS` plus `_COST_AIC` lines. `TOTAL_COST_USD` and per-model `_COST_USD` keys are removed.
- Session discovery is now window-scoped. Each VS Code window scans only its own `workspaceStorage/<hash>/chatSessions/` (derived from `context.storageUri`) instead of every VS Code variant and every workspace globally. Single-window users see no change; multi-window users stop double-counting the same chats across windows.
- Empty windows (no folder open) render a `$(circle-slash) Copilot Budget` status bar with a "no workspace" tooltip. No session scanning is performed, no tracking file is written, and the commit hook is not auto-installed. Commands stay registered: `showDiagnostics` still prints platform/path info; the others surface an "open a folder" info message.
- Polling interval dropped from 120s to 30s so per-commit attribution reflects recent activity without waiting on the next cycle.
- Both status bar items now carry a stable id (`copilot-budget.statusBar`) and display name (`Copilot Budget`) so VS Code's status bar visibility menu shows a labeled entry.
- Tooltip and quick pick no longer carry the heuristic-estimate disclosure line; the breakdown speaks for itself.
- `getDiscoveryDiagnostics()` output shape changed: the old `candidatePaths` list is replaced with `storageUri` and `chatSessionsDir` fields (both `null` in the empty-window state).

### Added

- `Copilot-AI-Credits` git trailer (default-on) — the plan-invariant metric, equal to the AIC cost computed from tokens × per-model rate.
- `Copilot-AI-Credits-Models` git trailer (opt-in) — per-model AI Credits breakdown, sorted by descending credits, using display names from the upstream rate card.
- `Copilot Budget: Toggle Commit Hook` command — the quick pick exposes a single `Commit-Hook: ON|OFF` row that flips `copilot-budget.commitHook.enabled` and installs/uninstalls the hook in one click.

### Fixed

- Multi-window double-counting: opening two repos in two VS Code windows previously billed the same Copilot tokens into both windows' commit trailers because every `Tracker` scanned every session file on disk. Each window now sees only its own chats.

### Removed

- Premium-request tracking and the `Copilot-Premium-Requests` trailer (no compatibility shim).
- Per-model `Copilot-Model` trailer.
- `copilot-budget.plan` setting and GitHub Copilot plan auto-detection (no longer needed under usage-based billing).
- Character-based token estimation (`tokenEstimators.json`); tokens are now read from session JSONL metadata directly.
- USD from status bar text, tooltip, quick pick, diagnostics output, and tracking file. USD survives only as the opt-in `Copilot-Est-Cost` trailer.
- SQLite/vscdb session reader. VS Code now writes all chat sessions to JSONL files; reading them is sufficient. The `sql.js` dependency and `sql-wasm.wasm` binary are gone, reducing bundle size by ~500 KB. Sessions that exist only in legacy `state.vscdb interactive.sessions` (never migrated to JSONL) are no longer attributed; on current VS Code installs these are months-old duplicates of JSONL sessions, so per-commit attribution is unaffected.
- Runtime `js-yaml` dependency (moved to devDependencies; YAML → JSON conversion happens at build time).

### Breaking

- Upgrading from 0.5.x discards the previous tracking file. The counter starts fresh on first launch; pre-1.0 tracking data (premium requests, $0.04/request cost) is not convertible to AIC and is intentionally not migrated.
- The `commitHook.trailers.premiumRequests` and `commitHook.trailers.model` settings are removed.
- The `commitHook.trailers.estimatedCost` setting now defaults to `false`. Users relying on the `Copilot-Est-Cost` trailer in CI/scripts must explicitly enable it by setting the value to `"Copilot-Est-Cost"` (or any custom trailer name).

### Upgrade Notes

- Same-repo dual-window still has last-writer-wins on `<gitdir>/copilot-budget` (two windows on the same folder share a `workspaceStorage` hash, so they share a `chatSessions/` directory and tracking-file path). Pre-existing risk, out of scope for window-scoping.
- Existing `<gitdir>/copilot-budget` files written by the pre-fix global scanner are restored on first activation and may carry inflated numbers from cross-window pollution. Run *Copilot Budget: Reset Tracking* to zero them if accuracy matters for the next commit.

## [0.5.3] - 2026-03-03

### Fixed

- No longer shows "No workspace folder found" error popups when VS Code is opened without a project
- Commit hook auto-install is skipped when no workspace is open

### Changed

- Commit hook auto-install is now disabled by default (`copilot-budget.commitHook.enabled` defaults to `false`)

## [0.5.1] - 2026-02-27

### Fixed

- CI test failure: `sessionDiscovery` Linux path test now clears `XDG_CONFIG_HOME` before running so the mocked `os.homedir()` is used instead of the CI runner's real environment variable

### Changed

- README synced with current project state: added plan options table with per-plan cost details, `settings.json` configuration examples, and comprehensive commit hook workflow documentation with example trailer output

## [0.5.0] - 2026-02-27

### Added

- Stats now persist across VS Code restarts — on activation, the extension restores premium requests, tokens, and interaction counts from the previous session
- Configurable commit trailers — three new settings (`commitHook.trailers.premiumRequests`, `estimatedCost`, `model`) let you rename or disable individual git trailers
- Default trailer prefix changed from `AI-` to `Copilot-` (e.g. `Copilot-Premium-Requests`, `Copilot-Est-Cost`, `Copilot-Model`)

### Changed

- "Reset Tracking" command now also clears restored previous-session stats
- Internal codebase refactored for maintainability: shared utility module, extracted helpers across core modules, simplified control flow, and streamlined test suite

## [0.4.5] - 2026-02-25

### Changed

- Migrated workspace-side file operations (`gitDir.ts`, `trackingFile.ts`, `commitHook.ts`) from Node.js `fs` to `vscode.workspace.fs` for proper devcontainer and remote filesystem support
- New `fsUtils.ts` module providing thin wrappers (`readTextFile`, `writeTextFile`, `stat`) around `vscode.workspace.fs`
- `resolveGitDir()` and `resolveGitCommonDir()` now accept `vscode.Uri` and return `Promise<vscode.Uri | null>`
- `writeTrackingFile()`, `installHook()`, `uninstallHook()`, `isHookInstalled()` are now async
- `deactivate()` is now async
- Commit hook `chmod` on remote filesystems uses a VS Code shell task fallback when `fs.chmodSync` is unavailable

## [0.4.3] - 2026-02-25

### Added

- Worktree, submodule, and devcontainer support — the extension now correctly follows `.git` files to resolve the real git directory
- New `gitDir.ts` module with `resolveGitDir()` and `resolveGitCommonDir()` utilities

### Fixed

- Commit hook now installs to the shared git hooks directory (via `resolveGitCommonDir`), so it works correctly in git worktrees
- Tracking file writes to the worktree-specific git directory, so each worktree tracks independently

## [0.4.2] - 2026-02-24

### Changed

- Commit hook is now refreshed with latest code on every activation when setting is enabled
- `installHook()` silently overwrites an existing Copilot Budget hook instead of re-announcing installation
- Removed redundant `isHookInstalled()` guard from auto-install path — always ensures hook is up to date

## [0.4.1] - 2026-02-24

### Changed

- Status bar shows integer premium requests and one-decimal cost for brevity
- Removed "Copilot" label prefix from status bar item

## [0.3.0] - 2026-02-24

### Added

- Plan-aware cost calculation with automatic GitHub Copilot plan detection via API
- New `copilot-budget.plan` setting to manually select plan (auto/free/pro/pro+/business/enterprise)
- Plan detection with periodic refresh every 15 minutes
- Plan name displayed in quick pick header when detected

### Changed

- Cost calculation now uses plan-specific effective rate instead of fixed $0.04 overage rate
- Commit hook simplified to a dumb pipe (reads tracking file, writes trailers, resets file)
- Removed commit trailer accumulation from hook
- Status bar quick pick shows per-model cost based on detected plan rate

## [0.2.0] - 2026-02-24

### Added

- Premium request tracking based on per-model GitHub Copilot billing multipliers
- Estimated cost calculation at $0.04 per premium request
- Premium multiplier data in `data/tokenEstimators.json` for 30+ models
- Per-model interaction counting in session parser
- SQLite (`state.vscdb`) session reading via `sql.js` (WASM-based, no native modules)
- `state.vscdb` discovery in `workspaceStorage/*/` directories
- Graceful degradation when SQLite initialization fails (JSON/JSONL files still work)
- Diagnostic logging to the "Copilot Budget" Output channel
- `Copilot Budget: Show Diagnostics` command showing scanned paths, discovered files, and current stats
- Session discovery for `globalStorage/github.copilot/` (newer built-in Copilot)
- Session discovery for `workspaceStorage/*/github.copilot-chat/` and `workspaceStorage/*/github.copilot/`
- File deduplication in session discovery

### Changed

- Status bar now shows premium requests and estimated cost instead of raw token count
- Commit hook now uses git trailers (`AI-Premium-Requests`, `AI-Est-Cost`, `AI-Model`) instead of inline text
- Commit hook writes premium request and cost data as git trailers
- Tracking file format extended with `PREMIUM_REQUESTS`, `ESTIMATED_COST`, and per-model premium request data
- Added `sql.js` as the first runtime dependency (WASM-based SQLite)

### Fixed

- Extension showing 0 tokens in devcontainers due to incomplete session file search paths

## [0.1.0] - 2026-02-21

### Added

- Real-time token usage tracking for GitHub Copilot
- Status bar display showing tokens used
- Quick pick panel with detailed session statistics
- Git commit hook to append AI budget info to commit messages
- Commands: Show Token Stats, Reset Tracking, Install/Uninstall Commit Hook
- Configurable enable/disable and auto-hook-install settings
