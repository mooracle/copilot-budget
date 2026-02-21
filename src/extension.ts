import * as vscode from 'vscode';
import { Tracker } from './tracker';
import { createStatusBar, showStatsQuickPick } from './statusBar';
import { writeTrackingFile } from './trackingFile';
import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import { isEnabled, isCommitHookEnabled, onConfigChanged } from './config';

let tracker: Tracker | null = null;
let statusBar: { item: vscode.StatusBarItem; dispose: () => void } | null =
  null;

const ALL_COMMANDS = [
  'copilot-budget.showStats',
  'copilot-budget.resetTracking',
  'copilot-budget.installHook',
  'copilot-budget.uninstallHook',
];

export function activate(context: vscode.ExtensionContext): void {
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
}
