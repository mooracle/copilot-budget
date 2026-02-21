import { writeTrackingFile, readTrackingFile, resetTrackingFile } from './trackingFile';
import { TrackingStats } from './tracker';
import * as fs from 'fs';
import * as vscode from 'vscode';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockVscode = vscode as any;

function setupWorkspace(rootPath: string) {
  mockVscode.workspace.workspaceFolders = [
    { uri: { fsPath: rootPath }, name: 'test', index: 0 },
  ];
  mockFs.statSync.mockReturnValue({ isDirectory: () => true } as any);
}

function clearWorkspace() {
  mockVscode.workspace.workspaceFolders = undefined;
}

const sampleStats: TrackingStats = {
  since: '2024-01-15T10:30:00Z',
  lastUpdated: '2024-01-15T12:00:00Z',
  models: {
    'gpt-4o': { inputTokens: 1500, outputTokens: 800 },
    'claude-sonnet-4': { inputTokens: 500, outputTokens: 300 },
  },
  totalTokens: 3100,
  interactions: 15,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('trackingFile', () => {
  describe('writeTrackingFile', () => {
    it('writes stats in key=value format', () => {
      setupWorkspace('/project');
      let writtenContent = '';
      mockFs.writeFileSync.mockImplementation((_p: any, data: any) => {
        writtenContent = data;
      });

      const result = writeTrackingFile(sampleStats);

      expect(result).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
      const callArgs = mockFs.writeFileSync.mock.calls[0];
      expect(callArgs[0]).toMatch(/\.git[/\\]tokentrack$/);

      expect(writtenContent).toContain('TOTAL_TOKENS=3100');
      expect(writtenContent).toContain('INTERACTIONS=15');
      expect(writtenContent).toContain('SINCE=2024-01-15T10:30:00Z');
      expect(writtenContent).toContain('MODEL gpt-4o 1500 800');
      expect(writtenContent).toContain('MODEL claude-sonnet-4 500 300');
    });

    it('returns false when no workspace folder', () => {
      clearWorkspace();
      expect(writeTrackingFile(sampleStats)).toBe(false);
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('returns false when .git is not a directory', () => {
      mockVscode.workspace.workspaceFolders = [
        { uri: { fsPath: '/project' }, name: 'test', index: 0 },
      ];
      mockFs.statSync.mockReturnValue({ isDirectory: () => false } as any);

      expect(writeTrackingFile(sampleStats)).toBe(false);
    });

    it('returns false when .git does not exist', () => {
      mockVscode.workspace.workspaceFolders = [
        { uri: { fsPath: '/project' }, name: 'test', index: 0 },
      ];
      mockFs.statSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(writeTrackingFile(sampleStats)).toBe(false);
    });

    it('returns false when write fails', () => {
      setupWorkspace('/project');
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      expect(writeTrackingFile(sampleStats)).toBe(false);
    });

    it('handles stats with no models', () => {
      setupWorkspace('/project');
      let writtenContent = '';
      mockFs.writeFileSync.mockImplementation((_p: any, data: any) => {
        writtenContent = data;
      });

      const emptyStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T10:30:00Z',
        models: {},
        totalTokens: 0,
        interactions: 0,
      };

      writeTrackingFile(emptyStats);
      expect(writtenContent).toContain('TOTAL_TOKENS=0');
      expect(writtenContent).toContain('INTERACTIONS=0');
      expect(writtenContent).not.toContain('MODEL ');
    });
  });

  describe('readTrackingFile', () => {
    it('reads and parses the tracking file', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockReturnValue(
        'TOTAL_TOKENS=3100\nINTERACTIONS=15\nSINCE=2024-01-15T10:30:00Z\nMODEL gpt-4o 1500 800\nMODEL claude-sonnet-4 500 300\n',
      );

      const stats = readTrackingFile();
      expect(stats).not.toBeNull();
      expect(stats!.totalTokens).toBe(3100);
      expect(stats!.interactions).toBe(15);
      expect(stats!.since).toBe('2024-01-15T10:30:00Z');
      expect(stats!.models['gpt-4o']).toEqual({ inputTokens: 1500, outputTokens: 800 });
      expect(stats!.models['claude-sonnet-4']).toEqual({ inputTokens: 500, outputTokens: 300 });
    });

    it('returns null when no workspace folder', () => {
      clearWorkspace();
      expect(readTrackingFile()).toBeNull();
    });

    it('returns null when file does not exist', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(readTrackingFile()).toBeNull();
    });

    it('returns null when file is empty', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockReturnValue('');

      expect(readTrackingFile()).toBeNull();
    });

    it('handles malformed lines gracefully', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockReturnValue(
        'TOTAL_TOKENS=abc\nINTERACTIONS=15\nSINCE=2024-01-15T10:30:00Z\nMODEL incomplete\nRANDOM_LINE=123\n',
      );

      const stats = readTrackingFile();
      expect(stats).not.toBeNull();
      expect(stats!.totalTokens).toBe(0); // NaN falls back to 0
      expect(stats!.interactions).toBe(15);
      expect(Object.keys(stats!.models)).toHaveLength(0); // incomplete MODEL line skipped
    });
  });

  describe('resetTrackingFile', () => {
    it('truncates the tracking file', () => {
      setupWorkspace('/project');
      mockFs.writeFileSync.mockImplementation(() => {});

      const result = resetTrackingFile();
      expect(result).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.git[/\\]tokentrack$/),
        '',
        'utf-8',
      );
    });

    it('returns false when no workspace folder', () => {
      clearWorkspace();
      expect(resetTrackingFile()).toBe(false);
    });

    it('returns false when write fails', () => {
      setupWorkspace('/project');
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      expect(resetTrackingFile()).toBe(false);
    });
  });

  describe('roundtrip', () => {
    it('write then read produces equivalent stats', () => {
      setupWorkspace('/project');
      let storedContent = '';
      mockFs.writeFileSync.mockImplementation((_p: any, data: any) => {
        storedContent = data;
      });

      writeTrackingFile(sampleStats);

      mockFs.readFileSync.mockReturnValue(storedContent);
      const readBack = readTrackingFile();

      expect(readBack).not.toBeNull();
      expect(readBack!.totalTokens).toBe(sampleStats.totalTokens);
      expect(readBack!.interactions).toBe(sampleStats.interactions);
      expect(readBack!.since).toBe(sampleStats.since);
      expect(readBack!.models['gpt-4o']).toEqual(sampleStats.models['gpt-4o']);
      expect(readBack!.models['claude-sonnet-4']).toEqual(sampleStats.models['claude-sonnet-4']);
    });
  });
});
