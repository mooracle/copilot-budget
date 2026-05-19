# Incremental Parsing for Active Copilot Session Files

## Overview

A long Copilot Chat session writes to its JSONL file every few seconds. The current scan re-reads + re-parses the entire file whenever mtime changes — at 10MB that's ~100–300ms of JSON.parse per poll, at 30MB+ it becomes an observable freeze every 30s.

This plan introduces per-file incremental parsing: keep the rebuilt `sessionState` and last-parsed string offset in the file cache. On the next mtime change, read only the new bytes, apply their deltas to the cached state, and re-aggregate. Per-poll cost drops from ~100–300ms to ~5–15ms for active files. Memory cost is ~5–15MB per cached parser state, bounded by an LRU cap (default 3 entries).

The mtime filter and per-file `setImmediate` yield are already shipped. This is the last remaining freeze vector for realistic users.

## Context (from discovery)

- **Files involved:**
  - `src/sessionParser.ts` — JSONL delta parser. Currently exposes only `parseSessionFileContent(content)`. Needs to split into stateful API.
  - `src/tracker.ts` — owns the `fileCache` Map. `FileCache` shape changes. Per-file scan branch needs to choose between incremental and full parse.
  - `src/sessionParser.test.ts` — needs new tests for stateful API and incremental equivalence.
  - `src/tracker.test.ts` — needs new tests for incremental scan behavior, truncation/rotation, LRU eviction.

- **Related patterns:**
  - `applyDelta` already mutates state in place (kind=0 replace, kind=1 update, kind=2 append). Stateful API is a natural fit.
  - `fileCache` is `Map<string, FileCache>` — already keyed by path. Adding `lastOffset` and `parserState` is structural, not API-changing.
  - `processRequests(state.requests)` is the aggregation step. Re-running it on the cached `sessionState` after applying new deltas is the re-aggregation primitive.

- **Dependencies:**
  - No new dependencies. Uses existing `fs.readFileSync` (sync read of byte range still cheap with positional argument).

## Development Approach

- **Testing approach:** Regular (code first, then tests in the same task). Tests are required deliverables per task, not deferred.
- Complete each task fully before moving to the next.
- Make small, focused changes — parser split lands cleanly before tracker touches it.
- **CRITICAL: every task MUST include new/updated tests** covering both success and edge cases.
- **CRITICAL: all tests must pass before starting next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run `npm test` after each task.
- Backward compatibility: `parseSessionFileContent(content)` keeps its current signature so existing tests and any external use continue to work.

## Testing Strategy

- **Unit tests:** required for every task.
- **No e2e tests:** project has no UI e2e suite (`jest` only). Integration is covered by `tracker.test.ts`.
- All new behavior must be testable via the existing `fs`/`sessionDiscovery`/`sessionParser` mock layer.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code changes, tests, plan-completion housekeeping.
- **Post-Completion** (no checkboxes): manual verification, follow-up changes.

## Implementation Steps

### Task 1: Split sessionParser into stateful API

**Files:**
- Modify: `src/sessionParser.ts`
- Modify: `src/sessionParser.test.ts`

Carve `parseSessionFileContent` into three pieces so callers can apply deltas incrementally while preserving the existing one-shot API for backward compatibility.

- [x] add exported type `ParserState` (holds `sessionState: unknown`). Initialize via new `createParserState(): ParserState`.
- [x] add exported `applyDeltaLines(lines: string[], state: ParserState): ParserState` that runs the existing `applyDelta` loop against `state.sessionState`. Invalid JSON lines are skipped (current behavior preserved).
- [x] add exported `aggregateFromState(state: ParserState): ParsedSession` that pulls `state.sessionState.requests` and runs the existing `processRequests`.
- [x] refactor `parseSessionFileContent(content: string): ParsedSession` to: skip-empty/first-line-invalid-shape guards (unchanged); then `applyDeltaLines(lines, createParserState())`; then `aggregateFromState`. Output must be byte-identical to current behavior on all existing fixtures.
- [x] write tests: `createParserState` returns expected shape; `applyDeltaLines` accepts multiple chunks and matches one-shot result (i.e. `apply(a) + apply(b)` ≡ `apply(a+b)`); `aggregateFromState` on an empty state returns `{interactions: 0, modelUsage: {}, modelInteractions: {}}`.
- [x] write tests: pending→completed transition across two `applyDeltaLines` calls — append a kind=2 pending request, aggregate (counts 0), apply kind=1 `result.metadata` + kind=1 `modelState.value=1` in a second call, aggregate (counts 1, correct tokens).
- [x] write tests: invalid JSON lines mid-stream don't poison `sessionState` (skipped, subsequent lines still apply).
- [x] run `npm test` — must pass before next task.

### Task 2: Add lastOffset + parserState to FileCache

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/tracker.test.ts`

Make the cache shape carry the new fields without yet using them — pure structural change so it lands cleanly. The scan loop still does full re-parse on mtime change for now; we'll wire incremental in Task 3.

- [x] extend `FileCache` interface: add `lastOffset: number` (string code-unit index after last complete newline parsed — NOT bytes) and `parserState: import('./sessionParser').ParserState | null` (null = evicted or never created).
- [x] on full re-parse path (cache miss or mtime change), populate `lastOffset = content.length` (JS string code-unit count) AND `parserState` built by running `applyDeltaLines(allLines, createParserState())` before aggregating. Aggregate from the state, not from `parseSessionFileContent` — keeps the parser-state cache and aggregate in sync. **Do not use `Buffer.byteLength` anywhere in this path** — mixing byte offsets with `string.slice()` corrupts on any multi-byte character.
- [x] full-re-parse path still emits the same `ParsedSession` shape downstream. No behavior change visible to callers.
- [x] extend `setupFiles` helper in `tracker.test.ts` to stub the new parser exports (`createParserState`, `applyDeltaLines`, `aggregateFromState`) so Task 3 tests can exercise the stateful path. Existing `parseSessionFileContent` mock stays for back-compat tests.
- [x] write tests: cache entries created on first scan have non-null `parserState` and `lastOffset === content.length` (JS string length).
- [x] write tests: a second scan with same mtime hits the existing mtime-cache branch (no re-parse) — unchanged behavior.
- [x] run `npm test` — must pass before next task.

### Task 3: Wire incremental parse on mtime change

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/tracker.test.ts`

Make the mtime-changed branch read only `[lastOffset .. fileSize]` when `parserState` is non-null, parse new lines into the cached state, advance `lastOffset` to after the last complete newline, then re-aggregate. Fall back to full re-parse when `parserState` is null (evicted, see Task 5) or any guard trips.

- [x] in `doScanAll`, after `fs.statSync(file)` returns and mtime mismatches cache, read full file with `fs.readFileSync(file, 'utf-8')` (rationale: positional `fs.read` requires fd lifecycle; full-read is one syscall and only runs on actual mtime change). Use `content.length` (JS string code-unit count) as the comparison unit throughout — this matches `cached.lastOffset` exactly.
- [x] branch on `cached?.parserState`:
  - **incremental path:** if `cached.parserState != null` AND `content.length > cached.lastOffset`, slice `content.slice(cached.lastOffset)` to get the new tail.
  - **full re-parse:** if `cached.parserState == null` (evicted or first scan), OR `content.length < cached.lastOffset` (truncation), OR `content.length === cached.lastOffset` while mtime changed (in-place rewrite — same size, different bytes; rare but possible).
- [x] partial-final-line handling: in the incremental path, `const newTail = content.slice(cached.lastOffset); const lastNewline = newTail.lastIndexOf('\n');`. If `lastNewline < 0`, no complete new line yet — do not call the parser, do not advance `lastOffset`, update `mtime` so we don't re-enter this branch until the file changes again. Otherwise, take `newTail.slice(0, lastNewline)` (everything up to but not including the final newline), split with the same `/\r?\n/` filter as the existing parser, pass to `applyDeltaLines`. Advance `cached.lastOffset += lastNewline + 1` (all string code-unit math — no `Buffer.byteLength`).
- [x] re-aggregate via `aggregateFromState(cached.parserState)` and store the result in `cached` as the new fields `interactions`/`modelUsage`/`modelInteractions` (existing shape preserved).
- [x] keep mtime-unchanged branch as-is (returns cached aggregate without touching state).
- [x] write tests: file grew by N lines between scans → only the new tail is passed to `applyDeltaLines` (assert call args on the mocked function). Aggregate equals the result of a from-scratch full parse of the new total content.
- [x] write tests: file truncated (`content.length < cached.lastOffset`) → cached `parserState` discarded, full re-parse from index 0, `lastOffset` reset to new `content.length`.
- [x] write tests: same-size in-place rewrite (`content.length === cached.lastOffset` but mtime changed) → falls to full re-parse branch.
- [x] write tests: file appended a partial line (no trailing newline) → no parse occurs this scan, `lastOffset` does not advance; next scan with the completing newline parses the now-complete line including the partial bytes from the previous scan. **Cover this with a three-scan sequence:** scan 1 partial, scan 2 partial-completed-plus-more, assert the originally-partial line is parsed exactly once and the extra new line is also parsed.
- [x] write tests: pending→completed across scans — request appended (kind=2 with `modelState.value=0`) in scan 1, completed (kind=1 fills `result.metadata` + kind=1 `modelState.value=1`) in scan 2's new bytes. Verify total interactions transitions 0→1 and tokens match a single-shot full parse.
- [x] write tests: multi-byte content (emoji/CJK in a prompt body) round-trips through incremental parse identically to full parse — regression guard against any future drift back to byte-indexing.
- [x] run `npm test` — must pass before next task.

### Task 4: Add LRU cap on parserState retention

**Files:**
- Modify: `src/tracker.ts`
- Modify: `src/tracker.test.ts`

Cap the number of `parserState` objects kept in the cache. Default 3 — covers single-active-chat (typical) and multi-chat (rare) without unbounded growth over long sessions. Evicted entries keep their aggregate; they just lose the ability to do incremental on the next change (full re-parse, no correctness impact).

- [ ] add private constant `MAX_PARSER_STATES = 3` (or read from a future config — for now hardcode and leave a TODO referencing config if it's ever needed).
- [ ] add private field `parserStateLru: string[]` — paths in least-recently-touched order. Touched on every scan where the file's `parserState` was used or created.
- [ ] eviction policy: after a scan that creates/uses a `parserState`, if `parserStateLru.length > MAX_PARSER_STATES`, shift the oldest path and set its cache entry's `parserState = null` (keep `lastOffset` and aggregate fields). On the next mtime change for that file, full re-parse runs and re-installs `parserState`.
- [ ] `dispose()` clears `parserStateLru` too.
- [ ] write tests: scanning 4 different active files (4 mtime changes) leaves exactly 3 with non-null `parserState`; the least-recently-touched has `parserState = null` but its aggregate is preserved.
- [ ] write tests: an evicted file that becomes active again gets `parserState` re-installed (full re-parse on next mtime change).
- [ ] write tests: eviction does not affect `getFileDiagnostics()` output (per-file aggregate breakdown unchanged).
- [ ] run `npm test` — must pass before next task.

### Task 5: Verify acceptance criteria

- [ ] verify all goals from Overview: incremental path takes <20ms on a synthetic 10MB chat (manual benchmark with `console.time` in a one-off test, document result inline).
- [ ] verify all edge cases handled: pending→completed, truncation, partial line, LRU eviction.
- [ ] run full test suite: `npm test`
- [ ] run lint: `npm run lint`
- [ ] run compile: `npm run compile` (esbuild must succeed; bundle size delta should be negligible).
- [ ] verify no behavior change in `getFileDiagnostics()` output shape (downstream `showDiagnostics` command depends on it).

### Task 6: Update CLAUDE.md and complete plan

**Files:**
- Modify: `CLAUDE.md`
- Move: this plan to `docs/plans/completed/`

- [ ] update `CLAUDE.md` `tracker.ts` and `sessionParser.ts` sections to describe the stateful parser API and `FileCache`'s new `lastOffset`/`parserState` fields. Note the LRU cap.
- [ ] move this plan to `docs/plans/completed/20260519-incremental-session-parsing.md`.

## Technical Details

### `FileCache` (new shape)

```ts
interface FileCache {
  mtime: number;
  // Aggregate result of the last parse — returned directly on mtime-cache hit.
  interactions: number;
  modelUsage: ModelUsage;
  modelInteractions: { [model: string]: number };
  // **String code-unit** index (NOT bytes) into the decoded file content
  // marking the position immediately after the last \n we successfully
  // parsed. Used as the start of the next incremental slice. Resets to 0 on
  // truncation. Rationale: tracker reads via fs.readFileSync(file, 'utf-8')
  // and operates on decoded JS strings; mixing byte offsets with
  // string.slice() corrupts on any multi-byte content. String-index throughout
  // is the only consistent choice — Buffer.byteLength must not appear in this
  // path.
  lastOffset: number;
  // Cached parser state allowing incremental delta application. Null when
  // evicted by LRU or when the file has never been parsed yet (transient).
  parserState: ParserState | null;
}
```

### `ParserState` (new exported type)

```ts
export interface ParserState {
  sessionState: unknown;  // Same delta-rebuilt object the current parser uses.
}
```

(Reviewer flagged `lineNumber` as YAGNI — no current diagnostic consumes it. Add later if a use shows up.)

### Per-scan decision tree (inside `doScanAll`)

All offset math is in JS string code-units. **No `Buffer.byteLength` anywhere in this path.**

```
stat = fs.statSync(file)
mtime = stat.mtimeMs
cached = fileCache.get(file)

if (cached && cached.mtime === mtime) {
  // No change — return aggregate directly.
  fold cached aggregate into totals
  continue
}

content = fs.readFileSync(file, 'utf-8')      // decoded string
size = content.length                          // code-unit count, matches lastOffset

// Decide incremental vs full
canIncremental =
  cached?.parserState != null &&
  size > cached.lastOffset                     // grew; truncation/in-place-rewrite fall through

if (canIncremental) {
  newTail = content.slice(cached.lastOffset)
  lastNewline = newTail.lastIndexOf('\n')
  if (lastNewline < 0) {
    // No complete new line — don't parse, don't advance lastOffset.
    cached.mtime = mtime
    fold previous aggregate, continue
  }
  completeLines = newTail.slice(0, lastNewline).split(/\r?\n/).filter(l => l.trim())
  applyDeltaLines(completeLines, cached.parserState)
  cached.lastOffset += lastNewline + 1         // code-unit advance, matches content indexing
  cached.mtime = mtime
  aggregate = aggregateFromState(cached.parserState)
  // update cached fields, fold into totals
} else {
  // Full re-parse: no state, or truncation (size < lastOffset),
  // or in-place rewrite (size === lastOffset with mtime change).
  state = createParserState()
  lines = content.split(/\r?\n/).filter(l => l.trim())
  applyDeltaLines(lines, state)
  aggregate = aggregateFromState(state)
  fileCache.set(file, {
    mtime,
    lastOffset: size,                          // = content.length
    parserState: state,
    ...aggregate
  })
}

touch parserStateLru, evict if over cap
```

### Why string code-units, not bytes

Tracker reads via `fs.readFileSync(file, 'utf-8')` → decoded JS string. JS string `.slice()` and `.length` operate in UTF-16 code units. Anything that stores a byte offset and then slices a string with it will desync the moment a multi-byte character (emoji, accented chars, CJK) enters the file — JSON.parse on misaligned input throws, `applyDeltaLines` silently skips, tokens go missing. Using `Buffer.byteLength` to "track bytes" while indexing strings with the result is the exact bug shape to avoid.

The single anchor: `lastOffset` is always a JS string code-unit index into the same decoded `content` that produced it. `content.slice(lastOffset)` is always correct.

### Why slice the full read instead of positional `fs.read`

A positional `fs.read(fd, buffer, ...)` would avoid loading the unchanged prefix into memory. But:
- We're already gated by mtime change (rare) — full read only happens on actual file growth, not idle.
- `fs.readFileSync` is one syscall; positional read requires fd open/read/close lifecycle plus buffer management.
- Memory blip from reading a 30MB string is recoverable; complexity of fd lifecycle is not.

If memory pressure shows up later (~30MB transient allocations per poll on heavy users), revisit with `fs.createReadStream` + `start: cached.lastOffset` and incremental `readline`.

### Why LRU at 3

- One active chat is typical.
- Two active chats (e.g. main + side conversation) is uncommon but real.
- Three is the safety margin.
- Each parserState is roughly the size of the original file's request array (~5–15MB for a 10MB JSONL). 3 × 15MB = 45MB worst case in cache. Acceptable.
- Above 3, hit rate falls off fast — concurrent active chats are vanishingly rare.

### Truncation detection

A user might clear the chat (Copilot UI: "New Chat" or similar) and the JSONL gets truncated or recreated. Detected by `content.length < cached.lastOffset`. Response: discard `parserState` and `lastOffset`, full re-parse from index 0. This both fixes correctness and re-initializes incremental tracking.

A subtler case: file rewritten in place with same size and changed contents (mtime bumped but `content.length === cached.lastOffset`). The decision tree falls to the full re-parse branch in that case (`canIncremental` requires `size > lastOffset`). Cheap guard.

**Assumption: append-only writes.** A same-prefix rewrite (content grew but prefix code-units changed underneath) would corrupt incremental results. No known Copilot session writer produces this; the JSONL is append-only by design. If a future Copilot version breaks this invariant, the symptom is stale aggregates that don't match a full re-parse — detectable by mismatched per-file diagnostics. Mitigation if observed: hash the prefix and fall back to full re-parse on mismatch. Not adding the hash now (YAGNI).

## Post-Completion

**Manual verification:**
- Open VS Code with an active Copilot Chat workspace that has a ~10MB JSONL session file. Observe: status bar updates every 30s with no observable typing/UI hitch. Run `Copilot Budget: Show Diagnostics` — per-file breakdown should match what a from-scratch parse would produce.
- If you have a workspace with several chat sessions touched in the last week, open 4 of them in quick succession (force 4 active parserStates) and verify the LRU eviction kicks in (`parserState` null on the least-recent).

**No external system updates required.** Tracking file schema is unchanged; commit hook unchanged; rate card unchanged.
