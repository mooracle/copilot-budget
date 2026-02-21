import * as vscode from 'vscode';
import { Tracker, TrackingStats } from './tracker';

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function createStatusBar(
  tracker: Tracker,
): { item: vscode.StatusBarItem; dispose: () => void } {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.text = '$(symbol-numeric) TokenTrack: 0';
  item.tooltip = 'Click to view per-model token breakdown';
  item.command = 'tokentrack.showStats';
  item.show();

  function updateText(stats: TrackingStats): void {
    item.text = `$(symbol-numeric) TokenTrack: ${formatNumber(stats.totalTokens)}`;
  }

  // Set initial text from current stats
  updateText(tracker.getStats());

  const subscription = tracker.onStatsChanged(updateText);

  return {
    item,
    dispose: () => {
      subscription.dispose();
      item.dispose();
    },
  };
}

export async function showStatsQuickPick(tracker: Tracker): Promise<void> {
  const stats = tracker.getStats();
  const items: vscode.QuickPickItem[] = [];

  items.push({
    label: `$(symbol-numeric) Total: ${formatNumber(stats.totalTokens)} tokens`,
    description: `${stats.interactions} interactions`,
  });

  items.push({
    label: `$(clock) Tracking since`,
    description: new Date(stats.since).toLocaleString(),
  });

  const models = Object.entries(stats.models);
  if (models.length > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    for (const [model, usage] of models) {
      const total = usage.inputTokens + usage.outputTokens;
      items.push({
        label: `$(hubot) ${model}`,
        description: `${formatNumber(total)} tokens`,
        detail: `Input: ${formatNumber(usage.inputTokens)} | Output: ${formatNumber(usage.outputTokens)}`,
      });
    }
  }

  await vscode.window.showQuickPick(items, {
    title: 'TokenTrack - Token Usage',
    placeHolder: 'Per-model token breakdown',
  });
}
