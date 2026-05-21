import { createStatusBar } from './statusBar';
import { Tracker, TrackingStats } from './tracker';
import * as vscode from 'vscode';
import * as path from 'path';
import { loadRateCard, resetRateCardForTesting } from './tokenRates';

jest.mock('./tracker');
jest.mock('./sessionDiscovery');
jest.mock('./sessionParser');
jest.mock('./config', () => {
  const listeners: Array<(e: { affectsConfiguration: (key: string) => boolean }) => void> = [];
  return {
    getDisplayCurrency: jest.fn().mockReturnValue('aic'),
    onConfigChanged: jest.fn((cb: (e: { affectsConfiguration: (key: string) => boolean }) => void) => {
      listeners.push(cb);
      return { dispose: jest.fn(() => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      }) };
    }),
    __fireConfigChange: (key: string) => {
      const e = { affectsConfiguration: (k: string) => k === key };
      for (const cb of [...listeners]) cb(e);
    },
    __getConfigListenerCount: () => listeners.length,
  };
});

import { getDisplayCurrency } from './config';
const mockGetDisplayCurrency = getDisplayCurrency as jest.MockedFunction<
  typeof getDisplayCurrency
>;
const configModule = jest.requireMock('./config') as {
  __fireConfigChange: (key: string) => void;
  __getConfigListenerCount: () => number;
};

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

    it('refreshes text immediately when displayCurrency changes', () => {
      // Without the config subscription, the status bar would stay in the old
      // unit until the next stats change — on an idle workspace, that could be
      // arbitrarily far away.
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.text).toBe('$(credit-card) ~2 AIC');

      mockGetDisplayCurrency.mockReturnValue('usd');
      configModule.__fireConfigChange('copilot-budget.displayCurrency');

      expect(createdItem.text).toBe('$(credit-card) ~$0.02');
    });

    it('ignores config changes that do not affect displayCurrency', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);
      const initialText = createdItem.text;

      mockGetDisplayCurrency.mockReturnValue('usd');
      configModule.__fireConfigChange('copilot-budget.commitHook.enabled');

      expect(createdItem.text).toBe(initialText);
    });

    it('disposes the config subscription on dispose', () => {
      const { tracker } = createMockTracker(makeStats());
      const { dispose } = createStatusBar(tracker);
      const before = configModule.__getConfigListenerCount();

      dispose();

      expect(configModule.__getConfigListenerCount()).toBe(before - 1);
    });

    it('wires showStats command', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.command).toBe('copilot-budget.showStats');
    });
  });

});
