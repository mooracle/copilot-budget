# Security Hardening from Oplane Threat Model

## Overview

Close the four security gaps identified in the baseline Oplane threat model
(`e4f0ed9e-65e1-4557-bea7-10e67e93d4c7`) for the Copilot Budget VS Code
extension. Each fix is a discrete, independently committable change.

> **Guiding principle:** these are security hardenings and must **not change
> the extension's working flow** for legitimate users. Each fix is
> defense-in-depth that blocks attack-shaped input only — no behavior change
> for normal use (existing trailer settings, git worktrees, the empty-string
> opt-out idiom, etc. all keep working exactly as they do today).

| Priority | Requirement | Current state | Target state |
|---|---|---|---|
| 1 | OPLANE_REQ-00040973 + 00040968 — trailer-name allow-list | Deny-list strips only `[\n\r=/\\]` | Strict allow-list `^[A-Za-z0-9][A-Za-z0-9_-]*$`; reject mismatches → fall back to default |
| 2 | OPLANE_REQ-00040970 — WASM integrity check | No verification of `sql-wasm.wasm` | Build-time SHA-256 injected via esbuild `define`; verified before `initSqlJs` |
| 3 | OPLANE_REQ-00040972 — logger redaction | Verbatim passthrough | Strip Bearer tokens, `gh{p,o,u,s,r}_*` PATs, replace `$HOME` with `~` |
| 4 | OPLANE_REQ-00040967 — path bounds | No traversal/symlink guards | Normalize + bound `gitdir:` redirect; assert tracking file is under git dir |

## Context (from discovery)

**Files involved:**
- `src/config.ts:29-34` — `sanitizeTrailerKey()` (deny-list)
- `src/logger.ts:12-16` — `log()` passthrough
- `src/sqliteReader.ts:21-37` — `initSqlite()` reads WASM via `fs.readFileSync`
- `esbuild.js:20-29` — `copyWasm()` copies `sql-wasm.wasm` from node_modules
- `src/gitDir.ts:10-31` — `resolveGitDir()` follows `gitdir:` redirect (no bounds)
- `src/trackingFile.ts:8-14` — `getTrackingFileUri()` builds write target

**Patterns found:**
- Workspace I/O routes through `fsUtils.ts` (`readTextFile`, `writeTextFile`, `stat`) backed by `vscode.workspace.fs`. Host-side I/O uses Node `fs` directly.
- All log calls use `log()` from `src/logger.ts`. There is no second logging surface.
- esbuild config is small and self-contained (`esbuild.js`); already does pre/post copy of the WASM artifact.
- Tests live alongside source as `*.test.ts`. `vscode` is mocked via `src/__mocks__/vscode.ts`. Workspace-side modules mock `./fsUtils`, host-side modules mock `fs` directly.

**Dependencies:**
- Only one runtime dep: `sql.js`. No new runtime deps will be added.
- Build deps: `esbuild`, `jest`, `@vscode/vsce`, `@types/*`, `eslint`. Node 18 stdlib provides `crypto.createHash` for the WASM hash — no new build dep needed.

## Development Approach

- **Testing approach:** Regular — implementation first, then unit tests in the same task.
- Complete each task fully before moving to the next.
- Make small, focused changes; one commit per task.
- **CRITICAL: every task MUST include new/updated tests.** Tests are not optional.
- **CRITICAL: all tests must pass before starting next task.**
- Run `npm test` and `npm run lint` after each task.
- Maintain backward compatibility (existing default trailer names match the new allow-list; existing tracking file format is unchanged).

## Testing Strategy

- **Unit tests (Jest):** required for every task. Place alongside source as `*.test.ts`.
- **No e2e tests:** this project has no Playwright/Cypress harness. Manual verification (Extension Dev Host with `F5`) covers integration points and is listed in Post-Completion.
- For each task, cover both the happy path and at least one rejection / failure path (allow-list mismatch, hash mismatch, redaction trigger, path escape).

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Update plan file when scope shifts.

## What Goes Where

- **Implementation Steps** — code, tests, docs reachable inside the repo.
- **Post-Completion** — manual Extension Dev Host smoke test, optional npm-update audit playbook.

## Implementation Steps

### Task 1: Trailer-name allow-list

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] Replace `sanitizeTrailerKey` body (`src/config.ts:29-34`) with the following decision order. **Empty string remains the user-facing opt-out idiom** (existing behavior — must not regress):
  1. If value is `false`, return `false`.
  2. If not a string, return `fallback`.
  3. If value is `''` (or whitespace-only), return `false` — preserves the existing opt-out shortcut.
  4. If matches `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`, return value.
  5. Otherwise return `fallback` (the `model` trailer's fallback is `false`, so opt-out is preserved there too).
- [ ] Verify the two default trailer names (`Copilot-Premium-Requests`, `Copilot-Est-Cost`) still pass the regex; the optional `model` trailer remains `false` by default; the existing `'' → false` opt-out shortcut is preserved.
- [ ] Add `src/config.test.ts` cases: accepts `Copilot-Premium-Requests`, accepts `X-Foo_bar-1`, rejects `Bad$Name` (returns fallback), rejects `;rm -rf` (returns fallback), rejects leading hyphen / underscore (must start alphanumeric), `'' → false` (opt-out shortcut preserved), `'   ' → false` (whitespace-only also opt-out), explicit `false` for the optional `model` trailer is preserved (no default leak).
- [ ] Update existing `sanitizeTrailerKey` tests that relied on partial sanitization (e.g. `Foo=Bar` → `FooBar`) to instead assert rejection-with-fallback. The existing `'' → false` test must continue to pass unchanged.
- [ ] Run `npm test -- config` and `npm run lint`; must pass before Task 2.

### Task 2: Build-time WASM SHA-256 + load-time verification

**Files:**
- Modify: `esbuild.js`
- Modify: `src/sqliteReader.ts`
- Modify: `src/sqliteReader.test.ts`

- [ ] In `esbuild.js`: import `crypto` and `fs.readFileSync`. Compute `sha256` of `node_modules/sql.js/dist/sql-wasm.wasm` once at build start (handle missing file: log a warning and use empty string — runtime will then fail-closed).
- [ ] Add `define: { 'globalThis.__WASM_SHA256__': JSON.stringify(hash) }` to `buildOptions`. Use the `globalThis.`-prefixed key so production and Jest read from the same channel (esbuild substitutes `globalThis.__WASM_SHA256__` literally; Jest stubs `(globalThis as any).__WASM_SHA256__` in `beforeAll`). Apply the define in both build and watch paths.
  - **Watch-mode limitation:** the hash is captured when the esbuild context is created. If a developer runs `npm run watch` and then upgrades `sql.js`, they must restart the watcher to pick up the new hash. Document this in a comment in `esbuild.js`; do not bother re-creating the context on WASM change (over-engineering for the actual surface).
- [ ] In `src/sqliteReader.ts`: read the expected hash via `(globalThis as any).__WASM_SHA256__ ?? ''` (no bare-identifier reference — that would `ReferenceError` under Jest). After `fs.readFileSync(wasmPath)`, compute SHA-256 over `wasmBinary` using Node's `crypto.createHash('sha256')`. If `expected` is empty, or `actual !== expected`, log `sqliteReader: WASM integrity check failed (expected ${expected || '<missing>'}, got ${actual})` and return `false` without calling `initSqlJs`. Successful path logs the existing `sql.js initialized successfully`. Keep this read module-private — no exported helper, no widened public surface.
- [ ] No code change in `src/__mocks__/vscode.ts`. In `src/sqliteReader.test.ts`, set `(globalThis as any).__WASM_SHA256__ = '<sha256-of-fixed-buffer>'` in `beforeAll` and restore in `afterAll`. Compute the fixture hash from the same fixed buffer the `fs.readFileSync` mock returns.
- [ ] Add `src/sqliteReader.test.ts` cases: hash match → `initSqlite()` returns `true` and `isSqliteReady()` is true; hash mismatch (stubbed `__WASM_SHA256__` differs from fixture buffer hash) → returns `false`, `isSqliteReady()` stays false, captured log includes `WASM integrity check failed`; missing expected hash (`__WASM_SHA256__ = ''`) → returns `false`, log includes `<missing>`. Mock `fs.readFileSync` to return the fixture buffer and `sql.js` to a no-op `initSqlJs`.
- [ ] Run `npm run compile && npm test -- sqliteReader` and `npm run lint`; must pass before Task 3.

### Task 3: Logger redaction (defense-in-depth)

**Files:**
- Modify: `src/logger.ts`
- Modify: `src/logger.test.ts`

- [ ] Add `redactSecrets(message: string): string` helper (exported plainly for unit testing) in `src/logger.ts`. Redactions, applied in order:
  1. `/Authorization:\s*Bearer\s+\S+/gi` → `Authorization: Bearer [REDACTED]`
  2. `/gh[posur]_[A-Za-z0-9]{36,}/g` → `[REDACTED-GITHUB-TOKEN]` (no underscore in body, length ≥ 36; matches actual GitHub PAT format and self-delimits without `\b`)
  3. Replace the user's home directory prefix (computed *lazily on first invocation* via `os.homedir()`, then cached in a module-level variable) with `~` everywhere it appears in the message.
- [ ] Apply `redactSecrets()` inside `log()` before appending. Do not change `getOutputChannel()` or `disposeLogger()`.
- [ ] Add `src/logger.test.ts` cases:
  - redacts `Authorization: Bearer ghp_<36-char-token>` → `Authorization: Bearer [REDACTED]` (rule 1 wins; rule 2 never sees it)
  - redacts standalone `ghs_<36-char-token>` (no `Authorization:` prefix) → `[REDACTED-GITHUB-TOKEN]`
  - **does not redact hex digests** (e.g., `WASM integrity check failed (expected abc123…, got def456…)` passes through unchanged) — guards Task 2's diagnostic log
  - replaces `os.homedir()` prefix with `~` in a sample path; leaves unrelated paths untouched
  - leaves an unrelated message (no Bearer, no PAT, no home path) untouched
  - idempotent: `redactSecrets(redactSecrets(s)) === redactSecrets(s)` for representative inputs
  - Tests must reset the cached home dir between cases (call `jest.resetModules()` after re-mocking `os`) since the cache populates on first call.
- [ ] Run `npm test -- logger` and `npm run lint`; must pass before Task 4.

### Task 4: Path bounds for tracking file writes (defense-in-depth)

**Scope note:** This task only adds a defense-in-depth check on the **write target** (`trackingFile.ts`). It does **not** add restrictions to `gitDir.ts` resolution because doing so would break legitimate `git worktree add ../name` patterns whose `.git` files contain relative `gitdir:` paths with `..` segments. `vscode.Uri.joinPath` already normalizes `..` away during resolution, so the resolved gitdir is always a clean absolute path. We trust `joinPath`'s normalization and instead guard the place we actually write — the tracking file location.

**Files:**
- Modify: `src/trackingFile.ts`
- Modify: `src/trackingFile.test.ts`

- [ ] In `src/trackingFile.ts:8-14`, after computing the candidate via `vscode.Uri.joinPath(gitDir, 'copilot-budget')`, assert both (a) `candidate.scheme === gitDir.scheme` and (b) `path.posix.normalize(candidate.path).startsWith(path.posix.normalize(gitDir.path).replace(/\/$/, '') + '/')`. If either check fails, return `null`. This is purely defense-in-depth: `joinPath` already enforces these invariants today, and no legitimate flow can fail this check. The check exists to guard against future API drift, accidental `.with({ scheme: ... })` mutations, or a regression in the URI helper.
- [ ] **Do not modify `src/gitDir.ts`.** The existing `resolveGitDir` and `resolveGitCommonDir` functions correctly preserve URI scheme via `with({ path })` and let `joinPath` handle normalization. Adding traversal restrictions there would break worktrees with relative `.git` redirects. Document this scope decision in the commit message and below in Technical Details.
- [ ] Add `src/trackingFile.test.ts` cases:
  - `resolveGitDir` returns URI with path `/tmp/repo/.git` → `getTrackingFileUri()` returns a URI whose path is `/tmp/repo/.git/copilot-budget` and same scheme as gitDir (happy path — no behavior change).
  - `resolveGitDir` returns a URI with path `/tmp/repo/.git/` (trailing slash) → still produces `/tmp/repo/.git/copilot-budget` (normalization handles trailing slash).
  - `resolveGitDir` returns `null` → `getTrackingFileUri()` returns `null` (existing behavior preserved).
  - Hostile mock where the candidate URI returned by `vscode.Uri.joinPath` has a different scheme than `gitDir` → `getTrackingFileUri()` returns `null`. Force this by mocking `Uri.joinPath` to swap the scheme.
  - Hostile mock where the candidate path does not start with the gitDir prefix (e.g., `Uri.joinPath` returns `/tmp/elsewhere/copilot-budget`) → `getTrackingFileUri()` returns `null`.
- [ ] Run `npm test -- trackingFile` and `npm run lint`; must pass before Task 5.

**Threat-model coverage note:** OPLANE_REQ-00040967 will be marked `PARTIALLY_IMPLEMENTED` after this task — we cover the write-path defense-in-depth, but the read-path `gitdir:` resolution and symlink escapes are intentionally out-of-scope to preserve the worktree workflow. The Oplane status update in Task 5 reflects this.

### Task 5: Verify acceptance against threat model

- [ ] Run full test suite: `npm test`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run compile`; confirm `dist/extension.js` builds cleanly and `dist/sql-wasm.wasm` is present.
- [ ] Manually verify (one Extension Dev Host launch via `F5`):
  - Trailer with bad chars in workspace `.vscode/settings.json` (e.g. `"copilot-budget.commitHook.trailers.premiumRequests": "$(echo)"`) — extension falls back to `Copilot-Premium-Requests`, no shell metacharacters reach the tracking file.
  - Status bar populates and tracking file appears under `.git/copilot-budget` after a trigger.
  - Logger output contains no absolute home paths or token-shaped strings.
- [ ] Update Oplane: re-run `update_implementation_state` for OPLANE_REQ-00040967, 00040968, 00040970, 00040972, 00040973 to `IMPLEMENTED` with file references.

### Task 6: [Final] Update documentation

- [ ] Update `CLAUDE.md` *only if* a new pattern emerged worth documenting (e.g. the esbuild `define`-injected constant convention, the redaction layer in logger). If nothing new, skip.
- [ ] No README changes unless the trailer validation behavior is user-visible enough to warrant a note (probably not — defaults are unchanged).
- [ ] Move this plan to `docs/plans/completed/`.

## Technical Details

### Allow-list regex (Task 1)

```
/^[A-Za-z0-9][A-Za-z0-9_-]*$/
```

Validates:
- Must start with alphanumeric (rejects leading `-`, `_`, `.`).
- Body may contain alphanumeric, `_`, `-` (the standard git-trailer name shape).
- No length cap (git itself does not enforce one); rely on string nature to bound.

Defaults that must continue to pass: `Copilot-Premium-Requests`, `Copilot-Est-Cost`. Optional `model` trailer is `false` by default; user-supplied value must pass the regex or it falls back to `false`.

### WASM hash injection (Task 2)

Build-time (`esbuild.js`):

```js
const crypto = require('crypto');
const wasmSrc = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
let wasmHash = '';
if (existsSync(wasmSrc)) {
  wasmHash = crypto.createHash('sha256').update(require('fs').readFileSync(wasmSrc)).digest('hex');
} else {
  console.warn('Warning: sql-wasm.wasm not found — runtime integrity check will fail-closed.');
}
// Use the globalThis-prefixed key so production (esbuild substitution) and Jest
// (which sets globalThis.__WASM_SHA256__ in beforeAll) read from the same channel.
// Watch-mode caveat: hash is captured at context creation; restart the watcher
// after upgrading sql.js.
buildOptions.define = { 'globalThis.__WASM_SHA256__': JSON.stringify(wasmHash) };
```

Runtime (`src/sqliteReader.ts`):

```ts
import * as crypto from 'crypto';
// inside initSqlite, after fs.readFileSync(wasmPath):
const wasmBinary = fs.readFileSync(wasmPath);
const actual = crypto.createHash('sha256').update(wasmBinary).digest('hex');
const expected = (globalThis as any).__WASM_SHA256__ ?? '';
if (!expected || actual !== expected) {
  log(`sqliteReader: WASM integrity check failed (expected ${expected || '<missing>'}, got ${actual})`);
  return false;
}
sqlModule = await initSqlJs({ wasmBinary });
```

Test-time stubbing (`src/sqliteReader.test.ts`):

```ts
beforeAll(() => { (globalThis as any).__WASM_SHA256__ = '<sha-of-fixture-buffer>'; });
afterAll(() => { delete (globalThis as any).__WASM_SHA256__; });
```

Bare-identifier reference (`__WASM_SHA256__` without the `globalThis.` prefix) would `ReferenceError` under Jest, which is why production code reads via `globalThis` too — single channel, no `declare const` needed.

### Redaction patterns (Task 3)

Order matters — most specific first:

1. `/Authorization:\s*Bearer\s+\S+/gi` → `Authorization: Bearer [REDACTED]`
2. `/gh[posur]_[A-Za-z0-9]{36,}/g` → `[REDACTED-GITHUB-TOKEN]`  (no `\b`; base62 body length ≥ 36 self-delimits without false-extending into adjacent text)
3. Replace `os.homedir()` prefix with `~` everywhere it appears in the message. Compute lazily on first invocation and cache in a module-level variable.

Idempotent: running the redactor twice on the same string must produce the same string. Hex digests (e.g., the SHA-256 strings logged by Task 2's integrity check) are *not* matched by any of the three patterns and pass through untouched — Task 3's tests assert this explicitly.

### Path-bound check (Task 4)

For `gitdir:` resolution — inspect the **raw** string before joining (because `vscode.Uri.joinPath` collapses `..` and would mask traversal attempts post-join):

```ts
const gitdir = match[1];
// Normalize backslash to forward-slash so Windows-style paths in .git files are caught.
const segments = gitdir.replace(/\\/g, '/').split('/');
if (segments.some(s => s === '..')) return null;
if (path.isAbsolute(gitdir)) {
  return workspaceRoot.with({ path: gitdir });
}
return vscode.Uri.joinPath(workspaceRoot, gitdir);
```

Apply the same raw-string check to the trimmed `commondir` content in `resolveGitCommonDir` before any `with({ path })` or `joinPath`.

For `trackingFile.ts`, assert scheme equality and path-prefix containment:

```ts
const candidate = vscode.Uri.joinPath(gitDir, 'copilot-budget');
const gitDirPath = path.posix.normalize(gitDir.path);
if (candidate.scheme !== gitDir.scheme) return null;
if (!path.posix.normalize(candidate.path).startsWith(gitDirPath.replace(/\/$/, '') + '/')) return null;
return candidate;
```

**Limitation acknowledged:** the raw-`..` rejection is conservative — it refuses legitimate worktree patterns like `gitdir: ../legitworktree/.git/worktrees/foo` even when they don't escape any meaningful boundary. We accept this trade-off because the threat model prefers false-negatives over allowing arbitrary `..` traversal, and worktrees are normally configured with absolute paths anyway.

## Post-Completion

**Manual verification:**
- Extension Dev Host smoke test (Task 5 details).
- Provoke a malicious workspace setting and confirm the fallback path.
- Confirm OutputChannel content shows no home paths and no token-shaped strings.

**External system updates:**
- None — this is a self-contained extension.

**Maintenance note (not a task):**
- After `npm update sql.js` or any change to the WASM artifact, the build automatically picks up the new hash. No manual regen needed. If a future PR pulls in a tampered WASM, the build will succeed with a hash that won't match what reviewers expect — recommend documenting "hash should change only when sql.js version changes" in CLAUDE.md if the team adopts this as a review checkpoint (optional, not required for plan completion).
