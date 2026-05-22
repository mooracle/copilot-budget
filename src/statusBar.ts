import * as vscode from 'vscode';
import { Tracker, TrackingStats } from './tracker';
import { getDisplayName } from './tokenRates';
import { getDisplayCurrency, onConfigChanged } from './config';
import { formatAmount } from './amountFormatter';

function buildTooltip(stats: TrackingStats): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  const currency = getDisplayCurrency();
  const mode = stats.mode;
  md.appendMarkdown(
    `**Total:** ${formatAmount(stats.totalAiCredits, { mode, currency, precision: 'full' })}\n\n`,
  );

  const entries = Object.entries(stats.models);
  if (entries.length > 0) {
    for (const [model, usage] of entries) {
      md.appendMarkdown(
        `- ${getDisplayName(model)}: ${formatAmount(usage.costAic, { mode, currency, precision: 'full' })}\n`,
      );
    }
  }

  return md;
}

export interface StatusBarHandle {
  item: vscode.StatusBarItem;
  setNudge(visible: boolean): void;
  dispose(): void;
}

export function createStatusBar(tracker: Tracker): StatusBarHandle {
  const item = vscode.window.createStatusBarItem(
    'copilot-budget.statusBar',
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.name = 'Copilot Budget';
  item.command = 'copilot-budget.showStats';

  let nudgeVisible = false;

  function render(stats: TrackingStats): void {
    if (nudgeVisible) {
      item.text = '$(refresh) Copilot Budget — reload to start tracking';
      item.command = 'workbench.action.reloadWindow';
      item.tooltip = 'Reload to start tracking';
      return;
    }
    const currency = getDisplayCurrency();
    item.text = `$(credit-card) ${formatAmount(stats.totalAiCredits, { mode: stats.mode, currency, precision: 'short' })}`;
    item.command = 'copilot-budget.showStats';
    item.tooltip = buildTooltip(stats);
  }

  render(tracker.getStats());
  item.show();

  const subscription = tracker.onStatsChanged(render);
  // Currency lives in settings, not in TrackingStats — without this hook the
  // status bar would keep rendering in the old unit until the next scan-driven
  // stats event, which on an idle workspace may be many minutes away.
  const configSub = onConfigChanged((e) => {
    if (e.affectsConfiguration('copilot-budget.displayCurrency')) {
      render(tracker.getStats());
    }
  });

  return {
    item,
    setNudge(visible: boolean): void {
      nudgeVisible = visible;
      render(tracker.getStats());
    },
    dispose: () => {
      subscription.dispose();
      configSub.dispose();
      item.dispose();
    },
  };
}
