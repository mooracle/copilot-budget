import * as vscode from 'vscode';
import { Tracker, JsonlSource } from './tracker';
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

let tracker: Tracker | null = null;
let statusBar: { item: vscode.StatusBarItem; dispose: () => void } | null =
  null;
let commitResetCheck: Promise<boolean> | null = null;

// Detect commit-hook truncation and rebase the tracker so the next commit
// only reports activity that wasn't already in the consumed trailer.
// `tracker.consume()` keeps post-commit (and pre-commit-but-unwritten)
// activity as the next delta — a full reset would absorb it into the new
// baseline and silently underreport. Returns true when a rebase happened so
// callers can skip writing stale cumulative stats over the freshly written
// post-rebase file.
//
// Concurrency: overlapping callers share the in-flight promise rather than
// getting `false` immediately. Without this, a 5s-poll call entering while
// a stats-change call was mid-await would resolve to `false` and proceed to
// write a pre-consume snapshot that could race the post-consume write and
// reintroduce already-consumed trailers.
function checkCommitReset(): Promise<boolean> {
  if (!tracker) return Promise.resolve(false);
  if (commitResetCheck) return commitResetCheck;
  commitResetCheck = (async () => {
    try {
      if (!tracker || !(await isTrackingFileTruncated())) return false;
      await tracker.consume();
      log('Tracking file truncated by commit hook — stats rebased to last snapshot');
      if (tracker) {
        await writeTrackingFile(tracker.getStats()).catch(() => {});
      }
      return true;
    } finally {
      commitResetCheck = null;
    }
  })();
  return commitResetCheck;
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
      ch.appendLine(`Chat sessions dir: ${diag.chatSessionsDir ?? '(none — empty window)'}`);
      ch.appendLine('');
      ch.appendLine(`Session files found: ${diag.filesFound.length}`);
      for (const f of diag.filesFound) {
        ch.appendLine(`  ${f}`);
      }

      if (tracker) {
        // Force a fresh scan so the per-file breakdown reflects what's on
        // disk right now, not whatever was cached up to ~30s ago.
        await tracker.update();
        const stats = tracker.getStats();
        ch.appendLine('');
        ch.appendLine('Current stats:');
        ch.appendLine(`  Total tokens: ${stats.totalTokens}`);
        ch.appendLine(`  Interactions: ${stats.interactions}`);
        ch.appendLine(`  AI Credits: ${stats.totalAiCredits.toFixed(2)}`);
        ch.appendLine(`  Since: ${stats.since}`);
        ch.appendLine(`  Last updated: ${stats.lastUpdated}`);

        const perFile = tracker.getFileDiagnostics();
        ch.appendLine('');
        ch.appendLine(`Per-file breakdown (${perFile.length} file(s)):`);
        for (const f of perFile) {
          ch.appendLine(`  ${f.path}`);
          ch.appendLine(`    mtime: ${new Date(f.mtime).toISOString()}`);
          ch.appendLine(
            `    in baseline: ${f.inBaseline ? 'yes (pre-session content folded into baseline)' : 'no (entire file counts toward session delta)'}`,
          );
          ch.appendLine(`    interactions: ${f.interactions}`);
          const models = Object.entries(f.modelUsage);
          if (models.length === 0) {
            ch.appendLine('    models: (none)');
          } else {
            for (const [model, tokens] of models) {
              const total =
                tokens.inputTokens +
                tokens.outputTokens +
                tokens.cacheReadTokens +
                tokens.cacheCreationTokens;
              const turns = f.modelInteractions[model] ?? 0;
              ch.appendLine(
                `    ${model}: ${total} tokens across ${turns} turn(s) ` +
                  `(in=${tokens.inputTokens}, out=${tokens.outputTokens}, ` +
                  `cr=${tokens.cacheReadTokens}, cc=${tokens.cacheCreationTokens})`,
              );
            }
          }
        }
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

  tracker = new Tracker(new JsonlSource(context.storageUri), 'files');

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
      if (tracker) showStatsQuickPick(tracker);
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
      const newState = !isCommitHookEnabled();
      await vscode.workspace
        .getConfiguration('copilot-budget')
        .update('commitHook.enabled', newState, vscode.ConfigurationTarget.Global);
      if (newState) {
        await installHook();
      } else {
        await uninstallHook();
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
  commitResetCheck = null;
  disposeLogger();
}
