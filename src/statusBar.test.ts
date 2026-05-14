import { createStatusBar, showStatsQuickPick } from './statusBar';
import { Tracker, TrackingStats } from './tracker';
import * as vscode from 'vscode';
import * as path from 'path';
import { loadRateCard, resetRateCardForTesting } from './tokenRates';

jest.mock('./tracker');
jest.mock('./sessionDiscovery');
jest.mock('./sessionParser');

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
  loadRateCard(path.join(__dirname, '__fixtures__', 'models-and-pricing.yml'));
});

afterAll(() => {
  resetRateCardForTesting();
});

describe('statusBar', () => {
  let createdItem: any;

  beforeEach(() => {
    jest.clearAllMocks();
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
    it('creates a right-aligned status bar item with priority 100', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(mockWindow.createStatusBarItem).toHaveBeenCalledWith(
        vscode.StatusBarAlignment.Right,
        100,
      );
    });

    it('sets initial text with USD cost and Est suffix', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.text).toContain('$(credit-card)');
      expect(createdItem.text).toContain('$0.02');
      expect(createdItem.text).toContain('Est');
    });

    it('shows $0.00 for empty stats', () => {
      const { tracker } = createMockTracker(
        makeStats({ totalAiCredits: 0, models: {} }),
      );
      createStatusBar(tracker);

      expect(createdItem.text).toContain('$0.00');
      expect(createdItem.text).toContain('Est');
    });

    it('sets tooltip as a MarkdownString with total cost and AIC', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.tooltip).toBeInstanceOf(vscode.MarkdownString);
      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).toContain('Total:');
      expect(value).toContain('$0.0173');
      expect(value).toContain('1.73 AIC');
    });

    it('tooltip lists per-model rows with USD and AIC', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).toContain('GPT-4.1');
      expect(value).toContain('$0.0094');
      expect(value).toContain('0.94 AIC');
      expect(value).toContain('Claude Sonnet 4.6');
      expect(value).toContain('$0.0079');
      expect(value).toContain('0.79 AIC');
    });

    it('tooltip includes the heuristic disclosure note', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).toContain('estimate');
      expect(value).toContain('75%');
      expect(value).toContain('cached input');
      expect(value).not.toContain('upper bound');
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

      expect(createdItem.text).toContain('$0.00');

      fireStatsChanged(makeStats({ totalAiCredits: 123.4, models: {} }));

      expect(createdItem.text).toContain('$1.23');
      expect(createdItem.text).toContain('Est');
      const value = (createdItem.tooltip as vscode.MarkdownString).value;
      expect(value).toContain('$1.2340');
      expect(value).toContain('123.40 AIC');
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
    it('shows total USD and AIC in header', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      expect(mockWindow.showQuickPick).toHaveBeenCalledTimes(1);
      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const totalItem = items.find((i: any) => i.label?.includes('Total'));
      expect(totalItem).toBeDefined();
      expect(totalItem.label).toContain('$0.0173');
      expect(totalItem.description).toContain('1.73 AIC');
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

    it('shows per-model USD and AIC, with all four token buckets in detail', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const claudeItem = items.find((i: any) =>
        i.label?.includes('Claude Sonnet 4.6'),
      );
      expect(claudeItem).toBeDefined();
      expect(claudeItem.description).toContain('$0.0079');
      expect(claudeItem.description).toContain('0.79 AIC');
      expect(claudeItem.detail).toContain('in:');
      expect(claudeItem.detail).toContain('cache_read:');
      expect(claudeItem.detail).toContain('cache_creation:');
      expect(claudeItem.detail).toContain('out:');
      expect(claudeItem.detail).toContain('500');
      expect(claudeItem.detail).toContain('1,200');
      expect(claudeItem.detail).toContain('300');
      expect(claudeItem.detail).toContain('2,000');
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
      expect(totalItem.label).toContain('$0.0000');
    });

    it('includes the heuristic disclosure note as an item', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const noteItem = items.find((i: any) =>
        i.label?.includes('Estimate note'),
      );
      expect(noteItem).toBeDefined();
      expect(noteItem.description).toContain('75%');
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
