import * as vscode from 'vscode';
import { Tracker } from './tracker';
import { createStatusBar, StatusBarHandle } from './statusBar';
import { showBudgetPanel } from './budgetPanel';
import {
  writeTrackingFile,
  readTrackingFile,
  isTrackingFileTruncated,
} from './trackingFile';
import { installHook, uninstallHook } from './commitHook';
import {
  isEnabled,
  isCommitHookEnabled,
  isOTelDbExporterEnabled,
  autoEnableOTel,
  onConfigChanged,
} from './config';
import { discoverSessionIds, getDiscoveryDiagnostics } from './sessionDiscovery';
import { createOTelReader } from './otelReader';
import { getOutputChannel, disposeLogger, log } from './logger';

let tracker: Tracker | null = null;
let statusBar: StatusBarHandle | null = null;
let consumeInFlight: Promise<boolean> | null = null;

// Detect commit-hook truncation and rebase the tracker so the next commit
// only reports activity that wasn't already in the consumed trailer.
// `tracker.consume()` keeps post-commit (and pre-commit-but-unwritten)
// activity as the next delta — a full reset would absorb it into the new
// baseline and silently underreport. Returns true when a rebase happened so
// callers can skip writing stale cumulative stats over the freshly written
// post-rebase file.
//
// Concurrency: only the consume-and-write step is memoized. The truncation
// probe is run fresh per caller so a slow-filesystem race can't latch a
// stale `false`: if caller A's stat ran pre-truncation and resolved to false,
// memoizing that result would cause a caller B arriving post-truncation to
// reuse A's stale answer and write pre-consume stats over the truncated
// signal. Memoizing only the consume step keeps overlapping positive callers
// from running two parallel rebases against the same source.
function checkCommitReset(): Promise<boolean> {
  if (!tracker) return Promise.resolve(false);
  return (async () => {
    if (!tracker) return false;
    // Always re-probe truncation; never share a negative result across
    // callers. See concurrency note above.
    if (!(await isTrackingFileTruncated())) return false;
    if (!tracker) return false;
    if (consumeInFlight) return consumeInFlight;
    consumeInFlight = (async () => {
      try {
        if (!tracker) return false;
        // consume() may bail (returning false) if the tracker is disposed
        // mid-rebase — e.g., the extension deactivates while the truncation
        // probe is in flight. In that case there's no fresh snapshot to
        // write back, so we skip the post-rebase tracking-file write but
        // still return `true` so overlapping callers don't re-enter.
        const rebased = await tracker.consume();
        if (!rebased) {
          log('Tracking file truncated but consume() bailed (tracker disposed); skipping write');
          return true;
        }
        log('Tracking file truncated by commit hook — stats rebased to last snapshot');
        if (tracker) {
          await writeTrackingFile(tracker.getStats()).catch(() => {});
        }
        return true;
      } finally {
        consumeInFlight = null;
      }
    })();
    return consumeInFlight;
  })();
}

const ALL_COMMANDS = [
  'copilot-budget.showStats',
  'copilot-budget.resetTracking',
  'copilot-budget.installHook',
  'copilot-budget.uninstallHook',
  'copilot-budget.toggleCommitHook',
  'copilot-budget.showDiagnostics',
];

const EMPTY_WINDOW_MESSAGE =
  'Copilot Budget: no workspace open. Open a folder to track Copilot usage.';

function registerShowDiagnostics(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.showDiagnostics', async () => {
      const ch = getOutputChannel();
      const diag = getDiscoveryDiagnostics(context.storageUri);

      ch.appendLine('=== Copilot Budget Diagnostics ===');
      ch.appendLine(`Platform: ${diag.platform}`);
      ch.appendLine(`Home directory: ${diag.homedir}`);
      ch.appendLine('');
      ch.appendLine(`Storage URI: ${diag.storageUri ?? '(none — empty window)'}`);
      ch.appendLine(`Transcripts dir: ${diag.transcriptsDir ?? '(none — empty window)'}`);
      ch.appendLine(`Legacy chatSessions dir: ${diag.legacyChatSessionsDir ?? '(none — empty window)'}`);
      ch.appendLine('');
      ch.appendLine(`Session IDs found: ${diag.filesFound.length}`);
      for (const f of diag.filesFound) {
        ch.appendLine(`  ${f}`);
      }

      if (tracker) {
        // Force a fresh scan so the breakdown reflects what's on disk right
        // now, not whatever was cached up to ~30s ago. A scan failure (e.g.,
        // transient OTel DB error) shouldn't break the diagnostics output —
        // fall back to the last cached stats.
        try {
          await tracker.update();
        } catch (err) {
          log(`showDiagnostics: tracker.update failed: ${String(err)}`);
        }
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
}

function activateEmptyWindow(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(
    'copilot-budget.statusBar',
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.name = 'Copilot Budget';
  item.text = '$(circle-slash) Copilot Budget';
  item.tooltip = 'No workspace open — open a folder to track Copilot usage.';
  item.command = 'copilot-budget.showDiagnostics';
  item.show();
  context.subscriptions.push(item);

  const infoHandler = () => vscode.window.showInformationMessage(EMPTY_WINDOW_MESSAGE);
  for (const cmd of ALL_COMMANDS) {
    if (cmd === 'copilot-budget.showDiagnostics') continue;
    context.subscriptions.push(vscode.commands.registerCommand(cmd, infoHandler));
  }

  registerShowDiagnostics(context);
}

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

  if (!context.storageUri) {
    activateEmptyWindow(context);
    return;
  }

  // Auto-enable the upstream OTel exporter on first run per-workspace. This is
  // a strictly-asymmetric write: only flips unset → true, never overwrites an
  // explicit user choice. Failures are logged inside the helper and never
  // throw, so a transient settings-write error cannot block activation.
  await autoEnableOTel();

  const sessionIdsFn = () => discoverSessionIds(context.storageUri);
  const reader = createOTelReader(context.globalStorageUri);
  tracker = new Tracker(reader, sessionIdsFn);

  // Restore stats from previous session (if tracking file exists)
  const trackingFile = await readTrackingFile();
  if (trackingFile.kind === 'restored') {
    tracker.setPreviousStats(trackingFile.stats);
    log('Restored stats from previous session');
  } else if (trackingFile.kind === 'legacy') {
    log('Tracking file has legacy v0.5.x content, will overwrite');
  } else {
    log('No previous stats to restore');
  }

  // Kick off the initial scan in the background so activation doesn't hang
  // on accounts with many historical chats. The status bar shows zero (or
  // restored stats from setPreviousStats) until baseline lands and listeners
  // fire. Legacy-file overwrite chains onto start so the new schema is
  // written once we have real numbers — until then the legacy file remains
  // and is ignored by the hook (it lacks TOTAL_AI_CREDITS).
  const startPromise = tracker.start();

  if (trackingFile.kind === 'legacy') {
    startPromise
      .then(() => tracker && writeTrackingFile(tracker.getStats()).catch(() => {}))
      .catch(() => {});
  }
  startPromise.catch(() => {});

  statusBar = createStatusBar(tracker);
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Status-bar nudge: when the upstream OTel setting is on but `agent-traces.db`
  // hasn't appeared yet (typical right after auto-enable, before reload), show
  // a clickable "reload to start tracking" status bar item until the DB shows
  // up. Re-check on each stats event; clear the nudge exactly once when the
  // DB becomes available so we don't redundantly call setNudge(false) forever.
  let nudgeCleared = false;
  if (isOTelDbExporterEnabled() && !reader.isAvailable()) {
    statusBar.setNudge(true);
  } else {
    nudgeCleared = true;
  }
  const nudgeSub = tracker.onStatsChanged(() => {
    if (nudgeCleared) return;
    if (reader.isAvailable()) {
      statusBar?.setNudge(false);
      nudgeCleared = true;
    }
  });
  context.subscriptions.push(nudgeSub);

  // Write tracking file whenever stats change. Check for hook truncation
  // first: if the hook just consumed accumulated trailers, the tracker must
  // be reset so the next write doesn't re-emit stale TR_ lines. Re-read
  // tracker.getStats() post-await so a reset that landed mid-flight is
  // reflected in what gets written.
  const statsWriter = tracker.onStatsChanged(() => {
    checkCommitReset().then((wasReset) => {
      if (wasReset || !tracker) return;
      writeTrackingFile(tracker.getStats()).catch(() => {});
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
    checkCommitReset().then((wasReset) => {
      if (tracker && !wasReset) writeTrackingFile(tracker.getStats()).catch(() => {});
    }).catch(() => {});
  }, 5_000);
  context.subscriptions.push({ dispose: () => clearInterval(trackingFileRefresh) });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.showStats', () => {
      if (tracker) {
        showBudgetPanel({ tracker }).catch((err) =>
          log(`showBudgetPanel failed: ${String(err)}`),
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.resetTracking', async () => {
      if (tracker) {
        await tracker.reset();
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
    vscode.commands.registerCommand('copilot-budget.toggleCommitHook', async () => {
      // Hook action first; persist setting only on success. See
      // budgetPanel.handleHookToggle for the rationale — the setting and
      // disk state must stay in sync or we re-attempt failing installs on
      // every later config change. The settings write can also fail (locked
      // settings.json, Sync provider error); warn the user when it does so
      // they know disk and config have drifted.
      const newState = !isCommitHookEnabled();
      const succeeded = newState ? await installHook() : await uninstallHook();
      if (!succeeded) return;
      try {
        await vscode.workspace
          .getConfiguration('copilot-budget')
          .update('commitHook.enabled', newState, vscode.ConfigurationTarget.Global);
      } catch {
        vscode.window.showWarningMessage(
          `Copilot Budget: Hook ${newState ? 'installed' : 'removed'}, but failed to save the commitHook.enabled setting — disk state and setting may now disagree.`,
        );
      }
    }),
  );

  registerShowDiagnostics(context);

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
    // Check for hook truncation before the final write so we don't restore
    // stale cumulative stats over a freshly consumed file. Awaiting here
    // also drains any in-flight check started from a listener or the poll.
    const wasReset = await checkCommitReset().catch(() => false);
    if (!wasReset) {
      await writeTrackingFile(tracker.getStats()).catch(() => {});
    }
    tracker.dispose();
    tracker = null;
  }
  if (statusBar) {
    statusBar.dispose();
    statusBar = null;
  }
  consumeInFlight = null;
  disposeLogger();
}
