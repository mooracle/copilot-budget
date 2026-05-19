# Window-Scoped Session Tracking

## Overview

Today every VS Code window's `Tracker` scans **all** Copilot session files on disk, baselines the global total, and reports deltas of any chat anywhere as its own usage. With two windows open in two repos this double-bills the same tokens into both commit trailers. This plan scopes discovery to the current window's `workspaceStorage/<hash>/chatSessions/` so each window only sees and bills its own chats.

The hash is derived from `vscode.ExtensionContext.storageUri` (canonical, no MD5 reimplementation, matches VS Code's own scheme — including devcontainer-config variants which already get distinct hashes). When the window has no workspace open (`storageUri === undefined`), discovery is disabled entirely and the status bar renders a visible "no workspace" state instead of silently reporting zero.

Rolls out as the only behavior — single-window users see no change (their numbers don't move), multi-window users stop double-counting.

## Context (from discovery)

Files involved:
- `src/sessionDiscovery.ts` — `discoverSessionFiles()` currently walks all VS Code variants and every `workspaceStorage/*/chatSessions/` plus `globalStorage/emptyWindowChatSessions/`. To be replaced with a scoped version that takes a single `chatSessions/` directory derived from `storageUri`.
- `src/tracker.ts` — `scanAll()` calls `discoverSessionFiles()` with no arg. Needs to pass through the scope (storageUri).
- `src/extension.ts` — `activate(context)` doesn't currently use `context.storageUri`. Needs to thread it into the tracker and gate the disabled status bar.
- `src/statusBar.ts` — needs a "disabled / no workspace" render variant.
- `src/__mocks__/vscode.ts` — no `ExtensionContext` shape exposed yet; tests need it for storageUri.
- Tests: `sessionDiscovery.test.ts`, `tracker.test.ts`, `extension.test.ts`, `statusBar.test.ts`.

Patterns found:
- `extensionKind: ["ui", "workspace"]` in `package.json:39-42` — extension runs host-side in devcontainer setups (confirmed by user's logs scanning `/Users/mgyk/Library/Application Support/Code/User`). `context.storageUri` therefore points to the host's `workspaceStorage`, which is exactly where chat session files live.
- Devcontainer variants of the same project already get distinct workspaceStorage hashes (verified: clusternet maps to `ba1a05b62dc46074a825de938b41eb5f`, `637752fff42788e8d3b40557658b8a03`, `d44f3a3b67de608342132fc7b8651755` depending on devcontainer config). Window-scoping naturally isolates each variant.
- `vscode.workspace.fs` wrappers in `fsUtils.ts` are already used by workspace-side code; `sessionDiscovery.ts` continues to use Node `fs` because it reads host-side paths derived from `storageUri.fsPath`.

Dependencies:
- `vscode.ExtensionContext.storageUri` (Uri | undefined)
- `vscode.ExtensionContext.globalStorageUri` (only as reference; not scanned in this plan)
- existing Node `fs` calls in `sessionDiscovery.ts`

## Development Approach

- **testing approach**: Regular (code first, tests follow in the same task) — matches existing repo style.
- complete each task fully before moving to the next
- make small, focused changes
- **every task MUST include new/updated tests**
- **all tests must pass before starting the next task**
- run `npm test` after each task
- maintain backward compatibility — single-window users must see no behavior change

## Testing Strategy

- **unit tests**: required for every task. New tests for the scoped discovery helper, updated tests for Tracker (takes storageUri), new tests for the disabled status bar state, and updated extension activation tests.
- **e2e tests**: project has no Playwright/Cypress harness. Manual verification via `npm run package` + sideloading the VSIX is listed in Post-Completion.
- Mock work: `src/__mocks__/vscode.ts` gains an `ExtensionContext` stub with `storageUri` and `globalStorageUri` fields so tests can simulate workspace / empty-window states.

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps** (`[ ]`): code, tests, doc updates within this repo.
- **Post-Completion** (no checkboxes): manual multi-window verification, VSIX repackage, README/CHANGELOG note for users.

## Implementation Steps

### Task 1: Extend `__mocks__/vscode.ts` with `ExtensionContext`

**Files:**
- Modify: `src/__mocks__/vscode.ts`

This must land first because Tasks 2-4's tests all need a way to construct a mock context with `storageUri`.

- [x] export a helper `createMockExtensionContext({ storageUri?: Uri, globalStorageUri?: Uri }): ExtensionContext` — minimal shape with `subscriptions: []`, `storageUri`, `globalStorageUri`, and any other fields tests already touch
- [x] verify all existing tests still pass — this is purely additive
- [x] run `npm test` — must pass before Task 2

### Task 2: Replace discovery with scoped scan in `sessionDiscovery.ts`

**Files:**
- Modify: `src/sessionDiscovery.ts`
- Modify: `src/sessionDiscovery.test.ts`

- [x] change `discoverSessionFiles()` signature to `discoverSessionFiles(storageUri: vscode.Uri | undefined): string[]`. Single function: when `storageUri` is undefined return `[]`; otherwise derive `chatSessionsDir = Uri.joinPath(storageUri, '..', 'chatSessions').fsPath` and scan it for `.json`/`.jsonl` files using the existing `NON_SESSION_PATTERNS` filter and zero-byte skip. Inline the scan — no separate exported helpers.
- [x] update `getDiscoveryDiagnostics(storageUri)` to return the new shape `{platform, homedir, storageUri: string | null, chatSessionsDir: string | null, filesFound: string[]}`. `storageUri`/`chatSessionsDir` are null in the disabled state.
- [x] delete `getVSCodeUserPaths()`, the `VSCODE_VARIANTS` constant, and the `scanDirectory` helper if unused. Grep first to confirm no remaining callers outside this file.
- [x] clean up now-unused imports (`os`, `path` branching) left over after the deletion — final import list should match what the new code actually uses
- [x] write tests for `discoverSessionFiles`: undefined storageUri → `[]`; valid storageUri with chatSessions dir present → returns its files; valid storageUri with no chatSessions dir → `[]`; skips non-session names; skips zero-byte files
- [x] write a path-derivation assertion test: for `storageUri = file:///path/workspaceStorage/abc123/pub.ext` the resolved dir equals `/path/workspaceStorage/abc123/chatSessions` (catches the one-`..`-vs-two regression)
- [x] write test for `getDiscoveryDiagnostics` in both states (workspace + empty)
- [x] run `npm test` — must pass before Task 3

### Task 3: Thread `storageUri` into `Tracker`

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/tracker.test.ts`

- [x] change `Tracker` constructor to accept `storageUri: vscode.Uri | undefined` and store it as a private field
- [x] update `scanAll()` to call `discoverSessionFiles(this.storageUri)` instead of the no-arg form
- [x] no other Tracker logic changes — baseline / delta / consume mechanics work unchanged on the smaller file set
- [x] update existing Tracker tests to pass a stub Uri in constructor; add a test that confirms `scanAll` is called with the stored storageUri (mock `discoverSessionFiles` and assert the argument)
- [x] add a test for `storageUri: undefined` → `scanAll` returns zero interactions / zero models
- [x] run `npm test` — must pass before Task 4

### Task 4: Gate activation + empty-window status bar in `extension.ts`

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

Merged: the empty-window status bar and the activation branch that registers it land together (they're meaningless apart).

- [x] at `activate(context)`, check `context.storageUri`. If undefined: create a single static `vscode.StatusBarItem` directly (text `$(circle-slash) Copilot Budget`, tooltip `No workspace open — open a folder to track Copilot usage.`, command bound to `copilot-budget.showDiagnostics`), register the 5 commands as info-message handlers (mirror the existing `!isEnabled()` pattern in `extension.ts:60-71`), and skip tracker / tracking-file / hook auto-install entirely. Register the status bar item in `context.subscriptions`.
- [x] when `storageUri` is defined: pass it to `new Tracker(context.storageUri)` and proceed as today.
- [x] `showDiagnostics` command works in both states — pass `context.storageUri` into `getDiscoveryDiagnostics` and update the printout block (`extension.ts:158-181`) to match the new diagnostics shape: print `storageUri`, `chatSessionsDir`, then `filesFound`. Drop the candidate-paths loop.
- [x] do NOT touch `statusBar.ts` — `createStatusBar(tracker)` stays as-is, used only on the workspace path
- [x] write tests for empty-window activation: no tracker started, no tracking file written, static status bar registered with expected text/tooltip, command handlers show info messages, disposal on deactivate.
- [x] write tests for workspace activation: tracker constructed with the storageUri, normal status bar wired up.
- [x] run `npm test` — must pass before Task 5

### Task 5: Verify acceptance criteria

- [x] confirm single-window scenario: open one workspace, check status bar still shows accurate AIC (no regression on the happy path) (skipped - not automatable; requires Extension Development Host)
- [x] confirm two-window scenario: open two different repos, chat in both, verify each window's status bar shows only its own delta (no cross-pollination) (skipped - not automatable; requires Extension Development Host)
- [x] confirm empty-window scenario: open a window with no folder, verify status bar shows "no workspace" and no tracking file is created (skipped - not automatable; requires Extension Development Host)
- [x] confirm devcontainer scenario: re-open clusternet via devcontainer, verify the active hash (`ba1a05b62dc46074a825de938b41eb5f` in user's setup) is the only one scanned per the diagnostics output (skipped - not automatable; requires devcontainer setup)
- [x] run `npm test` (full suite must pass) — 253 tests passed across 12 suites
- [x] run `npm run lint` (must pass) — clean
- [x] run `npm run compile` (must succeed) — Build complete

### Task 6: Documentation + plan completion

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Move: this plan → `docs/plans/completed/20260516-window-scoped-tracking.md`

- [x] update `CLAUDE.md` architecture notes: session discovery is window-scoped via `context.storageUri`; empty windows show a disabled status bar
- [x] update `README.md` (only if it mentions discovery behavior or multi-window) to note that each window tracks its own workspace's usage
- [x] `mkdir -p docs/plans/completed` and `git mv` this plan there

## Technical Details

**Path derivation from `storageUri`:**
```
storageUri      = file:///.../workspaceStorage/<hash>/<publisher>.<ext-id>
parent          = .../workspaceStorage/<hash>
chatSessionsDir = .../workspaceStorage/<hash>/chatSessions
```
Use `vscode.Uri.joinPath(storageUri, '..', 'chatSessions')` — **one** `..`, since `storageUri` already points at the extension's subfolder inside `<hash>/`. A unit test must assert the exact resolved path equals `<workspaceStorage>/<hash>/chatSessions` for a sample input so this never regresses.

**`storageUri` lifetime:** fixed for a window's lifetime — VS Code does not change it without restarting the extension host. No mid-session cache invalidation needed.

**`commitHook.ts` and `trackingFile.ts` impact:** none required. Both already resolve `<gitdir>/copilot-budget` per-worktree from the workspace root (CLAUDE.md confirms). Window-scoping the tracker only changes what the tracker counts; it does not change where stats are persisted.

**`DiscoveryDiagnostics` shape change:**
```ts
// before
{ platform, homedir, candidatePaths: {path, exists}[], filesFound: string[] }
// after
{ platform, homedir, storageUri: string | null, chatSessionsDir: string | null, filesFound: string[] }
```
`extension.ts:154-185` (the `showDiagnostics` command) must be updated in the same task to print the new fields. `storageUri === null` and `chatSessionsDir === null` indicate the disabled (no-workspace) state.

**Why no `emptyWindowChatSessions` fallback:** the user chose to render a disabled status bar instead. Net effect: when `storageUri === undefined`, the tracker doesn't run, no scanning happens, no tracking file is written. Empty-window chats simply aren't billed — which is more honest than the previous "scan everything globally" behavior.

**Multi-root workspaces:** VS Code allocates a single `workspaceStorage/<hash>` per multi-root workspace (hash of the `.code-workspace` URI, not of individual roots). The single storageUri-derived chatSessionsDir handles this case for free — no special logic needed.

**Worktrees:** each window opens a distinct directory → distinct workspaceStorage hash → distinct chatSessions/ scan. No special handling.

**Devcontainer configs:** different devcontainer config = different remote-URI fingerprint = different hash. Window-scoping picks the active one automatically.

**Same-repo dual-window edge case:** two windows on the same folder share the same workspaceStorage hash, so they share the same chatSessions/. Both trackers will see the same files; both will write to the same `<gitdir>/copilot-budget` (last writer wins). This is an unchanged pre-existing risk; not in scope here. Documented in CLAUDE.md.

## Post-Completion

**Manual verification** (no automated harness for these):
- two-window double-counting fix: open repo A and repo B in separate windows, run a Copilot chat in each, wait ≥2 min, confirm each window's status-bar AIC reflects only its own chat (compare to old behavior where both inflated).
- devcontainer hash isolation: open clusternet via two different devcontainer configs in two windows; confirm each reports independently.
- disabled status bar UX: open VS Code with no folder, confirm the status bar reads "no workspace" and clicking it shows the explanatory info message.

**External system updates**:
- bump version in `package.json` (multi-window behavior change is worth a minor bump).
- add a CHANGELOG entry noting:
  - window-scoped tracking (per-window AIC instead of cross-window aggregate)
  - empty-window shows a visible "no workspace" status bar; no scanning, no tracking file write
  - same-repo dual-window still has last-writer-wins on `<gitdir>/copilot-budget` (pre-existing, out of scope)
  - **upgrade note**: existing `<gitdir>/copilot-budget` tracking files written by the old global scanner will be restored via `setPreviousStats` on first activation after upgrade. Those restored numbers may include cross-window pollution from before the fix; users can run *Copilot Budget: Reset Tracking* to zero them.
- repackage VSIX (`npm run package`) for distribution.
