jest.mock('./tracker');
jest.mock('./statusBar');
jest.mock('./trackingFile');
jest.mock('./commitHook');
jest.mock('./config');
jest.mock('./logger');
jest.mock('./sessionDiscovery');
jest.mock('./sqliteReader');
jest.mock('./planDetector');

import * as vscode from 'vscode';
import { __commandCallbacks } from './__mocks__/vscode';
import { activate, deactivate } from './extension';
import { Tracker } from './tracker';
import { createStatusBar, showStatsQuickPick } from './statusBar';
import { writeTrackingFile } from './trackingFile';
import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import { isEnabled, isCommitHookEnabled, onConfigChanged } from './config';
import { getDiscoveryDiagnostics } from './sessionDiscovery';
import { getOutputChannel, disposeLogger } from './logger';
import { initSqlite, disposeSqlite } from './sqliteReader';
import {
  detectPlan,
  getPlanInfo,
  onPlanChanged,
  startPeriodicRefresh,
  disposePlanDetector,
} from './planDetector';

const MockTracker = Tracker as jest.MockedClass<typeof Tracker>;
const mockCreateStatusBar = createStatusBar as jest.MockedFunction<
  typeof createStatusBar
>;
const mockShowStatsQuickPick = showStatsQuickPick as jest.MockedFunction<
  typeof showStatsQuickPick
>;
const mockWriteTrackingFile = writeTrackingFile as jest.MockedFunction<
  typeof writeTrackingFile
>;
const mockInstallHook = installHook as jest.MockedFunction<typeof installHook>;
const mockUninstallHook = uninstallHook as jest.MockedFunction<
  typeof uninstallHook
>;
const mockIsHookInstalled = isHookInstalled as jest.MockedFunction<
  typeof isHookInstalled
>;
const mockIsEnabled = isEnabled as jest.MockedFunction<typeof isEnabled>;
const mockIsCommitHookEnabled = isCommitHookEnabled as jest.MockedFunction<
  typeof isCommitHookEnabled
>;
const mockOnConfigChanged = onConfigChanged as jest.MockedFunction<
  typeof onConfigChanged
>;
const mockGetDiscoveryDiagnostics = getDiscoveryDiagnostics as jest.MockedFunction<
  typeof getDiscoveryDiagnostics
>;
const mockGetOutputChannel = getOutputChannel as jest.MockedFunction<
  typeof getOutputChannel
>;
const mockDisposeLogger = disposeLogger as jest.MockedFunction<
  typeof disposeLogger
>;
const mockInitSqlite = initSqlite as jest.MockedFunction<typeof initSqlite>;
const mockDisposeSqlite = disposeSqlite as jest.MockedFunction<
  typeof disposeSqlite
>;
const mockDetectPlan = detectPlan as jest.MockedFunction<typeof detectPlan>;
const mockGetPlanInfo = getPlanInfo as jest.MockedFunction<typeof getPlanInfo>;
const mockOnPlanChanged = onPlanChanged as jest.MockedFunction<typeof onPlanChanged>;
const mockStartPeriodicRefresh = startPeriodicRefresh as jest.MockedFunction<typeof startPeriodicRefresh>;
const mockDisposePlanDetector = disposePlanDetector as jest.MockedFunction<typeof disposePlanDetector>;

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionPath: '/test',
    globalState: { get: () => undefined, update: async () => {} },
    workspaceState: { get: () => undefined, update: async () => {} },
    extensionUri: { fsPath: '/test' },
  } as any;
}

let trackerInstance: any;
let statsChangedListeners: Array<(stats: any) => void>;
let configChangedCallback: ((e: any) => void) | null;

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(__commandCallbacks)) delete __commandCallbacks[key];

  statsChangedListeners = [];
  configChangedCallback = null;

  trackerInstance = {
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
    update: jest.fn(),
    dispose: jest.fn(),
    setPlanInfoProvider: jest.fn(),
    getStats: jest.fn().mockReturnValue({
      since: '2024-01-01T00:00:00Z',
      lastUpdated: '2024-01-01T01:00:00Z',
      models: { 'gpt-4o': { inputTokens: 100, outputTokens: 200, premiumRequests: 1 } },
      totalTokens: 300,
      interactions: 5,
      premiumRequests: 1,
      estimatedCost: 0.04,
    }),
    onStatsChanged: jest.fn((listener: any) => {
      statsChangedListeners.push(listener);
      return {
        dispose: () => {
          const idx = statsChangedListeners.indexOf(listener);
          if (idx >= 0) statsChangedListeners.splice(idx, 1);
        },
      };
    }),
  };

  MockTracker.mockImplementation(() => trackerInstance);

  const mockStatusBarItem = {
    dispose: jest.fn(),
    item: { text: '', dispose: jest.fn() },
  };
  mockCreateStatusBar.mockReturnValue(mockStatusBarItem as any);
  mockShowStatsQuickPick.mockResolvedValue(undefined);
  mockWriteTrackingFile.mockReturnValue(true);
  mockInstallHook.mockReturnValue(true);
  mockUninstallHook.mockReturnValue(true);
  mockIsHookInstalled.mockReturnValue(false);
  mockIsEnabled.mockReturnValue(true);
  mockIsCommitHookEnabled.mockReturnValue(false);
  mockOnConfigChanged.mockImplementation((cb: any) => {
    configChangedCallback = cb;
    return { dispose: jest.fn() };
  });
  mockGetDiscoveryDiagnostics.mockReturnValue({
    platform: 'darwin',
    homedir: '/home/test',
    candidatePaths: [
      { path: '/home/test/.config/Code/User', exists: true },
      { path: '/home/test/.config/Code - Insiders/User', exists: false },
    ],
    filesFound: ['/home/test/.config/Code/User/globalStorage/github.copilot-chat/sessions/test.json'],
    vscdbFilesFound: [],
  });
  mockGetOutputChannel.mockReturnValue({
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
    name: 'Copilot Budget',
  } as any);
  mockInitSqlite.mockResolvedValue(true);
  mockDetectPlan.mockResolvedValue({
    planName: 'unknown',
    costPerRequest: 0.04,
    source: 'default',
  });
  mockGetPlanInfo.mockReturnValue({
    planName: 'unknown',
    costPerRequest: 0.04,
    source: 'default',
  });
  mockOnPlanChanged.mockImplementation(() => ({ dispose: jest.fn() }));

  // Reset module-level state by calling deactivate
  deactivate();
  jest.clearAllMocks();
  // Re-setup mocks after deactivate cleared them
  MockTracker.mockImplementation(() => trackerInstance);
  mockCreateStatusBar.mockReturnValue({
    dispose: jest.fn(),
    item: { text: '', dispose: jest.fn() },
  } as any);
  mockIsEnabled.mockReturnValue(true);
  mockIsCommitHookEnabled.mockReturnValue(false);
  mockOnConfigChanged.mockImplementation((cb: any) => {
    configChangedCallback = cb;
    return { dispose: jest.fn() };
  });
  mockWriteTrackingFile.mockReturnValue(true);
  mockIsHookInstalled.mockReturnValue(false);
  mockInitSqlite.mockResolvedValue(true);
  mockDetectPlan.mockResolvedValue({
    planName: 'unknown',
    costPerRequest: 0.04,
    source: 'default',
  });
  mockGetPlanInfo.mockReturnValue({
    planName: 'unknown',
    costPerRequest: 0.04,
    source: 'default',
  });
  mockOnPlanChanged.mockImplementation(() => ({ dispose: jest.fn() }));
  trackerInstance.onStatsChanged = jest.fn((listener: any) => {
    statsChangedListeners = [];
    statsChangedListeners.push(listener);
    return {
      dispose: () => {
        const idx = statsChangedListeners.indexOf(listener);
        if (idx >= 0) statsChangedListeners.splice(idx, 1);
      },
    };
  });
  trackerInstance.getStats.mockReturnValue({
    since: '2024-01-01T00:00:00Z',
    lastUpdated: '2024-01-01T01:00:00Z',
    models: { 'gpt-4o': { inputTokens: 100, outputTokens: 200, premiumRequests: 1 } },
    totalTokens: 300,
    interactions: 5,
    premiumRequests: 1,
    estimatedCost: 0.04,
  });
});

describe('extension', () => {
  describe('activate', () => {
    it('creates a Tracker and starts it', async () => {
      const ctx = makeContext();
      await activate(ctx);
      expect(MockTracker).toHaveBeenCalledTimes(1);
      expect(trackerInstance.start).toHaveBeenCalledTimes(1);
    });

    it('creates a status bar', async () => {
      const ctx = makeContext();
      await activate(ctx);
      expect(mockCreateStatusBar).toHaveBeenCalledWith(trackerInstance);
    });

    it('registers 5 commands', async () => {
      const ctx = makeContext();
      await activate(ctx);
      // subscriptions: planSub + statusBar disposable + statsWriter + trackingFileRefresh + 5 commands + configSub = 10
      expect(ctx.subscriptions.length).toBe(10);
    });

    it('registers stub commands when disabled', async () => {
      mockIsEnabled.mockReturnValue(false);
      const ctx = makeContext();
      await activate(ctx);
      expect(MockTracker).not.toHaveBeenCalled();
      expect(mockCreateStatusBar).not.toHaveBeenCalled();
      // 5 stub commands registered so users get a helpful message
      expect(ctx.subscriptions.length).toBe(5);
    });

    it('writes tracking file when stats change', async () => {
      const ctx = makeContext();
      await activate(ctx);
      const stats = {
        since: '2024-01-01',
        lastUpdated: '2024-01-01',
        models: {},
        totalTokens: 500,
        interactions: 3,
      };
      statsChangedListeners[0](stats);
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(stats);
    });

    it('periodically re-writes tracking file even when stats unchanged', async () => {
      jest.useFakeTimers();
      const ctx = makeContext();
      await activate(ctx);
      mockWriteTrackingFile.mockClear();

      // Advance past one 120s interval
      jest.advanceTimersByTime(120_000);
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(trackerInstance.getStats());

      // Clean up: dispose subscriptions to clear the interval
      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('auto-installs hook when commitHook.enabled is true', async () => {
      mockIsCommitHookEnabled.mockReturnValue(true);
      mockIsHookInstalled.mockReturnValue(false);
      const ctx = makeContext();
      await activate(ctx);
      expect(mockInstallHook).toHaveBeenCalledTimes(1);
    });

    it('skips auto-install when hook already installed', async () => {
      mockIsCommitHookEnabled.mockReturnValue(true);
      mockIsHookInstalled.mockReturnValue(true);
      const ctx = makeContext();
      await activate(ctx);
      expect(mockInstallHook).not.toHaveBeenCalled();
    });

    it('does not auto-install hook when commitHook.enabled is false', async () => {
      mockIsCommitHookEnabled.mockReturnValue(false);
      const ctx = makeContext();
      await activate(ctx);
      expect(mockInstallHook).not.toHaveBeenCalled();
    });

    it('installs hook on config change when enabled', async () => {
      mockIsCommitHookEnabled.mockReturnValue(false);
      const ctx = makeContext();
      await activate(ctx);
      expect(mockInstallHook).not.toHaveBeenCalled();

      // Simulate config change enabling the hook
      mockIsCommitHookEnabled.mockReturnValue(true);
      mockIsHookInstalled.mockReturnValue(false);
      configChangedCallback!({} as any);
      expect(mockInstallHook).toHaveBeenCalledTimes(1);
    });

    it('calls initSqlite before starting tracker', async () => {
      const ctx = makeContext();
      await activate(ctx);
      expect(mockInitSqlite).toHaveBeenCalledTimes(1);
      // initSqlite should be called before tracker.start
      const initOrder = mockInitSqlite.mock.invocationCallOrder[0];
      const startOrder = trackerInstance.start.mock.invocationCallOrder[0];
      expect(initOrder).toBeLessThan(startOrder);
    });

    it('does not call initSqlite when disabled', async () => {
      mockIsEnabled.mockReturnValue(false);
      const ctx = makeContext();
      await activate(ctx);
      expect(mockInitSqlite).not.toHaveBeenCalled();
    });

    it('continues when initSqlite returns false', async () => {
      mockInitSqlite.mockResolvedValue(false);
      const ctx = makeContext();
      await activate(ctx);
      // Tracker should still be created and started
      expect(MockTracker).toHaveBeenCalledTimes(1);
      expect(trackerInstance.start).toHaveBeenCalledTimes(1);
    });

    it('calls detectPlan before tracker.start', async () => {
      const ctx = makeContext();
      await activate(ctx);
      expect(mockDetectPlan).toHaveBeenCalledTimes(1);
      const detectOrder = mockDetectPlan.mock.invocationCallOrder[0];
      const startOrder = trackerInstance.start.mock.invocationCallOrder[0];
      expect(detectOrder).toBeLessThan(startOrder);
    });

    it('sets plan info provider on tracker', async () => {
      const ctx = makeContext();
      await activate(ctx);
      expect(trackerInstance.setPlanInfoProvider).toHaveBeenCalledWith(mockGetPlanInfo);
    });

    it('starts periodic plan refresh', async () => {
      const ctx = makeContext();
      await activate(ctx);
      expect(mockStartPeriodicRefresh).toHaveBeenCalledTimes(1);
    });

    it('subscribes to plan changes', async () => {
      const ctx = makeContext();
      await activate(ctx);
      expect(mockOnPlanChanged).toHaveBeenCalledTimes(1);
    });

    it('calls tracker.update when plan changes', async () => {
      let planChangeListener: (() => void) | null = null;
      mockOnPlanChanged.mockImplementation((listener: any) => {
        planChangeListener = listener;
        return { dispose: jest.fn() };
      });

      const ctx = makeContext();
      await activate(ctx);
      expect(planChangeListener).not.toBeNull();

      planChangeListener!();
      expect(trackerInstance.update).toHaveBeenCalledTimes(1);
    });

    it('re-detects plan on config change', async () => {
      const ctx = makeContext();
      await activate(ctx);
      mockDetectPlan.mockClear();

      configChangedCallback!({} as any);
      expect(mockDetectPlan).toHaveBeenCalledTimes(1);
    });

    it('does not call detectPlan when disabled', async () => {
      mockIsEnabled.mockReturnValue(false);
      const ctx = makeContext();
      await activate(ctx);
      expect(mockDetectPlan).not.toHaveBeenCalled();
    });
  });

  describe('commands', () => {
    it('showStats command calls showStatsQuickPick', async () => {
      const ctx = makeContext();
      await activate(ctx);

      __commandCallbacks['copilot-budget.showStats']();
      expect(mockShowStatsQuickPick).toHaveBeenCalledWith(trackerInstance);
    });

    it('resetTracking command calls tracker.reset', async () => {
      const ctx = makeContext();
      await activate(ctx);

      __commandCallbacks['copilot-budget.resetTracking']();
      expect(trackerInstance.reset).toHaveBeenCalledTimes(1);
    });

    it('installHook command calls installHook', async () => {
      const ctx = makeContext();
      await activate(ctx);

      __commandCallbacks['copilot-budget.installHook']();
      expect(mockInstallHook).toHaveBeenCalledTimes(1);
    });

    it('uninstallHook command calls uninstallHook', async () => {
      const ctx = makeContext();
      await activate(ctx);

      __commandCallbacks['copilot-budget.uninstallHook']();
      expect(mockUninstallHook).toHaveBeenCalledTimes(1);
    });

    it('showDiagnostics command outputs diagnostics and shows channel', async () => {
      const ctx = makeContext();
      await activate(ctx);

      const mockChannel = mockGetOutputChannel();
      __commandCallbacks['copilot-budget.showDiagnostics']();

      expect(mockGetDiscoveryDiagnostics).toHaveBeenCalled();
      expect(mockChannel.appendLine).toHaveBeenCalled();
      expect(mockChannel.show).toHaveBeenCalled();
    });

    it('showDiagnostics command displays premium requests and estimated cost', async () => {
      const ctx = makeContext();
      await activate(ctx);

      const mockChannel = mockGetOutputChannel();
      __commandCallbacks['copilot-budget.showDiagnostics']();

      const appendCalls = (mockChannel.appendLine as jest.Mock).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(appendCalls).toContain('  Premium requests: 1.00');
      expect(appendCalls).toContain('  Estimated cost: $0.04');
    });

    it('showDiagnostics command displays plan info', async () => {
      mockGetPlanInfo.mockReturnValue({
        planName: 'pro',
        costPerRequest: 10 / 300,
        source: 'api',
      });
      const ctx = makeContext();
      await activate(ctx);

      const mockChannel = mockGetOutputChannel();
      __commandCallbacks['copilot-budget.showDiagnostics']();

      const appendCalls = (mockChannel.appendLine as jest.Mock).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(appendCalls).toContain('Plan detection:');
      expect(appendCalls).toContain('  Plan: pro');
      expect(appendCalls).toContain(`  Cost per request: $${(10 / 300).toFixed(4)}`);
      expect(appendCalls).toContain('  Source: api');
    });

    it('showDiagnostics command displays vscdb file info', async () => {
      mockGetDiscoveryDiagnostics.mockReturnValue({
        platform: 'darwin',
        homedir: '/home/test',
        candidatePaths: [],
        filesFound: [],
        vscdbFilesFound: ['/path/to/state.vscdb'],
      });
      const ctx = makeContext();
      await activate(ctx);

      const mockChannel = mockGetOutputChannel();
      __commandCallbacks['copilot-budget.showDiagnostics']();

      const appendCalls = (mockChannel.appendLine as jest.Mock).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(appendCalls).toContain('Vscdb files found: 1');
      expect(appendCalls).toContain('  /path/to/state.vscdb');
    });
  });

  describe('deactivate', () => {
    it('writes final stats and disposes tracker', async () => {
      const ctx = makeContext();
      await activate(ctx);

      deactivate();

      expect(mockWriteTrackingFile).toHaveBeenCalledWith(
        trackerInstance.getStats(),
      );
      expect(trackerInstance.dispose).toHaveBeenCalledTimes(1);
    });

    it('does not throw when called without activate', () => {
      expect(() => deactivate()).not.toThrow();
    });

    it('cleans up status bar', async () => {
      const disposeFn = jest.fn();
      mockCreateStatusBar.mockReturnValue({
        dispose: disposeFn,
        item: { text: '', dispose: jest.fn() },
      } as any);

      const ctx = makeContext();
      await activate(ctx);
      deactivate();

      expect(disposeFn).toHaveBeenCalled();
    });

    it('sets tracker and statusBar to null after cleanup', async () => {
      const ctx = makeContext();
      await activate(ctx);
      deactivate();

      // Calling deactivate again should not throw or call dispose again
      trackerInstance.dispose.mockClear();
      deactivate();
      expect(trackerInstance.dispose).not.toHaveBeenCalled();
    });

    it('calls disposeLogger', async () => {
      const ctx = makeContext();
      await activate(ctx);
      deactivate();
      expect(mockDisposeLogger).toHaveBeenCalled();
    });

    it('calls disposePlanDetector on deactivate', async () => {
      const ctx = makeContext();
      await activate(ctx);
      mockDisposePlanDetector.mockClear();
      deactivate();
      expect(mockDisposePlanDetector).toHaveBeenCalledTimes(1);
    });

    it('calls disposePlanDetector before disposeSqlite', async () => {
      const ctx = makeContext();
      await activate(ctx);
      mockDisposePlanDetector.mockClear();
      mockDisposeSqlite.mockClear();
      deactivate();
      const planOrder = mockDisposePlanDetector.mock.invocationCallOrder[0];
      const sqliteOrder = mockDisposeSqlite.mock.invocationCallOrder[0];
      expect(planOrder).toBeLessThan(sqliteOrder);
    });

    it('calls disposeSqlite before disposeLogger', async () => {
      const ctx = makeContext();
      await activate(ctx);
      deactivate();
      expect(mockDisposeSqlite).toHaveBeenCalledTimes(1);
      const sqliteOrder = mockDisposeSqlite.mock.invocationCallOrder[0];
      const loggerOrder = mockDisposeLogger.mock.invocationCallOrder[0];
      expect(sqliteOrder).toBeLessThan(loggerOrder);
    });
  });
});
