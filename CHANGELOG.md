# Changelog

All notable changes to Copilot Budget will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
