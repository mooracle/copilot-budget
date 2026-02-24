# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Copilot Budget** is a VS Code extension that tracks GitHub Copilot premium request usage and estimated cost per session and optionally appends AI budget git trailers to commit messages. It activates on startup, polls Copilot session files every 120 seconds, and displays premium requests and estimated cost in the status bar.

## Build & Development Commands

```bash
npm run compile          # Build: src/extension.ts → dist/extension.js (esbuild)
npm run watch            # Watch mode with auto-rebuild
npm run lint             # ESLint on src/**/*.ts
npm test                 # Run all Jest tests
npm test -- --watch      # Jest watch mode
npm test -- <pattern>    # Run single test file (e.g. npm test -- tracker)
npm run package          # Create .vsix via @vscode/vsce
```

Debug: Press F5 in VS Code to launch Extension Development Host.

## Architecture

The extension follows a **baseline/delta** model: on activation it snapshots all Copilot session tokens as a baseline, then reports only the delta (tokens used during the current VS Code session).

**Entry point**: `src/extension.ts` — `activate()` initializes SQLite, detects the Copilot plan, creates a `Tracker` with plan info provider, wires up the status bar, registers 5 commands (including showDiagnostics), starts periodic plan refresh, and optionally auto-installs the git hook.

**Core modules** (all in `src/`):

- **tracker.ts** — Central state machine. Polls every 120s, caches parsed results by file mtime, emits `onStatsChanged` events. Returns `TrackingStats` with per-model breakdowns including premium request counts and estimated cost. Tracks per-model interaction counts for premium request calculation.
- **sessionDiscovery.ts** — Finds Copilot session files across VS Code variants (Code, Insiders, VSCodium, Cursor) and platforms (macOS, Linux, Windows, remote/WSL). Scans `globalStorage` and `workspaceStorage` for both `github.copilot-chat/` and `github.copilot/`. Exports `getDiscoveryDiagnostics()` returning platform, homedir, candidate paths, and files found.
- **sessionParser.ts** — Parses two formats: plain JSON sessions and delta-based JSONL (VS Code Insiders). Extracts input/output/thinking tokens per model. Also returns per-model interaction counts (`modelInteractions`) used for premium request calculation.
- **tokenEstimator.ts** — Character-to-token estimation using per-model ratios from `data/tokenEstimators.json`. Fallback ratio: 0.25. Also exports `getPremiumMultiplier(model)` for GitHub Copilot billing multipliers.
- **statusBar.ts** — Status bar item showing premium request count and estimated cost. Quick pick panel with per-model premium request, cost, and token breakdown.
- **trackingFile.ts** — Writes stats to `.git/copilot-budget` in key=value format for the commit hook to read. Includes `PREMIUM_REQUESTS`, `ESTIMATED_COST`, and per-model premium request data.
- **planDetector.ts** — Detects GitHub Copilot plan for accurate cost-per-request calculation. Exports `PlanInfo` type, `PLAN_COSTS` map, `DEFAULT_COST_PER_REQUEST` ($0.04 overage), `detectPlan()`, `getPlanInfo()`, `onPlanChanged()`, `startPeriodicRefresh()`/`stopPeriodicRefresh()`, `disposePlanDetector()`, and `parseApiResponse()`. Detection order: user config (`copilot-budget.plan`) > GitHub API (`copilot_internal/user` with `createIfNone: false`) > default ($0.04). Refreshes every 15 minutes.
- **commitHook.ts** — Installs/uninstalls a POSIX `prepare-commit-msg` hook that reads `.git/copilot-budget` and appends git trailers (`AI-Premium-Requests`, `AI-Est-Cost`, `AI-Model`) to commit messages. Resets the tracking file after appending.
- **sqliteReader.ts** — Reads Copilot sessions from `state.vscdb` SQLite databases using `sql.js` (WASM-based). Exports `initSqlite()`, `readSessionsFromVscdb()`, `isSqliteReady()`, and `disposeSqlite()`. Loads WASM binary from `dist/sql-wasm.wasm` at activation; gracefully degrades if init fails.
- **config.ts** — Wraps `copilot-budget.enabled`, `copilot-budget.commitHook.enabled`, and `copilot-budget.plan` settings. Exports `PlanSetting` type.
- **logger.ts** — Shared OutputChannel logger singleton. Exports `log()` (timestamped append), `getOutputChannel()`, and `disposeLogger()`. Used by sessionDiscovery, tracker, and the diagnostics command.

## Testing

Tests live alongside source files as `*.test.ts`. The `vscode` module is mocked via `src/__mocks__/vscode.ts`. Tests heavily mock `fs`, `sessionDiscovery`, and `sessionParser` to isolate units.

## Key Design Details

- **One runtime dependency: `sql.js`** — WASM-based SQLite reader for `state.vscdb` files. No native modules; the WASM binary (`sql-wasm.wasm`) is copied to `dist/` by esbuild config. All other code uses only Node.js built-ins and the VS Code API.
- **esbuild bundles** to a single `dist/extension.js` (CommonJS, Node 18 target, vscode external). The build also copies `sql-wasm.wasm` to `dist/`.
- The commit hook is pure POSIX shell with no external dependencies.
- Prototype pollution prevention is implemented in the JSONL delta parser.
- The extension makes one optional network call: plan detection queries `https://api.github.com/copilot_internal/user` via `fetch()` (Node 18 built-in) using existing GitHub authentication (`createIfNone: false`, never prompts). Gracefully degrades to the $0.04 overage rate if the call fails. All session data is read from local files.
