import { createStatusBar, showStatsQuickPick } from './statusBar';
import { Tracker, TrackingStats } from './tracker';
import * as vscode from 'vscode';
import * as path from 'path';
import { loadRateCard, resetRateCardForTesting } from './tokenRates';

jest.mock('./tracker');
jest.mock('./sessionDiscovery');
jest.mock('./sessionParser');
jest.mock('./config', () => ({
  isCommitHookEnabled: jest.fn().mockReturnValue(true),
  getDisplayCurrency: jest.fn().mockReturnValue('aic'),
}));

import { isCommitHookEnabled, getDisplayCurrency } from './config';
const mockIsCommitHookEnabled = isCommitHookEnabled as jest.MockedFunction<
  typeof isCommitHookEnabled
>;
const mockGetDisplayCurrency = getDisplayCurrency as jest.MockedFunction<
  typeof getDisplayCurrency
>;

const mockWindow = vscode.window as any;

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

function createMockTracker(stats: TrackingStats) {
  let listener: ((s: TrackingStats) => void) | null = null;
  const tracker = {
    getStats: jest.fn().mockReturnValue(stats),
    onStatsChanged: jest.fn().mockImplementation((cb: any) => {
      listener = cb;
      return { dispose: jest.fn() };
    }),
    initialize: jest.fn(),
    update: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
    dispose: jest.fn(),
  };
  return {
    tracker: tracker as unknown as Tracker,
    fireStatsChanged: (s: TrackingStats) => listener?.(s),
    getListener: () => listener,
  };
}

beforeAll(() => {
  resetRateCardForTesting();
  loadRateCard(path.join(__dirname, '__fixtures__', 'models-and-pricing.json'));
});

afterAll(() => {
  resetRateCardForTesting();
});

describe('statusBar', () => {
  let createdItem: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCommitHookEnabled.mockReturnValue(true);
    mockGetDisplayCurrency.mockReturnValue('aic');
    createdItem = {
      text: '',
      tooltip: '' as any,
      command: '',
      show: jest.fn(),
      hide: jest.fn(),
      dispose: jest.fn(),
    };
    mockWindow.createStatusBarItem = jest.fn().mockReturnValue(createdItem);
    mockWindow.showQuickPick = jest.fn().mockResolvedValue(undefined);
  });

  describe('createStatusBar', () => {
    it('creates a right-aligned status bar item with a stable id, name, and priority 100', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(mockWindow.createStatusBarItem).toHaveBeenCalledWith(
        'copilot-budget.statusBar',
        vscode.StatusBarAlignment.Right,
        100,
      );
      expect(createdItem.name).toBe('Copilot Budget');
    });

    it('sets initial text with tilde-prefixed AIC integer in files mode', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.text).toBe('$(credit-card) ~2 AIC');
    });

    it('shows 0 AIC for empty stats (no tilde even in files mode)', () => {
      const { tracker } = createMockTracker(
        makeStats({ totalAiCredits: 0, models: {} }),
      );
      createStatusBar(tracker);

      expect(createdItem.text).toBe('$(credit-card) 0 AIC');
    });

    it('drops tilde in telemetry mode', () => {
      const { tracker } = createMockTracker(makeStats({ mode: 'telemetry' }));
      createStatusBar(tracker);

      expect(createdItem.text).toBe('$(credit-card) 2 AIC');
    });

    it('renders USD when displayCurrency is usd', () => {
      mockGetDisplayCurrency.mockReturnValue('usd');
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      // 1.726 AIC → Math.ceil → 2 AIC → $0.02; files mode adds tilde.
      expect(createdItem.text).toBe('$(credit-card) ~$0.02');
    });

    it('USD without tilde in telemetry mode', () => {
      mockGetDisplayCurrency.mockReturnValue('usd');
      const { tracker } = createMockTracker(makeStats({ mode: 'telemetry' }));
      createStatusBar(tracker);

      expect(createdItem.text).toBe('$(credit-card) $0.02');
    });

    it('does not include commit-hook indicator in status bar text', () => {
      mockIsCommitHookEnabled.mockReturnValue(false);
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.text).not.toContain('Commit-Hook');
      expect(createdItem.text).not.toContain('circle-slash');
    });

    it('tooltip does not mention commit-hook status', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);
      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).not.toContain('Commit hook');
    });

    it('sets tooltip as a MarkdownString with total AIC (files mode → tilde)', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.tooltip).toBeInstanceOf(vscode.MarkdownString);
      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).toContain('Total:');
      expect(value).toContain('~1.73 AIC');
      expect(value).not.toContain('$');
    });

    it('tooltip lists per-model rows with tilde-prefixed AIC in files mode', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).toContain('GPT-4.1');
      expect(value).toContain('~0.94 AIC');
      expect(value).toContain('Claude Sonnet 4.6');
      expect(value).toContain('~0.79 AIC');
      expect(value).not.toContain('$');
    });

    it('tooltip lists per-model rows without tilde in telemetry mode', () => {
      const { tracker } = createMockTracker(makeStats({ mode: 'telemetry' }));
      createStatusBar(tracker);

      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).toContain('GPT-4.1');
      expect(value).toContain('0.94 AIC');
      expect(value).toContain('Claude Sonnet 4.6');
      expect(value).toContain('0.79 AIC');
      expect(value).not.toContain('~');
    });

    it('tooltip includes the files-mode disclosure note', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).toContain('Estimate assumes no caching');
    });

    it('tooltip includes the telemetry-mode disclosure note', () => {
      const { tracker } = createMockTracker(makeStats({ mode: 'telemetry' }));
      createStatusBar(tracker);

      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).toContain("Measured via Copilot's OTel database");
    });

    it('tooltip does not include the old 75% heuristic note', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).not.toContain('75%');
      expect(value).not.toContain('cached input');
    });

    it('subscribes to tracker stats changes', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(tracker.onStatsChanged).toHaveBeenCalled();
    });

    it('updates text and tooltip when stats change', () => {
      const { tracker, fireStatsChanged } = createMockTracker(
        makeStats({ totalAiCredits: 0, models: {} }),
      );
      createStatusBar(tracker);

      expect(createdItem.text).toBe('$(credit-card) 0 AIC');

      fireStatsChanged(makeStats({ totalAiCredits: 123.4, models: {} }));

      expect(createdItem.text).toBe('$(credit-card) ~124 AIC');
      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).toContain('~123.40 AIC');
      expect(value).not.toContain('$1.23');
    });

    it('disposes item and subscription on dispose', () => {
      const { tracker } = createMockTracker(makeStats());
      const subDispose = jest.fn();
      (tracker.onStatsChanged as jest.Mock).mockReturnValue({
        dispose: subDispose,
      });
      const { dispose } = createStatusBar(tracker);

      dispose();

      expect(createdItem.dispose).toHaveBeenCalled();
      expect(subDispose).toHaveBeenCalled();
    });

    it('wires showStats command', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.command).toBe('copilot-budget.showStats');
    });
  });

  describe('showStatsQuickPick', () => {
    it('shows total AIC in header with tilde in files mode', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      expect(mockWindow.showQuickPick).toHaveBeenCalledTimes(1);
      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const totalItem = items.find((i: any) => i.label?.includes('Total'));
      expect(totalItem).toBeDefined();
      expect(totalItem.label).toContain('~1.73 AIC');
      expect(totalItem.label).not.toMatch(/\$\d/);
      expect(totalItem.description).toBeUndefined();
    });

    it('shows total without tilde in telemetry mode', async () => {
      const { tracker } = createMockTracker(makeStats({ mode: 'telemetry' }));
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const totalItem = items.find((i: any) => i.label?.includes('Total'));
      expect(totalItem.label).toContain('1.73 AIC');
      expect(totalItem.label).not.toContain('~');
    });

    it('shows total in USD when currency is usd', async () => {
      mockGetDisplayCurrency.mockReturnValue('usd');
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const totalItem = items.find((i: any) => i.label?.includes('Total'));
      // 1.726 AIC / 100 → toFixed(2) → '$0.02'; files mode adds tilde.
      expect(totalItem.label).toContain('~$0.02');
      expect(totalItem.label).not.toContain('AIC');
    });

    it('shows tracking since timestamp', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const sinceItem = items.find((i: any) =>
        i.label?.includes('Tracking since'),
      );
      expect(sinceItem).toBeDefined();
    });

    it('shows per-model AIC with tilde in files mode, all four token buckets in detail', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const claudeItem = items.find((i: any) =>
        i.label?.includes('Claude Sonnet 4.6'),
      );
      expect(claudeItem).toBeDefined();
      expect(claudeItem.description).toBe('~0.79 AIC');
      expect(claudeItem.description).not.toContain('$');
      expect(claudeItem.detail).toContain('in:');
      expect(claudeItem.detail).toContain('cache_read:');
      expect(claudeItem.detail).toContain('cache_creation:');
      expect(claudeItem.detail).toContain('out:');
      expect(claudeItem.detail).toContain('500');
      expect(claudeItem.detail).toContain('1,200');
      expect(claudeItem.detail).toContain('300');
      expect(claudeItem.detail).toContain('2,000');
    });

    it('shows per-model AIC without tilde in telemetry mode', async () => {
      const { tracker } = createMockTracker(makeStats({ mode: 'telemetry' }));
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const claudeItem = items.find((i: any) =>
        i.label?.includes('Claude Sonnet 4.6'),
      );
      expect(claudeItem.description).toBe('0.79 AIC');
      expect(claudeItem.description).not.toContain('~');
    });

    it('shows per-model in USD when currency is usd', async () => {
      mockGetDisplayCurrency.mockReturnValue('usd');
      const { tracker } = createMockTracker(makeStats({ mode: 'telemetry' }));
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const claudeItem = items.find((i: any) =>
        i.label?.includes('Claude Sonnet 4.6'),
      );
      // 0.786 / 100 → $0.01 (toFixed(2) of 0.00786)
      expect(claudeItem.description).toMatch(/^\$0\.0\d$/);
    });

    it('does not include premium-request column anywhere', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const serialized = JSON.stringify(items);
      expect(serialized).not.toMatch(/\bPR\b/);
      expect(serialized.toLowerCase()).not.toContain('premium request');
    });

    it('includes a separator before models', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const separators = items.filter(
        (i: any) => i.kind === vscode.QuickPickItemKind.Separator,
      );
      expect(separators.length).toBeGreaterThanOrEqual(1);
    });

    it('handles empty models gracefully', async () => {
      const { tracker } = createMockTracker(
        makeStats({
          models: {},
          totalTokens: 0,
          interactions: 0,
          totalAiCredits: 0,
        }),
      );
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const modelItems = items.filter((i: any) => i.label?.includes('$(hubot)'));
      expect(modelItems).toHaveLength(0);
      const totalItem = items.find((i: any) => i.label?.includes('Total'));
      expect(totalItem.label).toContain('0.00 AIC');
      expect(totalItem.label).not.toMatch(/\$\d/);
    });

    it('does not include the heuristic disclosure note in the quick pick', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const noteItem = items.find((i: any) =>
        i.label?.includes('Estimate note'),
      );
      expect(noteItem).toBeUndefined();
      const serialized = JSON.stringify(items);
      expect(serialized).not.toContain('75%');
    });

    it('includes a Commit-Hook toggle showing ON when enabled', async () => {
      mockIsCommitHookEnabled.mockReturnValue(true);
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const toggle = items.find((i: any) => i.label?.startsWith('Commit-Hook:'));
      expect(toggle).toBeDefined();
      expect(toggle.label).toContain('$(check) ON');
      expect(toggle.label).not.toContain('OFF');
    });

    it('shows Commit-Hook toggle as OFF when disabled', async () => {
      mockIsCommitHookEnabled.mockReturnValue(false);
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const toggle = items.find((i: any) => i.label?.startsWith('Commit-Hook:'));
      expect(toggle.label).toContain('$(circle-slash) OFF');
      expect(toggle.label).not.toContain(' ON');
    });

    it('dispatches toggle command when user picks the Commit-Hook item', async () => {
      mockIsCommitHookEnabled.mockReturnValue(false);
      const { tracker } = createMockTracker(makeStats());
      mockWindow.showQuickPick.mockImplementationOnce(async (items: any[]) =>
        items.find((i) => i.label?.startsWith('Commit-Hook:')),
      );

      await showStatsQuickPick(tracker);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'copilot-budget.toggleCommitHook',
      );
    });

    it('does not dispatch toggle when user picks a non-toggle item', async () => {
      mockIsCommitHookEnabled.mockReturnValue(true);
      const { tracker } = createMockTracker(makeStats());
      mockWindow.showQuickPick.mockImplementationOnce(async (items: any[]) =>
        items.find((i) => i.label?.includes('Total')),
      );

      await showStatsQuickPick(tracker);

      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    it('passes title and placeHolder to quick pick', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const options = mockWindow.showQuickPick.mock.calls[0][1];
      expect(options.title).toBe('Copilot Budget');
      expect(options.placeHolder).toBeTruthy();
    });
  });
});
