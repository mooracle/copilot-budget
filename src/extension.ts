import * as vscode from 'vscode';
import { Tracker } from './tracker';
import { createStatusBar, showStatsQuickPick } from './statusBar';
import { writeTrackingFile } from './trackingFile';
import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import { isEnabled, isCommitHookEnabled, onConfigChanged } from './config';

let tracker: Tracker | null = null;
let statusBar: { item: vscode.StatusBarItem; dispose: () => void } | null =
  null;

export function activate(context: vscode.ExtensionContext): void {
  if (!isEnabled()) return;

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
    vscode.commands.registerCommand('tokentrack.showStats', () => {
      if (tracker) showStatsQuickPick(tracker);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokentrack.resetTracking', () => {
      if (tracker) {
        tracker.reset();
        vscode.window.showInformationMessage('TokenTrack: Tracking reset.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokentrack.installHook', () => {
      installHook();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokentrack.uninstallHook', () => {
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
