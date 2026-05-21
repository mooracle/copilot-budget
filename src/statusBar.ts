import * as vscode from 'vscode';
import { Tracker, TrackingStats } from './tracker';
import { getDisplayName } from './tokenRates';
import { getDisplayCurrency, onConfigChanged } from './config';
import { formatAmount } from './amountFormatter';

const FILES_NOTE = 'Estimate assumes no caching (upper bound).';
const TELEMETRY_NOTE = "Measured via Copilot's OTel database.";

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
    md.appendMarkdown('\n');
  }

  md.appendMarkdown(`_${mode === 'files' ? FILES_NOTE : TELEMETRY_NOTE}_\n`);

  return md;
}

export function createStatusBar(
  tracker: Tracker,
): { item: vscode.StatusBarItem; dispose: () => void } {
  const item = vscode.window.createStatusBarItem(
    'copilot-budget.statusBar',
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.name = 'Copilot Budget';
  item.command = 'copilot-budget.showStats';

  function updateText(stats: TrackingStats): void {
    const currency = getDisplayCurrency();
    item.text = `$(credit-card) ${formatAmount(stats.totalAiCredits, { mode: stats.mode, currency, precision: 'short' })}`;
    item.tooltip = buildTooltip(stats);
  }

  updateText(tracker.getStats());
  item.show();

  const subscription = tracker.onStatsChanged(updateText);
  // Currency lives in settings, not in TrackingStats — without this hook the
  // status bar would keep rendering in the old unit until the next scan-driven
  // stats event, which on an idle workspace may be many minutes away.
  const configSub = onConfigChanged((e) => {
    if (e.affectsConfiguration('copilot-budget.displayCurrency')) {
      updateText(tracker.getStats());
    }
  });

  return {
    item,
    dispose: () => {
      subscription.dispose();
      configSub.dispose();
      item.dispose();
    },
  };
}
