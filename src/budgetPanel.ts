import * as vscode from 'vscode';
import { Tracker, ModelStats, TrackingStats } from './tracker';
import { getDisplayName } from './tokenRates';
import { getDisplayCurrency } from './config';
import { isHookInstalled, installHook, uninstallHook } from './commitHook';
import { formatAmount } from './amountFormatter';

const ACTION = {
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
  hookInstalled: boolean,
): PanelItem[] {
  const items: PanelItem[] = [];

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
    label: `$(credit-card) Total: ${formatAmount(stats.totalAiCredits, { currency, precision: 'full' })}`,
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
        description: formatAmount(usage.costAic, { currency, precision: 'full' }),
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

async function handleCurrencyToggle(current: 'aic' | 'usd'): Promise<void> {
  const next = current === 'aic' ? 'usd' : 'aic';
  // Same rationale as handleOTelEnable: warn the user when the settings write
  // fails rather than letting the rejection bubble up silently. The render
  // loop will continue regardless so the panel doesn't strand on a stale view.
  try {
    await vscode.workspace
      .getConfiguration('copilot-budget')
      .update('displayCurrency', next, vscode.ConfigurationTarget.Global);
  } catch {
    vscode.window.showWarningMessage(
      'Copilot Budget: Failed to change display currency — settings could not be saved.',
    );
  }
}

async function handleHookToggle(installed: boolean): Promise<void> {
  // Run the hook action FIRST, then persist `copilot-budget.commitHook.enabled`
  // only if the action succeeded. The two states must stay in sync:
  //   - setting=true means "auto-install on activation and after any
  //     copilot-budget.* config change" (see extension.ts onConfigChanged).
  //     If we persisted true before a failed install, every later config
  //     change would re-attempt the failing install — never succeeding but
  //     also never reflecting reality.
  //   - setting=false means "do not auto-install". If we persisted false
  //     before a failed uninstall, the hook would remain on disk while the
  //     setting claims it's off.
  // installHook/uninstallHook return false on failure (no workspace folder,
  // existing non-Copilot hook, FS error, etc); the user has already seen the
  // warning/error toast in those paths.
  const succeeded = installed ? await uninstallHook() : await installHook();
  if (!succeeded) return;
  // The settings write can also fail (locked settings.json, Settings Sync
  // provider error, ConfigurationTarget rejection). Catching it here is
  // important because showBudgetPanel's caller in extension.ts swallows
  // unhandled rejections — without this the user wouldn't know that the
  // install/uninstall succeeded on disk but the setting will trigger the
  // wrong behavior on the next onConfigChanged tick (a stale "true" after
  // uninstall would re-install the hook).
  try {
    await vscode.workspace
      .getConfiguration('copilot-budget')
      .update('commitHook.enabled', !installed, vscode.ConfigurationTarget.Global);
  } catch {
    vscode.window.showWarningMessage(
      `Copilot Budget: Hook ${installed ? 'removed' : 'installed'}, but failed to save the commitHook.enabled setting — disk state and setting may now disagree.`,
    );
  }
}

export async function showBudgetPanel(ctx: PanelContext): Promise<void> {
  // Render-pick-handle loop. Toggles (currency, hook) re-render so the user
  // sees the new state immediately; stat picks exit because there's nothing
  // to do with them.
  while (true) {
    const stats = ctx.tracker.getStats();
    const currency = getDisplayCurrency();
    const hookInstalled = await isHookInstalled();

    const items = buildItems(stats, currency, hookInstalled);
    const picked = (await vscode.window.showQuickPick(items, {
      title: 'Copilot Budget',
      placeHolder: 'Manage currency, hook, and view stats',
    })) as PanelItem | undefined;

    if (!picked) return;

    switch (picked.__action) {
      case ACTION.CurrencyToggle:
        await handleCurrencyToggle(currency);
        continue;
      case ACTION.HookToggle:
        await handleHookToggle(hookInstalled);
        continue;
      case ACTION.Refresh:
        // Trigger a fresh scan so the next render shows the latest stats
        // instead of whatever the 30s background poll has cached. Swallow
        // failures (the next normal poll will retry); the panel must still
        // re-render so the user isn't stuck on a stale view.
        try {
          await ctx.tracker.update();
        } catch {
          // Intentionally ignored; tracker.update logs internally.
        }
        continue;
      case ACTION.Stat:
      default:
        return;
    }
  }
}
