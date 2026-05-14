import * as vscode from 'vscode';
import { Tracker, TrackingStats, ModelStats } from './tracker';
import { getDisplayName } from './tokenRates';

const HEURISTIC_NOTE =
  "Cost is an estimate. When per-message cache split isn't reported by " +
  'Copilot, the extension assumes 75% cached input from turn 2 onward ' +
  '(real value may be higher or lower).';

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatUsdShort(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatUsdLong(n: number): string {
  return `$${n.toFixed(4)}`;
}

function formatAic(n: number): string {
  return `${n.toFixed(2)} AIC`;
}

function totalModelTokens(usage: ModelStats): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheCreationTokens
  );
}

function buildTooltip(stats: TrackingStats): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendMarkdown(
    `**Total:** ${formatUsdLong(stats.totalAiCredits / 100)} (${formatAic(stats.totalAiCredits)})\n\n`,
  );

  const entries = Object.entries(stats.models);
  if (entries.length > 0) {
    for (const [model, usage] of entries) {
      md.appendMarkdown(
        `- ${getDisplayName(model)}: ${formatUsdLong(usage.costAic / 100)} (${formatAic(usage.costAic)})\n`,
      );
    }
    md.appendMarkdown('\n');
  }

  md.appendMarkdown(`_${HEURISTIC_NOTE}_`);
  return md;
}

export function createStatusBar(
  tracker: Tracker,
): { item: vscode.StatusBarItem; dispose: () => void } {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.command = 'copilot-budget.showStats';

  function updateText(stats: TrackingStats): void {
    item.text = `$(credit-card) ${formatUsdShort(stats.totalAiCredits / 100)} Est`;
    item.tooltip = buildTooltip(stats);
  }

  updateText(tracker.getStats());
  item.show();

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
    label: `$(credit-card) Total: ${formatUsdLong(stats.totalAiCredits / 100)}`,
    description: formatAic(stats.totalAiCredits),
  });

  items.push({
    label: `$(clock) Tracking since`,
    description: new Date(stats.since).toLocaleString(),
  });

  const models = Object.entries(stats.models);
  if (models.length > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    for (const [model, usage] of models) {
      const totalTokens = totalModelTokens(usage);
      items.push({
        label: `$(hubot) ${getDisplayName(model)}`,
        description: `${formatUsdLong(usage.costAic / 100)} (${formatAic(usage.costAic)})`,
        detail:
          `Tokens: ${formatNumber(totalTokens)} ` +
          `(in: ${formatNumber(usage.inputTokens)} / ` +
          `cache_read: ${formatNumber(usage.cacheReadTokens)} / ` +
          `cache_creation: ${formatNumber(usage.cacheCreationTokens)} / ` +
          `out: ${formatNumber(usage.outputTokens)})`,
      });
    }
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(info) Estimate note',
    description: HEURISTIC_NOTE,
  });

  await vscode.window.showQuickPick(items, {
    title: 'Copilot Budget',
    placeHolder: 'Per-model cost breakdown',
  });
}
