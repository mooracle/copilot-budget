# Copilot Budget

Track GitHub Copilot token usage and estimated cost, and optionally append AI budget info to git commit messages.

## Features

- **Token-based cost tracking** — reads server-reported token counts from Copilot's session JSONL (input, output, cache_read, cache_creation) and computes cost in AI Credits against the published per-million-token rate card. Status bar shows estimated cost as `N AIC`.
- **AI Credits** — cost is reported in AI Credits (1 AIC = $0.01). AIC is the plan-invariant metric — accurate across individual, Pro, Business, and Enterprise users regardless of negotiated USD discounts.
- **Per-model breakdown** — see AIC cost and input / cache_read / cache_creation / output tokens grouped by model (GPT, Claude, Gemini, etc.) in the status bar tooltip and quick pick panel.
- **Upstream rate card** — per-model rates are a byte-identical mirror of [`github/docs:data/tables/copilot/models-and-pricing.yml`](https://github.com/github/docs/blob/main/data/tables/copilot/models-and-pricing.yml), shipped with the extension.
- **Commit hook integration** — automatically appends configurable git trailers (`Copilot-AI-Credits` on by default; `Copilot-Est-Cost` USD trailer and per-model breakdown are opt-in) to commit messages. Trailer keys can be renamed or individually disabled via settings.
- **Persistent tracking** — stats accumulate across VS Code restarts. The extension writes current stats to a tracking file on every stats update, on a 5-second refresh interval, and on deactivation; on activation it reads them back. Use the "Reset Tracking" command to start fresh.
- **Worktree & submodule support** — correctly follows `.git` files in git worktrees, submodules, and devcontainers for both hook installation and tracking file placement.
- **Lightweight** — polls every two minutes with file-level caching; no network calls at runtime.

## Getting Started

1. Install the extension from the VS Code Marketplace (search for **Copilot Budget**).
2. The status bar item appears automatically showing your estimated cost.
3. Click the status bar item to see a per-model breakdown of AIC cost and token counts.
4. The commit hook is **not** installed automatically by default. To enable it, set `copilot-budget.commitHook.enabled` to `true` (see [Commit Hook Workflow](#commit-hook-workflow) below).

## Commands

| Command | Description |
|---|---|
| `Copilot Budget: Show Token Stats` | Open a quick pick with total AIC cost and per-model breakdown |
| `Copilot Budget: Reset Tracking` | Reset the counter to zero (re-baselines from current session files) |
| `Copilot Budget: Install Commit Hook` | Install the `prepare-commit-msg` hook that appends AI budget info to commits |
| `Copilot Budget: Uninstall Commit Hook` | Remove the Copilot Budget commit hook |
| `Copilot Budget: Show Diagnostics` | Show diagnostic info (scanned paths, discovered files, current stats) in the Output panel |

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `copilot-budget.enabled` | boolean | `true` | Enable or disable Copilot Budget token usage tracking |
| `copilot-budget.commitHook.enabled` | boolean | `false` | Automatically install the `prepare-commit-msg` hook when the extension activates |
| `copilot-budget.commitHook.trailers.estimatedCost` | string \| false | `false` | Opt-in git trailer key for estimated USD cost in commit history. Disabled by default. Set to a string (e.g. `"Copilot-Est-Cost"`) to enable. |
| `copilot-budget.commitHook.trailers.aiCredits` | string \| false | `"Copilot-AI-Credits"` | Git trailer key for total AI Credits (1 AIC = $0.01). Set to `false` to disable this trailer. |
| `copilot-budget.commitHook.trailers.aiCreditsPerModel` | string \| false | `false` | Git trailer key for per-model AI Credits breakdown. Disabled by default. Set to a string (e.g. `"Copilot-AI-Credits-Models"`) to enable. |

### Cost Methodology

AIC cost is `(input × rate.input + cache_read × rate.cached_input + cache_creation × (rate.cache_creation ?? rate.input) + output × rate.output) / 1,000,000` per model, summed across models. The upstream rate card publishes USD per million tokens; the extension converts those rates to AIC (× 100) once at load time, so all in-extension cost values are AIC. If the opt-in `Copilot-Est-Cost` trailer is enabled, the USD equivalent is computed from AIC ÷ 100 at trailer-write time.

AIC is plan-invariant — accurate across individual, Pro, Business, and Enterprise plans. GitHub Copilot's post-2026-06-01 billing is denominated in AIC directly, so AIC matches what Copilot bills regardless of any negotiated USD pricing.

When per-message cache split (`cacheReadTokens`) is not reported by Copilot, the extension applies a heuristic: turn 1 is treated as 0% cached, turn 2 onward as 75% cached. Real values may be higher or lower. The status bar tooltip notes that cost is estimated.

### Example `settings.json`

Use all defaults (manually-installed hook, default trailer keys):

```jsonc
// No configuration needed — everything works out of the box.
```

Enable the commit hook and the per-model AI Credits trailer:

```jsonc
{
  "copilot-budget.commitHook.enabled": true,
  "copilot-budget.commitHook.trailers.aiCreditsPerModel": "Copilot-AI-Credits-Models"
}
```

Enable the opt-in USD trailer (off by default):

```jsonc
{
  "copilot-budget.commitHook.trailers.estimatedCost": "Copilot-Est-Cost"
}
```

Rename a trailer:

```jsonc
{
  "copilot-budget.commitHook.trailers.aiCredits": "AI-Credits"
}
```

## Commit Hook Workflow

The commit hook is the mechanism that appends AI budget information as git trailers to your commit messages. Here is the full end-to-end workflow:

### Default Behavior

By default (`copilot-budget.commitHook.enabled: false`), the hook is **not** installed automatically. Enable the setting to have the extension install/refresh a `prepare-commit-msg` hook into `.git/hooks/` on activation.

### Data Flow

1. **Extension tracks usage** — as you use GitHub Copilot, the extension detects new activity every 2 minutes and updates an internal stats object with per-model token counts and cost.
2. **Tracking file is written** — on every stats update and on a 5-second refresh interval, the extension writes current stats to `.git/copilot-budget` in a key=value format. This file contains both raw stats and `TR_`-prefixed lines that encode the trailer data.
3. **You commit** — when you run `git commit`, Git triggers the `prepare-commit-msg` hook.
4. **Hook appends trailers** — the hook reads `.git/copilot-budget`, extracts all `TR_` lines, converts them to git trailers (e.g. `TR_Copilot-AI-Credits=42.31` becomes `Copilot-AI-Credits: 42.31`), and appends them to the commit message.
5. **Hook resets the tracking file** — after appending, the hook truncates `.git/copilot-budget` to zero bytes so the next commit only includes usage since the last commit.
6. **Stats persist** — within 5 seconds the extension detects the truncation, rebases the tracker so future writes only include usage after the commit, and re-writes the tracking file with any new activity already captured by the in-memory tracker.

### What Gets Appended

With default settings, a commit message looks like:

```
feat: add user authentication

Copilot-AI-Credits: 42.31
```

With the opt-in per-model trailer and the opt-in USD trailer both enabled:

```
feat: add user authentication

Copilot-AI-Credits: 42.31
Copilot-AI-Credits-Models: Claude Sonnet 4.6=40.81,GPT-4.1=1.50
Copilot-Est-Cost: $0.42
```

The per-model trailer value is a comma-separated list of `<model>=<aic>` entries sorted by descending credits, using display names from the upstream rate card.

### Hook Skip Conditions

The hook silently does nothing when:

- The commit source is `merge`, `squash`, or `commit` (amend) — to avoid polluting non-standard commits.
- The tracking file (`.git/copilot-budget`) does not exist.
- The tracking file contains no `TR_` lines — no enabled trailers or no Copilot usage to report.

### Manual Hook Management

If the hook was not auto-installed (e.g. `commitHook.enabled` is `false`), install or remove it on demand via:

- **Command Palette** → `Copilot Budget: Install Commit Hook`
- **Command Palette** → `Copilot Budget: Uninstall Commit Hook`

> **Note:** If a `prepare-commit-msg` hook already exists that was not installed by Copilot Budget, the install command will not overwrite it. Remove the existing hook first or integrate manually.

### Worktree Support

In git worktrees, the hook is installed in the **common git directory** (shared across worktrees), while the tracking file is written to each **worktree's own git directory**. This means the hook is shared but each worktree tracks its own usage independently.

## How It Works

1. **Discovery** — On activation, Copilot Budget scans only the current window's `workspaceStorage/<hash>/chatSessions/` directory, derived from the extension's `storageUri`. Each open window tracks its own workspace's usage independently — multi-window setups no longer double-count tokens across windows. When VS Code is opened with no folder, no scanning is performed and the status bar shows a visible "no workspace" indicator instead. All discovery activity is logged to the "Copilot Budget" Output channel.
2. **Parsing** — Each session file is parsed to extract per-request `result.metadata.{promptTokens, outputTokens, cacheReadTokens?, cacheCreationTokens?}`. When the cache split is absent the turn-based heuristic fills it in.
3. **Baseline & Restore** — A token snapshot is taken at startup as a baseline so only new activity is counted. If a tracking file from a previous session exists (written on deactivation), those stats are restored and merged, providing continuity across VS Code restarts.
4. **Polling** — Every two minutes the extension re-scans, using file mtime caching to skip unchanged files.
5. **Cost computation** — Per-model rates are loaded from the bundled `models-and-pricing.yml` (mirror of `github/docs` upstream). The rate card publishes USD per million tokens; rates are converted to AIC (× 100) once at load time, so all in-extension cost values are AIC.
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
- The extension bundles [js-yaml](https://github.com/nodeca/js-yaml) for parsing the rate card. No additional installation is required.

## Contributing

The per-model rate card lives at `data/models-and-pricing.yml` and is a byte-identical mirror of [`github/docs:data/tables/copilot/models-and-pricing.yml`](https://github.com/github/docs/blob/main/data/tables/copilot/models-and-pricing.yml). When GitHub publishes new pricing, refresh the local copy with:

```bash
npm run update-rates
```

Commit the updated YAML with your change so reviewers can see the diff directly.

## License

[MIT](LICENSE)
