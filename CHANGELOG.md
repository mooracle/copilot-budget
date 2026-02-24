# Changelog

All notable changes to Copilot Budget will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Commit hook accumulates premium request and cost totals from previous commits
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
