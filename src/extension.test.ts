jest.mock('./tracker');
jest.mock('./statusBar');
jest.mock('./trackingFile');
jest.mock('./commitHook');
jest.mock('./config');

import * as vscode from 'vscode';
import { __commandCallbacks } from './__mocks__/vscode';
import { activate, deactivate } from './extension';
import { Tracker } from './tracker';
import { createStatusBar, showStatsQuickPick } from './statusBar';
import { writeTrackingFile } from './trackingFile';
import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import { isEnabled, isCommitHookEnabled, onConfigChanged } from './config';

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
    dispose: jest.fn(),
    getStats: jest.fn().mockReturnValue({
      since: '2024-01-01T00:00:00Z',
      lastUpdated: '2024-01-01T01:00:00Z',
      models: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
      totalTokens: 300,
      interactions: 5,
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
    models: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
    totalTokens: 300,
    interactions: 5,
  });
});

describe('extension', () => {
  describe('activate', () => {
    it('creates a Tracker and starts it', () => {
      const ctx = makeContext();
      activate(ctx);
      expect(MockTracker).toHaveBeenCalledTimes(1);
      expect(trackerInstance.start).toHaveBeenCalledTimes(1);
    });

    it('creates a status bar', () => {
      const ctx = makeContext();
      activate(ctx);
      expect(mockCreateStatusBar).toHaveBeenCalledWith(trackerInstance);
    });

    it('registers 4 commands', () => {
      const ctx = makeContext();
      activate(ctx);
      // subscriptions: statusBar disposable + statsWriter + 4 commands + configSub = 7
      expect(ctx.subscriptions.length).toBe(7);
    });

    it('registers stub commands when disabled', () => {
      mockIsEnabled.mockReturnValue(false);
      const ctx = makeContext();
      activate(ctx);
      expect(MockTracker).not.toHaveBeenCalled();
      expect(mockCreateStatusBar).not.toHaveBeenCalled();
      // 4 stub commands registered so users get a helpful message
      expect(ctx.subscriptions.length).toBe(4);
    });

    it('writes tracking file when stats change', () => {
      const ctx = makeContext();
      activate(ctx);
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

    it('auto-installs hook when commitHook.enabled is true', () => {
      mockIsCommitHookEnabled.mockReturnValue(true);
      mockIsHookInstalled.mockReturnValue(false);
      const ctx = makeContext();
      activate(ctx);
      expect(mockInstallHook).toHaveBeenCalledTimes(1);
    });

    it('skips auto-install when hook already installed', () => {
      mockIsCommitHookEnabled.mockReturnValue(true);
      mockIsHookInstalled.mockReturnValue(true);
      const ctx = makeContext();
      activate(ctx);
      expect(mockInstallHook).not.toHaveBeenCalled();
    });

    it('does not auto-install hook when commitHook.enabled is false', () => {
      mockIsCommitHookEnabled.mockReturnValue(false);
      const ctx = makeContext();
      activate(ctx);
      expect(mockInstallHook).not.toHaveBeenCalled();
    });

    it('installs hook on config change when enabled', () => {
      mockIsCommitHookEnabled.mockReturnValue(false);
      const ctx = makeContext();
      activate(ctx);
      expect(mockInstallHook).not.toHaveBeenCalled();

      // Simulate config change enabling the hook
      mockIsCommitHookEnabled.mockReturnValue(true);
      mockIsHookInstalled.mockReturnValue(false);
      configChangedCallback!({} as any);
      expect(mockInstallHook).toHaveBeenCalledTimes(1);
    });
  });

  describe('commands', () => {
    it('showStats command calls showStatsQuickPick', () => {
      const ctx = makeContext();
      activate(ctx);

      __commandCallbacks['tokentrack.showStats']();
      expect(mockShowStatsQuickPick).toHaveBeenCalledWith(trackerInstance);
    });

    it('resetTracking command calls tracker.reset', () => {
      const ctx = makeContext();
      activate(ctx);

      __commandCallbacks['tokentrack.resetTracking']();
      expect(trackerInstance.reset).toHaveBeenCalledTimes(1);
    });

    it('installHook command calls installHook', () => {
      const ctx = makeContext();
      activate(ctx);

      __commandCallbacks['tokentrack.installHook']();
      expect(mockInstallHook).toHaveBeenCalledTimes(1);
    });

    it('uninstallHook command calls uninstallHook', () => {
      const ctx = makeContext();
      activate(ctx);

      __commandCallbacks['tokentrack.uninstallHook']();
      expect(mockUninstallHook).toHaveBeenCalledTimes(1);
    });
  });

  describe('deactivate', () => {
    it('writes final stats and disposes tracker', () => {
      const ctx = makeContext();
      activate(ctx);

      deactivate();

      expect(mockWriteTrackingFile).toHaveBeenCalledWith(
        trackerInstance.getStats(),
      );
      expect(trackerInstance.dispose).toHaveBeenCalledTimes(1);
    });

    it('does not throw when called without activate', () => {
      expect(() => deactivate()).not.toThrow();
    });

    it('cleans up status bar', () => {
      const disposeFn = jest.fn();
      mockCreateStatusBar.mockReturnValue({
        dispose: disposeFn,
        item: { text: '', dispose: jest.fn() },
      } as any);

      const ctx = makeContext();
      activate(ctx);
      deactivate();

      expect(disposeFn).toHaveBeenCalled();
    });

    it('sets tracker and statusBar to null after cleanup', () => {
      const ctx = makeContext();
      activate(ctx);
      deactivate();

      // Calling deactivate again should not throw or call dispose again
      trackerInstance.dispose.mockClear();
      deactivate();
      expect(trackerInstance.dispose).not.toHaveBeenCalled();
    });
  });
});
