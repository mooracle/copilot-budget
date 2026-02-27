# Copilot Budget

Track GitHub Copilot token usage and optionally append AI budget info to git commit messages.

## Features

- **Premium request tracking** — calculates premium request consumption per model using GitHub Copilot's billing multipliers and displays premium requests and estimated cost in the status bar.
- **Per-model breakdown** — see premium requests, estimated cost, and input/output tokens grouped by model (GPT-4o, Claude, Gemini, etc.).
- **Plan-aware cost calculation** — automatically detects your GitHub Copilot plan (Free, Pro, Pro+, Business, Enterprise) via the GitHub API for accurate per-request cost. Can also be configured manually. Falls back to the $0.04 overage rate when the plan cannot be determined.
- **Commit hook integration** — automatically appends configurable git trailers (by default `Copilot-Premium-Requests` and `Copilot-Est-Cost`) to commit messages. Trailer keys can be renamed or individually disabled via settings.
- **Persistent tracking** — stats accumulate across VS Code restarts. On deactivation the extension writes current stats to a tracking file; on activation it reads them back. Use the "Reset Tracking" command to start fresh.
- **SQLite session support** — reads Copilot sessions from `state.vscdb` databases, catching sessions that only exist in SQLite after recent Copilot storage migrations.
- **Worktree & submodule support** — correctly follows `.git` files in git worktrees, submodules, and devcontainers for both hook installation and tracking file placement.
- **Lightweight** — polls every two minutes with file-level caching; one optional API call for plan detection.

## Getting Started

1. Install the extension from the VS Code Marketplace (search for **Copilot Budget**).
2. The status bar item appears automatically showing your premium request consumption and estimated cost.
3. Click the status bar item to see a per-model breakdown of premium requests, cost, and token counts.
4. The commit hook is installed automatically on activation. To disable it, set `copilot-budget.commitHook.enabled` to `false` in settings.

## Commands

| Command | Description |
|---|---|
| `Copilot Budget: Show Token Stats` | Open a quick pick with premium requests, estimated cost, and per-model breakdown |
| `Copilot Budget: Reset Tracking` | Reset the token counter to zero (re-baselines from current session files) |
| `Copilot Budget: Install Commit Hook` | Install the `prepare-commit-msg` hook that appends AI budget info to commits |
| `Copilot Budget: Uninstall Commit Hook` | Remove the Copilot Budget commit hook |
| `Copilot Budget: Show Diagnostics` | Show diagnostic info (scanned paths, discovered files, current stats) in the Output panel |

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `copilot-budget.enabled` | boolean | `true` | Enable or disable Copilot Budget token usage tracking |
| `copilot-budget.commitHook.enabled` | boolean | `true` | Automatically install the prepare-commit-msg hook when the extension activates |
| `copilot-budget.commitHook.trailers.premiumRequests` | string \| false | `"Copilot-Premium-Requests"` | Git trailer key for premium request count. Set to `false` to disable. |
| `copilot-budget.commitHook.trailers.estimatedCost` | string \| false | `"Copilot-Est-Cost"` | Git trailer key for estimated cost. Set to `false` to disable. |
| `copilot-budget.commitHook.trailers.model` | string \| false | `false` | Git trailer key for per-model breakdown. Set to `false` to disable. |
| `copilot-budget.plan` | string | `"auto"` | GitHub Copilot plan for cost calculation. Options: `auto` (detect via GitHub API), `free`, `pro`, `pro+`, `business`, `enterprise` |

## How It Works

1. **Discovery** — On activation, Copilot Budget scans known Copilot session file locations for conversation logs, including `globalStorage/github.copilot-chat/`, `globalStorage/github.copilot/`, `workspaceStorage/*/github.copilot-chat/`, `workspaceStorage/*/github.copilot/`, and `workspaceStorage/*/chatSessions/`. It also reads `state.vscdb` SQLite databases in `workspaceStorage/*/` to catch sessions stored only in SQLite. All discovery activity is logged to the "Copilot Budget" Output channel.
2. **Parsing** — Each session file is parsed to extract model names, input/output token counts, and interaction counts. When token counts are not available directly, the extension estimates them from message text length using per-model character-to-token ratios.
3. **Baseline & Restore** — A token snapshot is taken at startup as a baseline so only new activity is counted. If a tracking file from a previous session exists (written on deactivation), those stats are restored and merged, providing continuity across VS Code restarts.
4. **Polling** — Every two minutes the extension re-scans, using file mtime caching to skip unchanged files.
5. **Plan detection** — The extension detects your GitHub Copilot plan to determine the effective cost per premium request. It first checks the `copilot-budget.plan` setting; if set to `auto`, it queries the GitHub API using existing authentication. The plan is refreshed every 15 minutes. If detection fails, it falls back to the $0.04 overage rate.
6. **Commit hook** — When installed, a `prepare-commit-msg` shell script reads the tracking file (`.git/copilot-budget`) and appends configurable git trailers to the commit message. By default it appends `Copilot-Premium-Requests` and `Copilot-Est-Cost`; the per-model trailer is disabled by default. Trailer keys can be customized or disabled individually via `copilot-budget.commitHook.trailers.*` settings. After appending, the hook resets the tracking file so the next commit only includes usage since the previous commit.

> **Note:** If a `prepare-commit-msg` hook already exists that was not installed by Copilot Budget, the install command will not overwrite it. Remove the existing hook first or integrate manually.

## Supported Editors

- Visual Studio Code 1.85+ (Stable)
- Visual Studio Code Insiders
- Visual Studio Code Exploration builds
- VSCodium
- Cursor

Also works in remote environments (Codespaces, WSL, SSH Remote).

## Requirements

- GitHub Copilot extension (provides the session files that Copilot Budget reads)
- The extension bundles [sql.js](https://github.com/sql-js/sql.js) for reading SQLite-based session storage. No additional installation is required.

## License

[MIT](LICENSE)
