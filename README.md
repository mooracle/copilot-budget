# Copilot Budget

Track GitHub Copilot token usage and optionally append AI budget info to git commit messages.

## Features

- **Real-time token tracking** — monitors Copilot session files and displays a running token count in the status bar.
- **Per-model breakdown** — see input and output tokens grouped by model (GPT-4o, Claude, Gemini, etc.).
- **Commit hook integration** — automatically appends an `AI Budget:` line to commit messages showing tokens consumed since the last commit.
- **Session-aware** — tracks only tokens used since VS Code was opened (baseline subtraction), so counts reset each session.
- **Lightweight** — polls every two minutes with file-level caching; no network calls.

## Getting Started

1. Install the extension from the VS Code Marketplace (search for **Copilot Budget**).
2. The status bar item appears automatically showing your current token count.
3. Click the status bar item to see a per-model breakdown.
4. (Optional) Enable the commit hook via settings or the command palette to annotate commits.

## Commands

| Command | Description |
|---|---|
| `Copilot Budget: Show Token Stats` | Open a quick pick with total tokens, interaction count, and per-model breakdown |
| `Copilot Budget: Reset Tracking` | Reset the token counter to zero (re-baselines from current session files) |
| `Copilot Budget: Install Commit Hook` | Install the `prepare-commit-msg` hook that appends AI budget info to commits |
| `Copilot Budget: Uninstall Commit Hook` | Remove the Copilot Budget commit hook |

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `copilot-budget.enabled` | boolean | `true` | Enable or disable Copilot Budget token usage tracking |
| `copilot-budget.commitHook.enabled` | boolean | `false` | Automatically install the prepare-commit-msg hook when the extension activates |

## How It Works

1. **Discovery** — On activation, Copilot Budget scans known Copilot session file locations for conversation logs.
2. **Parsing** — Each session file is parsed to extract model names, input/output token counts, and interaction counts. When token counts are not available directly, the extension estimates them from message text length using per-model character-to-token ratios.
3. **Baseline** — A snapshot is taken at startup so only tokens used during the current session are reported.
4. **Polling** — Every two minutes the extension re-scans, using file mtime caching to skip unchanged files.
5. **Commit hook** — When installed, a `prepare-commit-msg` shell script reads the tracking file (`.git/copilot-budget`) and appends per-model token usage to the commit message body. After appending, the hook resets the tracking file so the next commit only includes tokens used since the previous commit.

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

## License

[MIT](LICENSE)
