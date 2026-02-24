import * as vscode from 'vscode';
import { Tracker } from './tracker';
import { createStatusBar, showStatsQuickPick } from './statusBar';
import { writeTrackingFile } from './trackingFile';
import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import { isEnabled, isCommitHookEnabled, onConfigChanged } from './config';
import { getDiscoveryDiagnostics } from './sessionDiscovery';
import { log, getOutputChannel, disposeLogger } from './logger';
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
  tracker.start();

  statusBar = createStatusBar(tracker);
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Write tracking file whenever stats change
  const statsWriter = tracker.onStatsChanged((stats) => {
    writeTrackingFile(stats);
  });
  context.subscriptions.push(statsWriter);

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
    vscode.commands.registerCommand('copilot-budget.installHook', () => {
      installHook();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.uninstallHook', () => {
      uninstallHook();
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
        ch.appendLine(`  Premium requests: ${stats.premiumRequests.toFixed(2)}`);
        ch.appendLine(`  Estimated cost: $${stats.estimatedCost.toFixed(2)}`);
        ch.appendLine(`  Since: ${stats.since}`);
        ch.appendLine(`  Last updated: ${stats.lastUpdated}`);
      }

      ch.show();
    }),
  );

  // Auto-install hook if enabled in settings
  if (isCommitHookEnabled() && !isHookInstalled()) {
    installHook();
  }

  // Listen for config changes
  const configSub = onConfigChanged(() => {
    if (isCommitHookEnabled() && !isHookInstalled()) {
      installHook();
    }
  });
  context.subscriptions.push(configSub);
}

export function deactivate(): void {
  if (tracker) {
    // Final write of current stats
    writeTrackingFile(tracker.getStats());
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
