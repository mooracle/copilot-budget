jest.mock('./tracker');
jest.mock('./statusBar');
jest.mock('./trackingFile');
jest.mock('./commitHook');
jest.mock('./config');
jest.mock('./logger');
jest.mock('./sessionDiscovery');

import * as vscode from 'vscode';
import { __commandCallbacks } from './__mocks__/vscode';
import { activate, deactivate } from './extension';
import { Tracker } from './tracker';
import { createStatusBar, showStatsQuickPick } from './statusBar';
import {
  writeTrackingFile,
  readTrackingFile,
  isTrackingFileTruncated,
} from './trackingFile';
import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import { isEnabled, isCommitHookEnabled, onConfigChanged } from './config';
import { getDiscoveryDiagnostics } from './sessionDiscovery';
import { getOutputChannel, disposeLogger } from './logger';

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
const mockIsTrackingFileTruncated = isTrackingFileTruncated as jest.MockedFunction<
  typeof isTrackingFileTruncated
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
      costAic: 1.0,
    },
  },
  totalTokens: 300,
  interactions: 5,
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
    consume: jest.fn(),
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
  mockReadTrackingFile.mockResolvedValue({ kind: 'absent' });
  mockIsTrackingFileTruncated.mockResolvedValue(false);
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
    filesFound: ['/home/test/.config/Code/User/workspaceStorage/abc123/chatSessions/test.jsonl'],
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
  mockReadTrackingFile.mockResolvedValue({ kind: 'absent' });
  mockIsTrackingFileTruncated.mockResolvedValue(false);
  mockIsHookInstalled.mockResolvedValue(false);
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
      trackerInstance.getStats.mockReturnValue(stats);
      statsChangedListeners[0](stats);
      // checkCommitReset → then → writeTrackingFile; flush microtasks
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(stats);
    });

    it('listener writes the fresh tracker.getStats() post-await, not the closure-captured stats', async () => {
      // If the user resets (or the tracker otherwise updates) while
      // checkCommitReset is suspended on its stat probe, the listener must
      // write the current state, not the stale snapshot it was originally
      // called with. Re-reading tracker.getStats() post-await is what makes
      // this safe — no separate reset fence required.
      let resolveTruncated: (val: boolean) => void = () => {};
      mockIsTrackingFileTruncated.mockImplementation(
        () => new Promise<boolean>((resolve) => { resolveTruncated = resolve; }),
      );

      const ctx = makeContext();
      await activate(ctx);
      mockWriteTrackingFile.mockClear();

      const stale = {
        since: '2024-01-01', lastUpdated: '2024-01-01',
        models: {}, totalTokens: 999, interactions: 99,
      };
      const fresh = {
        since: '2024-02-01', lastUpdated: '2024-02-01',
        models: {}, totalTokens: 0, interactions: 0,
      };
      trackerInstance.getStats.mockReturnValue(stale);
      statsChangedListeners[0](stale);
      await Promise.resolve();

      // Reset lands while checkCommitReset is awaiting. Tracker now returns
      // fresh stats; release the probe.
      trackerInstance.getStats.mockReturnValue(fresh);
      resolveTruncated(false);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockWriteTrackingFile).toHaveBeenCalledWith(fresh);
      expect(mockWriteTrackingFile).not.toHaveBeenCalledWith(stale);

      for (const sub of ctx.subscriptions) sub.dispose();
    });

    it('rebases tracker via consume() and skips stale write when stats change after hook truncation', async () => {
      // After the hook truncates the file, the next stats-change must rebase
      // the tracker (so the consumed cumulative cost is dropped from the
      // baseline) and must NOT write the pre-rebase stats back over the
      // freshly written post-rebase file — otherwise the next commit gets a
      // duplicate trailer. consume() (not reset()) preserves any post-commit
      // activity in the new delta instead of absorbing it into the baseline.
      mockIsTrackingFileTruncated.mockResolvedValue(true);
      const ctx = makeContext();
      await activate(ctx);
      mockWriteTrackingFile.mockClear();

      const staleStats = {
        since: '2024-01-01',
        lastUpdated: '2024-01-01',
        models: {},
        totalTokens: 500,
        interactions: 3,
      };
      statsChangedListeners[0](staleStats);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);
      expect(trackerInstance.reset).not.toHaveBeenCalled();
      // checkCommitReset writes the fresh post-rebase stats once; the
      // listener must NOT additionally write `staleStats`.
      expect(mockWriteTrackingFile).not.toHaveBeenCalledWith(staleStats);
    });

    it('periodically re-writes tracking file even when stats unchanged', async () => {
      jest.useFakeTimers();
      const ctx = makeContext();
      await activate(ctx);
      mockWriteTrackingFile.mockClear();

      // Advance past one 5s interval (the truncation-detect / refresh poll)
      jest.advanceTimersByTime(5_000);
      // Drain microtasks chained behind the timer's async callback
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(trackerInstance.getStats());

      // Clean up: dispose subscriptions to clear the interval
      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('rebases tracker via consume() on the 5s poll when truncation is detected', async () => {
      jest.useFakeTimers();
      mockIsTrackingFileTruncated.mockResolvedValue(true);
      const ctx = makeContext();
      await activate(ctx);
      mockWriteTrackingFile.mockClear();
      trackerInstance.consume.mockClear();
      trackerInstance.reset.mockClear();

      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);
      expect(trackerInstance.reset).not.toHaveBeenCalled();
      // checkCommitReset writes the post-rebase stats; the timer's own write
      // must be skipped (wasReset=true).
      expect(mockWriteTrackingFile).toHaveBeenCalledTimes(1);

      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('serializes overlapping truncation checks so a concurrent caller cannot write pre-consume stats', async () => {
      // Race scenario: a stats-change listener starts checkCommitReset and
      // suspends on isTrackingFileTruncated. While suspended, the 5s poll
      // fires a second checkCommitReset. With a boolean guard, the second
      // call would return false immediately and write `tracker.getStats()`
      // (still pre-consume at that microtask point), racing the first call's
      // post-consume write. The promise-cached check makes both callers
      // share the same in-flight result so consume() runs exactly once and
      // no pre-consume snapshot is written.
      jest.useFakeTimers();
      let resolveTruncated: (val: boolean) => void = () => {};
      mockIsTrackingFileTruncated.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveTruncated = resolve;
          }),
      );

      const ctx = makeContext();
      await activate(ctx);
      mockWriteTrackingFile.mockClear();
      trackerInstance.consume.mockClear();

      // Fire the stats-change listener first — this kicks off checkCommitReset
      // which suspends awaiting isTrackingFileTruncated.
      const staleStats = {
        since: '2024-01-01',
        lastUpdated: '2024-01-01',
        models: {},
        totalTokens: 500,
        interactions: 3,
      };
      statsChangedListeners[0](staleStats);
      await Promise.resolve();

      // Now advance the 5s timer while the first check is still suspended.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();

      // Release the truncation check.
      resolveTruncated(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // consume() must run exactly once across both overlapping checks.
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);
      // Neither overlapping caller may write its captured snapshot — both
      // share the in-flight check's result (wasReset=true) and skip.
      expect(mockWriteTrackingFile).not.toHaveBeenCalledWith(staleStats);
      // Only the single post-rebase write from inside checkCommitReset
      // reaches the filesystem.
      expect(mockWriteTrackingFile).toHaveBeenCalledTimes(1);

      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('overwrites the tracking file on activation when it contains legacy v0.5.x content', async () => {
      mockReadTrackingFile.mockResolvedValue({ kind: 'legacy' });
      const ctx = makeContext();
      await activate(ctx);

      expect(mockWriteTrackingFile).toHaveBeenCalledWith(trackerInstance.getStats());
    });

    it('does NOT overwrite the tracking file on activation when read returns absent (could be transient I/O error)', async () => {
      mockReadTrackingFile.mockResolvedValue({ kind: 'absent' });
      const ctx = makeContext();
      await activate(ctx);

      // The onStatsChanged listener may still fire later; the activation
      // path itself must not synchronously write zeros.
      expect(mockWriteTrackingFile).not.toHaveBeenCalled();
    });

    it('does NOT overwrite the tracking file on activation when read succeeds with valid stats', async () => {
      mockReadTrackingFile.mockResolvedValue({
        kind: 'restored',
        stats: {
          since: '2024-01-01T00:00:00Z',
          interactions: 5,
          models: {},
        },
      });
      const ctx = makeContext();
      await activate(ctx);

      expect(mockWriteTrackingFile).not.toHaveBeenCalled();
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
            costAic: 0,
          },
        },
      };
      mockReadTrackingFile.mockResolvedValue({ kind: 'restored', stats: restored });

      const ctx = makeContext();
      await activate(ctx);

      expect(mockReadTrackingFile).toHaveBeenCalledTimes(1);
      expect(trackerInstance.setPreviousStats).toHaveBeenCalledWith(restored);
    });

    it('does not call setPreviousStats when readTrackingFile returns absent', async () => {
      mockReadTrackingFile.mockResolvedValue({ kind: 'absent' });

      const ctx = makeContext();
      await activate(ctx);

      expect(mockReadTrackingFile).toHaveBeenCalledTimes(1);
      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();
    });

    it('calls readTrackingFile before tracker.start', async () => {
      mockReadTrackingFile.mockResolvedValue({ kind: 'absent' });

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

    it('showDiagnostics command displays AI credits without USD cost', async () => {
      const ctx = makeContext();
      await activate(ctx);

      const mockChannel = mockGetOutputChannel();
      __commandCallbacks['copilot-budget.showDiagnostics']();

      const appendCalls = (mockChannel.appendLine as jest.Mock).mock.calls.map(
        (c: any[]) => c[0],
      );
      for (const line of appendCalls) {
        expect(line).not.toMatch(/Total cost:/);
      }
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
