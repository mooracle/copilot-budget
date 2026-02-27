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
4. The commit hook is installed automatically on activation (see [Commit Hook Workflow](#commit-hook-workflow) below). To disable it, set `copilot-budget.commitHook.enabled` to `false`.

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
| `copilot-budget.commitHook.enabled` | boolean | `true` | Automatically install the `prepare-commit-msg` hook when the extension activates |
| `copilot-budget.commitHook.trailers.premiumRequests` | string \| false | `"Copilot-Premium-Requests"` | Git trailer key for premium request count. Set to `false` to disable this trailer. |
| `copilot-budget.commitHook.trailers.estimatedCost` | string \| false | `"Copilot-Est-Cost"` | Git trailer key for estimated cost. Set to `false` to disable this trailer. |
| `copilot-budget.commitHook.trailers.model` | string \| false | `false` | Git trailer key for per-model breakdown. Disabled by default. Set to a string (e.g. `"Copilot-Model"`) to enable. |
| `copilot-budget.plan` | string | `"auto"` | GitHub Copilot plan for cost calculation. See [Plan Options](#plan-options) below. |

### Plan Options

The `copilot-budget.plan` setting determines the cost-per-request used for estimated cost calculation. The default is `"auto"`, which auto-detects via the GitHub API.

| Value | Monthly Price | Included Requests | Cost per Request |
|---|---|---|---|
| `"auto"` | — | — | Auto-detect via GitHub API; falls back to $0.04/request if unavailable |
| `"free"` | $0 | 50 | $0.00 |
| `"pro"` | $10 | 300 | $0.0333 |
| `"pro+"` | $39 | 1,500 | $0.0260 |
| `"business"` | $19 | 300 | $0.0633 |
| `"enterprise"` | $39 | 1,000 | $0.0390 |

### Example `settings.json`

Use all defaults (auto-detect plan, auto-install hook, default trailer keys):

```jsonc
// No configuration needed — everything works out of the box.
```

Manually set the plan and rename a trailer:

```jsonc
{
  "copilot-budget.plan": "pro",
  "copilot-budget.commitHook.trailers.estimatedCost": "AI-Cost"
}
```

Enable the per-model trailer:

```jsonc
{
  "copilot-budget.commitHook.trailers.model": "Copilot-Model"
}
```

Disable the commit hook entirely:

```jsonc
{
  "copilot-budget.commitHook.enabled": false
}
```

Disable only the estimated cost trailer (keep premium requests):

```jsonc
{
  "copilot-budget.commitHook.trailers.estimatedCost": false
}
```

## Commit Hook Workflow

The commit hook is the mechanism that appends AI budget information as git trailers to your commit messages. Here is the full end-to-end workflow:

### Default Behavior

By default (`copilot-budget.commitHook.enabled: true`), the extension **automatically installs** a `prepare-commit-msg` hook into `.git/hooks/` when it activates. No manual action is required.

### Data Flow

1. **Extension tracks usage** — as you use GitHub Copilot, the extension detects new activity every 2 minutes and updates an internal stats object with per-model token counts, premium requests, and estimated cost.
2. **Tracking file is written** — on every stats update (and every poll cycle), the extension writes current stats to `.git/copilot-budget` in a key=value format. This file contains both raw stats and `TR_`-prefixed lines that encode the trailer data.
3. **You commit** — when you run `git commit`, Git triggers the `prepare-commit-msg` hook.
4. **Hook appends trailers** — the hook reads `.git/copilot-budget`, extracts all `TR_` lines, converts them to git trailers (e.g. `TR_Copilot-Premium-Requests=15.00` becomes `Copilot-Premium-Requests: 15.00`), and appends them to the commit message.
5. **Hook resets the tracking file** — after appending, the hook truncates `.git/copilot-budget` so the next commit only includes usage since the last commit.
6. **Stats persist** — the extension re-writes the tracking file on the next poll cycle with any new activity that occurred after the commit.

### What Gets Appended

With default settings, a commit message looks like:

```
feat: add user authentication

Copilot-Premium-Requests: 15.00
Copilot-Est-Cost: $0.50
```

With the optional model trailer enabled (`"copilot-budget.commitHook.trailers.model": "Copilot-Model"`):

```
feat: add user authentication

Copilot-Premium-Requests: 15.00
Copilot-Est-Cost: $0.50
Copilot-Model: claude_sonnet_4 1250/3800/1.00
Copilot-Model: gpt_4o 800/2100/0.00
```

The model trailer format is `<model> <input_tokens>/<output_tokens>/<premium_requests>`.

### Hook Skip Conditions

The hook silently does nothing when:

- The commit source is `merge`, `squash`, or `commit` (amend) — to avoid polluting non-standard commits.
- The tracking file (`.git/copilot-budget`) does not exist.
- The `PREMIUM_REQUESTS` value is empty, `0`, or `0.00` — no Copilot usage to report.

### Manual Hook Management

If the hook was not auto-installed (e.g. you disabled `commitHook.enabled` and later want it), use:

- **Command Palette** → `Copilot Budget: Install Commit Hook`
- **Command Palette** → `Copilot Budget: Uninstall Commit Hook`

> **Note:** If a `prepare-commit-msg` hook already exists that was not installed by Copilot Budget, the install command will not overwrite it. Remove the existing hook first or integrate manually.

### Worktree Support

In git worktrees, the hook is installed in the **common git directory** (shared across worktrees), while the tracking file is written to each **worktree's own git directory**. This means the hook is shared but each worktree tracks its own usage independently.

## How It Works

1. **Discovery** — On activation, Copilot Budget scans known Copilot session file locations for conversation logs, including `globalStorage/github.copilot-chat/`, `globalStorage/github.copilot/`, `workspaceStorage/*/github.copilot-chat/`, `workspaceStorage/*/github.copilot/`, and `workspaceStorage/*/chatSessions/`. It also reads `state.vscdb` SQLite databases in `workspaceStorage/*/` to catch sessions stored only in SQLite. All discovery activity is logged to the "Copilot Budget" Output channel.
2. **Parsing** — Each session file is parsed to extract model names, input/output token counts, and interaction counts. When token counts are not available directly, the extension estimates them from message text length using per-model character-to-token ratios.
3. **Baseline & Restore** — A token snapshot is taken at startup as a baseline so only new activity is counted. If a tracking file from a previous session exists (written on deactivation), those stats are restored and merged, providing continuity across VS Code restarts.
4. **Polling** — Every two minutes the extension re-scans, using file mtime caching to skip unchanged files.
5. **Plan detection** — The extension detects your GitHub Copilot plan to determine the effective cost per premium request. It first checks the `copilot-budget.plan` setting; if set to `auto`, it queries the GitHub API using existing authentication. The plan is refreshed every 15 minutes. If detection fails, it falls back to the $0.04 overage rate.
6. **Commit hook** — See [Commit Hook Workflow](#commit-hook-workflow) above for the full details.

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
