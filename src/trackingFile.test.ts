import { writeTrackingFile, parseTrackingFileContent, readTrackingFile } from './trackingFile';
import { TrackingStats } from './tracker';
import * as vscode from 'vscode';
import * as gitDir from './gitDir';
import * as fsUtils from './fsUtils';
import * as config from './config';
import * as tokenRates from './tokenRates';

jest.mock('./gitDir');
jest.mock('./fsUtils');
jest.mock('./config');
jest.mock('./tokenRates');

const mockVscode = vscode as any;
const mockResolveGitDir = gitDir.resolveGitDir as jest.MockedFunction<typeof gitDir.resolveGitDir>;
const mockWriteTextFile = fsUtils.writeTextFile as jest.MockedFunction<typeof fsUtils.writeTextFile>;
const mockReadTextFile = fsUtils.readTextFile as jest.MockedFunction<typeof fsUtils.readTextFile>;
const mockGetTrailerConfig = config.getTrailerConfig as jest.MockedFunction<typeof config.getTrailerConfig>;
const mockGetDisplayName = tokenRates.getDisplayName as jest.MockedFunction<typeof tokenRates.getDisplayName>;

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
    'gpt-4.1': {
      inputTokens: 1500,
      outputTokens: 800,
      cacheReadTokens: 200,
      cacheCreationTokens: 0,
      costUsd: 0.0734,
    },
    'claude-sonnet-4.6': {
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 1200,
      cacheCreationTokens: 100,
      costUsd: 0.3497,
    },
  },
  totalTokens: 4600,
  interactions: 15,
  totalCostUsd: 0.4231,
  totalAiCredits: 42.31,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteTextFile.mockResolvedValue(undefined);
  mockGetTrailerConfig.mockReturnValue({
    estimatedCost: 'Copilot-Est-Cost',
    aiCredits: 'Copilot-AI-Credits',
    aiCreditsPerModel: false,
  });
  mockGetDisplayName.mockImplementation((id: string) => {
    if (id === 'claude-sonnet-4.6') return 'Claude Sonnet 4.6';
    if (id === 'gpt-4.1') return 'GPT-4.1';
    return id;
  });
});

describe('trackingFile', () => {
  describe('writeTrackingFile', () => {
    it('writes stats in new v0.6 key=value schema', async () => {
      setupWorkspace('/project');

      const result = await writeTrackingFile(sampleStats);

      expect(result).toBe(true);
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
      const [uri, content] = mockWriteTextFile.mock.calls[0];
      expect(uri.path).toMatch(/\.git\/copilot-budget$/);

      expect(content).toContain('SINCE=2024-01-15T10:30:00Z');
      expect(content).toContain('INTERACTIONS=15');
      expect(content).toContain('TOTAL_COST_USD=0.4231');
      expect(content).toContain('TOTAL_AI_CREDITS=42.31');

      expect(content).toContain('MODEL_gpt-4.1_INPUT_TOKENS=1500');
      expect(content).toContain('MODEL_gpt-4.1_OUTPUT_TOKENS=800');
      expect(content).toContain('MODEL_gpt-4.1_CACHE_READ_TOKENS=200');
      expect(content).toContain('MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0');
      expect(content).toContain('MODEL_gpt-4.1_COST_USD=0.0734');

      expect(content).toContain('MODEL_claude-sonnet-4.6_INPUT_TOKENS=500');
      expect(content).toContain('MODEL_claude-sonnet-4.6_OUTPUT_TOKENS=300');
      expect(content).toContain('MODEL_claude-sonnet-4.6_CACHE_READ_TOKENS=1200');
      expect(content).toContain('MODEL_claude-sonnet-4.6_CACHE_CREATION_TOKENS=100');
      expect(content).toContain('MODEL_claude-sonnet-4.6_COST_USD=0.3497');

      expect(content).not.toContain('PREMIUM_REQUESTS');
      expect(content).not.toContain('ESTIMATED_COST');
      expect(content).not.toContain('TOTAL_TOKENS=');
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
      expect(content).toContain('TOTAL_COST_USD=0.4231');
    });

    it('returns false when write fails', async () => {
      setupWorkspace('/project');
      mockWriteTextFile.mockRejectedValue(new Error('EACCES'));

      expect(await writeTrackingFile(sampleStats)).toBe(false);
    });

    it('sanitizes model names with unsafe characters in MODEL_ keys', async () => {
      setupWorkspace('/project');

      const unsafeStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T12:00:00Z',
        models: {
          'model with spaces': {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.01,
          },
          'model$(cmd)': {
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.02,
          },
        },
        totalTokens: 450,
        interactions: 2,
        totalCostUsd: 0.03,
        totalAiCredits: 3.0,
      };

      await writeTrackingFile(unsafeStats);
      const content = mockWriteTextFile.mock.calls[0][1];
      expect(content).toContain('MODEL_model_with_spaces_INPUT_TOKENS=100');
      expect(content).toContain('MODEL_model__cmd__INPUT_TOKENS=200');
      expect(content).not.toMatch(/\$\(cmd\)/);
    });

    it('writes default TR_ trailers (estimatedCost + aiCredits) with correct formatting', async () => {
      setupWorkspace('/project');
      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).toContain('TR_Copilot-Est-Cost=$0.42');
      expect(content).toContain('TR_Copilot-AI-Credits=42.31');
      expect(content).not.toContain('TR_Copilot-AI-Credits-Models');
    });

    it('estimatedCost TR_ value uses $ prefix (byte-identical to v0.5.3)', async () => {
      setupWorkspace('/project');
      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      const line = content.split('\n').find((l) => l.startsWith('TR_Copilot-Est-Cost='));
      expect(line).toBe('TR_Copilot-Est-Cost=$0.42');
    });

    it('aiCredits TR_ value has no $ prefix and 2 decimals', async () => {
      setupWorkspace('/project');
      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      const line = content.split('\n').find((l) => l.startsWith('TR_Copilot-AI-Credits='));
      expect(line).toBe('TR_Copilot-AI-Credits=42.31');
    });

    it('writes aiCreditsPerModel TR_ line using display names, sorted descending', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        estimatedCost: 'Copilot-Est-Cost',
        aiCredits: 'Copilot-AI-Credits',
        aiCreditsPerModel: 'Copilot-AI-Credits-Models',
      });

      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      // Claude Sonnet 4.6 has 0.3497 cost = 34.97 credits, GPT-4.1 has 0.0734 = 7.34 credits.
      // Sorted descending by credits.
      expect(content).toContain(
        'TR_Copilot-AI-Credits-Models=Claude Sonnet 4.6=34.97,GPT-4.1=7.34',
      );
    });

    it('omits aiCreditsPerModel TR_ line when no models tracked', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        estimatedCost: 'Copilot-Est-Cost',
        aiCredits: 'Copilot-AI-Credits',
        aiCreditsPerModel: 'Copilot-AI-Credits-Models',
      });

      const emptyStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T10:30:00Z',
        models: {},
        totalTokens: 0,
        interactions: 0,
        totalCostUsd: 0,
        totalAiCredits: 0,
      };

      await writeTrackingFile(emptyStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).not.toContain('TR_Copilot-AI-Credits-Models');
    });

    it('omits all TR_ lines when every trailer is false', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        estimatedCost: false,
        aiCredits: false,
        aiCreditsPerModel: false,
      });

      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).not.toContain('TR_');
    });

    it('honors custom trailer names', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        estimatedCost: 'AI-Cost',
        aiCredits: 'AI-Credits',
        aiCreditsPerModel: 'AI-Credits-Per-Model',
      });

      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).toContain('TR_AI-Cost=$0.42');
      expect(content).toContain('TR_AI-Credits=42.31');
      expect(content).toMatch(/TR_AI-Credits-Per-Model=/);
      expect(content).not.toContain('Copilot-');
    });

    it('handles stats with no models', async () => {
      setupWorkspace('/project');

      const emptyStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T10:30:00Z',
        models: {},
        totalTokens: 0,
        interactions: 0,
        totalCostUsd: 0,
        totalAiCredits: 0,
      };

      await writeTrackingFile(emptyStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).toContain('SINCE=2024-01-15T10:30:00Z');
      expect(content).toContain('INTERACTIONS=0');
      expect(content).toContain('TOTAL_COST_USD=0.0000');
      expect(content).toContain('TOTAL_AI_CREDITS=0.00');
      expect(content).not.toMatch(/^MODEL_/m);
    });
  });

  describe('parseTrackingFileContent', () => {
    it('parses a valid v0.6 tracking file', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=15',
        'TOTAL_COST_USD=0.4231',
        'TOTAL_AI_CREDITS=42.31',
        'MODEL_gpt-4.1_INPUT_TOKENS=1500',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=800',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=200',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_USD=0.0734',
        'MODEL_claude-sonnet-4.6_INPUT_TOKENS=500',
        'MODEL_claude-sonnet-4.6_OUTPUT_TOKENS=300',
        'MODEL_claude-sonnet-4.6_CACHE_READ_TOKENS=1200',
        'MODEL_claude-sonnet-4.6_CACHE_CREATION_TOKENS=100',
        'MODEL_claude-sonnet-4.6_COST_USD=0.3497',
        '',
      ].join('\n');

      const result = parseTrackingFileContent(content);

      expect(result).not.toBeNull();
      expect(result!.since).toBe('2024-01-15T10:30:00Z');
      expect(result!.interactions).toBe(15);
      expect(result!.models['gpt-4.1']).toEqual({
        inputTokens: 1500,
        outputTokens: 800,
        cacheReadTokens: 200,
        cacheCreationTokens: 0,
        costUsd: 0.0734,
      });
      expect(result!.models['claude-sonnet-4.6']).toEqual({
        inputTokens: 500,
        outputTokens: 300,
        cacheReadTokens: 1200,
        cacheCreationTokens: 100,
        costUsd: 0.3497,
      });
    });

    it('returns null for empty content', () => {
      expect(parseTrackingFileContent('')).toBeNull();
      expect(parseTrackingFileContent('   ')).toBeNull();
      expect(parseTrackingFileContent('\n\n')).toBeNull();
    });

    it('returns null when SINCE is missing', () => {
      const content = [
        'INTERACTIONS=1',
        'TOTAL_COST_USD=0.10',
        'MODEL_gpt-4.1_INPUT_TOKENS=50',
      ].join('\n');

      expect(parseTrackingFileContent(content)).toBeNull();
    });

    it('returns null when SINCE is not a valid date', () => {
      const content = [
        'SINCE=not-a-date',
        'TOTAL_COST_USD=0.10',
        'MODEL_gpt-4.1_INPUT_TOKENS=100',
      ].join('\n');

      expect(parseTrackingFileContent(content)).toBeNull();
    });

    it('returns null when no new-format key is present (legacy v0.5.x file)', () => {
      const legacyContent = [
        'TOTAL_TOKENS=3100',
        'INTERACTIONS=8',
        'PREMIUM_REQUESTS=8.00',
        'ESTIMATED_COST=0.32',
        'SINCE=2024-01-15T10:30:00Z',
        'MODEL claude_sonnet_4_6 1500 800 5.00',
        'MODEL gpt_4o 500 300 3.00',
        'TR_Copilot-Premium-Requests=8.00',
        'TR_Copilot-Est-Cost=$0.32',
        '',
      ].join('\n');

      expect(parseTrackingFileContent(legacyContent)).toBeNull();
    });

    it('returns null with SINCE only and no other new-format keys', () => {
      expect(parseTrackingFileContent('SINCE=2024-01-15T10:30:00Z\n')).toBeNull();
      expect(parseTrackingFileContent('SINCE=2024-01-15T10:30:00Z\nINTERACTIONS=5\n')).toBeNull();
    });

    it('accepts a file with SINCE + TOTAL_COST_USD and no MODEL_ lines', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=0',
        'TOTAL_COST_USD=0.0000',
        'TOTAL_AI_CREDITS=0.00',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(result!.since).toBe('2024-01-15T10:30:00Z');
      expect(result!.interactions).toBe(0);
      expect(result!.models).toEqual({});
    });

    it('accepts a file with SINCE + MODEL_ lines but no TOTAL_ aggregates', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=2',
        'MODEL_gpt-4.1_INPUT_TOKENS=100',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=50',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=0',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_USD=0.01',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(result!.models['gpt-4.1'].costUsd).toBe(0.01);
    });

    it('ignores TR_ lines', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=5',
        'TOTAL_COST_USD=0.12',
        'TOTAL_AI_CREDITS=12.00',
        'MODEL_gpt-4.1_INPUT_TOKENS=100',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=200',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=0',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_USD=0.12',
        'TR_Copilot-Est-Cost=$0.12',
        'TR_Copilot-AI-Credits=12.00',
        '',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(result!.interactions).toBe(5);
      expect(Object.keys(result!.models)).toEqual(['gpt-4.1']);
    });

    it('ignores unknown lines silently', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=3',
        'TOTAL_COST_USD=0.10',
        'TOTAL_AI_CREDITS=10.00',
        'COMPLETELY_UNKNOWN=foo',
        'random text with no equals',
        '=missing-key',
        'MODEL_gpt-4.1_INPUT_TOKENS=100',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=50',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=0',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_USD=0.10',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(result!.models['gpt-4.1'].inputTokens).toBe(100);
    });

    it('skips MODEL_ lines with non-numeric values', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=1',
        'TOTAL_COST_USD=0.05',
        'MODEL_gpt-4.1_INPUT_TOKENS=100',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=not-a-number',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=0',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_USD=0.05',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(result!.models['gpt-4.1'].inputTokens).toBe(100);
      expect(result!.models['gpt-4.1'].outputTokens).toBe(0);
      expect(result!.models['gpt-4.1'].costUsd).toBe(0.05);
    });

    it('roundtrips with writeTrackingFile output (models field preserved)', async () => {
      setupWorkspace('/project');
      await writeTrackingFile(sampleStats);
      const written = mockWriteTextFile.mock.calls[0][1];

      const result = parseTrackingFileContent(written);
      expect(result).not.toBeNull();
      expect(result!.since).toBe(sampleStats.since);
      expect(result!.interactions).toBe(sampleStats.interactions);
      expect(result!.models['gpt-4.1']).toEqual(sampleStats.models['gpt-4.1']);
      expect(result!.models['claude-sonnet-4.6']).toEqual(sampleStats.models['claude-sonnet-4.6']);
    });
  });

  describe('readTrackingFile', () => {
    it('reads and parses a v0.6 tracking file', async () => {
      setupWorkspace('/project');
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=5',
        'TOTAL_COST_USD=0.10',
        'TOTAL_AI_CREDITS=10.00',
        'MODEL_gpt-4.1_INPUT_TOKENS=100',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=200',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=0',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_USD=0.10',
        '',
      ].join('\n');
      mockReadTextFile.mockResolvedValue(content);

      const result = await readTrackingFile();

      expect(result).not.toBeNull();
      expect(result!.since).toBe('2024-01-15T10:30:00Z');
      expect(result!.interactions).toBe(5);
      expect(result!.models['gpt-4.1']).toEqual({
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.10,
      });
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

    it('returns null for legacy v0.5.x tracking file (no new-format key)', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(
        [
          'TOTAL_TOKENS=3100',
          'INTERACTIONS=8',
          'PREMIUM_REQUESTS=8.00',
          'SINCE=2024-01-15T10:30:00Z',
          'MODEL claude_sonnet_4_6 1500 800 5.00',
          '',
        ].join('\n'),
      );

      expect(await readTrackingFile()).toBeNull();
    });
  });
});
