# Drop SQLite/vscdb reader and dead session-discovery paths

## Overview

VS Code now stores all Copilot chat sessions as JSONL files in `workspaceStorage/<ws>/chatSessions/` (authoritative; the per-workspace `state.vscdb` key `chat.ChatSessionStore.index` lists exactly those session IDs). The `interactive.sessions` key still present in older `state.vscdb` files is a stale legacy mirror — on a migrated machine it holds a strict subset of the JSONL session IDs, all months old.

This refactor removes the dead read paths and their dependencies:
- Delete `src/sqliteReader.ts` + tests and the `sql.js` dependency (drops ~500 KB WASM binary, removes async SQLite init from activation).
- Delete the vscdb scan in `src/sessionDiscovery.ts`.
- Delete the dead workspaceStorage/globalStorage Copilot-chat subdirs that are never populated on current VS Code: `workspaceStorage/*/github.copilot-chat/`, `workspaceStorage/*/github.copilot/`, `globalStorage/github.copilot-chat/`, `globalStorage/github.copilot/`.
- Delete the plain-JSON branch in `src/sessionParser.ts` (only reachable from the deleted vscdb read path).
- Keep the only two paths that still hold real session data: `workspaceStorage/*/chatSessions/*.jsonl` (primary) and `globalStorage/emptyWindowChatSessions/*.jsonl` (workspace-less chats).

**Tradeoff documented**: sessions that exist *only* in `state.vscdb interactive.sessions` (i.e. never migrated to JSONL) will no longer contribute to attribution. On a fully migrated VS Code install these are months-stale and already duplicated to JSONL. The extension's scope is per-commit attribution (see CLAUDE.md + memories), so losing months-old session data has zero practical impact on the next commit's trailer.

Out of scope: any change to the rate card, tracking-file schema, commit hook, status bar, or trailer config. This is purely a discovery/reader cleanup.

## Context (from discovery)

Verified against current source on 2026-05-16, branch `aic-token-cost-tracking`:

- `src/sqliteReader.ts` — Reads `state.vscdb` via `sql.js`. Exports `initSqlite`, `readSessionsFromVscdb`, `isSqliteReady`, `disposeSqlite`. Loads `dist/sql-wasm.wasm` at activation. Sole query: `SELECT value FROM ItemTable WHERE key = 'interactive.sessions'` (`src/sqliteReader.ts:60`).
- `src/sessionDiscovery.ts:122` — `discoverVscdbFiles()` scans `workspaceStorage/*/state.vscdb` across all variant + remote user paths.
- `src/sessionDiscovery.ts:178-209` — `discoverSessionFiles()` scans:
  - `workspaceStorage/*/{chatSessions, github.copilot-chat, github.copilot}` (line 180)
  - `globalStorage/{emptyWindowChatSessions, github.copilot-chat, github.copilot}` (lines 204-206)
- `src/sessionDiscovery.ts:223` — `getDiscoveryDiagnostics()` returns `vscdbFilesFound` alongside `filesFound`.
- `src/tracker.ts:4` — imports `readSessionsFromVscdb`, `isSqliteReady` from sqliteReader.
- `src/tracker.ts:179` — `const vscdbFiles = isSqliteReady() ? discoverVscdbFiles() : []`.
- `src/tracker.ts:227` — `readSessionsFromVscdb(vscdbFile)` returns JSON strings; each is then handed to `parseSessionFileContent(path, content)` with a path that does NOT end in `.jsonl`, exercising the plain-JSON branch of the parser.
- `src/sessionParser.ts:309-313` — `parseSessionFileContent` branches on `sessionFilePath.endsWith('.jsonl')`. The `else` branch parses a plain-JSON session object — only reached via the vscdb path.
- `src/extension.ts` — `activate()` calls `initSqlite()`; `deactivate()` calls `disposeSqlite()`; `showDiagnostics` prints a `Vscdb files found:` block (see CLAUDE.md architecture note).
- `esbuild.js:21-30` — `copyWasm()` copies `node_modules/sql.js/dist/sql-wasm.wasm` to `dist/sql-wasm.wasm`. Called from both build and watch paths.
- `package.json` — `dependencies.sql.js: "^1.14.0"`. No `@types/sql.js` (sql.js ships types or none).
- `CLAUDE.md:30, 43, 54-56` — describes sqliteReader as a core module, sql.js as a runtime dep, the WASM copy step, and lists sqliteReader.ts among host-side modules using Node `fs`.
- `README.md:13` — "SQLite session support" feature bullet.
- `README.md:147` — Discovery paragraph enumerating all scan paths including state.vscdb.
- `README.md:167` — Mentions bundling `sql.js`.

Tests touching the deleted surface:
- `src/sqliteReader.test.ts` — delete entirely.
- `src/sessionDiscovery.test.ts` — has `discoverVscdbFiles` cases and dead-subdir fixtures.
- `src/tracker.test.ts` — has vscdb-path coverage.
- `src/sessionParser.test.ts` — has plain-JSON (non-`.jsonl`) cases reflecting the deleted parser branch.
- `src/extension.test.ts` — asserts `initSqlite`/`disposeSqlite` calls and the `Vscdb files found:` diagnostics line.
- `src/__mocks__/vscode.ts` — no change expected.

## Development Approach

- **Testing approach**: Regular (code first, tests after) — matches the project convention used in the two prior plans in `docs/plans/completed/`.
- Complete each task fully before moving to the next.
- Make small, focused changes; run `npm test` and `npm run lint` after each task.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** — no exceptions.
- **CRITICAL: update this plan file when scope changes during implementation**.
- No backwards-compatibility shims: deletions are clean. Per the existing memory `feedback_keep_scope_tight`, don't reintroduce vscdb as a fallback "for accuracy".

## Testing Strategy

- **Unit tests**: required for every task (alongside source files, `*.test.ts`). When deletion is the only change, the corresponding test deletion is the test deliverable.
- **No e2e tests**: this extension has no Playwright/Cypress suite; UI verification is manual in the Extension Development Host (F5).
- **Build/lint must stay green** after each task: `npm run lint && npm run compile`.
- After Task 4 (the central code deletion), grep checks must confirm no remaining references: `git grep -E 'sql\.js|sqliteReader|vscdb|sql-wasm' src/` returns nothing.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]`): code/test/doc changes inside this repo.
- **Post-Completion** (no checkboxes): manual smoke in Extension Development Host, version bump + marketplace publish (handled as part of a future release).

## Implementation Steps

### Task 1: Remove vscdb scan from session discovery

**Files:**
- Modify: `src/sessionDiscovery.ts`
- Modify: `src/sessionDiscovery.test.ts`

- [x] delete `discoverVscdbFiles()` export from `src/sessionDiscovery.ts`
- [x] drop `vscdbFilesFound` from the `DiscoveryDiagnostics` interface and from `getDiscoveryDiagnostics()`
- [x] in `discoverSessionFiles()`, change the workspaceStorage subdir list from `['chatSessions', 'github.copilot-chat', 'github.copilot']` to `['chatSessions']` (line 180)
- [x] in `discoverSessionFiles()`, drop the two `github.copilot-chat` / `github.copilot` globalStorage entries (lines 205-206); keep only `emptyWindowChatSessions`
- [x] delete tests in `src/sessionDiscovery.test.ts` covering `discoverVscdbFiles` and the four dropped subdir paths; keep tests for `chatSessions/` and `emptyWindowChatSessions/`
- [x] run `npm test && npm run lint` — must pass before next task
  - Scope note: keeping tests green after the sessionDiscovery deletions required minimal surgery in consumers ahead of their assigned tasks: removed `discoverVscdbFiles` import + call from `tracker.ts` (stubbed `vscdbFiles` to `[]`), removed unused `isSqliteReady` import from `tracker.ts`, deleted the `Tracker — vscdb integration` describe block from `tracker.test.ts`, removed `vscdbFilesFound` from mock objects in `extension.test.ts` and the `showDiagnostics command displays vscdb file info` test, removed the `discoverVscdbFiles` mock in `trackingFile.test.ts`, and removed the `Vscdb files found:` block from `extension.ts`. Task 2/4's remaining work (drop `readSessionsFromVscdb` import + processing loop; drop `initSqlite`/`disposeSqlite` wiring) is unaffected.

### Task 2: Remove vscdb reads from the tracker

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/tracker.test.ts`

- [ ] remove the `import { readSessionsFromVscdb, isSqliteReady } from './sqliteReader'` line (`src/tracker.ts:4`)
- [ ] remove the `discoverVscdbFiles()` import if it's still present after Task 1
- [ ] delete the `vscdbFiles` loop and `readSessionsFromVscdb(vscdbFile)` call site (around `src/tracker.ts:179` and `:227`) along with any local variables/branches that exist only to feed it
- [ ] delete vscdb-path tests in `src/tracker.test.ts` (any test mocking `readSessionsFromVscdb`, `isSqliteReady`, or asserting tracker behavior against a plain-JSON session string fed from vscdb)
- [ ] run `npm test && npm run lint` — must pass before next task

### Task 3: Drop the plain-JSON branch of sessionParser

**Files:**
- Modify: `src/sessionParser.ts`
- Modify: `src/sessionParser.test.ts`

- [ ] verify the plain-JSON branch (`src/sessionParser.ts:313` `else` of the `.jsonl` check) has no remaining callers after Task 2 (`git grep` for `parseSessionFileContent` callsites; the only one in tracker.ts should now always pass a `.jsonl` path)
- [ ] if the only difference between the two branches was the `.jsonl` check, drop the conditional and inline the JSONL parser; rename or simplify the function signature only if it tightens the contract (do not introduce a new abstraction layer)
- [ ] delete tests in `src/sessionParser.test.ts` that feed plain-JSON paths (non-`.jsonl`) to the parser; keep all JSONL tests intact
- [ ] confirm `src/sessionParser.test.ts` still covers the vscdb-equivalent metadata cases (server token reads, cache split, malformed metadata) on the JSONL path — these were the substantive checks; the vscdb-string fixture was the same content
- [ ] run `npm test && npm run lint` — must pass before next task

### Task 4: Delete sqliteReader module and wire-up

**Files:**
- Delete: `src/sqliteReader.ts`
- Delete: `src/sqliteReader.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

- [ ] delete `src/sqliteReader.ts` and `src/sqliteReader.test.ts`
- [ ] remove `initSqlite` import + activation call in `src/extension.ts`; remove the `sqliteOk` log line
- [ ] remove `disposeSqlite` import + deactivate call in `src/extension.ts`
- [ ] remove the `Vscdb files found:` block from the `showDiagnostics` command body in `src/extension.ts` (and its surrounding loop over `diag.vscdbFilesFound`)
- [ ] update `src/extension.test.ts`: drop assertions on `initSqlite`/`disposeSqlite` being called; drop assertions on `Vscdb files found:` appearing in diagnostics output
- [ ] grep guard: `git grep -E 'sql\.js|sqliteReader|initSqlite|disposeSqlite|isSqliteReady|readSessionsFromVscdb|discoverVscdbFiles|vscdbFilesFound|sql-wasm' src/` must return nothing
- [ ] run `npm test && npm run lint` — must pass before next task

### Task 5: Drop sql.js dependency and esbuild WASM copy

**Files:**
- Modify: `package.json`
- Modify: `esbuild.js`
- Delete: `dist/sql-wasm.wasm` (regenerated by build; just confirm it does not reappear)

- [ ] remove `"sql.js": "^1.14.0"` from `dependencies` in `package.json`
- [ ] run `npm install` to refresh `package-lock.json`
- [ ] delete the `copyWasm()` function and both call sites (build + watch) in `esbuild.js`
- [ ] run `npm run compile` and confirm `dist/sql-wasm.wasm` is absent (delete it manually if a stale copy lingers from a prior build)
- [ ] run `npm test && npm run lint` — must pass before next task

### Task 6: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] in `CLAUDE.md`:
  - line ~30: drop "initializes SQLite" from the activate() summary
  - line ~43: delete the `sqliteReader.ts` module bullet
  - line ~45: drop sqliteReader from the utils.ts consumer list
  - line ~54: rewrite the "Runtime dependencies" bullet — sql.js is gone; only js-yaml remains
  - line ~55: drop sqliteReader from the host-side modules list (sessionDiscovery.ts is the only one left)
  - line ~56: drop `sql-wasm.wasm` from the esbuild copy description
- [ ] in `README.md`:
  - line ~13: drop the "SQLite session support" feature bullet
  - line ~147: rewrite the Discovery paragraph to reflect the two remaining scan paths (`workspaceStorage/*/chatSessions/`, `globalStorage/emptyWindowChatSessions/`); cite the rationale in one sentence ("VS Code consolidated chat storage to JSONL files; the legacy SQLite path no longer holds active sessions")
  - line ~167: drop the sql.js bundling note; leave the js-yaml line as-is
- [ ] add a `CHANGELOG.md` entry under the unreleased section: "Removed: SQLite/vscdb session reader. VS Code now writes all chat sessions to JSONL files; reading them is sufficient. The `sql.js` dependency and `sql-wasm.wasm` binary are gone, reducing bundle size by ~500 KB."

### Task 7: Verify acceptance criteria

- [ ] `git grep -E 'sql\.js|sqliteReader|vscdb|sql-wasm|interactive\.sessions' src/ esbuild.js package.json` returns nothing
- [ ] `git grep -E 'sql\.js|sqliteReader|vscdb|sql-wasm' CLAUDE.md README.md` returns nothing
- [ ] `npm run lint && npm test && npm run compile` all pass
- [ ] `ls dist/` shows no `sql-wasm.wasm`
- [ ] `node -e "console.log(require('./package.json').dependencies)"` shows only `js-yaml`
- [ ] activation in the Extension Development Host (F5) still discovers sessions from `workspaceStorage/*/chatSessions/` — verified via the `Copilot Budget` Output channel showing non-zero session counts
- [ ] move this plan to `docs/plans/completed/`

## Technical Details

**Discovery surface after this change:**
- `workspaceStorage/<ws>/chatSessions/*.{json,jsonl}` for every variant user path (`Code`, `Code - Insiders`, `Code - Exploration`, `.vscode-server`, `.vscode-server-insiders`, `.vscode-remote`)
- `globalStorage/emptyWindowChatSessions/*.{json,jsonl}` for the same variants

**Parser surface after this change:**
- Single path: JSONL with `result.metadata.{promptTokens, outputTokens, cacheReadTokens?, cacheCreationTokens?}` reads, turn-based cache heuristic, rate-card normalization. No more dual-branch.

**Activation cost reduction:**
- Removed: `initSqlite()` (loads WASM, instantiates sql.js Database constructor). Saves one async init + ~500 KB binary fetch from disk on extension start.
- Removed: `discoverVscdbFiles()` scan of `workspaceStorage/*/state.vscdb` across all variants (was 253 stat()s on this Mac).

## Post-Completion

*Items requiring manual intervention — no checkboxes, informational only.*

**Manual verification:**
- Launch Extension Development Host (F5), open a workspace with prior Copilot chat history, verify the status bar populates and the diagnostics command shows non-empty `Session files found` without any vscdb-related lines.
- Verify on an Insiders profile that workspace-less chats (opened via "New Chat" with no folder) still get attributed — they come from `globalStorage/emptyWindowChatSessions/`.

**External:**
- Marketplace publish: bundle size drops by ~500 KB. No user-facing setting changes; no migration step required.
- If a user has the pre-change extension installed with a `dist/sql-wasm.wasm` left over, the next version replaces it cleanly (esbuild overwrites the dist dir).
