import { writeTrackingFile } from './trackingFile';
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
    'gpt-4o': { inputTokens: 1500, outputTokens: 800, premiumRequests: 10 },
    'claude-sonnet-4': { inputTokens: 500, outputTokens: 300, premiumRequests: 5 },
  },
  totalTokens: 3100,
  interactions: 15,
  premiumRequests: 15,
  estimatedCost: 0.60,
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
      expect(callArgs[0]).toMatch(/\.git[/\\]copilot-budget$/);

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

    it('sanitizes model names with unsafe characters', () => {
      setupWorkspace('/project');
      let writtenContent = '';
      mockFs.writeFileSync.mockImplementation((_p: any, data: any) => {
        writtenContent = data;
      });

      const unsafeStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T12:00:00Z',
        models: {
          'model with spaces': { inputTokens: 100, outputTokens: 50, premiumRequests: 1 },
          'model$(cmd)': { inputTokens: 200, outputTokens: 100, premiumRequests: 1 },
          'model`id`': { inputTokens: 300, outputTokens: 150, premiumRequests: 1 },
        },
        totalTokens: 900,
        interactions: 3,
        premiumRequests: 3,
        estimatedCost: 0.12,
      };

      writeTrackingFile(unsafeStats);
      expect(writtenContent).toContain('MODEL model_with_spaces 100 50');
      expect(writtenContent).toContain('MODEL model__cmd_ 200 100');
      expect(writtenContent).toContain('MODEL model_id_ 300 150');
      expect(writtenContent).not.toMatch(/\$\(cmd\)/);
      expect(writtenContent).not.toMatch(/`id`/);
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
        premiumRequests: 0,
        estimatedCost: 0,
      };

      writeTrackingFile(emptyStats);
      expect(writtenContent).toContain('TOTAL_TOKENS=0');
      expect(writtenContent).toContain('INTERACTIONS=0');
      expect(writtenContent).not.toContain('MODEL ');
    });
  });
});
