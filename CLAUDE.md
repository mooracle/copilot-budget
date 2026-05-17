# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Copilot Budget** is a VS Code extension that tracks GitHub Copilot token usage and estimated cost in AI Credits (AIC; 1 AIC = $0.01) across sessions and optionally appends AI budget git trailers to commit messages. It activates on startup, restores stats from any previous session, polls Copilot session files every 30 seconds, and displays estimated cost in the status bar. Cost is derived from server-reported token counts and a per-model rate card mirrored from `github/docs:data/tables/copilot/models-and-pricing.yml`.

## Build & Development Commands

```bash
npm run compile          # Build: src/extension.ts → dist/extension.js (esbuild)
npm run watch            # Watch mode with auto-rebuild
npm run lint             # ESLint on src/**/*.ts
npm test                 # Run all Jest tests
npm test -- --watch      # Jest watch mode
npm test -- <pattern>    # Run single test file (e.g. npm test -- tracker)
npm run package          # Create .vsix via @vscode/vsce
npm run update-rates     # Refresh data/models-and-pricing.yml from github/docs upstream
```

The rate card (`data/models-and-pricing.yml`) is a byte-identical mirror of `github/docs:data/tables/copilot/models-and-pricing.yml`. When GitHub publishes new pricing, run `npm run update-rates` and commit the updated YAML alongside the diff so reviewers see the change directly.

Debug: Press F5 in VS Code to launch Extension Development Host.

## Architecture

The extension follows a **baseline/delta** model: on activation it snapshots all Copilot session tokens as a baseline, then reports only the delta (tokens used during the current VS Code session).

**Entry point**: `src/extension.ts` — `activate(context)` branches on `context.storageUri`. When defined (workspace open) it creates a `Tracker(context.storageUri)`, restores previous-session stats from the tracking file (if present), wires up the status bar, registers 5 commands (including showDiagnostics), and optionally auto-installs the git hook. When undefined (empty window) it skips tracker/tracking-file/hook setup entirely, renders a static `$(circle-slash) Copilot Budget` status bar bound to `showDiagnostics`, and registers the other 4 commands as info-message handlers.

**Core modules** (all in `src/`):

- **tracker.ts** — Central state machine. Constructor takes the current window's `storageUri: vscode.Uri | undefined` and stores it for window-scoped discovery. Polls every 30s, caches parsed results by file mtime, emits `onStatsChanged` events. Returns `TrackingStats` with per-model `{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costAic}` plus totals `{totalTokens, interactions, totalAiCredits}` (1 AIC = $0.01). Cost is computed per model via `computeCost` from `tokenRates.ts` and is AIC throughout. Exports `RestoredStats` type for persisted session data. `setPreviousStats(restored)` merges a prior session's stats into the current delta, enabling persistence across restarts.
- **sessionDiscovery.ts** — Discovers Copilot session files for the current window only via `discoverSessionFiles(storageUri)`. Resolves `<workspaceStorage>/<hash>/chatSessions/` from `vscode.Uri.joinPath(storageUri, '..', 'chatSessions')` (one `..` since `storageUri` already points at the extension's subfolder), then scans for `.jsonl` files using `NON_SESSION_PATTERNS` and a zero-byte skip. Legacy plain-`.json` chat sessions (from older Copilot Chat versions) are intentionally excluded since the parser is delta-only. When `storageUri` is undefined returns `[]` (empty window). Exports `getDiscoveryDiagnostics(storageUri)` returning `{platform, homedir, storageUri, chatSessionsDir, filesFound}` — `storageUri`/`chatSessionsDir` are `null` in the empty-window state. No cross-variant scanning, no `emptyWindowChatSessions` fallback — empty-window chats are intentionally not billed.
- **sessionParser.ts** — Parses delta-based JSONL chat session files. Reads server-reported `result.metadata.{promptTokens, outputTokens, cacheReadTokens?, cacheCreationTokens?}` per request. When `cacheReadTokens` is absent, applies a turn-based heuristic (turn 1 = 0% cached, turn 2+ = 75% cached) and derives `inputTokens = promptTokens - cacheRead - cacheCreation`. Normalizes per-request `modelId` via `getRateCard` so aggregation keys match the rate card. Also returns per-model interaction counts (`modelInteractions`) for diagnostics.
- **tokenRates.ts** — Loads and normalizes the per-model rate card from `dist/models-and-pricing.yml` at first use (lazy `fs.readFileSync` + `yaml.load`). At load time each rate field is multiplied by 100 so stored rates are AIC per 1M tokens (the YAML on disk stays USD — byte-identical mirror of upstream). Exports `RateCard` type, `getRateCard(modelId)` (strips `copilot/`, `copilotcli/`, `claude-code/` prefixes, then exact match against normalized ids — no family fallback), `computeCost(modelId, tokens)` returning AIC per `(input × rate.input + cacheRead × rate.cachedInput + cacheCreation × (rate.cacheCreation ?? rate.input) + output × rate.output) / 1e6`, `getDisplayName(modelId)`, and `getAllRates()`. Unknown models return `null`/`0` to avoid silent mispricing.
- **statusBar.ts** — Status bar item showing total estimated cost as `N AIC` (integer, ceil-rounded via `formatAicShort`; `0 AIC` only when truly zero, otherwise `Math.ceil`). Tooltip shows total + per-model rows in AIC (2dp via `formatAic`) plus a heuristic disclosure note. Quick pick panel breaks tokens down per model into input / cache_read / cache_creation / output. No USD anywhere in user-facing surfaces.
- **trackingFile.ts** — Reads and writes stats to `<gitdir>/copilot-budget` in key=value format for the commit hook to read. `writeTrackingFile()` is async and uses `resolveGitDir` (with `vscode.Uri`) and `writeTextFile` from `fsUtils`. Each worktree gets its own tracking file. Schema: `SINCE`, `INTERACTIONS`, `TOTAL_AI_CREDITS`, per-model `MODEL_<sanitized>_{INPUT,OUTPUT,CACHE_READ,CACHE_CREATION}_TOKENS` plus `_COST_AIC`, and `TR_`-prefixed trailer lines. The `TR_` lines are controlled by `getTrailerConfig()` from `config.ts`. Per-model AI Credits trailer uses `getDisplayName()` from `tokenRates.ts` for human-readable model names. When the opt-in `estimatedCost` trailer is enabled, the USD value is derived inline from `totalAiCredits / 100` at trailer-write time. `parseTrackingFileContent(content)` requires at least `SINCE` and `TOTAL_AI_CREDITS`; legacy v0.6.x files containing `TOTAL_COST_USD` / `_COST_USD` keys are tolerated by silently ignoring those keys (cost is re-derived from tokens on the next scan). Pre-0.6 files (no `TOTAL_AI_CREDITS`) return `null`.
- **fsUtils.ts** — Thin wrappers around `vscode.workspace.fs` to avoid repetitive TextEncoder/TextDecoder boilerplate. Exports `readTextFile(uri)`, `writeTextFile(uri, content)`, and `stat(uri)`. All return promises and handle errors gracefully (returning `null` on failure). Used by `gitDir.ts`, `trackingFile.ts`, and `commitHook.ts`.
- **gitDir.ts** — Shared utility for resolving git directories. `resolveGitDir(workspaceRoot: vscode.Uri): Promise<vscode.Uri | null>` follows `.git` files (worktrees, submodules, devcontainers) to the real git dir. `resolveGitCommonDir(workspaceRoot: vscode.Uri): Promise<vscode.Uri | null>` further follows the `commondir` file in worktrees to reach the shared git dir (where hooks live). Uses `fsUtils` helpers for filesystem access via `vscode.workspace.fs`.
- **commitHook.ts** — Installs/uninstalls a POSIX `prepare-commit-msg` hook that reads `copilot-budget` from the git dir and appends git trailers to commit messages. The hook uses a generic `TR_` line protocol: if the tracking file contains any `TR_<name>=<value>` lines, the hook converts them to git trailers via sed (e.g., `TR_Copilot-AI-Credits=42.31` becomes `Copilot-AI-Credits: 42.31`); otherwise it skips. Trailer names are configured in `config.ts` and written by `trackingFile.ts`. All exported functions (`isHookInstalled`, `installHook`, `uninstallHook`) are async. Uses `resolveGitCommonDir` (with `vscode.Uri`) and `readTextFile`/`writeTextFile` from `fsUtils`. Includes a `makeExecutable` helper that uses `fs.chmodSync` for local files and a VS Code shell task for remote filesystems. The hook script uses `git rev-parse --git-dir` at runtime for worktree-safe tracking file resolution. Resets the tracking file after appending.
- **config.ts** — Wraps `copilot-budget.enabled`, `copilot-budget.commitHook.enabled`, and `copilot-budget.commitHook.trailers.*` settings. Exports `TrailerConfig` interface (`{estimatedCost, aiCredits, aiCreditsPerModel}` — each `string | false`) and `getTrailerConfig()`. Defaults: `aiCredits` → `"Copilot-AI-Credits"` (on; primary trailer), `estimatedCost` → `false` (opt-in USD trailer), `aiCreditsPerModel` → `false` (opt-in).
- **utils.ts** — Shared utility helpers. Exports `sanitizeModelName(name)` (replaces non-alphanumeric characters with underscores for key=value tracking file keys) and `errorMessage(err)` (safely extracts a message string from unknown thrown values). Used by `tracker.ts`, `trackingFile.ts`, and `commitHook.ts`.
- **logger.ts** — Shared OutputChannel logger singleton. Exports `log()` (timestamped append), `getOutputChannel()`, and `disposeLogger()`. Used by sessionDiscovery, tracker, and the diagnostics command.

## Testing

Tests live alongside source files as `*.test.ts`. The `vscode` module is mocked via `src/__mocks__/vscode.ts` (includes `workspace.fs`, `Uri.joinPath`, `FileType` enum, `Task`/`ShellExecution` mocks). Tests for workspace-side modules (`gitDir`, `trackingFile`, `commitHook`) mock `./fsUtils` rather than Node.js `fs`. Session discovery and parser tests still mock `fs` directly. Tests heavily use `sessionDiscovery` and `sessionParser` mocks to isolate units.

## Key Design Details

- **Window-scoped discovery** — each VS Code window only scans its own `workspaceStorage/<hash>/chatSessions/` derived from `context.storageUri`. Multi-window users no longer double-count: each window's tracker sees only its own chats and writes only its own deltas to `<gitdir>/copilot-budget`. Same-repo dual-window remains last-writer-wins on the tracking file (shared hash → shared chatSessions dir → shared tracking file path); pre-existing risk, out of scope.
- **Runtime dependency: `js-yaml`** — `js-yaml` (~30 KB minified) parses the bundled rate card at activation.
- **Workspace-side file I/O uses `vscode.workspace.fs`** — Modules that access workspace files (`gitDir.ts`, `trackingFile.ts`, `commitHook.ts`) use `vscode.workspace.fs` via `fsUtils.ts` wrappers, enabling transparent remote filesystem proxying in devcontainers, Codespaces, and SSH Remote. Only `commitHook.ts` retains a Node.js `fs` import for local `chmodSync`. The host-side module `sessionDiscovery.ts` continues to use Node.js `fs` since it reads from the host machine's filesystem.
- **esbuild bundles** to a single `dist/extension.js` (CommonJS, Node 18 target, vscode external). The build also copies `data/models-and-pricing.yml` to `dist/`.
- The commit hook is pure POSIX shell with no external dependencies.
- Prototype pollution prevention is implemented in the JSONL delta parser.
- The extension makes no network calls at runtime. All session data is read from local files; the rate card is shipped in the extension bundle and refreshed by contributors via `npm run update-rates`.
