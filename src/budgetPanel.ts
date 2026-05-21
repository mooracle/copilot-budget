import * as vscode from 'vscode';
import { Tracker, ModelStats, TrackingStats } from './tracker';
import { getDisplayName } from './tokenRates';
import {
  isOTelDbExporterEnabled,
  getDisplayCurrency,
  OTEL_SECTION,
  OTEL_KEY,
  OTEL_FULL_KEY,
} from './config';
import { isHookInstalled, installHook, uninstallHook } from './commitHook';
import { formatAmount } from './amountFormatter';

// Strictly asymmetric upstream-write invariant: we only ever flip the OTel
// exporter setting to `true` via this panel — never to `false`. To stop using
// telemetry data, users disable the upstream setting in VS Code settings.

const ACTION = {
  OTelEnable: 'otel-enable',
  OTelAlreadyEnabled: 'otel-already-enabled',
  CurrencyToggle: 'currency-toggle',
  HookToggle: 'hook-toggle',
  Refresh: 'refresh',
  Stat: 'stat',
} as const;
type Action = (typeof ACTION)[keyof typeof ACTION];

interface PanelItem extends vscode.QuickPickItem {
  __action?: Action;
}

export interface PanelContext {
  tracker: Tracker;
}

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

function buildItems(
  stats: TrackingStats,
  currency: 'aic' | 'usd',
  otelEnabled: boolean,
  hookInstalled: boolean,
): PanelItem[] {
  const items: PanelItem[] = [];
  const mode = stats.mode;

  if (otelEnabled) {
    items.push({
      label: '$(check) Accurate cost tracking (OTel) — enabled',
      __action: ACTION.OTelAlreadyEnabled,
    });
  } else {
    items.push({
      label: '$(circle-large-outline) Enable accurate cost tracking (OTel)',
      __action: ACTION.OTelEnable,
    });
  }

  items.push({
    label:
      currency === 'aic'
        ? '$(symbol-numeric) Display: AIC (switch to $)'
        : '$(symbol-numeric) Display: $ (switch to AIC)',
    __action: ACTION.CurrencyToggle,
  });

  items.push({
    label: hookInstalled
      ? '$(check) Append AI Credits trailer to commits'
      : '$(circle-large-outline) Append AI Credits trailer to commits',
    __action: ACTION.HookToggle,
  });

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

  items.push({
    label: `$(credit-card) Total: ${formatAmount(stats.totalAiCredits, { mode, currency, precision: 'full' })}`,
    __action: ACTION.Stat,
  });
  items.push({
    label: '$(clock) Tracking since',
    description: new Date(stats.since).toLocaleString(),
    __action: ACTION.Stat,
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
        __action: ACTION.Stat,
      });
    }
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(refresh) Refresh',
    __action: ACTION.Refresh,
  });

  return items;
}

async function handleOTelEnable(): Promise<void> {
  await vscode.workspace
    .getConfiguration(OTEL_SECTION)
    .update(OTEL_KEY, true, vscode.ConfigurationTarget.Global);
  const action = await vscode.window.showInformationMessage(
    'Accurate cost tracking enabled. Reload window now?',
    'Reload',
    'Later',
  );
  if (action === 'Reload') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function handleOTelAlreadyEnabled(): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    `OTel is already enabled. To disable, use VS Code settings: ${OTEL_FULL_KEY}`,
    'Open Settings',
  );
  if (action === 'Open Settings') {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      OTEL_FULL_KEY,
    );
  }
}

async function handleCurrencyToggle(current: 'aic' | 'usd'): Promise<void> {
  const next = current === 'aic' ? 'usd' : 'aic';
  await vscode.workspace
    .getConfiguration('copilot-budget')
    .update('displayCurrency', next, vscode.ConfigurationTarget.Global);
}

async function handleHookToggle(installed: boolean): Promise<void> {
  if (installed) {
    await uninstallHook();
  } else {
    await installHook();
  }
}

export async function showBudgetPanel(ctx: PanelContext): Promise<void> {
  // Render-pick-handle loop. Toggles (currency, hook) re-render so the user
  // sees the new state immediately; OTel toggles and stat picks exit because
  // the follow-up flow (reload prompt / settings page / cancellation) moves
  // focus away from the panel.
  while (true) {
    const stats = ctx.tracker.getStats();
    const currency = getDisplayCurrency();
    const otelEnabled = isOTelDbExporterEnabled();
    const hookInstalled = await isHookInstalled();

    const items = buildItems(stats, currency, otelEnabled, hookInstalled);
    const picked = (await vscode.window.showQuickPick(items, {
      title: 'Copilot Budget',
      placeHolder: 'Manage OTel mode, currency, hook, and view stats',
    })) as PanelItem | undefined;

    if (!picked) return;

    switch (picked.__action) {
      case ACTION.OTelEnable:
        await handleOTelEnable();
        return;
      case ACTION.OTelAlreadyEnabled:
        await handleOTelAlreadyEnabled();
        return;
      case ACTION.CurrencyToggle:
        await handleCurrencyToggle(currency);
        continue;
      case ACTION.HookToggle:
        await handleHookToggle(hookInstalled);
        continue;
      case ACTION.Refresh:
        continue;
      case ACTION.Stat:
      default:
        return;
    }
  }
}
