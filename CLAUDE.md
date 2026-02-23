# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Copilot Budget** is a VS Code extension that tracks GitHub Copilot token usage per session and optionally appends AI budget info to git commit messages. It activates on startup, polls Copilot session files every 120 seconds, and displays a running token count in the status bar.

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

**Entry point**: `src/extension.ts` — `activate()` creates a `Tracker`, wires up the status bar, registers 5 commands (including showDiagnostics), and optionally auto-installs the git hook.

**Core modules** (all in `src/`):

- **tracker.ts** — Central state machine. Polls every 120s, caches parsed results by file mtime, emits `onStatsChanged` events. Returns `TrackingStats` with per-model breakdowns.
- **sessionDiscovery.ts** — Finds Copilot session files across VS Code variants (Code, Insiders, VSCodium, Cursor) and platforms (macOS, Linux, Windows, remote/WSL). Scans `globalStorage` and `workspaceStorage` for both `github.copilot-chat/` and `github.copilot/`. Exports `getDiscoveryDiagnostics()` returning platform, homedir, candidate paths, and files found.
- **sessionParser.ts** — Parses two formats: plain JSON sessions and delta-based JSONL (VS Code Insiders). Extracts input/output/thinking tokens per model.
- **tokenEstimator.ts** — Character-to-token estimation using per-model ratios from `data/tokenEstimators.json`. Fallback ratio: 0.25.
- **statusBar.ts** — Status bar item + quick pick panel showing per-model breakdown.
- **trackingFile.ts** — Writes stats to `.git/copilot-budget` in key=value format for the commit hook to read.
- **commitHook.ts** — Installs/uninstalls a POSIX `prepare-commit-msg` hook that reads `.git/copilot-budget` and appends token info to commit messages.
- **sqliteReader.ts** — Reads Copilot sessions from `state.vscdb` SQLite databases using `sql.js` (WASM-based). Exports `initSqlite()`, `readSessionsFromVscdb()`, `isSqliteReady()`, and `disposeSqlite()`. Loads WASM binary from `dist/sql-wasm.wasm` at activation; gracefully degrades if init fails.
- **config.ts** — Wraps `copilot-budget.enabled` and `copilot-budget.commitHook.enabled` settings.
- **logger.ts** — Shared OutputChannel logger singleton. Exports `log()` (timestamped append), `getOutputChannel()`, and `disposeLogger()`. Used by sessionDiscovery, tracker, and the diagnostics command.

## Testing

Tests live alongside source files as `*.test.ts`. The `vscode` module is mocked via `src/__mocks__/vscode.ts`. Tests heavily mock `fs`, `sessionDiscovery`, and `sessionParser` to isolate units.

## Key Design Details

- **One runtime dependency: `sql.js`** — WASM-based SQLite reader for `state.vscdb` files. No native modules; the WASM binary (`sql-wasm.wasm`) is copied to `dist/` by esbuild config. All other code uses only Node.js built-ins and the VS Code API.
- **esbuild bundles** to a single `dist/extension.js` (CommonJS, Node 18 target, vscode external). The build also copies `sql-wasm.wasm` to `dist/`.
- The commit hook is pure POSIX shell with no external dependencies.
- Prototype pollution prevention is implemented in the JSONL delta parser.
- The extension never makes network calls — all data is read from local session files.
