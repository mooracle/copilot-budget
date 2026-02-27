import { writeTrackingFile, parseTrackingFileContent, readTrackingFile } from './trackingFile';
import { TrackingStats } from './tracker';
import * as vscode from 'vscode';
import * as gitDir from './gitDir';
import * as fsUtils from './fsUtils';
import * as config from './config';

jest.mock('./gitDir');
jest.mock('./fsUtils');
jest.mock('./config');

const mockVscode = vscode as any;
const mockResolveGitDir = gitDir.resolveGitDir as jest.MockedFunction<typeof gitDir.resolveGitDir>;
const mockWriteTextFile = fsUtils.writeTextFile as jest.MockedFunction<typeof fsUtils.writeTextFile>;
const mockReadTextFile = fsUtils.readTextFile as jest.MockedFunction<typeof fsUtils.readTextFile>;
const mockGetTrailerConfig = config.getTrailerConfig as jest.MockedFunction<typeof config.getTrailerConfig>;

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
  mockGetTrailerConfig.mockReturnValue({
    premiumRequests: 'Copilot-Premium-Requests',
    estimatedCost: 'Copilot-Est-Cost',
    model: false,
  });
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

      expect(content).toContain('INTERACTIONS=15');
      expect(content).toContain('PREMIUM_REQUESTS=15.00');
      expect(content).toContain('SINCE=2024-01-15T10:30:00Z');
      expect(content).not.toContain('TOTAL_TOKENS');
      expect(content).not.toContain('ESTIMATED_COST');
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

    it('writes TR_ lines with configured trailer names', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        premiumRequests: 'Copilot-Premium-Requests',
        estimatedCost: 'Copilot-Est-Cost',
        model: 'Copilot-Model',
      });

      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).toContain('TR_Copilot-Premium-Requests=15.00');
      expect(content).toContain('TR_Copilot-Est-Cost=$0.60');
      expect(content).toContain('TR_Copilot-Model=gpt-4o 1500/800/10.00');
      expect(content).toContain('TR_Copilot-Model=claude-sonnet-4 500/300/5.00');
    });

    it('omits TR_ lines when trailer set to false', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        premiumRequests: false,
        estimatedCost: false,
        model: false,
      });

      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).not.toContain('TR_');
    });

    it('writes TR_ lines with custom trailer names', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        premiumRequests: 'AI-Requests',
        estimatedCost: 'AI-Cost',
        model: false,
      });

      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).toContain('TR_AI-Requests=15.00');
      expect(content).toContain('TR_AI-Cost=$0.60');
      expect(content).not.toContain('TR_AI-Model');
      expect(content).not.toContain('TR_Copilot-');
    });

    it('sanitizes model names in TR_ lines', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        premiumRequests: 'Copilot-Premium-Requests',
        estimatedCost: 'Copilot-Est-Cost',
        model: 'Copilot-Model',
      });

      const unsafeStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T12:00:00Z',
        models: {
          'model$(cmd)': { inputTokens: 200, outputTokens: 100, premiumRequests: 1 },
        },
        totalTokens: 300,
        interactions: 1,
        premiumRequests: 1,
        estimatedCost: 0.04,
      };

      await writeTrackingFile(unsafeStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).toContain('TR_Copilot-Model=model__cmd_ 200/100/1.00');
      expect(content).not.toMatch(/\$\(cmd\)/);
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
      expect(content).toContain('INTERACTIONS=0');
      expect(content).toContain('PREMIUM_REQUESTS=0.00');
      expect(content).not.toContain('MODEL ');
    });
  });

  describe('parseTrackingFileContent', () => {
    it('parses a valid tracking file', () => {
      const content = [
        'TOTAL_TOKENS=3100',
        'INTERACTIONS=15',
        'PREMIUM_REQUESTS=15.00',
        'ESTIMATED_COST=0.60',
        'SINCE=2024-01-15T10:30:00Z',
        'MODEL gpt-4o 1500 800 10.00',
        'MODEL claude-sonnet-4 500 300 5.00',
        '',
      ].join('\n');

      const result = parseTrackingFileContent(content);

      expect(result).not.toBeNull();
      expect(result!.since).toBe('2024-01-15T10:30:00Z');
      expect(result!.interactions).toBe(15);
      expect(result!.models['gpt-4o']).toEqual({ inputTokens: 1500, outputTokens: 800, premiumRequests: 10 });
      expect(result!.models['claude-sonnet-4']).toEqual({ inputTokens: 500, outputTokens: 300, premiumRequests: 5 });
    });

    it('returns null for empty content', () => {
      expect(parseTrackingFileContent('')).toBeNull();
      expect(parseTrackingFileContent('   ')).toBeNull();
      expect(parseTrackingFileContent('\n\n')).toBeNull();
    });

    it('returns null when SINCE is missing', () => {
      const content = [
        'TOTAL_TOKENS=100',
        'INTERACTIONS=1',
        'MODEL gpt-4o 50 50 1.00',
      ].join('\n');

      expect(parseTrackingFileContent(content)).toBeNull();
    });

    it('handles file with no MODEL lines', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=0',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(result!.since).toBe('2024-01-15T10:30:00Z');
      expect(result!.interactions).toBe(0);
      expect(result!.models).toEqual({});
    });

    it('skips MODEL lines with invalid numbers', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=5',
        'MODEL good-model 100 200 3.00',
        'MODEL bad-model abc def ghi',
        'MODEL short-model 100',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(Object.keys(result!.models)).toEqual(['good-model']);
    });

    it('returns null when SINCE is not a valid date', () => {
      const content = [
        'SINCE=not-a-date',
        'INTERACTIONS=5',
        'MODEL gpt-4o 100 200 3.00',
      ].join('\n');

      expect(parseTrackingFileContent(content)).toBeNull();
    });

    it('ignores TR_ lines (used by commit hook)', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=5',
        'MODEL gpt-4o 100 200 3.00',
        'TR_Copilot-Premium-Requests=3.00',
        'TR_Copilot-Est-Cost=$0.12',
        '',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(result!.since).toBe('2024-01-15T10:30:00Z');
      expect(result!.interactions).toBe(5);
      expect(result!.models['gpt-4o']).toEqual({ inputTokens: 100, outputTokens: 200, premiumRequests: 3 });
    });

    it('roundtrips with writeTrackingFile output', async () => {
      setupWorkspace('/project');
      await writeTrackingFile(sampleStats);
      const written = mockWriteTextFile.mock.calls[0][1];

      const result = parseTrackingFileContent(written);
      expect(result).not.toBeNull();
      expect(result!.since).toBe(sampleStats.since);
      expect(result!.interactions).toBe(sampleStats.interactions);
      expect(result!.models['gpt-4o']).toEqual(sampleStats.models['gpt-4o']);
      expect(result!.models['claude-sonnet-4']).toEqual(sampleStats.models['claude-sonnet-4']);
    });
  });

  describe('readTrackingFile', () => {
    it('reads and parses the tracking file', async () => {
      setupWorkspace('/project');
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=5',
        'MODEL gpt-4o 100 200 3.00',
        '',
      ].join('\n');
      mockReadTextFile.mockResolvedValue(content);

      const result = await readTrackingFile();

      expect(result).not.toBeNull();
      expect(result!.since).toBe('2024-01-15T10:30:00Z');
      expect(result!.interactions).toBe(5);
      expect(result!.models['gpt-4o']).toEqual({ inputTokens: 100, outputTokens: 200, premiumRequests: 3 });
    });

    it('returns null when no workspace folder', async () => {
      clearWorkspace();
      expect(await readTrackingFile()).toBeNull();
    });

    it('returns null when readTextFile returns null', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(null);

      expect(await readTrackingFile()).toBeNull();
    });

    it('returns null for empty file (truncated by commit hook)', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue('');

      expect(await readTrackingFile()).toBeNull();
    });

    it('returns null for corrupt file missing SINCE', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue('INTERACTIONS=5\nMODEL gpt-4o 100 200 3.00\n');

      expect(await readTrackingFile()).toBeNull();
    });
  });
});
