import * as vscode from 'vscode';
import { Tracker } from './tracker';
import { createStatusBar, showStatsQuickPick } from './statusBar';
import {
  writeTrackingFile,
  readTrackingFile,
  isTrackingFileTruncated,
} from './trackingFile';
import { installHook, uninstallHook } from './commitHook';
import { isEnabled, isCommitHookEnabled, onConfigChanged } from './config';
import { getDiscoveryDiagnostics } from './sessionDiscovery';
import { getOutputChannel, disposeLogger, log } from './logger';
import { initSqlite, disposeSqlite } from './sqliteReader';

let tracker: Tracker | null = null;
let statusBar: { item: vscode.StatusBarItem; dispose: () => void } | null =
  null;
let commitResetCheck: Promise<boolean> | null = null;
// True when the tracking file existed at activation but could not be read.
// While set, all write paths defer so a transient I/O error doesn't cause
// the refresh loop to clobber a valid file with a fresh zero baseline.
let safeToWrite = true;
// True when consume() rebased the tracker but the follow-up write failed
// and the file is still truncated. Lets the next poll retry the write
// without calling consume() again, which would absorb the post-commit
// delta into the new baseline and lose real usage.
let pendingConsumeWrite = false;
// Bumped whenever the user resets tracking. attemptRecoverFromUnread()
// captures this before its await and re-checks after; a mismatch means a
// reset landed mid-flight, so the recovery must abort instead of restoring
// the pre-reset snapshot on top of the freshly reset state.
let resetGeneration = 0;

// Detect commit-hook truncation and rebase the tracker so the next commit
// only reports activity that wasn't already in the consumed trailer.
// `tracker.consume()` keeps post-commit (and pre-commit-but-unwritten)
// activity as the next delta — a full reset would absorb it into the new
// baseline and silently underreport.
//
// Returns true when the caller MUST skip its fallback writeTrackingFile().
// Two reasons this can happen:
//   1. A rebase happened and checkCommitReset already wrote the
//      post-rebase snapshot — a fallback write would clobber it with
//      stale cumulative stats.
//   2. The stat probe was ambiguous (null) on a first probe
//      (pendingConsumeWrite=false). We can't tell if the file is
//      truncated; if it is, a fallback write would re-emit TR_ lines the
//      hook just consumed, causing duplicate trailers on the next commit.
//      The retry case (pendingConsumeWrite=true) intentionally returns
//      false so the caller's fallback write can serve as the retry.
//
// Concurrency: overlapping callers share the in-flight promise rather than
// getting `false` immediately. Without this, a 5s-poll call entering while
// a stats-change call was mid-await would resolve to `false` and proceed to
// write a pre-consume snapshot that could race the post-consume write and
// reintroduce already-consumed trailers.
function checkCommitReset(): Promise<boolean> {
  if (!tracker) return Promise.resolve(false);
  if (commitResetCheck) return commitResetCheck;
  // Kept as a non-async wrapper around an async IIFE so callers receive the
  // inner promise directly without an extra wrapping hop — preserves the
  // microtask depth that listener/poll callbacks rely on.
  commitResetCheck = (async () => {
    try {
      const truncated = await isTrackingFileTruncated();
      if (!tracker) return false;
      if (truncated === false) {
        pendingConsumeWrite = false;
        return false;
      }
      if (truncated === null) {
        // Stat failed with an ambiguous error. We cannot tell whether the
        // file is still truncated, so we must not clear pendingConsumeWrite
        // (a later true-truncation read would otherwise trigger a second
        // consume() and absorb unwritten post-commit deltas into the new
        // baseline). Two sub-cases for the caller's fallback write:
        //   - pendingConsumeWrite=true: a previous consume() + failed
        //     write needs to retry. Letting the caller's fallback write
        //     proceed IS the retry; on success it clears the flag.
        //   - pendingConsumeWrite=false: this is the first probe. If the
        //     file is actually truncated, the caller's fallback would
        //     write pre-consume stats and re-emit TR_ lines the hook just
        //     consumed (→ duplicate trailers on the next commit). Signal
        //     "skip" so the next tick re-stats and decides cleanly.
        return !pendingConsumeWrite;
      }
      if (!pendingConsumeWrite) {
        tracker.consume();
        log('Tracking file truncated by commit hook — stats rebased to last snapshot');
        pendingConsumeWrite = true;
      } else {
        log('Tracking file still truncated; retrying post-consume write');
      }
      if (tracker) {
        const ok = await writeTrackingFile(tracker.getStats()).catch(() => false);
        if (ok) pendingConsumeWrite = false;
      }
      return true;
    } finally {
      commitResetCheck = null;
    }
  })();
  return commitResetCheck;
}

// Re-read the tracking file after activation observed an 'unread' state.
// If the read now succeeds, restore previous stats (if any) and resume
// writes. If still unreadable, keep deferring.
async function attemptRecoverFromUnread(): Promise<void> {
  if (!tracker || safeToWrite) return;
  const gen = resetGeneration;
  const result = await readTrackingFile();
  // Re-check safeToWrite after the await: an overlapping recovery from a
  // concurrent stats-change/poll caller may have completed first, restored
  // previousStats, and already triggered a post-restore write. Applying our
  // own (possibly fresher) read on top would either set previousStats to a
  // stale snapshot or, worse, to a freshly-written snapshot that already
  // includes the prior previousStats — leading to double-counted totals on
  // the next update. The gen check is kept for the reset path, which both
  // sets safeToWrite=true and bumps gen.
  if (!tracker || safeToWrite || gen !== resetGeneration) return;
  if (result.kind === 'unread') return;
  safeToWrite = true;
  if (result.kind === 'restored') {
    tracker.setPreviousStats(result.stats);
    tracker.update();
    log('Tracking file became readable; restored previous stats');
  } else if (result.kind === 'legacy') {
    // Mirror activation's legacy handling: legacy v0.5.x content can
    // contain stale TR_ lines that a concurrent commit hook would pick up.
    // Overwrite immediately rather than waiting for the next stats-change
    // or 5s poll — otherwise a commit landing in the gap appends stale
    // trailers.
    await writeTrackingFile(tracker.getStats()).catch(() => {});
    log('Tracking file readable again with legacy content; overwrote with current stats');
  } else {
    // 'absent' after 'unread' means the file disappeared (deleted by user,
    // consumed by hook, etc.). The in-memory tracker may already hold stats
    // accumulated during this session — write them out immediately rather
    // than waiting for the next stats-change or 5s poll. Otherwise a commit
    // landing in that gap finds no tracking file and silently drops the
    // trailer, attributing the usage to a later commit.
    await writeTrackingFile(tracker.getStats()).catch(() => {});
    log('Tracking file readable again; wrote current stats to absent file');
  }
}

const ALL_COMMANDS = [
  'copilot-budget.showStats',
  'copilot-budget.resetTracking',
  'copilot-budget.installHook',
  'copilot-budget.uninstallHook',
  'copilot-budget.showDiagnostics',
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!isEnabled()) {
    const handler = () =>
      vscode.window.showInformationMessage(
        'Copilot Budget is disabled. Enable it via the copilot-budget.enabled setting.',
      );
    for (const cmd of ALL_COMMANDS) {
      context.subscriptions.push(
        vscode.commands.registerCommand(cmd, handler),
      );
    }
    return;
  }

  const sqliteOk = await initSqlite();
  if (!sqliteOk) {
    log('SQLite support unavailable — vscdb files will be skipped');
  }

  tracker = new Tracker();

  // Restore stats from previous session (if tracking file exists)
  const trackingFile = await readTrackingFile();
  if (trackingFile.kind === 'restored') {
    tracker.setPreviousStats(trackingFile.stats);
    log('Restored stats from previous session');
  } else if (trackingFile.kind === 'legacy') {
    log('Tracking file has legacy v0.5.x content, will overwrite');
  } else if (trackingFile.kind === 'unread') {
    safeToWrite = false;
    log('Tracking file exists but could not be read; deferring writes until readable');
  } else {
    log('No previous stats to restore');
  }

  tracker.start();

  // Only overwrite when we positively identified legacy content — a missing
  // file or empty file (hook truncation) maps to 'absent', and a transient
  // I/O failure on an existing file maps to 'unread'; neither should be
  // clobbered with zero stats.
  if (trackingFile.kind === 'legacy') {
    await writeTrackingFile(tracker.getStats()).catch(() => {});
  }

  statusBar = createStatusBar(tracker);
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Write tracking file whenever stats change. Check for hook truncation
  // first: if the hook just consumed accumulated trailers, the tracker must
  // be reset so the next write doesn't re-emit stale TR_ lines.
  const statsWriter = tracker.onStatsChanged((stats) => {
    if (!safeToWrite) {
      attemptRecoverFromUnread().catch(() => {});
      return;
    }
    // Capture resetGeneration before the await: if the user resets while
    // checkCommitReset is suspended, the captured `stats` is a pre-reset
    // snapshot. Writing it after the reset's own direct write would race
    // and re-persist stale totals + TR_ lines, silently undoing the reset.
    const gen = resetGeneration;
    checkCommitReset().then((skipFallbackWrite) => {
      if (skipFallbackWrite) return;
      if (gen !== resetGeneration) return;
      // A successful fallback write replaces a (possibly still-truncated)
      // file with current stats, ending the consume cycle. Clearing
      // pendingConsumeWrite here is required for the retry case: a prior
      // consume() with failed write left the flag set; an ambiguous stat
      // on the next tick let this fallback write run as the retry. Without
      // clearing, a real new commit-hook truncation after the successful
      // fallback write would be misclassified as a retry and skip
      // consume(), absorbing post-commit usage into the new baseline.
      writeTrackingFile(stats).then((ok) => {
        if (ok) pendingConsumeWrite = false;
      }).catch(() => {});
    }).catch(() => {});
  });
  context.subscriptions.push(statsWriter);

  // Poll for hook-induced truncation on a short interval. Without this, a
  // truncation between stats-change events would only be noticed on the next
  // session-file change, leaving the in-memory tracker out of sync with the
  // on-disk "consumed" signal. When no truncation is detected we still re-
  // write current stats so external readers (status bar consumers, manual
  // file inspection) see a fresh snapshot.
  const trackingFileRefresh = setInterval(() => {
    if (!tracker) return;
    if (!safeToWrite) {
      attemptRecoverFromUnread().catch(() => {});
      return;
    }
    checkCommitReset().then((skipFallbackWrite) => {
      if (!tracker || skipFallbackWrite) return;
      // See the listener path for why a successful fallback write clears
      // pendingConsumeWrite even though checkCommitReset itself didn't.
      writeTrackingFile(tracker.getStats()).then((ok) => {
        if (ok) pendingConsumeWrite = false;
      }).catch(() => {});
    }).catch(() => {});
  }, 5_000);
  context.subscriptions.push({ dispose: () => clearInterval(trackingFileRefresh) });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.showStats', () => {
      if (tracker) showStatsQuickPick(tracker);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.resetTracking', () => {
      if (tracker) {
        // Cancel any deferred 'unread' recovery. The user is explicitly
        // discarding prior state, so a later read that succeeds must not
        // restore the on-disk snapshot on top of the reset (which would
        // silently undo it). Bumping resetGeneration also invalidates any
        // already-in-flight recovery whose await is about to resolve.
        // Resuming writes ensures the reset's stats-change emit gets
        // persisted instead of deferring again.
        safeToWrite = true;
        pendingConsumeWrite = false;
        resetGeneration++;
        tracker.reset();
        // Persist the reset snapshot directly. The stats-change listener
        // also tries to write, but its checkCommitReset path may skip the
        // write on an ambiguous stat() probe — leaving stale TR_ lines
        // from a prior session in the file until the next successful poll,
        // long enough for a commit to append them. Reset stats have
        // totalAiCredits=0, which gates TR_ emission off, so this write
        // can never produce duplicate trailers on a subsequent commit.
        writeTrackingFile(tracker.getStats()).catch(() => {});
        vscode.window.showInformationMessage('Copilot Budget: Tracking reset.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.installHook', async () => {
      await installHook();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.uninstallHook', async () => {
      await uninstallHook();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.showDiagnostics', () => {
      const ch = getOutputChannel();
      const diag = getDiscoveryDiagnostics();

      ch.appendLine('=== Copilot Budget Diagnostics ===');
      ch.appendLine(`Platform: ${diag.platform}`);
      ch.appendLine(`Home directory: ${diag.homedir}`);
      ch.appendLine('');
      ch.appendLine('Candidate paths:');
      for (const cp of diag.candidatePaths) {
        ch.appendLine(`  ${cp.exists ? 'EXISTS' : 'MISSING'}: ${cp.path}`);
      }
      ch.appendLine('');
      ch.appendLine(`Session files found: ${diag.filesFound.length}`);
      for (const f of diag.filesFound) {
        ch.appendLine(`  ${f}`);
      }
      ch.appendLine('');
      ch.appendLine(`Vscdb files found: ${diag.vscdbFilesFound.length}`);
      for (const f of diag.vscdbFilesFound) {
        ch.appendLine(`  ${f}`);
      }

      if (tracker) {
        const stats = tracker.getStats();
        ch.appendLine('');
        ch.appendLine('Current stats:');
        ch.appendLine(`  Total tokens: ${stats.totalTokens}`);
        ch.appendLine(`  Interactions: ${stats.interactions}`);
        ch.appendLine(`  AI Credits: ${stats.totalAiCredits.toFixed(2)}`);
        ch.appendLine(`  Since: ${stats.since}`);
        ch.appendLine(`  Last updated: ${stats.lastUpdated}`);
      }

      ch.show();
    }),
  );

  // Auto-install/refresh hook if enabled in settings (only when a workspace is open)
  if (isCommitHookEnabled() && vscode.workspace.workspaceFolders?.length) {
    installHook().catch(() => {});
  }

  // Listen for config changes
  const configSub = onConfigChanged(() => {
    if (isCommitHookEnabled()) {
      installHook().catch(() => {});
    }
  });
  context.subscriptions.push(configSub);
}

export async function deactivate(): Promise<void> {
  if (tracker) {
    // Final recovery attempt for the 'unread' case. Without this, a session
    // that closes before the first 5s poll, or one where recovery only
    // becomes possible after the last poll, would skip the final write and
    // lose every stat accumulated during the run.
    if (!safeToWrite) {
      await attemptRecoverFromUnread().catch(() => {});
    }
    if (safeToWrite) {
      // Drain any in-flight check (listener/poll) and run our own to rebase
      // the tracker if the hook just truncated the file. Unlike the
      // listener/poll paths, we ignore the "skip fallback write" signal: it
      // exists for callers that can defer to a next tick on an ambiguous
      // stat probe or after a successful in-check write. Deactivate has no
      // next tick, so a transient stat error or an in-check write failure
      // would silently drop the entire session. tracker.getStats() is read
      // fresh post-await (post-consume if a rebase ran), so the final write
      // is correct against the current state in every case — at worst a
      // redundant re-write of stats already on disk.
      await checkCommitReset().catch(() => {});
      await writeTrackingFile(tracker.getStats()).catch(() => {});
    }
    tracker.dispose();
    tracker = null;
  }
  if (statusBar) {
    statusBar.dispose();
    statusBar = null;
  }
  commitResetCheck = null;
  safeToWrite = true;
  pendingConsumeWrite = false;
  disposeSqlite();
  disposeLogger();
}
