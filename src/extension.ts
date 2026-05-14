import * as vscode from 'vscode';
import { Tracker } from './tracker';
import { createStatusBar, showStatsQuickPick } from './statusBar';
import { writeTrackingFile, readTrackingFile } from './trackingFile';
import { installHook, uninstallHook } from './commitHook';
import { isEnabled, isCommitHookEnabled, onConfigChanged } from './config';
import { getDiscoveryDiagnostics } from './sessionDiscovery';
import { getOutputChannel, disposeLogger, log } from './logger';
import { initSqlite, disposeSqlite } from './sqliteReader';

let tracker: Tracker | null = null;
let statusBar: { item: vscode.StatusBarItem; dispose: () => void } | null =
  null;

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
  const restored = await readTrackingFile();
  if (restored) {
    tracker.setPreviousStats(restored);
    log('Restored stats from previous session');
  } else {
    log('No previous stats to restore');
  }

  tracker.start();

  statusBar = createStatusBar(tracker);
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Write tracking file whenever stats change
  const statsWriter = tracker.onStatsChanged((stats) => {
    writeTrackingFile(stats).catch(() => {});
  });
  context.subscriptions.push(statsWriter);

  // Also re-write the tracking file on every poll, in case the commit hook
  // truncated it. The onStatsChanged listener only fires when stats differ,
  // so without this the file stays empty after a commit until new activity.
  const trackingFileRefresh = setInterval(() => {
    if (tracker) writeTrackingFile(tracker.getStats()).catch(() => {});
  }, 120_000);
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
        tracker.reset();
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
        ch.appendLine(`  Total cost: $${stats.totalCostUsd.toFixed(4)}`);
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
    // Final write of current stats
    await writeTrackingFile(tracker.getStats()).catch(() => {});
    tracker.dispose();
    tracker = null;
  }
  if (statusBar) {
    statusBar.dispose();
    statusBar = null;
  }
  disposeSqlite();
  disposeLogger();
}
