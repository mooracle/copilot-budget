import { createStatusBar, showStatsQuickPick } from './statusBar';
import { Tracker, TrackingStats } from './tracker';
import * as vscode from 'vscode';
import { getPlanInfo } from './planDetector';

jest.mock('./tracker');
jest.mock('./sessionDiscovery');
jest.mock('./sessionParser');
jest.mock('./planDetector', () => ({
  getPlanInfo: jest.fn().mockReturnValue({
    planName: 'unknown',
    costPerRequest: 0.04,
    source: 'default',
  }),
}));
jest.mock('fs');

const mockWindow = vscode.window as any;

function makeStats(overrides: Partial<TrackingStats> = {}): TrackingStats {
  return {
    since: '2024-01-15T10:30:00Z',
    lastUpdated: '2024-01-15T12:00:00Z',
    models: {
      'gpt-4o': { inputTokens: 1500, outputTokens: 800, premiumRequests: 10 },
      'claude-sonnet-4': { inputTokens: 500, outputTokens: 300, premiumRequests: 5 },
    },
    totalTokens: 3100,
    interactions: 15,
    premiumRequests: 15,
    estimatedCost: 0.60,
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

    it('sets initial text with premium requests and cost', () => {
      const { tracker } = createMockTracker(makeStats());
      createStatusBar(tracker);

      expect(createdItem.text).toContain('15 PR');
      expect(createdItem.text).toContain('$0.6');
    });

    it('shows zero for empty stats', () => {
      const { tracker } = createMockTracker(
        makeStats({ premiumRequests: 0, estimatedCost: 0, models: {} }),
      );
      createStatusBar(tracker);

      expect(createdItem.text).toContain('0 PR');
      expect(createdItem.text).toContain('$0.0');
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
        makeStats({ premiumRequests: 0, estimatedCost: 0 }),
      );
      createStatusBar(tracker);

      expect(createdItem.text).toContain('0 PR');

      fireStatsChanged(makeStats({ premiumRequests: 25.50, estimatedCost: 1.02 }));

      expect(createdItem.text).toContain('26 PR');
      expect(createdItem.text).toContain('$1.0');
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

    it('formats premium requests as integers and cost with one decimal', () => {
      const { tracker } = createMockTracker(
        makeStats({ premiumRequests: 12.25, estimatedCost: 0.49 }),
      );
      createStatusBar(tracker);

      expect(createdItem.text).toContain('12 PR');
      expect(createdItem.text).toContain('$0.5');
    });
  });

  describe('showStatsQuickPick', () => {
    it('shows premium requests and estimated cost in header', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      expect(mockWindow.showQuickPick).toHaveBeenCalledTimes(1);
      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const prItem = items.find((i: any) =>
        i.label?.includes('Premium Requests'),
      );
      expect(prItem).toBeDefined();
      expect(prItem.label).toContain('15');
      expect(prItem.description).toContain('$0.6');
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

    it('shows per-model premium requests and cost', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const gptItem = items.find((i: any) =>
        i.label?.includes('gpt-4o'),
      );
      expect(gptItem).toBeDefined();
      expect(gptItem.description).toContain('10 PR');
      expect(gptItem.description).toContain('$0.4');
    });

    it('shows tokens in detail line', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const gptItem = items.find((i: any) =>
        i.label?.includes('gpt-4o'),
      );
      expect(gptItem).toBeDefined();
      expect(gptItem.detail).toContain('2,300');
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
        makeStats({ models: {}, totalTokens: 0, interactions: 0, premiumRequests: 0, estimatedCost: 0 }),
      );
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      // Should have premium requests header and since, but no separator or model items
      expect(items.length).toBe(2);
    });

    it('passes title and placeHolder to quick pick', async () => {
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const options = mockWindow.showQuickPick.mock.calls[0][1];
      expect(options.title).toContain('Copilot Budget');
      expect(options.placeHolder).toBeTruthy();
    });

    it('shows plan name in title when plan is detected via api', async () => {
      (getPlanInfo as jest.Mock).mockReturnValue({
        planName: 'pro',
        costPerRequest: 10 / 300,
        source: 'api',
      });
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const options = mockWindow.showQuickPick.mock.calls[0][1];
      expect(options.title).toBe('Copilot Budget - Premium Requests (pro plan)');
    });

    it('shows plan name in title when plan is from config', async () => {
      (getPlanInfo as jest.Mock).mockReturnValue({
        planName: 'enterprise',
        costPerRequest: 0.039,
        source: 'config',
      });
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const options = mockWindow.showQuickPick.mock.calls[0][1];
      expect(options.title).toBe('Copilot Budget - Premium Requests (enterprise plan)');
    });

    it('does not show plan name when source is default', async () => {
      (getPlanInfo as jest.Mock).mockReturnValue({
        planName: 'unknown',
        costPerRequest: 0.04,
        source: 'default',
      });
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const options = mockWindow.showQuickPick.mock.calls[0][1];
      expect(options.title).toBe('Copilot Budget - Premium Requests');
    });

    it('uses plan cost per request for per-model cost', async () => {
      (getPlanInfo as jest.Mock).mockReturnValue({
        planName: 'pro',
        costPerRequest: 10 / 300,
        source: 'api',
      });
      const { tracker } = createMockTracker(makeStats());
      await showStatsQuickPick(tracker);

      const items = mockWindow.showQuickPick.mock.calls[0][0] as any[];
      const gptItem = items.find((i: any) => i.label?.includes('gpt-4o'));
      expect(gptItem).toBeDefined();
      // 10 PR * (10/300) = $0.33, displayed as $0.3
      expect(gptItem.description).toContain('$0.3');
    });
  });
});
