import * as vscode from 'vscode';
import * as path from 'path';
import { __workspaceUpdate } from './__mocks__/vscode';
import { showBudgetPanel } from './budgetPanel';
import { Tracker, TrackingStats } from './tracker';
import { loadRateCard, resetRateCardForTesting } from './tokenRates';

jest.mock('./tracker');
jest.mock('./sessionDiscovery');
jest.mock('./sessionParser');
jest.mock('./config', () => ({
  getDisplayCurrency: jest.fn().mockReturnValue('aic'),
  isOTelDbExporterEnabled: jest.fn().mockReturnValue(false),
  OTEL_SECTION: 'github.copilot.chat.otel',
  OTEL_KEY: 'dbSpanExporter.enabled',
  OTEL_FULL_KEY: 'github.copilot.chat.otel.dbSpanExporter.enabled',
}));
jest.mock('./commitHook', () => ({
  isHookInstalled: jest.fn().mockResolvedValue(false),
  installHook: jest.fn().mockResolvedValue(true),
  uninstallHook: jest.fn().mockResolvedValue(true),
}));

import { getDisplayCurrency, isOTelDbExporterEnabled } from './config';
import { isHookInstalled, installHook, uninstallHook } from './commitHook';

const mockGetDisplayCurrency = getDisplayCurrency as jest.MockedFunction<
  typeof getDisplayCurrency
>;
const mockIsOTelDbExporterEnabled = isOTelDbExporterEnabled as jest.MockedFunction<
  typeof isOTelDbExporterEnabled
>;
const mockIsHookInstalled = isHookInstalled as jest.MockedFunction<
  typeof isHookInstalled
>;
const mockInstallHook = installHook as jest.MockedFunction<typeof installHook>;
const mockUninstallHook = uninstallHook as jest.MockedFunction<
  typeof uninstallHook
>;

const mockWindow = vscode.window as any;
const mockCommands = vscode.commands as any;

function makeStats(overrides: Partial<TrackingStats> = {}): TrackingStats {
  return {
    since: '2024-01-15T10:30:00Z',
    lastUpdated: '2024-01-15T12:00:00Z',
    models: {
      'gpt-4.1': {
        inputTokens: 1500,
        outputTokens: 800,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costAic: 0.94,
      },
      'claude-sonnet-4.6': {
        inputTokens: 500,
        outputTokens: 300,
        cacheReadTokens: 1200,
        cacheCreationTokens: 0,
        costAic: 0.786,
      },
    },
    totalTokens: 4300,
    interactions: 15,
    totalAiCredits: 1.726,
    mode: 'files',
    ...overrides,
  };
}

function makeTracker(stats: TrackingStats): Tracker {
  return {
    getStats: jest.fn().mockReturnValue(stats),
  } as unknown as Tracker;
}

beforeAll(() => {
  resetRateCardForTesting();
  loadRateCard(path.join(__dirname, '__fixtures__', 'models-and-pricing.json'));
});

afterAll(() => {
  resetRateCardForTesting();
});

beforeEach(() => {
  jest.clearAllMocks();
  __workspaceUpdate.mockClear();
  mockGetDisplayCurrency.mockReturnValue('aic');
  mockIsOTelDbExporterEnabled.mockReturnValue(false);
  mockIsHookInstalled.mockResolvedValue(false);
  mockInstallHook.mockResolvedValue(true);
  mockUninstallHook.mockResolvedValue(true);
  // Default: user dismisses the panel (no item picked) so the loop exits
  // after one render. Individual tests override this for action paths.
  mockWindow.showQuickPick = jest.fn().mockResolvedValue(undefined);
  mockWindow.showInformationMessage = jest.fn().mockResolvedValue(undefined);
  mockCommands.executeCommand = jest.fn().mockResolvedValue(undefined);
});

describe('budgetPanel', () => {
  describe('panel rendering', () => {
    it('renders three toggle rows at the top in declared order', async () => {
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      // Skip past separators when verifying — first three non-separator items
      // are OTel, Currency, Hook in that order.
      const toggleRows = items.filter(
        (i: any) => i.kind !== vscode.QuickPickItemKind.Separator,
      );
      expect(toggleRows[0].label).toContain('OTel');
      expect(toggleRows[1].label).toContain('Display');
      expect(toggleRows[2].label).toContain('Append AI Credits trailer');
    });

    it('renders the OTel-off row when upstream setting is false', async () => {
      mockIsOTelDbExporterEnabled.mockReturnValue(false);
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const otel = items.find((i: any) => i.label?.includes('OTel'));
      expect(otel.label).toContain('$(circle-large-outline)');
      expect(otel.label).toContain('Enable accurate cost tracking');
    });

    it('renders the OTel-on row when upstream setting is true', async () => {
      mockIsOTelDbExporterEnabled.mockReturnValue(true);
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const otel = items.find((i: any) => i.label?.includes('OTel'));
      expect(otel.label).toContain('$(check)');
      expect(otel.label).toContain('enabled');
    });

    it('renders currency row reflecting AIC state', async () => {
      mockGetDisplayCurrency.mockReturnValue('aic');
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const currency = items.find((i: any) => i.label?.includes('Display'));
      expect(currency.label).toContain('AIC (switch to $)');
    });

    it('renders currency row reflecting USD state', async () => {
      mockGetDisplayCurrency.mockReturnValue('usd');
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const currency = items.find((i: any) => i.label?.includes('Display'));
      expect(currency.label).toContain('$ (switch to AIC)');
    });

    it('renders hook-installed row when isHookInstalled returns true', async () => {
      mockIsHookInstalled.mockResolvedValue(true);
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const hook = items.find((i: any) =>
        i.label?.includes('Append AI Credits trailer'),
      );
      expect(hook.label).toContain('$(check)');
    });

    it('renders hook-not-installed row when isHookInstalled returns false', async () => {
      mockIsHookInstalled.mockResolvedValue(false);
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const hook = items.find((i: any) =>
        i.label?.includes('Append AI Credits trailer'),
      );
      expect(hook.label).toContain('$(circle-large-outline)');
    });

    it('shows total with tilde in files mode and AIC formatting', async () => {
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const total = items.find((i: any) => i.label?.includes('Total:'));
      expect(total.label).toContain('~1.73 AIC');
    });

    it('shows total without tilde in telemetry mode', async () => {
      const tracker = makeTracker(makeStats({ mode: 'telemetry' }));
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const total = items.find((i: any) => i.label?.includes('Total:'));
      expect(total.label).toContain('1.73 AIC');
      expect(total.label).not.toContain('~');
    });

    it('shows total in USD when currency is usd', async () => {
      mockGetDisplayCurrency.mockReturnValue('usd');
      const tracker = makeTracker(makeStats({ mode: 'telemetry' }));
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const total = items.find((i: any) => i.label?.includes('Total:'));
      expect(total.label).toMatch(/\$0\.0\d/);
    });

    it('renders per-model rows with token buckets in detail', async () => {
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const claude = items.find((i: any) =>
        i.label?.includes('Claude Sonnet 4.6'),
      );
      expect(claude).toBeDefined();
      expect(claude.description).toBe('~0.79 AIC');
      expect(claude.detail).toContain('in:');
      expect(claude.detail).toContain('cache_read:');
      expect(claude.detail).toContain('cache_creation:');
      expect(claude.detail).toContain('out:');
    });

    it('omits per-model section when models empty', async () => {
      const tracker = makeTracker(
        makeStats({
          models: {},
          totalTokens: 0,
          totalAiCredits: 0,
          interactions: 0,
        }),
      );
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const modelRows = items.filter((i: any) => i.label?.includes('$(hubot)'));
      expect(modelRows).toHaveLength(0);
    });

    it('includes a Refresh action at the bottom', async () => {
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const refresh = items.find((i: any) => i.label?.includes('Refresh'));
      expect(refresh).toBeDefined();
      expect(refresh.label).toContain('$(refresh)');
    });

    it('uses separators between sections', async () => {
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const seps = items.filter(
        (i: any) => i.kind === vscode.QuickPickItemKind.Separator,
      );
      // toggles | stats | (models) | refresh → at least 2 separators
      expect(seps.length).toBeGreaterThanOrEqual(2);
    });

    it('passes title and placeHolder to showQuickPick', async () => {
      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const options = mockWindow.showQuickPick.mock.calls[0][1];
      expect(options.title).toBe('Copilot Budget');
      expect(options.placeHolder).toBeTruthy();
    });
  });

  describe('OTel toggle (strictly asymmetric)', () => {
    it('writes upstream setting to true when OTel-off row is picked', async () => {
      mockIsOTelDbExporterEnabled.mockReturnValue(false);
      mockWindow.showQuickPick.mockImplementationOnce(async (items: any[]) =>
        items.find((i) => i.label?.includes('Enable accurate')),
      );

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(__workspaceUpdate).toHaveBeenCalledWith(
        'github.copilot.chat.otel',
        'dbSpanExporter.enabled',
        true,
        vscode.ConfigurationTarget.Global,
      );
    });

    it('prompts for reload after enabling OTel', async () => {
      mockIsOTelDbExporterEnabled.mockReturnValue(false);
      mockWindow.showQuickPick.mockImplementationOnce(async (items: any[]) =>
        items.find((i) => i.label?.includes('Enable accurate')),
      );
      mockWindow.showInformationMessage.mockResolvedValueOnce('Later');

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockWindow.showInformationMessage).toHaveBeenCalledWith(
        expect.stringMatching(/Reload window now/i),
        'Reload',
        'Later',
      );
    });

    it('reloads when user picks Reload', async () => {
      mockIsOTelDbExporterEnabled.mockReturnValue(false);
      mockWindow.showQuickPick.mockImplementationOnce(async (items: any[]) =>
        items.find((i) => i.label?.includes('Enable accurate')),
      );
      mockWindow.showInformationMessage.mockResolvedValueOnce('Reload');

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockCommands.executeCommand).toHaveBeenCalledWith(
        'workbench.action.reloadWindow',
      );
    });

    it('does not reload when user picks Later', async () => {
      mockIsOTelDbExporterEnabled.mockReturnValue(false);
      mockWindow.showQuickPick.mockImplementationOnce(async (items: any[]) =>
        items.find((i) => i.label?.includes('Enable accurate')),
      );
      mockWindow.showInformationMessage.mockResolvedValueOnce('Later');

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockCommands.executeCommand).not.toHaveBeenCalled();
    });

    it('does NOT call configuration.update when OTel-on row is picked (asymmetric invariant)', async () => {
      mockIsOTelDbExporterEnabled.mockReturnValue(true);
      mockWindow.showQuickPick.mockImplementationOnce(async (items: any[]) =>
        items.find((i) => i.label?.includes('OTel') && i.label?.includes('enabled')),
      );

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      // The whole point: clicking the already-enabled row must NEVER flip
      // the upstream setting to anything (and especially never to false).
      expect(__workspaceUpdate).not.toHaveBeenCalled();
    });

    it('shows the open-settings info message when OTel-on row is picked', async () => {
      mockIsOTelDbExporterEnabled.mockReturnValue(true);
      mockWindow.showQuickPick.mockImplementationOnce(async (items: any[]) =>
        items.find((i) => i.label?.includes('OTel') && i.label?.includes('enabled')),
      );

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockWindow.showInformationMessage).toHaveBeenCalledWith(
        expect.stringMatching(/already enabled/i),
        'Open Settings',
      );
    });

    it('opens settings when user picks Open Settings', async () => {
      mockIsOTelDbExporterEnabled.mockReturnValue(true);
      mockWindow.showQuickPick.mockImplementationOnce(async (items: any[]) =>
        items.find((i) => i.label?.includes('OTel') && i.label?.includes('enabled')),
      );
      mockWindow.showInformationMessage.mockResolvedValueOnce('Open Settings');

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockCommands.executeCommand).toHaveBeenCalledWith(
        'workbench.action.openSettings',
        'github.copilot.chat.otel.dbSpanExporter.enabled',
      );
    });
  });

  describe('currency toggle', () => {
    it('writes the inverted value when currency row is picked', async () => {
      mockGetDisplayCurrency.mockReturnValue('aic');
      // First call: pick currency row. Second call: user dismisses re-rendered panel.
      mockWindow.showQuickPick
        .mockImplementationOnce(async (items: any[]) =>
          items.find((i) => i.label?.includes('Display')),
        )
        .mockResolvedValueOnce(undefined);

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(__workspaceUpdate).toHaveBeenCalledWith(
        'copilot-budget',
        'displayCurrency',
        'usd',
        vscode.ConfigurationTarget.Global,
      );
    });

    it('writes back to aic when current is usd', async () => {
      mockGetDisplayCurrency.mockReturnValue('usd');
      mockWindow.showQuickPick
        .mockImplementationOnce(async (items: any[]) =>
          items.find((i) => i.label?.includes('Display')),
        )
        .mockResolvedValueOnce(undefined);

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(__workspaceUpdate).toHaveBeenCalledWith(
        'copilot-budget',
        'displayCurrency',
        'aic',
        vscode.ConfigurationTarget.Global,
      );
    });

    it('alternates correctly across multiple accepts', async () => {
      // aic → usd → aic → exit
      const currencies = ['aic', 'usd', 'aic'] as const;
      let renderCount = 0;
      mockGetDisplayCurrency.mockImplementation(
        () => currencies[Math.min(renderCount, currencies.length - 1)],
      );
      mockWindow.showQuickPick.mockImplementation(async (items: any[]) => {
        renderCount += 1;
        if (renderCount <= 2) {
          return items.find((i: any) => i.label?.includes('Display'));
        }
        return undefined; // exit third loop
      });

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      const currencyUpdates = __workspaceUpdate.mock.calls.filter(
        (c) => c[0] === 'copilot-budget' && c[1] === 'displayCurrency',
      );
      expect(currencyUpdates).toHaveLength(2);
      expect(currencyUpdates[0][2]).toBe('usd'); // aic → usd
      expect(currencyUpdates[1][2]).toBe('aic'); // usd → aic
    });

    it('re-renders the panel after currency toggle', async () => {
      mockGetDisplayCurrency.mockReturnValue('aic');
      mockWindow.showQuickPick
        .mockImplementationOnce(async (items: any[]) =>
          items.find((i) => i.label?.includes('Display')),
        )
        .mockResolvedValueOnce(undefined);

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      // Second showQuickPick call confirms the loop continued past the toggle.
      expect(mockWindow.showQuickPick).toHaveBeenCalledTimes(2);
    });
  });

  describe('hook toggle', () => {
    it('calls installHook and persists commitHook.enabled=true when hook is not installed', async () => {
      mockIsHookInstalled.mockResolvedValue(false);
      mockWindow.showQuickPick
        .mockImplementationOnce(async (items: any[]) =>
          items.find((i) => i.label?.includes('Append AI Credits trailer')),
        )
        .mockResolvedValueOnce(undefined);

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockInstallHook).toHaveBeenCalledTimes(1);
      expect(mockUninstallHook).not.toHaveBeenCalled();
      expect(__workspaceUpdate).toHaveBeenCalledWith(
        'copilot-budget',
        'commitHook.enabled',
        true,
        vscode.ConfigurationTarget.Global,
      );
    });

    it('calls uninstallHook and persists commitHook.enabled=false when hook is installed', async () => {
      mockIsHookInstalled.mockResolvedValue(true);
      mockWindow.showQuickPick
        .mockImplementationOnce(async (items: any[]) =>
          items.find((i) => i.label?.includes('Append AI Credits trailer')),
        )
        .mockResolvedValueOnce(undefined);

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockUninstallHook).toHaveBeenCalledTimes(1);
      expect(mockInstallHook).not.toHaveBeenCalled();
      expect(__workspaceUpdate).toHaveBeenCalledWith(
        'copilot-budget',
        'commitHook.enabled',
        false,
        vscode.ConfigurationTarget.Global,
      );
    });

    it('re-renders the panel after hook toggle', async () => {
      mockIsHookInstalled.mockResolvedValue(false);
      mockWindow.showQuickPick
        .mockImplementationOnce(async (items: any[]) =>
          items.find((i) => i.label?.includes('Append AI Credits trailer')),
        )
        .mockResolvedValueOnce(undefined);

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockWindow.showQuickPick).toHaveBeenCalledTimes(2);
    });
  });

  describe('refresh action', () => {
    it('re-renders without writing any configuration', async () => {
      mockWindow.showQuickPick
        .mockImplementationOnce(async (items: any[]) =>
          items.find((i) => i.label?.includes('Refresh')),
        )
        .mockResolvedValueOnce(undefined);

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockWindow.showQuickPick).toHaveBeenCalledTimes(2);
      expect(__workspaceUpdate).not.toHaveBeenCalled();
    });
  });

  describe('dismissal', () => {
    it('exits without writes when user dismisses the panel', async () => {
      mockWindow.showQuickPick.mockResolvedValue(undefined);

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockWindow.showQuickPick).toHaveBeenCalledTimes(1);
      expect(__workspaceUpdate).not.toHaveBeenCalled();
      expect(mockInstallHook).not.toHaveBeenCalled();
      expect(mockUninstallHook).not.toHaveBeenCalled();
    });

    it('exits when a stat row is selected (no rerender)', async () => {
      mockWindow.showQuickPick.mockImplementationOnce(async (items: any[]) =>
        items.find((i) => i.label?.includes('Total:')),
      );

      const tracker = makeTracker(makeStats());
      await showBudgetPanel({ tracker });

      expect(mockWindow.showQuickPick).toHaveBeenCalledTimes(1);
    });
  });
});
