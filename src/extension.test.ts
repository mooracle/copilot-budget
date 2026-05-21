jest.mock('./tracker');
jest.mock('./statusBar');
jest.mock('./budgetPanel');
jest.mock('./trackingFile');
jest.mock('./commitHook');
jest.mock('./config');
jest.mock('./logger');
jest.mock('./sessionDiscovery');
jest.mock('./otelReader');

import * as vscode from 'vscode';
import { __commandCallbacks, __workspaceUpdate, createMockExtensionContext } from './__mocks__/vscode';
import { activate, deactivate } from './extension';
import { Tracker, JsonlSource, OTelSource } from './tracker';
import { createStatusBar } from './statusBar';
import { showBudgetPanel } from './budgetPanel';
import {
  writeTrackingFile,
  readTrackingFile,
  isTrackingFileTruncated,
} from './trackingFile';
import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import {
  isEnabled,
  isCommitHookEnabled,
  onConfigChanged,
  getEstimationMode,
  isOTelDbExporterEnabled,
  onDidChangeOTelSetting,
} from './config';
import { getDiscoveryDiagnostics, discoverSessionFiles } from './sessionDiscovery';
import { createOTelReader, diagnoseUnavailable } from './otelReader';
import { getOutputChannel, disposeLogger } from './logger';

const MockTracker = Tracker as jest.MockedClass<typeof Tracker>;
const mockCreateStatusBar = createStatusBar as jest.MockedFunction<
  typeof createStatusBar
>;
const mockShowBudgetPanel = showBudgetPanel as jest.MockedFunction<
  typeof showBudgetPanel
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
const mockGetEstimationMode = getEstimationMode as jest.MockedFunction<
  typeof getEstimationMode
>;
const mockIsOTelDbExporterEnabled = isOTelDbExporterEnabled as jest.MockedFunction<
  typeof isOTelDbExporterEnabled
>;
const mockOnDidChangeOTelSetting = onDidChangeOTelSetting as jest.MockedFunction<
  typeof onDidChangeOTelSetting
>;
const mockGetDiscoveryDiagnostics = getDiscoveryDiagnostics as jest.MockedFunction<
  typeof getDiscoveryDiagnostics
>;
const mockDiscoverSessionFiles = discoverSessionFiles as jest.MockedFunction<
  typeof discoverSessionFiles
>;
const mockCreateOTelReader = createOTelReader as jest.MockedFunction<
  typeof createOTelReader
>;
const mockDiagnoseUnavailable = diagnoseUnavailable as jest.MockedFunction<
  typeof diagnoseUnavailable
>;
const mockGetOutputChannel = getOutputChannel as jest.MockedFunction<
  typeof getOutputChannel
>;
const mockDisposeLogger = disposeLogger as jest.MockedFunction<
  typeof disposeLogger
>;

function makeContext(): vscode.ExtensionContext {
  return createMockExtensionContext({
    storageUri: vscode.Uri.file(
      '/test/workspaceStorage/abc123/mooracle.copilot-budget',
    ),
  }) as vscode.ExtensionContext;
}

function makeEmptyWindowContext(): vscode.ExtensionContext {
  return createMockExtensionContext({}) as vscode.ExtensionContext;
}

let trackerInstance: any;
let statsChangedListeners: Array<(stats: any) => void>;
let configChangedCallback: ((e: any) => void) | null;
let otelSettingChangedCallback: (() => void) | null;
let mockOTelReader: any;

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
  mode: 'files' as const,
};

beforeEach(async () => {
  jest.clearAllMocks();
  for (const key of Object.keys(__commandCallbacks)) delete __commandCallbacks[key];
  (vscode as any).workspace.workspaceFolders = undefined;

  statsChangedListeners = [];
  configChangedCallback = null;
  otelSettingChangedCallback = null;

  trackerInstance = {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    reset: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(true),
    update: jest.fn().mockResolvedValue(undefined),
    dispose: jest.fn(),
    setPreviousStats: jest.fn(),
    swapSource: jest.fn().mockResolvedValue(undefined),
    getStats: jest.fn().mockReturnValue(SAMPLE_STATS),
    getFileDiagnostics: jest.fn().mockReturnValue([]),
    mode: 'files' as 'files' | 'telemetry',
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
    refresh: jest.fn(),
    item: { text: '', dispose: jest.fn() },
  };
  mockCreateStatusBar.mockReturnValue(mockStatusBarItem as any);
  mockShowBudgetPanel.mockResolvedValue(undefined);
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
  mockOnDidChangeOTelSetting.mockImplementation((cb: any) => {
    otelSettingChangedCallback = cb;
    return { dispose: jest.fn() };
  });
  // Default to Files mode (upstream off, no DB). Individual tests flip these.
  mockGetEstimationMode.mockReturnValue('files');
  mockIsOTelDbExporterEnabled.mockReturnValue(false);
  mockDiagnoseUnavailable.mockReturnValue(null);
  mockOTelReader = {
    isAvailable: jest.fn(() => false),
    readSpansSince: jest.fn(() => []),
    getLatestTimestamp: jest.fn(() => 0),
    close: jest.fn(),
  };
  mockCreateOTelReader.mockReturnValue(mockOTelReader);
  mockDiscoverSessionFiles.mockReturnValue([]);
  mockGetDiscoveryDiagnostics.mockReturnValue({
    platform: 'darwin',
    homedir: '/home/test',
    storageUri: '/home/test/.config/Code/User/workspaceStorage/abc123/mooracle.copilot-budget',
    chatSessionsDir: '/home/test/.config/Code/User/workspaceStorage/abc123/chatSessions',
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
    refresh: jest.fn(),
    item: { text: '', dispose: jest.fn() },
  } as any);
  mockIsEnabled.mockReturnValue(true);
  mockIsCommitHookEnabled.mockReturnValue(false);
  mockOnConfigChanged.mockImplementation((cb: any) => {
    configChangedCallback = cb;
    return { dispose: jest.fn() };
  });
  mockOnDidChangeOTelSetting.mockImplementation((cb: any) => {
    otelSettingChangedCallback = cb;
    return { dispose: jest.fn() };
  });
  mockGetEstimationMode.mockReturnValue('files');
  mockIsOTelDbExporterEnabled.mockReturnValue(false);
  mockDiagnoseUnavailable.mockReturnValue(null);
  mockCreateOTelReader.mockReturnValue(mockOTelReader);
  mockDiscoverSessionFiles.mockReturnValue([]);
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
      // 6 stub commands registered so users get a helpful message
      expect(ctx.subscriptions.length).toBe(6);
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

    it('skips the post-rebase write when consume() bails (source swap mid-await)', async () => {
      // If a source swap lands during consume()'s await, consume() returns
      // false without rebasing. tracker.getStats() in that window still holds
      // the pre-truncation cumulative totals (swapSource carried them into
      // previousStats). Writing those back would re-introduce the trailers
      // the hook just consumed and double count on the next commit.
      jest.useFakeTimers();
      mockIsTrackingFileTruncated.mockResolvedValue(true);
      trackerInstance.consume.mockResolvedValue(false);
      const ctx = makeContext();
      await activate(ctx);
      mockWriteTrackingFile.mockClear();
      trackerInstance.consume.mockClear();

      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);
      // No write — the next 5s poll will retry on the still-truncated file.
      expect(mockWriteTrackingFile).not.toHaveBeenCalled();

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

    it('passes context.storageUri via JsonlSource to the Tracker constructor', async () => {
      const ctx = makeContext();
      await activate(ctx);
      const MockJsonlSource = JsonlSource as jest.MockedClass<typeof JsonlSource>;
      expect(MockJsonlSource).toHaveBeenCalledWith(ctx.storageUri);
      // Tracker receives the JsonlSource instance + the initial 'files' mode.
      // Auto-mocked instance identity comes from JsonlSource.mock.instances[0].
      expect(MockTracker).toHaveBeenCalledWith(
        MockJsonlSource.mock.instances[0],
        'files',
      );
    });

    it('constructs Tracker with OTelSource when getEstimationMode returns "telemetry"', async () => {
      mockGetEstimationMode.mockReturnValue('telemetry');
      mockIsOTelDbExporterEnabled.mockReturnValue(true);

      const ctx = makeContext();
      await activate(ctx);

      const MockOTelSource = OTelSource as jest.MockedClass<typeof OTelSource>;
      expect(MockOTelSource).toHaveBeenCalled();
      expect(MockTracker).toHaveBeenCalledWith(
        MockOTelSource.mock.instances[0],
        'telemetry',
      );
    });

    it('logs the remote-host diagnostic and closes the reader when DB missing but upstream enabled', async () => {
      mockGetEstimationMode.mockReturnValue('files');
      mockIsOTelDbExporterEnabled.mockReturnValue(true);
      mockDiagnoseUnavailable.mockReturnValue(
        'OTel exporter enabled upstream but agent-traces.db not found at /tmp/x — possible remote-host mismatch',
      );

      const ctx = makeContext();
      await activate(ctx);

      expect(mockDiagnoseUnavailable).toHaveBeenCalledWith(
        ctx.globalStorageUri,
        true,
      );
      // The reader created during pickSource is closed when we fall back to
      // Files mode — we don't hold onto a handle we won't use.
      expect(mockOTelReader.close).toHaveBeenCalled();
    });

    it('registers an onDidChangeOTelSetting listener', async () => {
      const ctx = makeContext();
      await activate(ctx);
      expect(mockOnDidChangeOTelSetting).toHaveBeenCalledTimes(1);
      expect(otelSettingChangedCallback).not.toBeNull();
    });
  });

  describe('OTel hot-swap on config change', () => {
    it('swaps Tracker to telemetry source when upstream setting enables OTel', async () => {
      const ctx = makeContext();
      await activate(ctx);
      // Initial mode = files.
      const MockOTelSource = OTelSource as jest.MockedClass<typeof OTelSource>;
      MockOTelSource.mockClear();

      // Simulate upstream enabling OTel: getEstimationMode now returns telemetry.
      mockGetEstimationMode.mockReturnValue('telemetry');
      mockIsOTelDbExporterEnabled.mockReturnValue(true);
      trackerInstance.mode = 'files';

      otelSettingChangedCallback!();
      // swapSource is awaited internally; flush microtasks so we can assert.
      await Promise.resolve();
      await Promise.resolve();

      expect(MockOTelSource).toHaveBeenCalledTimes(1);
      expect(trackerInstance.swapSource).toHaveBeenCalledWith(
        MockOTelSource.mock.instances[0],
        'telemetry',
      );
    });

    it('does not call swapSource when the effective mode is unchanged', async () => {
      const ctx = makeContext();
      await activate(ctx);

      // OTel setting changed (e.g., user toggled DB on then off rapidly) but
      // effective mode resolves to the same value — no swap should occur.
      mockGetEstimationMode.mockReturnValue('files');
      trackerInstance.mode = 'files';

      otelSettingChangedCallback!();
      await Promise.resolve();
      await Promise.resolve();

      expect(trackerInstance.swapSource).not.toHaveBeenCalled();
    });

    it('shows the one-time mode-swap info message on first Files→Telemetry swap', async () => {
      const ctx = makeContext();
      const wsUpdate = ctx.workspaceState.update as jest.Mock;
      (ctx.workspaceState.get as any) = jest.fn().mockReturnValue(false);
      (ctx.workspaceState.update as any) = jest.fn().mockResolvedValue(undefined);

      await activate(ctx);

      mockGetEstimationMode.mockReturnValue('telemetry');
      trackerInstance.mode = 'files';
      // swapSource resolves successfully — trigger the then-handler.
      trackerInstance.swapSource.mockImplementation(async () => {
        trackerInstance.mode = 'telemetry';
      });

      otelSettingChangedCallback!();
      // Drain the chained promises inside the hot-swap handler.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(ctx.workspaceState.update).toHaveBeenCalledWith(
        'copilot-budget.modeSwapMessageShown',
        true,
      );
      const showInfo = vscode.window.showInformationMessage as jest.Mock;
      expect(showInfo).toHaveBeenCalledWith(
        expect.stringMatching(/Switched to Telemetry mode/i),
      );
      // Sanity: the flag default-overwrite via fresh assignment didn't lose wsUpdate type
      void wsUpdate;
    });

    it('does NOT show the swap message a second time once workspaceState flag is set', async () => {
      const ctx = makeContext();
      (ctx.workspaceState.get as any) = jest.fn().mockReturnValue(true);
      (ctx.workspaceState.update as any) = jest.fn().mockResolvedValue(undefined);

      await activate(ctx);

      mockGetEstimationMode.mockReturnValue('telemetry');
      trackerInstance.mode = 'files';
      trackerInstance.swapSource.mockImplementation(async () => {
        trackerInstance.mode = 'telemetry';
      });

      otelSettingChangedCallback!();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const showInfo = vscode.window.showInformationMessage as jest.Mock;
      expect(showInfo).not.toHaveBeenCalledWith(
        expect.stringMatching(/Switched to Telemetry mode/i),
      );
      expect(ctx.workspaceState.update).not.toHaveBeenCalled();
    });

    it('serializes overlapping swap triggers and re-evaluates mode after each completes', async () => {
      // Race scenario: a Files→Telemetry swap is mid-flight when the user
      // disables OTel upstream. Without serialization, the disable event sees
      // tracker.mode === 'files' (not yet updated), getEstimationMode returns
      // 'files', so the disable is a no-op. The in-flight enable then
      // completes, locking us into Telemetry mode. The auto-poll only runs
      // while mode === 'files', so there's no recovery path.
      //
      // With serialization, the disable trigger queues behind the in-flight
      // enable. When it runs, it re-picks pickSource against the now-current
      // upstream=off state and correctly swaps back to Files.
      const ctx = makeContext();
      // Pre-set the one-time mode-swap flag so the showInformationMessage
      // path is skipped — it adds awaits that obscure the chain timing.
      (ctx.workspaceState.get as any) = jest.fn().mockReturnValue(true);
      await activate(ctx);

      let resolveFirstSwap: () => void = () => {};
      const swapCalls: Array<'telemetry' | 'files'> = [];
      trackerInstance.swapSource.mockImplementation(
        async (_src: any, mode: 'files' | 'telemetry') => {
          swapCalls.push(mode);
          if (swapCalls.length === 1) {
            await new Promise<void>((resolve) => {
              resolveFirstSwap = resolve;
            });
          }
          trackerInstance.mode = mode;
        },
      );

      // First trigger: user enables OTel.
      mockGetEstimationMode.mockReturnValue('telemetry');
      mockIsOTelDbExporterEnabled.mockReturnValue(true);
      otelSettingChangedCallback!();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.swapSource).toHaveBeenCalledTimes(1);
      expect(swapCalls[0]).toBe('telemetry');

      // Second trigger arrives while the first is still in flight: user
      // disables OTel. tracker.mode is still 'files' at this instant.
      mockGetEstimationMode.mockReturnValue('files');
      mockIsOTelDbExporterEnabled.mockReturnValue(false);
      otelSettingChangedCallback!();
      await Promise.resolve();
      await Promise.resolve();
      // No second swapSource call yet — it's queued behind the in-flight one.
      expect(trackerInstance.swapSource).toHaveBeenCalledTimes(1);

      // Let the first swap complete. Tracker mode is now 'telemetry'.
      resolveFirstSwap();
      // Flush enough microtasks for the chained handler to run pickSource,
      // dispatch the second swap, and have it resolve.
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // The queued trigger re-evaluates pickSource. getEstimationMode now
      // returns 'files', tracker.mode is 'telemetry' — they differ, so a
      // second swap fires to restore Files mode.
      expect(trackerInstance.swapSource).toHaveBeenCalledTimes(2);
      expect(swapCalls).toEqual(['telemetry', 'files']);
      expect(trackerInstance.mode).toBe('files');
    });

    it('re-probes truncation per caller instead of memoizing a stale negative', async () => {
      // Race scenario: caller A starts checkCommitReset and its
      // isTrackingFileTruncated probe runs against the pre-truncation file
      // (returns false on slow/remote fs). Caller B arrives after the hook
      // truncates. With a function-level promise cache including the
      // negative probe, B would reuse A's stale `false` and write
      // pre-consume stats over the truncated signal. Probing per-caller
      // (memoizing only consume) ensures B sees the truncation and rebases.
      jest.useFakeTimers();

      // First call: probe returns false (pre-truncation snapshot).
      // Subsequent calls: probe returns true (post-truncation).
      let probeCallCount = 0;
      mockIsTrackingFileTruncated.mockImplementation(async () => {
        probeCallCount += 1;
        return probeCallCount > 1;
      });

      const ctx = makeContext();
      await activate(ctx);
      mockWriteTrackingFile.mockClear();
      trackerInstance.consume.mockClear();

      // Fire stats-change listener — first probe returns false, no consume.
      statsChangedListeners[0](trackerInstance.getStats());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).not.toHaveBeenCalled();

      // 5s poll fires — second probe returns true, consume runs.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);

      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });
  });

  describe('empty-window activation (storageUri undefined)', () => {
    it('does not construct a Tracker', async () => {
      const ctx = makeEmptyWindowContext();
      await activate(ctx);
      expect(MockTracker).not.toHaveBeenCalled();
    });

    it('does not call readTrackingFile or writeTrackingFile', async () => {
      const ctx = makeEmptyWindowContext();
      await activate(ctx);
      expect(mockReadTrackingFile).not.toHaveBeenCalled();
      expect(mockWriteTrackingFile).not.toHaveBeenCalled();
    });

    it('does not call createStatusBar (uses a static status bar instead)', async () => {
      const ctx = makeEmptyWindowContext();
      await activate(ctx);
      expect(mockCreateStatusBar).not.toHaveBeenCalled();
    });

    it('does not auto-install the commit hook even if enabled', async () => {
      mockIsCommitHookEnabled.mockReturnValue(true);
      (vscode as any).workspace.workspaceFolders = [
        { uri: vscode.Uri.file('/project'), name: 'test', index: 0 },
      ];
      const ctx = makeEmptyWindowContext();
      await activate(ctx);
      expect(mockInstallHook).not.toHaveBeenCalled();
    });

    it('registers a static status bar item with the no-workspace text/tooltip', async () => {
      const createStatusBarItem = jest.spyOn(vscode.window, 'createStatusBarItem');
      const fakeItem: any = {
        text: '',
        tooltip: '',
        command: '',
        name: '',
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn(),
      };
      createStatusBarItem.mockReturnValue(fakeItem);

      const ctx = makeEmptyWindowContext();
      await activate(ctx);

      expect(createStatusBarItem).toHaveBeenCalledWith(
        'copilot-budget.statusBar',
        vscode.StatusBarAlignment.Right,
        100,
      );
      expect(fakeItem.name).toBe('Copilot Budget');
      expect(fakeItem.text).toBe('$(circle-slash) Copilot Budget');
      expect(fakeItem.tooltip).toBe(
        'No workspace open — open a folder to track Copilot usage.',
      );
      expect(fakeItem.command).toBe('copilot-budget.showDiagnostics');
      expect(fakeItem.show).toHaveBeenCalled();
      expect(ctx.subscriptions).toContain(fakeItem);

      createStatusBarItem.mockRestore();
    });

    it('registers all 5 commands; non-diagnostics ones surface an info message', async () => {
      const ctx = makeEmptyWindowContext();
      await activate(ctx);

      for (const cmd of [
        'copilot-budget.showStats',
        'copilot-budget.resetTracking',
        'copilot-budget.installHook',
        'copilot-budget.uninstallHook',
        'copilot-budget.showDiagnostics',
      ]) {
        expect(typeof __commandCallbacks[cmd]).toBe('function');
      }

      const showInfo = vscode.window.showInformationMessage as jest.Mock;
      showInfo.mockClear();
      __commandCallbacks['copilot-budget.showStats']();
      __commandCallbacks['copilot-budget.resetTracking']();
      __commandCallbacks['copilot-budget.installHook']();
      __commandCallbacks['copilot-budget.uninstallHook']();
      expect(showInfo).toHaveBeenCalledTimes(4);
      for (const call of showInfo.mock.calls) {
        expect(call[0]).toMatch(/no workspace open/i);
      }
      expect(mockInstallHook).not.toHaveBeenCalled();
      expect(mockUninstallHook).not.toHaveBeenCalled();
      expect(mockShowBudgetPanel).not.toHaveBeenCalled();
    });

    it('showDiagnostics works in empty-window mode and passes undefined storageUri', async () => {
      mockGetDiscoveryDiagnostics.mockReturnValueOnce({
        platform: 'darwin',
        homedir: '/home/test',
        storageUri: null,
        chatSessionsDir: null,
        filesFound: [],
      });

      const ctx = makeEmptyWindowContext();
      await activate(ctx);

      const mockChannel = mockGetOutputChannel();
      await __commandCallbacks['copilot-budget.showDiagnostics']();

      expect(mockGetDiscoveryDiagnostics).toHaveBeenCalledWith(undefined);
      const appendCalls = (mockChannel.appendLine as jest.Mock).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(appendCalls).toContain('Storage URI: (none — empty window)');
      expect(appendCalls).toContain('Chat sessions dir: (none — empty window)');
      expect(mockChannel.show).toHaveBeenCalled();
    });

    it('disposes the empty-window status bar on deactivate', async () => {
      const createStatusBarItem = jest.spyOn(vscode.window, 'createStatusBarItem');
      const dispose = jest.fn();
      createStatusBarItem.mockReturnValue({
        text: '',
        tooltip: '',
        command: '',
        show: jest.fn(),
        hide: jest.fn(),
        dispose,
      } as any);

      const ctx = makeEmptyWindowContext();
      await activate(ctx);

      for (const sub of ctx.subscriptions) sub.dispose();
      expect(dispose).toHaveBeenCalled();

      createStatusBarItem.mockRestore();
    });
  });

  describe('commands', () => {
    it('showStats command calls showBudgetPanel', async () => {
      const ctx = makeContext();
      await activate(ctx);

      __commandCallbacks['copilot-budget.showStats']();
      expect(mockShowBudgetPanel).toHaveBeenCalledWith({ tracker: trackerInstance });
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

    it('toggleCommitHook warns the user when the settings write rejects', async () => {
      // If the install/uninstall succeeds on disk but the follow-up
      // configuration.update() rejects (locked settings.json, Sync provider
      // error), the user must know — otherwise the next onConfigChanged tick
      // acts on stale config (e.g. re-installs the hook the user just removed
      // because the setting is still `true`).
      mockIsCommitHookEnabled.mockReturnValue(false);
      mockInstallHook.mockResolvedValue(true);
      const showWarning = vscode.window.showWarningMessage as jest.Mock;
      showWarning.mockClear();
      __workspaceUpdate.mockRejectedValueOnce(new Error('settings.json is read-only'));

      const ctx = makeContext();
      await activate(ctx);

      await __commandCallbacks['copilot-budget.toggleCommitHook']();

      expect(mockInstallHook).toHaveBeenCalled();
      expect(showWarning).toHaveBeenCalledWith(
        expect.stringMatching(/Hook installed.*failed to save the commitHook\.enabled setting/i),
      );
    });

    it('showDiagnostics command outputs diagnostics and shows channel', async () => {
      const ctx = makeContext();
      await activate(ctx);

      const mockChannel = mockGetOutputChannel();
      await __commandCallbacks['copilot-budget.showDiagnostics']();

      expect(mockGetDiscoveryDiagnostics).toHaveBeenCalledWith(ctx.storageUri);
      expect(mockChannel.appendLine).toHaveBeenCalled();
      expect(mockChannel.show).toHaveBeenCalled();
    });

    it('showDiagnostics command displays AI credits without USD cost', async () => {
      const ctx = makeContext();
      await activate(ctx);

      const mockChannel = mockGetOutputChannel();
      await __commandCallbacks['copilot-budget.showDiagnostics']();

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
      await __commandCallbacks['copilot-budget.showDiagnostics']();

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
        refresh: jest.fn(),
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
