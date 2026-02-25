import { writeTrackingFile } from './trackingFile';
import { TrackingStats } from './tracker';
import * as vscode from 'vscode';
import * as gitDir from './gitDir';
import * as fsUtils from './fsUtils';

jest.mock('./gitDir');
jest.mock('./fsUtils');

const mockVscode = vscode as any;
const mockResolveGitDir = gitDir.resolveGitDir as jest.MockedFunction<typeof gitDir.resolveGitDir>;
const mockWriteTextFile = fsUtils.writeTextFile as jest.MockedFunction<typeof fsUtils.writeTextFile>;

function setupWorkspace(rootPath: string, gitDirPath?: string) {
  const rootUri = vscode.Uri.file(rootPath);
  mockVscode.workspace.workspaceFolders = [
    { uri: rootUri, name: 'test', index: 0 },
  ];
  mockResolveGitDir.mockResolvedValue(vscode.Uri.file(gitDirPath ?? rootPath + '/.git'));
}

function clearWorkspace() {
  mockVscode.workspace.workspaceFolders = undefined;
  mockResolveGitDir.mockResolvedValue(null);
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
  mockWriteTextFile.mockResolvedValue(undefined);
});

describe('trackingFile', () => {
  describe('writeTrackingFile', () => {
    it('writes stats in key=value format', async () => {
      setupWorkspace('/project');

      const result = await writeTrackingFile(sampleStats);

      expect(result).toBe(true);
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
      const [uri, content] = mockWriteTextFile.mock.calls[0];
      expect(uri.path).toMatch(/\.git\/copilot-budget$/);

      expect(content).toContain('TOTAL_TOKENS=3100');
      expect(content).toContain('INTERACTIONS=15');
      expect(content).toContain('PREMIUM_REQUESTS=15.00');
      expect(content).toContain('ESTIMATED_COST=0.60');
      expect(content).toContain('SINCE=2024-01-15T10:30:00Z');
      expect(content).toContain('MODEL gpt-4o 1500 800 10.00');
      expect(content).toContain('MODEL claude-sonnet-4 500 300 5.00');
    });

    it('returns false when no workspace folder', async () => {
      clearWorkspace();
      expect(await writeTrackingFile(sampleStats)).toBe(false);
      expect(mockWriteTextFile).not.toHaveBeenCalled();
    });

    it('returns false when resolveGitDir returns null', async () => {
      mockVscode.workspace.workspaceFolders = [
        { uri: vscode.Uri.file('/project'), name: 'test', index: 0 },
      ];
      mockResolveGitDir.mockResolvedValue(null);

      expect(await writeTrackingFile(sampleStats)).toBe(false);
    });

    it('writes to worktree git dir when .git is a file', async () => {
      setupWorkspace('/worktrees/feature', '/repo/.git/worktrees/feature');

      const result = await writeTrackingFile(sampleStats);

      expect(result).toBe(true);
      const [uri, content] = mockWriteTextFile.mock.calls[0];
      expect(uri.path).toMatch(/\/repo\/\.git\/worktrees\/feature\/copilot-budget$/);
      expect(content).toContain('PREMIUM_REQUESTS=15.00');
    });

    it('returns false when write fails', async () => {
      setupWorkspace('/project');
      mockWriteTextFile.mockRejectedValue(new Error('EACCES'));

      expect(await writeTrackingFile(sampleStats)).toBe(false);
    });

    it('sanitizes model names with unsafe characters', async () => {
      setupWorkspace('/project');

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

      await writeTrackingFile(unsafeStats);
      const content = mockWriteTextFile.mock.calls[0][1];
      expect(content).toContain('MODEL model_with_spaces 100 50 1.00');
      expect(content).toContain('MODEL model__cmd_ 200 100 1.00');
      expect(content).toContain('MODEL model_id_ 300 150 1.00');
      expect(content).not.toMatch(/\$\(cmd\)/);
      expect(content).not.toMatch(/`id`/);
    });

    it('handles stats with no models', async () => {
      setupWorkspace('/project');

      const emptyStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T10:30:00Z',
        models: {},
        totalTokens: 0,
        interactions: 0,
        premiumRequests: 0,
        estimatedCost: 0,
      };

      await writeTrackingFile(emptyStats);
      const content = mockWriteTextFile.mock.calls[0][1];
      expect(content).toContain('TOTAL_TOKENS=0');
      expect(content).toContain('INTERACTIONS=0');
      expect(content).toContain('PREMIUM_REQUESTS=0.00');
      expect(content).toContain('ESTIMATED_COST=0.00');
      expect(content).not.toContain('MODEL ');
    });
  });
});
