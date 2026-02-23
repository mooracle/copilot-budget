import { createStatusBar, showStatsQuickPick } from './statusBar';
import { Tracker, TrackingStats } from './tracker';
import * as vscode from 'vscode';

jest.mock('./tracker');
jest.mock('./sessionDiscovery');
jest.mock('./sessionParser');
jest.mock('./tokenEstimator');
jest.mock('fs');

const mockWindow = vscode.window as any;

function makeStats(overrides: Partial<TrackingStats> = {}): TrackingStats {
  return {
    since: '2024-01-15T10:30:00Z',
    lastUpdated: '2024-01-15T12:00:00Z',
    models: {
      'gpt-4o': { inputTokens: 1500, outputTokens: 800 },
      'claude-sonnet-4': { inputTokens: 500, outputTokens: 300 },
    },
    totalTokens: 3100,
    interactions: 15,
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

describe('statusBar', () => {
  let createdItem: any;

  beforeEach(() => {
    jest.clearAllMocks();
    createdItem = {
      text: '',
      tooltip: '',
      command: '',
      show: jest.fn(),
      hide: jest.fn(),
      dispose: jest.fn(),
    };
    mockWindow.createStatusBarItem = jest.fn().mockReturnValue(createdItem);
    mockWindow.showQuickPick = jest.fn().mockResolvedValue(undefined);
  });

  describe('createStatusBar', () => {
    it('creates a right-aligned status bar item', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(mockWindow.createStatusBarItem).toHaveBeenCalledWith(
        vscode.StatusBarAlignment.Right,
        100,
      );
    });

    it('sets initial text from current stats', () => {
      const { tracker } = createMockTracker(makeStats({ totalTokens: 2800 }));
      createStatusBar(tracker);

      expect(createdItem.text).toContain('Copilot Budget:');
      expect(createdItem.text).toContain('2,800');
    });

    it('shows zero for empty stats', () => {
      const { tracker } = createMockTracker(
        makeStats({ totalTokens: 0, models: {} }),
      );
      createStatusBar(tracker);

      expect(createdItem.text).toContain('0');
    });

    it('sets command to copilot-budget.showStats', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.command).toBe('copilot-budget.showStats');
    });

    it('calls show on the item', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.show).toHaveBeenCalled();
    });

    it('sets tooltip text', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.tooltip).toBeTruthy();
    });

    it('subscribes to tracker stats changes', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(tracker.onStatsChanged).toHaveBeenCalled();
    });

    it('updates text when stats change', () => {
      const { tracker, fireStatsChanged } = createMockTracker(
        makeStats({ totalTokens: 0 }),
      );
      createStatusBar(tracker);

      expect(createdItem.text).toContain('0');

      fireStatsChanged(makeStats({ totalTokens: 5000 }));

      expect(createdItem.text).toContain('5,000');
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

    it('formats large numbers with commas', () => {
      const { tracker } = createMockTracker(
        makeStats({ totalTokens: 1234567 }),
      );
      createStatusBar(tracker);

      expect(createdItem.text).toContain('1,234,567');
    });
  });

  describe('showStatsQuickPick', () => {
    it('shows a quick pick with total tokens and interactions', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      expect(mockWindow.showQuickPick).toHaveBeenCalledTimes(1);
      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const totalItem = items.find((i: any) =>
        i.label?.includes('Total'),
      );
      expect(totalItem).toBeDefined();
      expect(totalItem.label).toContain('3,100');
      expect(totalItem.description).toContain('15');
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

    it('shows per-model breakdown with input/output detail', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const gptItem = items.find((i: any) =>
        i.label?.includes('gpt-4o'),
      );
      expect(gptItem).toBeDefined();
      expect(gptItem.description).toContain('2,300');
      expect(gptItem.detail).toContain('1,500');
      expect(gptItem.detail).toContain('800');
    });

    it('includes a separator before models', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const separator = items.find(
        (i: any) => i.kind === vscode.QuickPickItemKind.Separator,
      );
      expect(separator).toBeDefined();
    });

    it('handles empty models gracefully', async () => {
      const { tracker } = createMockTracker(
        makeStats({ models: {}, totalTokens: 0, interactions: 0 }),
      );
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      // Should have total and since, but no separator or model items
      expect(items.length).toBe(2);
    });

    it('passes title and placeHolder to quick pick', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const options = mockWindow.showQuickPick.mock.calls[0][1];
      expect(options.title).toContain('Copilot Budget');
      expect(options.placeHolder).toBeTruthy();
    });
  });
});
