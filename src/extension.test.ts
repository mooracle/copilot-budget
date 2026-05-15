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
import {
  writeTrackingFile,
  readTrackingFile,
  isTrackingFileTruncated,
} from './trackingFile';
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
  mockReadTrackingFile.mockResolvedValue({ kind: 'absent' });
  mockIsTrackingFileTruncated.mockResolvedValue(false);
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
      // checkCommitReset → then → writeTrackingFile; flush microtasks
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(stats);
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

    it('defers writes when readTrackingFile returns unread (transient I/O on existing file)', async () => {
      // 'unread' = file exists with size > 0 but couldn't be read this tick.
      // Writing zero stats over a valid file would silently destroy the
      // user's accumulated session. The activation path, stats-change
      // listener, and refresh poll must all defer writes until a follow-up
      // read succeeds.
      jest.useFakeTimers();
      mockReadTrackingFile.mockResolvedValue({ kind: 'unread' });
      const ctx = makeContext();
      await activate(ctx);

      expect(mockWriteTrackingFile).not.toHaveBeenCalled();
      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();

      // Stats-change listener fires while still unread → still no write.
      statsChangedListeners[0]({ ...SAMPLE_STATS });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWriteTrackingFile).not.toHaveBeenCalled();

      // Refresh poll fires while still unread → also no write.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWriteTrackingFile).not.toHaveBeenCalled();

      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('recovers from unread state once read succeeds, restoring previous stats', async () => {
      jest.useFakeTimers();
      mockReadTrackingFile.mockResolvedValueOnce({ kind: 'unread' });
      const restored = {
        since: '2024-01-01T00:00:00Z',
        interactions: 5,
        models: {},
      };
      mockReadTrackingFile.mockResolvedValueOnce({ kind: 'restored', stats: restored });
      const ctx = makeContext();
      await activate(ctx);

      expect(mockWriteTrackingFile).not.toHaveBeenCalled();
      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();

      // Next refresh tick re-reads, gets 'restored', restores stats and
      // resumes writes. update() emits a stats-change which writes.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(trackerInstance.setPreviousStats).toHaveBeenCalledWith(restored);
      expect(trackerInstance.update).toHaveBeenCalled();

      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('overwrites legacy content immediately when recovering from unread', async () => {
      // Scenario: activation observes 'unread' (file exists but not readable).
      // Later the file becomes readable but contains legacy v0.5.x content —
      // possibly with stale TR_ lines the commit hook would pick up. The
      // activation path always overwrites legacy content immediately (see
      // lines around `if (trackingFile.kind === 'legacy')`). Recovery must
      // mirror that: otherwise the stale file lingers until the next
      // stats-change or 5s poll, and a commit landing in the gap appends
      // stale trailers.
      jest.useFakeTimers();
      mockReadTrackingFile.mockResolvedValueOnce({ kind: 'unread' });
      mockReadTrackingFile.mockResolvedValueOnce({ kind: 'legacy' });
      const ctx = makeContext();
      await activate(ctx);
      expect(mockWriteTrackingFile).not.toHaveBeenCalled();

      // Refresh tick: re-read returns 'legacy'. Recovery must immediately
      // overwrite the stale content with current stats.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(trackerInstance.getStats());
      // setPreviousStats must NOT be called on legacy — the file's contents
      // are unparseable as the new format, so there's nothing to restore.
      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();

      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('writes current stats immediately when recovery finds the file absent', async () => {
      // Scenario: activation observes 'unread' (file exists but not readable).
      // Later the file becomes readable but is genuinely absent — possibly
      // deleted by the user or consumed by the commit hook between activation
      // and the next tick. In-memory stats may already be accumulating, so
      // recovery must write them out immediately. Otherwise a commit landing
      // in the gap before the next stats-change or 5s poll would find no
      // tracking file and drop the trailer entirely.
      jest.useFakeTimers();
      mockReadTrackingFile.mockResolvedValueOnce({ kind: 'unread' });
      mockReadTrackingFile.mockResolvedValueOnce({ kind: 'absent' });
      const ctx = makeContext();
      await activate(ctx);

      expect(mockWriteTrackingFile).not.toHaveBeenCalled();

      // Refresh tick: re-read returns 'absent'. Recovery must immediately
      // write the current in-memory stats so a commit can't slip through
      // before the next poll.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(trackerInstance.getStats());
      // setPreviousStats must NOT be called on 'absent' — there's nothing on
      // disk to restore.
      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();

      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('does not call consume() again when an intervening stat() fails between truncated polls', async () => {
      // Scenario: hook truncates, first poll detects, consume() runs, write
      // fails → pendingConsumeWrite=true. Second poll's stat() fails with an
      // ambiguous error (isTrackingFileTruncated returns null) — caller must
      // NOT clear pendingConsumeWrite. Third poll sees file still truncated;
      // because pendingConsumeWrite is still true, consume() does NOT run a
      // second time and the previously-rebased post-commit delta is preserved.
      jest.useFakeTimers();
      mockIsTrackingFileTruncated.mockResolvedValue(true);
      mockWriteTrackingFile.mockResolvedValue(false);
      const ctx = makeContext();
      await activate(ctx);
      trackerInstance.consume.mockClear();
      mockWriteTrackingFile.mockClear();

      // Tick 1: consume() + failed write. pendingConsumeWrite is now true.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);

      // Tick 2: stat fails with an ambiguous error → null. checkCommitReset
      // must preserve pendingConsumeWrite (no consume(), no write).
      mockIsTrackingFileTruncated.mockResolvedValueOnce(null as any);
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);

      // Tick 3: stat works again, file still truncated. Because the flag
      // survived tick 2, consume() does NOT run a second time — the write is
      // simply retried.
      mockIsTrackingFileTruncated.mockResolvedValue(true);
      mockWriteTrackingFile.mockClear();
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);
      expect(mockWriteTrackingFile).toHaveBeenCalledTimes(1);

      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('does not write pre-consume stats when the first stat() is ambiguous (null)', async () => {
      // Scenario: hook truncates the file, then the very first poll's stat()
      // fails with an ambiguous error (FileNotFound is OK, anything else is
      // ambiguous → null). pendingConsumeWrite is still false (no prior
      // consume() ran), so this is NOT a retry. If checkCommitReset returns
      // false here, the caller's fallback writeTrackingFile would re-populate
      // the 0-byte file with current (pre-consume) cumulative stats, including
      // TR_ lines the hook just consumed → duplicate trailers on the next
      // commit. The fix: when stat is null AND pendingConsumeWrite is false,
      // signal "skip the fallback write" so we wait for a clean re-stat.
      jest.useFakeTimers();
      mockIsTrackingFileTruncated.mockResolvedValue(null as any);
      const ctx = makeContext();
      await activate(ctx);
      trackerInstance.consume.mockClear();
      mockWriteTrackingFile.mockClear();

      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Can't tell if truncated → must not consume() yet.
      expect(trackerInstance.consume).not.toHaveBeenCalled();
      // And must NOT do the fallback write (would clobber a truncated file).
      expect(mockWriteTrackingFile).not.toHaveBeenCalled();

      // Next tick: stat works, file is genuinely truncated. consume() now
      // runs cleanly and the post-rebase write happens.
      mockIsTrackingFileTruncated.mockResolvedValue(true);
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);

      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('clears pendingConsumeWrite after a successful fallback write so a later truncation rebases again', async () => {
      // Scenario the prior test misses: tick 1 truncated → consume() ran,
      // write failed (pendingConsumeWrite=true). Tick 2 stat is ambiguous
      // (null) so checkCommitReset returns false without touching the flag.
      // The listener/poll fallback writeTrackingFile then SUCCEEDS, which
      // means the file is no longer truncated. If we don't clear
      // pendingConsumeWrite on that success, a brand-new real commit
      // truncation on tick 3 will be misclassified as a retry and skip
      // consume(), absorbing post-commit usage into the new baseline.
      jest.useFakeTimers();
      mockIsTrackingFileTruncated.mockResolvedValue(true);
      mockWriteTrackingFile.mockResolvedValue(false);
      const ctx = makeContext();
      await activate(ctx);
      trackerInstance.consume.mockClear();
      mockWriteTrackingFile.mockClear();

      // Tick 1: consume() + failed write. pendingConsumeWrite=true.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);

      // Tick 2: stat ambiguous → checkCommitReset returns false. Fallback
      // writeTrackingFile succeeds this time → must clear pendingConsumeWrite.
      mockIsTrackingFileTruncated.mockResolvedValueOnce(null as any);
      mockWriteTrackingFile.mockResolvedValue(true);
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);

      // Tick 3: brand-new commit truncation. With pendingConsumeWrite
      // properly cleared, consume() must run again to rebase the tracker
      // for the new commit.
      mockIsTrackingFileTruncated.mockResolvedValue(true);
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(2);

      for (const sub of ctx.subscriptions) sub.dispose();
      jest.useRealTimers();
    });

    it('overlapping unread recoveries do not both apply setPreviousStats', async () => {
      // Race scenario: activation observes 'unread'. Two recovery attempts
      // start concurrently (e.g., stats-change listener + 5s poll). The
      // first awaiting read resolves to 'restored' and applies
      // setPreviousStats + update(); after that the on-disk file has been
      // refreshed to include those restored stats. The second recovery's
      // own pending read then resolves — without re-checking safeToWrite
      // after the await, it would apply setPreviousStats a second time on
      // top of the already-restored state, double-counting on the next
      // update().
      mockReadTrackingFile.mockReset();
      mockReadTrackingFile.mockResolvedValueOnce({ kind: 'unread' });

      let resolveSecond: ((v: any) => void) | undefined;
      let resolveThird: ((v: any) => void) | undefined;
      mockReadTrackingFile.mockReturnValueOnce(
        new Promise((res) => {
          resolveSecond = res;
        }) as any,
      );
      mockReadTrackingFile.mockReturnValueOnce(
        new Promise((res) => {
          resolveThird = res;
        }) as any,
      );

      const ctx = makeContext();
      await activate(ctx);
      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();

      // Two overlapping recovery callers, both suspending on their own read.
      statsChangedListeners[0](SAMPLE_STATS);
      statsChangedListeners[0](SAMPLE_STATS);
      await Promise.resolve();

      // Second caller wins the race, resolves first to 'restored' and
      // restores previousStats + safeToWrite=true.
      const restoredFirst = {
        since: '2024-01-01T00:00:00Z',
        interactions: 5,
        models: {},
      };
      resolveSecond!({ kind: 'restored', stats: restoredFirst });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(trackerInstance.setPreviousStats).toHaveBeenCalledTimes(1);
      expect(trackerInstance.setPreviousStats).toHaveBeenCalledWith(restoredFirst);
      trackerInstance.setPreviousStats.mockClear();
      trackerInstance.update.mockClear();

      // Third caller (the second overlapping recovery) now resolves with a
      // newer snapshot — exactly the content of the freshly-written file.
      // Without the post-await safeToWrite recheck, setPreviousStats would
      // be called again here, double-applying the restored data.
      const restoredSecond = {
        since: '2024-01-01T00:00:00Z',
        interactions: 7,
        models: {},
      };
      resolveThird!({ kind: 'restored', stats: restoredSecond });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();
      expect(trackerInstance.update).not.toHaveBeenCalled();

      for (const sub of ctx.subscriptions) sub.dispose();
    });

    it('does not call consume() again on a subsequent truncated tick after a post-consume write fails', async () => {
      // Scenario: hook truncates file, extension detects, consume() rebases
      // and writes the post-commit delta. The write fails (filesystem
      // transient). Next poll sees the file still truncated. Without this
      // guard, consume() would run a second time and absorb the unwritten
      // post-commit delta into the new baseline — silently losing usage.
      jest.useFakeTimers();
      mockIsTrackingFileTruncated.mockResolvedValue(true);
      mockWriteTrackingFile.mockResolvedValue(false);
      const ctx = makeContext();
      await activate(ctx);
      trackerInstance.consume.mockClear();
      mockWriteTrackingFile.mockClear();

      // First detection: consume + (failed) write.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);
      expect(mockWriteTrackingFile).toHaveBeenCalledTimes(1);

      // Second tick: file still truncated, write still failing. Must retry
      // the write but NOT call consume() again.
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);
      expect(mockWriteTrackingFile).toHaveBeenCalledTimes(2);

      // Third tick: write finally succeeds. Pending flag clears so a later
      // truncation (e.g. a new commit) would consume again correctly.
      mockWriteTrackingFile.mockResolvedValue(true);
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(trackerInstance.consume).toHaveBeenCalledTimes(1);
      expect(mockWriteTrackingFile).toHaveBeenCalledTimes(3);

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

    it('resetTracking writes the reset snapshot directly even when checkCommitReset would skip', async () => {
      // Hook truncates the file, then stat() starts returning null (ambiguous
      // I/O error). The listener path's checkCommitReset returns true (skip
      // fallback write) on a first probe with pendingConsumeWrite=false,
      // leaving the file's stale TR_ lines in place. Reset stats have
      // totalAiCredits=0 (no TR_ emission), so resetTracking must write
      // directly to clear those stale trailers, not depend on the listener.
      mockIsTrackingFileTruncated.mockResolvedValue(null as any);

      const ctx = makeContext();
      await activate(ctx);
      mockWriteTrackingFile.mockClear();

      const resetSnapshot = {
        ...SAMPLE_STATS,
        totalAiCredits: 0,
        interactions: 0,
        totalTokens: 0,
        models: {},
      };
      trackerInstance.getStats.mockReturnValueOnce(resetSnapshot);

      __commandCallbacks['copilot-budget.resetTracking']();
      expect(trackerInstance.reset).toHaveBeenCalledTimes(1);
      // Direct write fires synchronously with the reset snapshot, ignoring
      // the listener's skip signal.
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(resetSnapshot);

      for (const sub of ctx.subscriptions) sub.dispose();
    });

    it('resetTracking after an unread startup is not silently undone by a later recovery', async () => {
      // Activate with 'unread', then have subsequent reads return a
      // 'restored' snapshot (the file became readable later). Without the
      // safeToWrite=true in the reset command, the listener's recovery
      // attempt would call setPreviousStats with the OLD on-disk stats,
      // overwriting the freshly-reset in-memory state — and the next write
      // would persist the restored totals back, silently undoing the reset.
      mockReadTrackingFile.mockResolvedValueOnce({ kind: 'unread' });
      const restoredOldStats = {
        since: '2024-01-01T00:00:00Z',
        interactions: 50,
        models: {
          'gpt-4o': {
            inputTokens: 5000,
            outputTokens: 5000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costAic: 10,
          },
        },
      };
      mockReadTrackingFile.mockResolvedValue({
        kind: 'restored',
        stats: restoredOldStats,
      });

      const ctx = makeContext();
      await activate(ctx);
      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();

      // User runs reset while still in the 'unread' state.
      __commandCallbacks['copilot-budget.resetTracking']();
      expect(trackerInstance.reset).toHaveBeenCalledTimes(1);

      // Simulate the stats-change tracker.reset() would emit: the listener
      // must now take the normal write path, NOT the unread-recovery path.
      const resetStats = { ...SAMPLE_STATS, totalAiCredits: 0, interactions: 0 };
      statsChangedListeners[0](resetStats);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(resetStats);

      for (const sub of ctx.subscriptions) sub.dispose();
    });

    it('resetTracking cancels an in-flight stats-change write so it cannot re-persist pre-reset stats', async () => {
      // Race scenario: a stats-change listener fires with pre-reset stats S1
      // and starts checkCommitReset, which suspends on isTrackingFileTruncated.
      // While suspended, the user resets. The pending callback must NOT
      // proceed to writeTrackingFile(S1) once the truncation check resolves —
      // doing so would race the reset's direct write of S0 and re-persist
      // stale totals + TR_ lines, silently undoing the reset.
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

      const preResetStats = {
        since: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T01:00:00Z',
        models: {
          'gpt-4o': {
            inputTokens: 1000,
            outputTokens: 2000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costAic: 42,
          },
        },
        totalTokens: 3000,
        interactions: 10,
        totalAiCredits: 42,
      };
      statsChangedListeners[0](preResetStats);
      await Promise.resolve();

      // User resets while the stats-change write is still suspended.
      __commandCallbacks['copilot-budget.resetTracking']();
      expect(trackerInstance.reset).toHaveBeenCalledTimes(1);

      // Reset's direct write fired with the (mock) reset snapshot.
      const directWriteCount = mockWriteTrackingFile.mock.calls.length;

      // Now release the suspended truncation check.
      resolveTruncated(false);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The pending listener invocation MUST have aborted instead of writing
      // preResetStats. Total writes since reset should equal the direct write
      // only — no extra writeTrackingFile(preResetStats) snuck through.
      expect(mockWriteTrackingFile).not.toHaveBeenCalledWith(preResetStats);
      expect(mockWriteTrackingFile.mock.calls.length).toBe(directWriteCount);

      for (const sub of ctx.subscriptions) sub.dispose();
    });

    it('resetTracking cancels an already in-flight unread recovery', async () => {
      // Activate with 'unread'. The stats-change listener then fires while
      // safeToWrite is still false, kicking off an attemptRecoverFromUnread
      // that awaits readTrackingFile. While that read is pending, the user
      // invokes reset. The pending read must NOT call setPreviousStats once
      // it resolves — doing so would silently restore the pre-reset snapshot
      // on top of the freshly reset state.
      mockReadTrackingFile.mockReset();
      mockReadTrackingFile.mockResolvedValueOnce({ kind: 'unread' });

      let resolveSecondRead: ((v: any) => void) | undefined;
      mockReadTrackingFile.mockReturnValueOnce(
        new Promise((res) => {
          resolveSecondRead = res;
        }) as any,
      );

      const ctx = makeContext();
      await activate(ctx);
      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();

      // Stats-change while still 'unread' kicks off attemptRecoverFromUnread,
      // which awaits the second readTrackingFile (still pending).
      statsChangedListeners[0](SAMPLE_STATS);
      await Promise.resolve();

      // User resets before the in-flight read resolves.
      __commandCallbacks['copilot-budget.resetTracking']();
      expect(trackerInstance.reset).toHaveBeenCalledTimes(1);

      // Now resolve the pending read with a 'restored' snapshot.
      const restoredOldStats = {
        since: '2024-01-01T00:00:00Z',
        interactions: 50,
        models: {
          'gpt-4o': {
            inputTokens: 5000,
            outputTokens: 5000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costAic: 10,
          },
        },
      };
      resolveSecondRead!({ kind: 'restored', stats: restoredOldStats });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The in-flight recovery must have aborted: no setPreviousStats, no
      // tracker.update from the recovery path.
      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();
      expect(trackerInstance.update).not.toHaveBeenCalled();

      for (const sub of ctx.subscriptions) sub.dispose();
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

    it('attempts a final unread recovery before the last write so short sessions are not lost', async () => {
      // Scenario: file is unreadable at activation, VS Code closes before
      // the first 5s poll (or after the last unsuccessful retry). Without a
      // recovery attempt in deactivate, this session's accumulated stats
      // never reach disk. With it, if the file is now readable, the prior
      // snapshot is merged and the final write succeeds.
      mockReadTrackingFile.mockResolvedValueOnce({ kind: 'unread' });
      const restored = {
        since: '2024-01-01T00:00:00Z',
        interactions: 5,
        models: {},
      };
      mockReadTrackingFile.mockResolvedValueOnce({
        kind: 'restored',
        stats: restored,
      });

      const ctx = makeContext();
      await activate(ctx);
      expect(mockWriteTrackingFile).not.toHaveBeenCalled();

      await deactivate();

      expect(trackerInstance.setPreviousStats).toHaveBeenCalledWith(restored);
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(
        trackerInstance.getStats(),
      );
    });

    it('still performs the final write when the stat probe is ambiguous at deactivate', async () => {
      // The listener/poll paths skip the fallback write on a null stat
      // (truncated=null, !pendingConsumeWrite) so a clean re-stat on the
      // next tick can decide between "truncated" and "fine" before we risk
      // re-emitting consumed TR_ lines. Deactivate has no next tick: if it
      // honored that "skip" signal, a single transient stat hiccup at
      // shutdown would drop every stat accumulated this session. The risk
      // of duplicate trailers (only if the file was actually truncated at
      // the exact ambiguous moment) is acceptable next to silent data
      // loss.
      mockIsTrackingFileTruncated.mockResolvedValue(null as any);
      const ctx = makeContext();
      await activate(ctx);
      mockWriteTrackingFile.mockClear();

      await deactivate();

      expect(trackerInstance.consume).not.toHaveBeenCalled();
      expect(mockWriteTrackingFile).toHaveBeenCalledWith(
        trackerInstance.getStats(),
      );
    });

    it('skips the final write when the file remains unread through deactivate', async () => {
      // If the file never becomes readable, we must NOT overwrite it with a
      // fresh zero baseline (which would clobber the user's accumulated
      // session that's locked behind whatever I/O issue caused 'unread').
      mockReadTrackingFile.mockResolvedValue({ kind: 'unread' });

      const ctx = makeContext();
      await activate(ctx);
      expect(mockWriteTrackingFile).not.toHaveBeenCalled();

      await deactivate();

      expect(trackerInstance.setPreviousStats).not.toHaveBeenCalled();
      expect(mockWriteTrackingFile).not.toHaveBeenCalled();
      expect(trackerInstance.dispose).toHaveBeenCalledTimes(1);
    });
  });
});
