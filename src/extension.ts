import * as vscode from 'vscode';
import { Tracker } from './tracker';
import { createStatusBar, showStatsQuickPick } from './statusBar';
import { writeTrackingFile, readTrackingFile } from './trackingFile';
import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import { isEnabled, isCommitHookEnabled, onConfigChanged } from './config';
import { getDiscoveryDiagnostics } from './sessionDiscovery';
import { log, getOutputChannel, disposeLogger } from './logger';
import { initSqlite, disposeSqlite } from './sqliteReader';
import {
  detectPlan,
  getPlanInfo,
  onPlanChanged,
  startPeriodicRefresh,
  disposePlanDetector,
} from './planDetector';

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

  // Detect plan before starting tracker so cost calculations use the right rate
  await detectPlan();

  tracker = new Tracker();
  tracker.setPlanInfoProvider(getPlanInfo);

  // Restore stats from previous session (if tracking file exists)
  const restored = await readTrackingFile();
  if (restored) {
    tracker.setPreviousStats(restored);
    log('Restored stats from previous session');
  } else {
    log('No previous stats to restore');
  }

  tracker.start();

  // Periodic plan refresh (re-detect every 15 min)
  startPeriodicRefresh();

  // Recompute stats when plan changes
  const planSub = onPlanChanged(() => {
    if (tracker) tracker.update();
  });
  context.subscriptions.push(planSub);

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

      const planInfo = getPlanInfo();
      ch.appendLine('');
      ch.appendLine('Plan detection:');
      ch.appendLine(`  Plan: ${planInfo.planName}`);
      ch.appendLine(`  Cost per request: $${planInfo.costPerRequest.toFixed(4)}`);
      ch.appendLine(`  Source: ${planInfo.source}`);

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

  // Auto-install/refresh hook if enabled in settings
  if (isCommitHookEnabled()) {
    installHook().catch(() => {});
  }

  // Listen for config changes
  const configSub = onConfigChanged(() => {
    if (isCommitHookEnabled()) {
      installHook().catch(() => {});
    }
    // Re-detect plan when config changes (user may have changed copilot-budget.plan)
    detectPlan().catch(() => {});
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
  disposePlanDetector();
  disposeSqlite();
  disposeLogger();
}
