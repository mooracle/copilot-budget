# Copilot Budget

Track GitHub Copilot token usage and estimated cost, and optionally append AI budget info to git commit messages.

> **Note:** The commit hook is **disabled by default**. Token tracking and the status bar work out of the box; the `prepare-commit-msg` hook that appends `Copilot-AI-Credits` trailers is opt-in. Open the Copilot Budget panel from the status bar to toggle it, or set `copilot-budget.commitHook.enabled` to `true`.

## Features

- **Measured cost tracking** — reads per-span token counts (input, output, cache_read, cache_creation) from Copilot Chat's OTel SQLite store (`agent-traces.db`) and computes cost in AI Credits against the published per-million-token rate card. The upstream OTel exporter is auto-enabled at Workspace scope on first activation; a one-time reload may be required before Copilot Chat starts emitting spans.
- **AI Credits** — cost is reported in AI Credits (1 AIC = $0.01), the unit GitHub Copilot now bills in. The per-token AIC cost is the same for everyone — plans differ only in how many AI Credits are included, an allowance this extension doesn't track.
- **Per-model breakdown** — see AIC cost and input / cache_read / cache_creation / output tokens grouped by model (GPT, Claude, Gemini, etc.) in the status bar tooltip and quick pick panel.
- **Upstream rate card** — per-model rates are a byte-identical mirror of [`github/docs:data/tables/copilot/models-and-pricing.yml`](https://github.com/github/docs/blob/main/data/tables/copilot/models-and-pricing.yml), shipped with the extension.
- **Commit hook integration** — automatically appends configurable git trailers (`Copilot-AI-Credits` on by default; `Copilot-Est-Cost` USD trailer and per-model breakdown are opt-in) to commit messages. Trailer keys can be renamed or individually disabled via settings.
- **Persistent tracking** — stats accumulate across VS Code restarts. The extension writes current stats to a tracking file on every stats update, on a 5-second refresh interval, and on deactivation; on activation it reads them back. Use the "Reset Tracking" command to start fresh.
- **Worktree & submodule support** — correctly follows `.git` files in git worktrees, submodules, and devcontainers for both hook installation and tracking file placement.
- **Lightweight** — polls every 30 seconds with file-level caching; no network calls at runtime.

## Getting Started

1. Install the extension from the VS Code Marketplace (search for **Copilot Budget**).
2. The status bar item appears automatically showing your estimated cost.
3. Click the status bar item to see a per-model breakdown of AIC cost and token counts.
4. The commit hook is **not** installed automatically by default. To enable it, set `copilot-budget.commitHook.enabled` to `true` (see [Commit Hook Workflow](#commit-hook-workflow) below).

## Commands

| Command | Description |
|---|---|
| `Copilot Budget: Open Panel` | Open the QuickPick panel with toggles (currency, commit hook) and per-model breakdown |
| `Copilot Budget: Reset Tracking` | Reset the counter to zero (re-baselines from current session files) |
| `Copilot Budget: Install Commit Hook` | Install the `prepare-commit-msg` hook that appends AI budget info to commits |
| `Copilot Budget: Uninstall Commit Hook` | Remove the Copilot Budget commit hook |
| `Copilot Budget: Toggle Commit Hook` | Flip `copilot-budget.commitHook.enabled` and install/uninstall the hook in one step |
| `Copilot Budget: Show Diagnostics` | Show diagnostic info (scanned paths, discovered files, current stats) in the Output panel |

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `copilot-budget.enabled` | boolean | `true` | Enable or disable Copilot Budget token usage tracking |
| `copilot-budget.sessionMaxAgeDays` | number | `7` | Only scan transcript / chatSessions files modified within this many days. Older session ids are skipped — their spans are already folded into the OTel baseline on first scan, so re-listing them gains nothing and is slow when the chat history is large. Set to `0` to scan everything. |
| `copilot-budget.commitHook.enabled` | boolean | `false` | Automatically install the `prepare-commit-msg` hook when the extension activates |
| `copilot-budget.commitHook.trailers.estimatedCost` | string \| false | `false` | Opt-in git trailer key for estimated USD cost in commit history. Disabled by default. Set to a string (e.g. `"Copilot-Est-Cost"`) to enable. |
| `copilot-budget.commitHook.trailers.aiCredits` | string \| false | `"Copilot-AI-Credits"` | Git trailer key for total AI Credits (1 AIC = $0.01). Set to `false` to disable this trailer. |
| `copilot-budget.commitHook.trailers.aiCreditsPerModel` | string \| false | `false` | Git trailer key for per-model AI Credits breakdown. Disabled by default. Set to a string (e.g. `"Copilot-AI-Credits-Models"`) to enable. |
| `copilot-budget.displayCurrency` | `"aic"` \| `"usd"` | `"aic"` | Unit used for status bar, tooltip, and panel. Trailer values are always bare numbers (AIC for `Copilot-AI-Credits`, USD for the opt-in `Copilot-Est-Cost`) regardless of this setting. Application-scoped (persists across windows). |

### Data Source

Copilot Budget reads measured per-span token counts (`input_tokens`, `output_tokens`, `cached_tokens`, plus `gen_ai.usage.cache_creation.input_tokens` for Claude models) from Copilot Chat's OTel SQLite store at `<globalStorage>/github.copilot-chat/agent-traces.db`. Only aggregate token counts are read — prompt and response content are never touched.

On first activation in a workspace where `github.copilot.chat.otel.dbSpanExporter.enabled` is unset at both Global and Workspace scope, the extension writes `true` at Workspace scope so Copilot Chat starts emitting spans. An explicit user choice (either scope) is preserved — the write is strictly asymmetric (only unset → `true`, never any other transition). To turn the exporter off later, use VS Code Settings; the extension never writes `false`.

After auto-enable, Copilot Chat typically needs a window reload before it begins writing spans. While the database is missing, the status bar renders `$(refresh) Copilot Budget — reload to start tracking` bound to `workbench.action.reloadWindow`. The nudge clears automatically once the database appears.

**Remote development:** the database lives wherever Copilot Chat runs (typically workspace-side). The extension declares `extensionKind: ["workspace", "ui"]` so VS Code prefers the workspace install in devcontainers / SSH Remote / Codespaces, keeping the extension on the same host as the database. If the database remains missing after a reload, check the Output channel for diagnostics.

### Cost Methodology

AIC cost is `(input × rate.input + cache_read × rate.cached_input + cache_creation × (rate.cache_creation ?? rate.input) + output × rate.output) / 1,000,000` per model, summed across models. The upstream rate card publishes USD per million tokens; the extension converts those rates to AIC (× 100) once at load time, so all in-extension cost values are AIC. If the opt-in `Copilot-Est-Cost` trailer is enabled, the USD equivalent is computed from AIC ÷ 100 at trailer-write time.

GitHub Copilot's post-2026-06-01 billing is denominated in AI Credits directly, so the measured AIC matches what Copilot bills. The per-token AIC rate is identical on every plan — plans differ only in the amount of AI Credits included (an allowance this extension does not track).

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

1. **Extension tracks usage** — as you use GitHub Copilot, the extension detects new activity every 30 seconds and updates an internal stats object with per-model token counts and cost.
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

Trailer values are bare two-decimal numbers — the trailer name conveys the unit (AIC).

With the opt-in per-model trailer and the opt-in USD trailer both enabled:

```
feat: add user authentication

Copilot-AI-Credits: 42.31
Copilot-AI-Credits-Models: Claude Sonnet 4.6=40.81,GPT-4.1=1.50
Copilot-Est-Cost: 0.42
```

The per-model trailer value is a comma-separated list of `<model>=<aic>` entries sorted by descending credits, using display names from the upstream rate card. The `Copilot-Est-Cost` value is bare USD (no `$` prefix).

### Hook Skip Conditions

The hook silently does nothing when:

- The commit source is `merge` (merge commits) or `commit` (`git commit --amend`, `-c`, `-C`) — to avoid appending trailers to non-standard commits.
- The tracking file (`.git/copilot-budget`) does not exist.
- The tracking file contains no `TR_` lines — no enabled trailers or no Copilot usage to report.

### Squash and Fixup Behavior

When an interactive rebase is in progress (`git rebase -i` with `squash`/`fixup -c`/`fixup -C`, or any other step that fires the hook), the hook detects the rebase state via `$GIT_DIR/rebase-merge` (or `$GIT_DIR/rebase-apply` for am-style rebase) and switches into sum mode. In sum mode it does **not** consult the tracking file or append fresh trailers. Instead it scans the in-progress message for inherited `Copilot-AI-Credits:` trailer lines (one per squashed commit) and rewrites them as a single summed line at the position of the first occurrence. The tracking file is left untouched so any usage accumulated during the rebase flushes on the next normal commit. `git merge --squash` + `git commit` invokes the hook with `$2 == squash` and follows the same sum path.

Limitations:

- Only the total `Copilot-AI-Credits:` trailer is summed. The opt-in aggregate per-model trailer (`Copilot-AI-Credits-Models: Claude=10.00,GPT=5.00`) is left as-is — N duplicate lines after an N-way squash. Likewise for the opt-in `Copilot-Est-Cost` USD trailer and any user-renamed trailer key (the awk script matches the default name only).
- Plain `git commit --fixup=X` followed by `git rebase --autosquash`: the fixup commit's message (and any trailer the hook wrote into it) is discarded by autosquash, so the rebased commit retains only the original commit's trailer. For trailers that survive the rebase, use `git commit --fixup=amend:X` or `git commit --fixup=reword:X`, whose messages replace or merge into the target commit during autosquash.

### Manual Hook Management

If the hook was not auto-installed (e.g. `commitHook.enabled` is `false`), install or remove it on demand via:

- **Command Palette** → `Copilot Budget: Install Commit Hook`
- **Command Palette** → `Copilot Budget: Uninstall Commit Hook`

> **Note:** If a `prepare-commit-msg` hook already exists that was not installed by Copilot Budget, the install command will not overwrite it. Remove the existing hook first or integrate manually.

### Worktree Support

In git worktrees, the hook is installed in the **common git directory** (shared across worktrees), while the tracking file is written to each **worktree's own git directory**. This means the hook is shared but each worktree tracks its own usage independently.

## Examples

The [`examples/`](examples/) directory contains sample integrations that consume the trailers Copilot Budget writes:

- [`examples/github-actions/pr-title-aic-total.yml`](examples/github-actions/pr-title-aic-total.yml) — GitHub Actions workflow that sums `Copilot-AI-Credits:` trailers across all commits in a pull request and rewrites the PR title as `[N AIC] <original title>`.

## How It Works

1. **Auto-enable** — On activation, the extension calls `inspect(github.copilot.chat.otel.dbSpanExporter.enabled)` and writes `true` at Workspace scope only if both `globalValue` and `workspaceValue` are `undefined`. Explicit user choices are preserved.
2. **Discovery** — The extension scans the current window's `workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/` directory (primary) and `workspaceStorage/<hash>/chatSessions/` (legacy fallback) for session-id stems, deduped by stem. These ids are used as the SQL session-id filter on every read. Each open window tracks its own workspace's usage independently. When VS Code is opened with no folder, no scanning is performed and the status bar shows a visible "no workspace" indicator instead. All discovery activity is logged to the "Copilot Budget" Output channel.
3. **Reading spans** — The extension opens `<globalStorage>/github.copilot-chat/agent-traces.db` read-only via Node 22's `node:sqlite` and runs a single grouped query over `spans`: `SELECT request_model, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cached_tokens) … WHERE operation_name = 'chat' AND end_time_ms > ? AND (chat_session_id IN (?, …) OR EXISTS (parent_chat_session_id IN (?, …)))`. Cache-creation tokens are summed from a `LEFT JOIN span_attributes` on `gen_ai.usage.cache_creation.input_tokens` (there is no `cache_creation_tokens` column on `spans`). The OR-on-parent clause attributes background "title" subagent spans (gpt-4o-mini) to the session that spawned them.
4. **Baseline & Restore** — A `MAX(end_time_ms)` snapshot is taken at startup as the high-water mark so only new activity is counted. If a tracking file from a previous session exists, those stats are restored and merged for continuity across VS Code restarts.
5. **Polling** — Every 30 seconds the extension re-queries the database since the fixed construction-time baseline and computes the per-scan delta in-memory.
6. **Cost computation** — Per-model rates are loaded at runtime from the bundled `models-and-pricing.json`, generated at build time from `data/models-and-pricing.yml` (a byte-identical mirror of `github/docs` upstream), so the runtime bundle has no `js-yaml` dependency. The rate card publishes USD per million tokens; rates are converted to AIC (× 100) once at load time, so all in-extension cost values are AIC. `request_model` values with no rate-card entry (`NULL` or unknown ids) contribute zero cost.
7. **Commit hook** — See [Commit Hook Workflow](#commit-hook-workflow) above for the full details.

## Supported Editors

- Visual Studio Code 1.103+ (Stable) — required for bundled Node ≥ 22.16, where `node:sqlite` is stable.
- Visual Studio Code Insiders
- Visual Studio Code Exploration builds
- VSCodium 1.103+
- Cursor (on a compatible Code base)

Also works in remote environments (Codespaces, WSL, SSH Remote). The extension declares `extensionKind: ["workspace", "ui"]` so VS Code installs it workspace-side in remote contexts, where Copilot Chat's OTel database lives.

## Requirements

- GitHub Copilot extension (provides the session files that Copilot Budget reads)
- VS Code 1.103+ (the extension reads Copilot Chat's OTel database via Node 22's built-in `node:sqlite`)

## Contributing

The per-model rate card lives at `data/models-and-pricing.yml` and is a byte-identical mirror of [`github/docs:data/tables/copilot/models-and-pricing.yml`](https://github.com/github/docs/blob/main/data/tables/copilot/models-and-pricing.yml). When GitHub publishes new pricing, refresh the local copy with:

```bash
npm run update-rates
```

Commit the updated YAML with your change so reviewers can see the diff directly.

## License

[MIT](LICENSE)
