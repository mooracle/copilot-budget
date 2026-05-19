import * as vscode from 'vscode';
import { Tracker, TrackingStats, ModelStats } from './tracker';
import { getDisplayName } from './tokenRates';
import { isCommitHookEnabled } from './config';

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatAic(n: number): string {
  return `${n.toFixed(2)} AIC`;
}

export function formatAicShort(n: number): string {
  if (!(n > 0)) {
    return '0 AIC';
  }
  return `${Math.ceil(n)} AIC`;
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
  md.appendMarkdown(`**Total:** ${formatAic(stats.totalAiCredits)}\n\n`);

  const entries = Object.entries(stats.models);
  if (entries.length > 0) {
    for (const [model, usage] of entries) {
      md.appendMarkdown(
        `- ${getDisplayName(model)}: ${formatAic(usage.costAic)}\n`,
      );
    }
  }

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
    item.text = `$(credit-card) ${formatAicShort(stats.totalAiCredits)}`;
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
    label: `$(credit-card) Total: ${formatAic(stats.totalAiCredits)}`,
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
        description: formatAic(usage.costAic),
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
  const hookEnabled = isCommitHookEnabled();
  const toggleLabel = `Commit-Hook: ${hookEnabled ? '$(check) ON' : '$(circle-slash) OFF'}`;
  items.push({
    label: toggleLabel,
    description: hookEnabled
      ? 'Click to disable — stop appending AI Credits trailer to commits'
      : 'Click to enable — append AI Credits trailer to commits',
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Copilot Budget',
    placeHolder: 'Per-model cost breakdown',
  });

  if (picked?.label === toggleLabel) {
    await vscode.commands.executeCommand('copilot-budget.toggleCommitHook');
  }
}
