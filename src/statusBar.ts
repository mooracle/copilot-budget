import * as vscode from 'vscode';
import { Tracker, TrackingStats, ModelStats } from './tracker';
import { getDisplayName } from './tokenRates';
import { isCommitHookEnabled, getDisplayCurrency } from './config';
import { formatAmount } from './amountFormatter';

const FILES_NOTE = 'Estimate assumes no caching (upper bound).';
const TELEMETRY_NOTE = "Measured via Copilot's OTel database.";

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
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
  const currency = getDisplayCurrency();
  const mode = stats.mode;
  const items: vscode.QuickPickItem[] = [];

  items.push({
    label: `$(credit-card) Total: ${formatAmount(stats.totalAiCredits, { mode, currency, precision: 'full' })}`,
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
        description: formatAmount(usage.costAic, { mode, currency, precision: 'full' }),
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
