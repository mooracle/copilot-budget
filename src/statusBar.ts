import * as vscode from 'vscode';
import { Tracker, TrackingStats } from './tracker';
import { getPlanInfo } from './planDetector';

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatPR(n: number): string {
  return n.toFixed(2);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function createStatusBar(
  tracker: Tracker,
): { item: vscode.StatusBarItem; dispose: () => void } {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.text = '$(symbol-numeric) Copilot: 0.00 PR | $0.00';
  item.tooltip = 'Click to view per-model budget breakdown';
  item.command = 'copilot-budget.showStats';
  item.show();

  function updateText(stats: TrackingStats): void {
    item.text = `$(symbol-numeric) Copilot: ${formatPR(stats.premiumRequests)} PR | ${formatCost(stats.estimatedCost)}`;
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
    label: `$(symbol-numeric) Premium Requests: ${formatPR(stats.premiumRequests)}`,
    description: `Est. cost: ${formatCost(stats.estimatedCost)}`,
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
        description: `${formatPR(usage.premiumRequests)} PR | ${formatCost(usage.premiumRequests * getPlanInfo().costPerRequest)}`,
        detail: `Tokens: ${formatNumber(total)} (in: ${formatNumber(usage.inputTokens)} / out: ${formatNumber(usage.outputTokens)})`,
      });
    }
  }

  const planInfo = getPlanInfo();
  const title = planInfo.source !== 'default'
    ? `Copilot Budget - Premium Requests (${planInfo.planName} plan)`
    : 'Copilot Budget - Premium Requests';

  await vscode.window.showQuickPick(items, {
    title,
    placeHolder: 'Per-model budget breakdown',
  });
}
