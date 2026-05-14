jest.mock('./tracker');
jest.mock('./statusBar');
jest.mock('./trackingFile');
jest.mock('./commitHook');
jest.mock('./config');
jest.mock('./logger');
jest.mock('./sessionDiscovery');
jest.mock('./sqliteReader');

import * as vscode from 'vscode';
import { __commandCallbacks } from './__mocks__/vscode';
import { activate, deactivate } from './extension';
import { Tracker } from './tracker';
import { createStatusBar, showStatsQuickPick } from './statusBar';
import { writeTrackingFile, readTrackingFile } from './trackingFile';
import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import { isEnabled, isCommitHookEnabled, onConfigChanged } from './config';
import { getDiscoveryDiagnostics } from './sessionDiscovery';
import { getOutputChannel, disposeLogger } from './logger';
import { initSqlite, disposeSqlite } from './sqliteReader';

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
const mockReadTrackingFile = readTrackingFile as jest.MockedFunction<
  typeof readTrackingFile
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
const _mockDisposeSqlite = disposeSqlite as jest.MockedFunction<
  typeof disposeSqlite
>;

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

const SAMPLE_STATS = {
  since: '2024-01-01T00:00:00Z',
  lastUpdated: '2024-01-01T01:00:00Z',
  models: {
    'gpt-4o': {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.01,
    },
  },
  totalTokens: 300,
  interactions: 5,
  totalCostUsd: 0.01,
  totalAiCredits: 1.0,
};

beforeEach(async () => {
  jest.clearAllMocks();
  for (const key of Object.keys(__commandCallbacks)) delete __commandCallbacks[key];
  (vscode as any).workspace.workspaceFolders = undefined;

  statsChangedListeners = [];
  configChangedCallback = null;

  trackerInstance = {
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
    update: jest.fn(),
    dispose: jest.fn(),
    setPreviousStats: jest.fn(),
    getStats: jest.fn().mockReturnValue(SAMPLE_STATS),
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
  mockWriteTrackingFile.mockResolvedValue(true);
  mockReadTrackingFile.mockResolvedValue(null);
  mockInstallHook.mockResolvedValue(true);
  mockUninstallHook.mockResolvedValue(true);
  mockIsHookInstalled.mockResolvedValue(false);
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

  // Reset module-level state by calling deactivate
  await deactivate();
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
  mockWriteTrackingFile.mockResolvedValue(true);
  mockReadTrackingFile.mockResolvedValue(null);
  mockIsHookInstalled.mockResolvedValue(false);
  mockInitSqlite.mockResolvedValue(true);
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
  trackerInstance.getStats.mockReturnValue(SAMPLE_STATS);
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

    it('auto-installs hook when commitHook.enabled is true and workspace exists', async () => {
      mockIsCommitHookEnabled.mockReturnValue(true);
      (vscode as any).workspace.workspaceFolders = [
        { uri: vscode.Uri.file('/project'), name: 'test', index: 0 },
      ];
      const ctx = makeContext();
      await activate(ctx);
      expect(mockInstallHook).toHaveBeenCalledTimes(1);
    });

    it('does not auto-install hook when commitHook.enabled is true but no workspace', async () => {
      mockIsCommitHookEnabled.mockReturnValue(true);
      (vscode as any).workspace.workspaceFolders = undefined;
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

    it('restores previous stats from tracking file', async () => {
      const restored = {
        since: '2024-01-01T00:00:00Z',
        interactions: 5,
        models: {
          'gpt-4o': {
            inputTokens: 100,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
          },
        },
      };
      mockReadTrackingFile.mockResolvedValue(restored);

      const ctx = makeContext();
      await activate(ctx);

      expect(mockReadTrackingFile).toHaveBeenCalledTimes(1);
      expect(trackerInstance.setPreviousStats).toHaveBeenCalledWith(restored);
    });

    it('does not call setPreviousStats when readTrackingFile returns null', async () => {
      mockReadTrackingFile.mockResolvedValue(null);

      const ctx = makeContext();
      await activate(ctx);

      expect(mockReadTrackingFile).toHaveBeenCalledTimes(1);
      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();
    });

    it('calls readTrackingFile before tracker.start', async () => {
      mockReadTrackingFile.mockResolvedValue(null);

      const ctx = makeContext();
      await activate(ctx);

      const readOrder = mockReadTrackingFile.mock.invocationCallOrder[0];
      const startOrder = trackerInstance.start.mock.invocationCallOrder[0];
      expect(readOrder).toBeLessThan(startOrder);
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

    it('showDiagnostics command displays USD cost and AI credits', async () => {
      const ctx = makeContext();
      await activate(ctx);

      const mockChannel = mockGetOutputChannel();
      __commandCallbacks['copilot-budget.showDiagnostics']();

      const appendCalls = (mockChannel.appendLine as jest.Mock).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(appendCalls).toContain('  Total cost: $0.0100');
      expect(appendCalls).toContain('  AI Credits: 1.00');
    });

    it('showDiagnostics does not display plan info', async () => {
      const ctx = makeContext();
      await activate(ctx);

      const mockChannel = mockGetOutputChannel();
      __commandCallbacks['copilot-budget.showDiagnostics']();

      const appendCalls = (mockChannel.appendLine as jest.Mock).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(appendCalls).not.toContain('Plan detection:');
      for (const line of appendCalls) {
        expect(line).not.toMatch(/Premium requests/);
        expect(line).not.toMatch(/Estimated cost/);
      }
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

      await deactivate();

      expect(mockWriteTrackingFile).toHaveBeenCalledWith(
        trackerInstance.getStats(),
      );
      expect(trackerInstance.dispose).toHaveBeenCalledTimes(1);
    });

    it('does not throw when called without activate', async () => {
      await expect(deactivate()).resolves.not.toThrow();
    });

    it('cleans up status bar', async () => {
      const disposeFn = jest.fn();
      mockCreateStatusBar.mockReturnValue({
        dispose: disposeFn,
        item: { text: '', dispose: jest.fn() },
      } as any);

      const ctx = makeContext();
      await activate(ctx);
      await deactivate();

      expect(disposeFn).toHaveBeenCalled();
    });

    it('sets tracker and statusBar to null after cleanup', async () => {
      const ctx = makeContext();
      await activate(ctx);
      await deactivate();

      // Calling deactivate again should not throw or call dispose again
      trackerInstance.dispose.mockClear();
      await deactivate();
      expect(trackerInstance.dispose).not.toHaveBeenCalled();
    });

    it('calls disposeLogger', async () => {
      const ctx = makeContext();
      await activate(ctx);
      await deactivate();
      expect(mockDisposeLogger).toHaveBeenCalled();
    });
  });
});
