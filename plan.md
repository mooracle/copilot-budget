# TokenTrack - VS Code Extension Plan

## Context

Build a VS Code extension that tracks GitHub Copilot token usage and optionally appends "AI Budget: MODEL, N tokens" to git commit messages. Based on the reference implementation at [rajbos/github-copilot-token-usage](https://github.com/rajbos/github-copilot-token-usage).

**Two decoupled parts:**
1. **VS Code Extension** - discovers Copilot session files, estimates tokens, writes stats to `.git/tokentrack`
2. **Git `prepare-commit-msg` hook** - reads the tracking file, appends budget line, resets the file

## Architecture

```
Copilot Session Files (on disk)
        ↓
  VS Code Extension (parses, estimates tokens)
        ↓
  .git/tokentrack  ← tracking file (not committed)
        ↓
  prepare-commit-msg hook (reads file, appends to commit msg, resets)
```

## File Structure

```
tokentrack/
├── package.json                  # Extension manifest
├── tsconfig.json
├── esbuild.js
├── .vscodeignore
├── .gitignore
├── .vscode/
│   ├── launch.json               # F5 debug config
│   └── tasks.json
├── src/
│   ├── extension.ts              # Entry point
│   ├── sessionParser.ts          # Parse Copilot session JSON/JSONL (from reference)
│   ├── tokenEstimator.ts         # Character-to-token ratio estimation
│   ├── sessionDiscovery.ts       # Find session files on disk
│   ├── tracker.ts                # Core: baseline/delta tracking logic
│   ├── trackingFile.ts           # Read/write .git/tokentrack
│   ├── statusBar.ts              # Status bar display
│   ├── commitHook.ts             # Install/uninstall the git hook
│   └── config.ts                 # Extension settings
├── data/
│   └── tokenEstimators.json      # Character-to-token ratios per model (from reference)
└── scripts/
    └── prepare-commit-msg        # The git hook script (standalone reference)
```

## Implementation Steps

### Step 1: Project Scaffolding
- [x] `package.json` with commands: `showStats`, `resetTracking`, `installHook`, `uninstallHook`
- [x] Settings: `tokentrack.enabled`, `tokentrack.commitHook.enabled`, `tokentrack.commitHook.format`
- [x] `tsconfig.json`, `esbuild.js`, `.vscodeignore`, `.gitignore`, `.vscode/launch.json`
- [x] Zero runtime dependencies (only Node.js built-ins + VS Code API)

### Step 2: Data Files
- [x] Copy `tokenEstimators.json` from reference (`/Users/mgyk/mooracle/github-copilot-token-usage-ref/src/tokenEstimators.json`)
- [x] 50 models with character-to-token ratios (GPT: 0.25, Claude: 0.24)

### Step 3: `src/config.ts` (~40 lines)
- [x] Typed getters for all extension settings
- [x] Listen for configuration changes

### Step 4: `src/tokenEstimator.ts` (~30 lines)
- [x] `estimateTokensFromText(text, model?)` - look up ratio, return `Math.ceil(text.length * ratio)`
- [x] Adapted from reference `extension.ts:5075-5088`

### Step 5: `src/sessionParser.ts` (~375 lines)
- [x] **Copy directly** from reference `/Users/mgyk/mooracle/github-copilot-token-usage-ref/src/sessionParser.ts`
- [x] Handles both JSON and delta-based JSONL (VS Code Insiders)
- [x] Returns `{ tokens, interactions, modelUsage, thinkingTokens }`
- [x] Includes prototype pollution prevention

### Step 6: `src/sessionDiscovery.ts` (~150 lines)
- [x] Discover Copilot session files from standard locations:
  - macOS: `~/Library/Application Support/Code/User/globalStorage/`
  - Linux: `~/.config/Code/User/globalStorage/`
  - Windows: `%APPDATA%/Code/User/globalStorage/`
- [x] Scan `workspaceStorage/*/chatSessions/`, `globalStorage/github.copilot-chat/`, `emptyWindowChatSessions/`
- [x] Filter out non-session files (embeddings, index, cache, etc.)
- [x] Adapted from reference `extension.ts:4515-4734`

### Step 7: `src/tracker.ts` (~200 lines)
- [x] On activation: scan all sessions → compute **baseline** token snapshot
- [x] Every 2 minutes: re-scan → compute **delta** (current - baseline)
- [x] Delta = "tokens used since tracking started / last reset"
- [x] mtime-based cache (skip unchanged files)
- [x] Emits events when stats change

**TrackingStats interface:**
```typescript
{
  since: string;           // ISO timestamp
  lastUpdated: string;
  models: { [model: string]: { inputTokens: number; outputTokens: number } };
  totalTokens: number;
  interactions: number;
}
```

### Step 8: `src/trackingFile.ts` (~60 lines)
- [x] Write `TrackingStats` to `.git/tokentrack` (key=value plain text format)
- [x] Read/reset the tracking file
- [x] Resolve workspace root via `vscode.workspace.workspaceFolders`

**File format** (`.git/tokentrack`):
```
TOTAL_TOKENS=2800
INTERACTIONS=15
SINCE=2024-01-15T10:30:00Z
MODEL gpt-4o 1500 800
MODEL claude-sonnet-4 500 300
```
- `TOTAL_TOKENS=N` - total estimated tokens
- `INTERACTIONS=N` - number of chat interactions
- `SINCE=ISO` - when tracking started
- `MODEL name inputTokens outputTokens` - per-model breakdown

### Step 9: `src/statusBar.ts` (~60 lines)
- [ ] Right-aligned status bar item: `$(symbol-numeric) TokenTrack: 2,800`
- [ ] Click → quick pick with per-model breakdown
- [ ] Updates on tracker events

### Step 10: `src/commitHook.ts` (~80 lines)
- [ ] `installHook()` - writes `prepare-commit-msg` to `.git/hooks/`
- [ ] `uninstallHook()` - removes it
- [ ] `isHookInstalled()` - checks for marker comment
- [ ] Won't overwrite existing non-TokenTrack hooks (warns user)

**Hook script** is pure POSIX shell (no python3/node dependency):
- Reads `.git/tokentrack` using `grep`/`cut`/`read`
- Lists all models with their token counts
- Appends structured footer, e.g.:
  ```
  AI Budget: gpt-4o 1500, claude-sonnet-4 800 | total: 2800 tokens
  ```
- Resets the tracking file (truncates to empty)
- Silently does nothing if no data exists
- Works on macOS, Linux, and Windows (Git Bash/MINGW)

**Hook script example:**
```sh
#!/bin/sh
# TokenTrack prepare-commit-msg hook
COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"
[ "$COMMIT_SOURCE" = "merge" ] || [ "$COMMIT_SOURCE" = "squash" ] && exit 0

REPO_ROOT="$(git rev-parse --show-toplevel)"
TRACKING_FILE="$REPO_ROOT/.git/tokentrack"
[ -f "$TRACKING_FILE" ] || exit 0

TOTAL=$(grep '^TOTAL_TOKENS=' "$TRACKING_FILE" | cut -d= -f2)
[ -z "$TOTAL" ] || [ "$TOTAL" = "0" ] && exit 0

MODELS=""
while read _ name inp out; do
  MODELS="${MODELS}${MODELS:+, }${name} $((inp + out))"
done <<EOF
$(grep '^MODEL ' "$TRACKING_FILE")
EOF

printf '\n\nAI Budget: %s | total: %s tokens' "$MODELS" "$TOTAL" >> "$COMMIT_MSG_FILE"
: > "$TRACKING_FILE"
```

### Step 11: `src/extension.ts` (~120 lines)
- [ ] `activate()`: init tracker, status bar, register commands, start update timer
- [ ] Auto-install hook if `tokentrack.commitHook.enabled` is true
- [ ] `deactivate()`: final tracking file write, cleanup

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Tracking file location | `.git/tokentrack` | Auto-excluded from VCS, hook finds it via `git rev-parse` |
| Hook parsing | Pure POSIX shell | No runtime deps, cross-platform (Git Bash on Windows), key=value format |
| Tracking file format | Key=value plain text | Parseable with grep/cut/read, no JSON parser needed |
| Token estimation | Character-to-token ratio | Same as reference; no tokenizer dependency |
| Update interval | 2 minutes | Balance responsiveness vs filesystem load |
| No webview | Status bar + quick pick only | MVP simplicity |
| Existing hook handling | Warn, don't overwrite | Respect user's existing hooks (husky, etc.) |

## Verification

1. **Build**: `npm install && npm run compile` - should produce `dist/extension.js`
2. **Debug**: F5 in VS Code → Extension Development Host opens
3. **Status bar**: Should show "TokenTrack: Loading..." then token count after scan
4. **Use Copilot Chat**: Token count should increase on next 2-min refresh
5. **Show Stats**: Command palette → "TokenTrack: Show Token Stats" → shows per-model breakdown
6. **Install Hook**: Command palette → "TokenTrack: Install Commit Hook" → check `.git/hooks/prepare-commit-msg` exists
7. **Commit test**: Make a commit → verify "AI Budget: model, N tokens" appended
8. **Reset**: After commit, tracking file should reset to 0
9. **Package**: `npx vsce package` → produces `.vsix` file
