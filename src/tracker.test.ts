import { Tracker, TrackingStats } from './tracker';
import * as fs from 'fs';
import * as sessionDiscovery from './sessionDiscovery';
import * as sessionParser from './sessionParser';
import * as tokenEstimator from './tokenEstimator';
import * as sqliteReader from './sqliteReader';

jest.mock('fs');
jest.mock('./sessionDiscovery');
jest.mock('./sessionParser');
jest.mock('./tokenEstimator');
jest.mock('./sqliteReader');
jest.mock('./logger');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockDiscovery = sessionDiscovery as jest.Mocked<typeof sessionDiscovery>;
const mockParser = sessionParser as jest.Mocked<typeof sessionParser>;
const mockEstimator = tokenEstimator as jest.Mocked<typeof tokenEstimator>;
const mockSqliteReader = sqliteReader as jest.Mocked<typeof sqliteReader>;

function setupEmptyDiscovery() {
  mockDiscovery.discoverSessionFiles.mockReturnValue([]);
}

function setupFiles(
  files: {
    path: string;
    mtime: number;
    content: string;
    parseResult: ReturnType<typeof sessionParser.parseSessionFileContent>;
  }[],
) {
  mockDiscovery.discoverSessionFiles.mockReturnValue(
    files.map((f) => f.path),
  );

  mockFs.statSync.mockImplementation((p: fs.PathLike) => {
    const file = files.find((f) => f.path === p.toString());
    if (!file) throw new Error(`ENOENT: no such file ${p}`);
    return { mtimeMs: file.mtime } as fs.Stats;
  });

  mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
    const file = files.find((f) => f.path === p.toString());
    if (!file) throw new Error(`ENOENT: no such file ${p}`);
    return file.content as any;
  });

  mockParser.parseSessionFileContent.mockImplementation(
    (filePath: string) => {
      const file = files.find((f) => f.path === filePath);
      if (!file)
        return { tokens: 0, interactions: 0, modelUsage: {}, modelInteractions: {}, thinkingTokens: 0 };
      return file.parseResult;
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockEstimator.estimateTokensFromText.mockImplementation(
    (text: string) => Math.ceil(text.length * 0.25),
  );
  mockEstimator.getPremiumMultiplier.mockReturnValue(1);
  (tokenEstimator as any).PREMIUM_REQUEST_COST = 0.04;
  // Default: sqlite not ready, no vscdb files
  mockSqliteReader.isSqliteReady.mockReturnValue(false);
  mockSqliteReader.readSessionsFromVscdb.mockReturnValue([]);
  mockDiscovery.discoverVscdbFiles.mockReturnValue([]);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Tracker', () => {
  describe('getStats before initialize', () => {
    it('returns zero stats', () => {
      const tracker = new Tracker();
      const stats = tracker.getStats();
      expect(stats.totalTokens).toBe(0);
      expect(stats.interactions).toBe(0);
      expect(stats.models).toEqual({});
      expect(stats.since).toBeDefined();
      expect(stats.lastUpdated).toBeDefined();
      tracker.dispose();
    });
  });

  describe('initialize (baseline computation)', () => {
    it('scans all sessions and sets baseline to zero delta', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();
      const stats = tracker.getStats();

      // After initialize, delta should be 0 (baseline = current)
      expect(stats.totalTokens).toBe(0);
      expect(stats.interactions).toBe(0);
      expect(stats.models).toEqual({});
      tracker.dispose();
    });

    it('handles no session files gracefully', () => {
      setupEmptyDiscovery();

      const tracker = new Tracker();
      tracker.initialize();
      const stats = tracker.getStats();

      expect(stats.totalTokens).toBe(0);
      expect(stats.interactions).toBe(0);
      tracker.dispose();
    });

    it('handles multiple session files', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
        {
          path: '/sessions/b.json',
          mtime: 2000,
          content: '{}',
          parseResult: {
            tokens: 200,
            interactions: 10,
            modelUsage: {
              'claude-sonnet-4': { inputTokens: 120, outputTokens: 80 },
            },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();
      // Baseline set = current, so delta is 0
      expect(tracker.getStats().totalTokens).toBe(0);
      tracker.dispose();
    });
  });

  describe('update (delta computation)', () => {
    it('computes delta when tokens increase after baseline', () => {
      // Initial state
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: { 'gpt-4o': 5 }, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();

      // File changed - more tokens
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 2000,
          content: '{}',
          parseResult: {
            tokens: 250,
            interactions: 8,
            modelUsage: { 'gpt-4o': { inputTokens: 150, outputTokens: 100 } },
            modelInteractions: { 'gpt-4o': 8 }, thinkingTokens: 0,
          },
        },
      ]);

      tracker.update();
      const stats = tracker.getStats();

      expect(stats.totalTokens).toBe(150); // 250 - 100
      expect(stats.interactions).toBe(3); // 8 - 5
      expect(stats.models['gpt-4o']).toEqual({
        inputTokens: 90, // 150 - 60
        outputTokens: 60, // 100 - 40
        premiumRequests: 3, // 3 delta interactions * 1 multiplier
      });
      expect(stats.premiumRequests).toBe(3);
      expect(stats.estimatedCost).toBeCloseTo(0.12);
      tracker.dispose();
    });

    it('tracks multiple models in delta', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 2,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: { 'gpt-4o': 2 }, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();

      // New model appears
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 2000,
          content: '{}',
          parseResult: {
            tokens: 300,
            interactions: 5,
            modelUsage: {
              'gpt-4o': { inputTokens: 100, outputTokens: 60 },
              'claude-sonnet-4': { inputTokens: 80, outputTokens: 60 },
            },
            modelInteractions: { 'gpt-4o': 3, 'claude-sonnet-4': 2 }, thinkingTokens: 0,
          },
        },
      ]);

      tracker.update();
      const stats = tracker.getStats();

      expect(stats.models['gpt-4o']).toEqual({
        inputTokens: 40,
        outputTokens: 20,
        premiumRequests: 1,
      });
      expect(stats.models['claude-sonnet-4']).toEqual({
        inputTokens: 80,
        outputTokens: 60,
        premiumRequests: 2,
      });
      expect(stats.premiumRequests).toBe(3);
      tracker.dispose();
    });

    it('does not fire event if stats unchanged', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      const listener = jest.fn();
      tracker.onStatsChanged(listener);
      tracker.initialize();

      // Same mtime - no change
      tracker.update();
      expect(listener).not.toHaveBeenCalled();
      tracker.dispose();
    });
  });

  describe('mtime-based cache', () => {
    it('skips re-parsing unchanged files', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();

      // parseSessionFileContent called once for initial scan
      expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);

      // Update with same mtime - should not re-parse
      tracker.update();
      expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);

      tracker.dispose();
    });

    it('evicts cache entries for deleted files', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
        {
          path: '/sessions/b.json',
          mtime: 2000,
          content: '{}',
          parseResult: {
            tokens: 50,
            interactions: 2,
            modelUsage: { 'gpt-4o': { inputTokens: 30, outputTokens: 20 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();
      expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(2);

      // File b.json deleted, only a.json remains
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      tracker.update();
      // a.json uses cache (same mtime), b.json evicted — no re-parse needed
      expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(2);

      tracker.dispose();
    });

    it('re-parses file when mtime changes', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();
      expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);

      // Change mtime
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 2000,
          content: '{}',
          parseResult: {
            tokens: 200,
            interactions: 8,
            modelUsage: { 'gpt-4o': { inputTokens: 120, outputTokens: 80 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      tracker.update();
      expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(2);

      tracker.dispose();
    });
  });

  describe('event emission', () => {
    it('fires listener when stats change', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: { 'gpt-4o': 5 }, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      const listener = jest.fn();
      tracker.onStatsChanged(listener);
      tracker.initialize();

      // Update with changed data
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 2000,
          content: '{}',
          parseResult: {
            tokens: 200,
            interactions: 8,
            modelUsage: { 'gpt-4o': { inputTokens: 120, outputTokens: 80 } },
            modelInteractions: { 'gpt-4o': 8 }, thinkingTokens: 0,
          },
        },
      ]);

      tracker.update();
      expect(listener).toHaveBeenCalledTimes(1);
      const emittedStats: TrackingStats = listener.mock.calls[0][0];
      expect(emittedStats.totalTokens).toBe(100);
      expect(emittedStats.interactions).toBe(3);
      expect(emittedStats.premiumRequests).toBe(3);

      tracker.dispose();
    });

    it('supports multiple listeners', () => {
      setupEmptyDiscovery();

      const tracker = new Tracker();
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      tracker.onStatsChanged(listener1);
      tracker.onStatsChanged(listener2);
      tracker.initialize();

      // Trigger a change via reset (which always fires)
      tracker.reset();
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);

      tracker.dispose();
    });

    it('removes listener on dispose', () => {
      setupEmptyDiscovery();

      const tracker = new Tracker();
      const listener = jest.fn();
      const sub = tracker.onStatsChanged(listener);
      tracker.initialize();

      sub.dispose();
      tracker.reset();
      expect(listener).not.toHaveBeenCalled();

      tracker.dispose();
    });
  });

  describe('start/stop (periodic scanning)', () => {
    it('calls update on interval', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.start(60_000);

      // parseSessionFileContent called once at start
      expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);

      // Advance timer by 60s
      jest.advanceTimersByTime(60_000);
      // Called again (but mtime same so uses cache)
      expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledTimes(2);

      tracker.stop();

      // No more calls after stop
      jest.advanceTimersByTime(60_000);
      expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledTimes(2);

      tracker.dispose();
    });
  });

  describe('reset', () => {
    it('resets baseline and fires event', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();

      // Simulate usage growth
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 2000,
          content: '{}',
          parseResult: {
            tokens: 300,
            interactions: 10,
            modelUsage: { 'gpt-4o': { inputTokens: 180, outputTokens: 120 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      tracker.update();
      expect(tracker.getStats().totalTokens).toBe(200);

      // Reset: new baseline = current state, delta = 0
      const listener = jest.fn();
      tracker.onStatsChanged(listener);
      tracker.reset();

      expect(listener).toHaveBeenCalledTimes(1);
      const resetStats: TrackingStats = listener.mock.calls[0][0];
      expect(resetStats.totalTokens).toBe(0);
      expect(resetStats.interactions).toBe(0);

      tracker.dispose();
    });
  });

  describe('error handling', () => {
    it('skips files that fail stat', () => {
      mockDiscovery.discoverSessionFiles.mockReturnValue([
        '/sessions/a.json',
        '/sessions/bad.json',
      ]);

      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        if (p.toString() === '/sessions/bad.json')
          throw new Error('ENOENT');
        return { mtimeMs: 1000 } as fs.Stats;
      });

      mockFs.readFileSync.mockReturnValue('{}' as any);

      mockParser.parseSessionFileContent.mockReturnValue({
        tokens: 50,
        interactions: 2,
        modelUsage: { 'gpt-4o': { inputTokens: 30, outputTokens: 20 } },
        modelInteractions: {}, thinkingTokens: 0,
      });

      const tracker = new Tracker();
      tracker.initialize();
      // Should not throw, and should process the good file
      expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);
      tracker.dispose();
    });

    it('skips files that fail to read', () => {
      mockDiscovery.discoverSessionFiles.mockReturnValue([
        '/sessions/a.json',
      ]);

      mockFs.statSync.mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      const tracker = new Tracker();
      tracker.initialize();
      // Should not throw
      expect(tracker.getStats().totalTokens).toBe(0);
      tracker.dispose();
    });
  });

  describe('dispose', () => {
    it('clears timer, listeners, and cache', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 5,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      const listener = jest.fn();
      tracker.onStatsChanged(listener);
      tracker.start(60_000);
      tracker.dispose();

      // Timer should be stopped
      jest.advanceTimersByTime(120_000);
      // Only 1 call from start(), no more after dispose
      expect(mockDiscovery.discoverSessionFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('premium requests', () => {
    it('computes premium requests using model multipliers', () => {
      // gpt-4o multiplier = 1, claude-sonnet-4 multiplier = 1 (default)
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 2,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: { 'gpt-4o': 2 }, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();

      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 2000,
          content: '{}',
          parseResult: {
            tokens: 300,
            interactions: 5,
            modelUsage: {
              'gpt-4o': { inputTokens: 100, outputTokens: 60 },
              'claude-sonnet-4': { inputTokens: 80, outputTokens: 60 },
            },
            modelInteractions: { 'gpt-4o': 3, 'claude-sonnet-4': 2 }, thinkingTokens: 0,
          },
        },
      ]);

      tracker.update();
      const stats = tracker.getStats();

      // 1 delta gpt-4o interaction * 1 + 2 delta claude-sonnet-4 interactions * 1 = 3
      expect(stats.premiumRequests).toBe(3);
      expect(stats.estimatedCost).toBeCloseTo(0.12); // 3 * 0.04
      tracker.dispose();
    });

    it('applies non-default multipliers per model', () => {
      mockEstimator.getPremiumMultiplier.mockImplementation((model: string) => {
        if (model === 'o1-pro') return 25;
        return 1;
      });

      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 0,
            interactions: 0,
            modelUsage: {},
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();

      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 2000,
          content: '{}',
          parseResult: {
            tokens: 500,
            interactions: 3,
            modelUsage: {
              'gpt-4o': { inputTokens: 100, outputTokens: 100 },
              'o1-pro': { inputTokens: 150, outputTokens: 150 },
            },
            modelInteractions: { 'gpt-4o': 2, 'o1-pro': 1 }, thinkingTokens: 0,
          },
        },
      ]);

      tracker.update();
      const stats = tracker.getStats();

      // gpt-4o: 2 interactions * 1 = 2
      // o1-pro: 1 interaction * 25 = 25
      expect(stats.models['gpt-4o'].premiumRequests).toBe(2);
      expect(stats.models['o1-pro'].premiumRequests).toBe(25);
      expect(stats.premiumRequests).toBe(27);
      expect(stats.estimatedCost).toBeCloseTo(1.08); // 27 * 0.04
      tracker.dispose();
    });

    it('returns zero premium requests when no interactions', () => {
      setupEmptyDiscovery();
      const tracker = new Tracker();
      tracker.initialize();
      const stats = tracker.getStats();
      expect(stats.premiumRequests).toBe(0);
      expect(stats.estimatedCost).toBe(0);
      tracker.dispose();
    });

    it('premium requests reset to zero after reset()', () => {
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 0,
            interactions: 0,
            modelUsage: {},
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      const tracker = new Tracker();
      tracker.initialize();

      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 2000,
          content: '{}',
          parseResult: {
            tokens: 200,
            interactions: 4,
            modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 100 } },
            modelInteractions: { 'gpt-4o': 4 }, thinkingTokens: 0,
          },
        },
      ]);

      tracker.update();
      expect(tracker.getStats().premiumRequests).toBe(4);

      tracker.reset();
      expect(tracker.getStats().premiumRequests).toBe(0);
      expect(tracker.getStats().estimatedCost).toBe(0);
      tracker.dispose();
    });

    it('handles modelInteractions from vscdb files', () => {
      setupEmptyDiscovery();
      mockSqliteReader.isSqliteReady.mockReturnValue(true);
      mockDiscovery.discoverVscdbFiles.mockReturnValue(['/ws/state.vscdb']);
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        if (p.toString() === '/ws/state.vscdb') {
          return { mtimeMs: 5000 } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      const sessionData = { requests: [{ message: { text: 'test' }, response: [{ value: 'reply' }] }] };
      mockSqliteReader.readSessionsFromVscdb.mockReturnValue([JSON.stringify([sessionData])]);
      mockParser.parseSessionFileContent.mockReturnValue({
        tokens: 100,
        interactions: 1,
        modelUsage: { 'gpt-4o': { inputTokens: 50, outputTokens: 50 } },
        modelInteractions: { 'gpt-4o': 1 }, thinkingTokens: 0,
      });

      const tracker = new Tracker();
      tracker.initialize();
      expect(tracker.getStats().premiumRequests).toBe(0); // baseline

      // vscdb file updated
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        if (p.toString() === '/ws/state.vscdb') {
          return { mtimeMs: 6000 } as fs.Stats;
        }
        throw new Error('ENOENT');
      });
      mockParser.parseSessionFileContent.mockReturnValue({
        tokens: 250,
        interactions: 3,
        modelUsage: { 'gpt-4o': { inputTokens: 130, outputTokens: 120 } },
        modelInteractions: { 'gpt-4o': 3 }, thinkingTokens: 0,
      });

      tracker.update();
      const stats = tracker.getStats();
      expect(stats.premiumRequests).toBe(2); // 3 - 1 = 2 delta interactions
      expect(stats.estimatedCost).toBeCloseTo(0.08); // 2 * 0.04
      tracker.dispose();
    });
  });

  describe('vscdb integration', () => {
    it('does not discover vscdb files when sqlite is not ready', () => {
      setupEmptyDiscovery();
      mockSqliteReader.isSqliteReady.mockReturnValue(false);

      const tracker = new Tracker();
      tracker.initialize();

      expect(mockDiscovery.discoverVscdbFiles).not.toHaveBeenCalled();
      tracker.dispose();
    });

    it('discovers and processes vscdb files when sqlite is ready', () => {
      setupEmptyDiscovery();
      mockSqliteReader.isSqliteReady.mockReturnValue(true);
      mockDiscovery.discoverVscdbFiles.mockReturnValue(['/ws/state.vscdb']);
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        if (p.toString() === '/ws/state.vscdb') {
          return { mtimeMs: 5000 } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      const sessionData = {
        requests: [
          {
            message: { text: 'hello world' },
            response: [{ value: 'hi there' }],
          },
        ],
      };
      mockSqliteReader.readSessionsFromVscdb.mockReturnValue([
        JSON.stringify([sessionData]),
      ]);

      mockParser.parseSessionFileContent.mockReturnValue({
        tokens: 150,
        interactions: 1,
        modelUsage: { 'gpt-4o': { inputTokens: 80, outputTokens: 70 } },
        modelInteractions: {}, thinkingTokens: 0,
      });

      const tracker = new Tracker();
      tracker.initialize();

      // Baseline set, delta = 0
      expect(tracker.getStats().totalTokens).toBe(0);
      expect(mockSqliteReader.readSessionsFromVscdb).toHaveBeenCalledWith('/ws/state.vscdb');
      expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(1);
      tracker.dispose();
    });

    it('vscdb data contributes to baseline and delta', () => {
      setupEmptyDiscovery();
      mockSqliteReader.isSqliteReady.mockReturnValue(true);
      mockDiscovery.discoverVscdbFiles.mockReturnValue(['/ws/state.vscdb']);
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        if (p.toString() === '/ws/state.vscdb') {
          return { mtimeMs: 5000 } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      const sessionData = { requests: [{ message: { text: 'test' }, response: [{ value: 'reply' }] }] };
      mockSqliteReader.readSessionsFromVscdb.mockReturnValue([JSON.stringify([sessionData])]);
      mockParser.parseSessionFileContent.mockReturnValue({
        tokens: 100,
        interactions: 1,
        modelUsage: { 'gpt-4o': { inputTokens: 50, outputTokens: 50 } },
        modelInteractions: {}, thinkingTokens: 0,
      });

      const tracker = new Tracker();
      tracker.initialize();
      expect(tracker.getStats().totalTokens).toBe(0); // baseline = current

      // Now vscdb file updated with more tokens
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        if (p.toString() === '/ws/state.vscdb') {
          return { mtimeMs: 6000 } as fs.Stats;
        }
        throw new Error('ENOENT');
      });
      mockParser.parseSessionFileContent.mockReturnValue({
        tokens: 250,
        interactions: 3,
        modelUsage: { 'gpt-4o': { inputTokens: 130, outputTokens: 120 } },
        modelInteractions: {}, thinkingTokens: 0,
      });

      tracker.update();
      const stats = tracker.getStats();
      expect(stats.totalTokens).toBe(150); // 250 - 100
      expect(stats.interactions).toBe(2); // 3 - 1
      expect(stats.models['gpt-4o']).toEqual({
        inputTokens: 80,  // 130 - 50
        outputTokens: 70, // 120 - 50
        premiumRequests: 0,
      });
      tracker.dispose();
    });

    it('uses mtime caching for vscdb files', () => {
      setupEmptyDiscovery();
      mockSqliteReader.isSqliteReady.mockReturnValue(true);
      mockDiscovery.discoverVscdbFiles.mockReturnValue(['/ws/state.vscdb']);
      mockFs.statSync.mockReturnValue({ mtimeMs: 5000 } as fs.Stats);

      const sessionData = { requests: [{ message: { text: 'x' }, response: [{ value: 'y' }] }] };
      mockSqliteReader.readSessionsFromVscdb.mockReturnValue([JSON.stringify([sessionData])]);
      mockParser.parseSessionFileContent.mockReturnValue({
        tokens: 100,
        interactions: 1,
        modelUsage: { 'gpt-4o': { inputTokens: 50, outputTokens: 50 } },
        modelInteractions: {}, thinkingTokens: 0,
      });

      const tracker = new Tracker();
      tracker.initialize();

      expect(mockSqliteReader.readSessionsFromVscdb).toHaveBeenCalledTimes(1);

      // Same mtime - should use cache, not re-read
      tracker.update();
      expect(mockSqliteReader.readSessionsFromVscdb).toHaveBeenCalledTimes(1);

      tracker.dispose();
    });

    it('continues when readSessionsFromVscdb returns empty array', () => {
      setupEmptyDiscovery();
      mockSqliteReader.isSqliteReady.mockReturnValue(true);
      mockDiscovery.discoverVscdbFiles.mockReturnValue(['/ws/state.vscdb']);
      mockFs.statSync.mockReturnValue({ mtimeMs: 5000 } as fs.Stats);
      mockSqliteReader.readSessionsFromVscdb.mockReturnValue([]);

      const tracker = new Tracker();
      // Should not throw
      tracker.initialize();
      expect(tracker.getStats().totalTokens).toBe(0);
      tracker.dispose();
    });

    it('handles vscdb stat failure gracefully', () => {
      setupEmptyDiscovery();
      mockSqliteReader.isSqliteReady.mockReturnValue(true);
      mockDiscovery.discoverVscdbFiles.mockReturnValue(['/ws/bad.vscdb']);
      mockFs.statSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const tracker = new Tracker();
      // Should not throw
      tracker.initialize();
      expect(tracker.getStats().totalTokens).toBe(0);
      expect(mockSqliteReader.readSessionsFromVscdb).not.toHaveBeenCalled();
      tracker.dispose();
    });

    it('handles invalid JSON from vscdb gracefully', () => {
      setupEmptyDiscovery();
      mockSqliteReader.isSqliteReady.mockReturnValue(true);
      mockDiscovery.discoverVscdbFiles.mockReturnValue(['/ws/state.vscdb']);
      mockFs.statSync.mockReturnValue({ mtimeMs: 5000 } as fs.Stats);
      mockSqliteReader.readSessionsFromVscdb.mockReturnValue(['not valid json']);

      const tracker = new Tracker();
      // Should not throw
      tracker.initialize();
      expect(tracker.getStats().totalTokens).toBe(0);
      tracker.dispose();
    });

    it('processes both JSON files and vscdb files together', () => {
      // Setup JSON file
      setupFiles([
        {
          path: '/sessions/a.json',
          mtime: 1000,
          content: '{}',
          parseResult: {
            tokens: 100,
            interactions: 2,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } },
            modelInteractions: {}, thinkingTokens: 0,
          },
        },
      ]);

      // Also setup vscdb
      mockSqliteReader.isSqliteReady.mockReturnValue(true);
      mockDiscovery.discoverVscdbFiles.mockReturnValue(['/ws/state.vscdb']);

      // Extend statSync to handle both files
      const origStatSync = mockFs.statSync.getMockImplementation();
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        if (p.toString() === '/ws/state.vscdb') {
          return { mtimeMs: 5000 } as fs.Stats;
        }
        return origStatSync!(p);
      });

      const sessionData = { requests: [{ message: { text: 'test' }, response: [{ value: 'reply' }] }] };
      mockSqliteReader.readSessionsFromVscdb.mockReturnValue([JSON.stringify([sessionData])]);

      // parseSessionFileContent will be called for both JSON file and vscdb session
      mockParser.parseSessionFileContent.mockImplementation((filePath: string) => {
        if (filePath === '/sessions/a.json') {
          return {
            tokens: 100,
            interactions: 2,
            modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40 } } as sessionParser.ModelUsage,
            modelInteractions: {}, thinkingTokens: 0,
          };
        }
        // vscdb session
        return {
          tokens: 200,
          interactions: 3,
          modelUsage: { 'claude-sonnet-4': { inputTokens: 120, outputTokens: 80 } } as sessionParser.ModelUsage,
          modelInteractions: {}, thinkingTokens: 0,
        };
      });

      const tracker = new Tracker();
      tracker.initialize();

      // Baseline = 300 tokens total (100 + 200), delta = 0
      expect(tracker.getStats().totalTokens).toBe(0);
      expect(mockParser.parseSessionFileContent).toHaveBeenCalledTimes(2);
      tracker.dispose();
    });
  });
});
