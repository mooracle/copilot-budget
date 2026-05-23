import {
  writeTrackingFile,
  parseTrackingFileContent,
  readTrackingFile,
  isTrackingFileTruncated,
  formatTrackingFile,
} from './trackingFile';
import { Tracker, TrackingStats } from './tracker';
import * as vscode from 'vscode';
import * as gitDir from './gitDir';
import * as fsUtils from './fsUtils';
import * as config from './config';
import * as tokenRates from './tokenRates';
import type { OTelReader, PerModelAggregate } from './otelReader';

jest.mock('./gitDir');
jest.mock('./fsUtils');
jest.mock('./config');
jest.mock('./tokenRates');
jest.mock('./logger');

const mockVscode = vscode as any;
const mockResolveGitDir = gitDir.resolveGitDir as jest.MockedFunction<typeof gitDir.resolveGitDir>;
const mockWriteTextFile = fsUtils.writeTextFile as jest.MockedFunction<typeof fsUtils.writeTextFile>;
const mockReadTextFile = fsUtils.readTextFile as jest.MockedFunction<typeof fsUtils.readTextFile>;
const mockFsStat = fsUtils.stat as jest.MockedFunction<typeof fsUtils.stat>;
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
      costAic: 7.34,
    },
    'claude-sonnet-4.6': {
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 1200,
      cacheCreationTokens: 100,
      costAic: 34.97,
    },
  },
  totalTokens: 4600,
  interactions: 15,
  totalAiCredits: 42.31,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteTextFile.mockResolvedValue(undefined);
  // Defaults match getTrailerConfig() defaults: estimatedCost is opt-in (off).
  mockGetTrailerConfig.mockReturnValue({
    estimatedCost: false,
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
  describe('formatTrackingFile', () => {
    it('emits TR_Copilot-AI-Credits line when totalAiCredits > 0', () => {
      const content = formatTrackingFile(sampleStats);
      expect(content).toContain('TR_Copilot-AI-Credits=42.31');
      // Format is newline-terminated key=value pairs.
      expect(content.endsWith('\n')).toBe(true);
      expect(content).toContain('SINCE=2024-01-15T10:30:00Z');
      expect(content).not.toContain('MODE=');
    });

    it('omits all TR_ lines when totalAiCredits is zero', () => {
      const zeroStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T10:30:00Z',
        models: {},
        totalTokens: 0,
        interactions: 0,
        totalAiCredits: 0,
      };

      const content = formatTrackingFile(zeroStats);
      expect(content).not.toContain('TR_');
      expect(content).toContain('TOTAL_AI_CREDITS=0.00');
    });

    it('emits aiCreditsPerModel TR_ line when enabled, sorted descending', () => {
      mockGetTrailerConfig.mockReturnValue({
        estimatedCost: false,
        aiCredits: 'Copilot-AI-Credits',
        aiCreditsPerModel: 'Copilot-AI-Credits-Models',
      });

      const content = formatTrackingFile(sampleStats);
      expect(content).toContain(
        'TR_Copilot-AI-Credits-Models=Claude Sonnet 4.6=34.97,GPT-4.1=7.34',
      );
      expect(content).toContain('TR_Copilot-AI-Credits=42.31');
    });
  });

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
      expect(content).toContain('TOTAL_AI_CREDITS=42.31');
      expect(content).not.toContain('MODE=');
      expect(content).not.toContain('TOTAL_COST_USD');

      expect(content).toContain('MODEL_gpt-4.1_INPUT_TOKENS=1500');
      expect(content).toContain('MODEL_gpt-4.1_OUTPUT_TOKENS=800');
      expect(content).toContain('MODEL_gpt-4.1_CACHE_READ_TOKENS=200');
      expect(content).toContain('MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0');
      expect(content).toContain('MODEL_gpt-4.1_COST_AIC=7.34000000');

      expect(content).toContain('MODEL_claude-sonnet-4.6_INPUT_TOKENS=500');
      expect(content).toContain('MODEL_claude-sonnet-4.6_OUTPUT_TOKENS=300');
      expect(content).toContain('MODEL_claude-sonnet-4.6_CACHE_READ_TOKENS=1200');
      expect(content).toContain('MODEL_claude-sonnet-4.6_CACHE_CREATION_TOKENS=100');
      expect(content).toContain('MODEL_claude-sonnet-4.6_COST_AIC=34.97000000');

      expect(content).not.toContain('PREMIUM_REQUESTS');
      expect(content).not.toContain('ESTIMATED_COST');
      expect(content).not.toContain('TOTAL_TOKENS=');
      expect(content).not.toContain('_COST_USD');
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
      expect(content).toContain('TOTAL_AI_CREDITS=42.31');
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
            costAic: 1.0,
          },
          'model$(cmd)': {
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costAic: 2.0,
          },
        },
        totalTokens: 450,
        interactions: 2,
        totalAiCredits: 3.0,
      };

      await writeTrackingFile(unsafeStats);
      const content = mockWriteTextFile.mock.calls[0][1];
      expect(content).toContain('MODEL_model_with_spaces_INPUT_TOKENS=100');
      expect(content).toContain('MODEL_model__cmd__INPUT_TOKENS=200');
      expect(content).not.toMatch(/\$\(cmd\)/);
    });

    it('writes only the aiCredits TR_ trailer under default config (estimatedCost is opt-in)', async () => {
      setupWorkspace('/project');
      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).toContain('TR_Copilot-AI-Credits=42.31');
      expect(content).not.toContain('TR_Copilot-Est-Cost');
      expect(content).not.toContain('TR_Copilot-AI-Credits-Models');
    });

    it('emits Copilot-Est-Cost TR_ line as a bare USD number when estimatedCost is enabled', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        estimatedCost: 'Copilot-Est-Cost',
        aiCredits: 'Copilot-AI-Credits',
        aiCreditsPerModel: false,
      });

      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      const line = content.split('\n').find((l) => l.startsWith('TR_Copilot-Est-Cost='));
      // USD is derived inline as totalAiCredits / 100 at trailer-write time (42.31 → 0.42).
      expect(line).toBe('TR_Copilot-Est-Cost=0.42');
    });

    it('aiCredits TR_ value is a bare 2-decimal number', async () => {
      setupWorkspace('/project');
      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      const line = content.split('\n').find((l) => l.startsWith('TR_Copilot-AI-Credits='));
      expect(line).toBe('TR_Copilot-AI-Credits=42.31');
    });

    it('writes aiCreditsPerModel TR_ line using display names, sorted descending, bare numbers', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        estimatedCost: 'Copilot-Est-Cost',
        aiCredits: 'Copilot-AI-Credits',
        aiCreditsPerModel: 'Copilot-AI-Credits-Models',
      });

      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      // Claude Sonnet 4.6 has 34.97 credits, GPT-4.1 has 7.34. Sorted descending.
      // Bare numeric values, no ~ on either side of =.
      expect(content).toContain(
        'TR_Copilot-AI-Credits-Models=Claude Sonnet 4.6=34.97,GPT-4.1=7.34',
      );
      expect(content).not.toContain('=~');
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

      // All trailer values are bare numbers — no $ on estimated-cost, no ~
      // on AI-Credits — regardless of mode.
      expect(content).toContain('TR_AI-Cost=0.42');
      expect(content).toContain('TR_AI-Credits=42.31');
      expect(content).toMatch(/TR_AI-Credits-Per-Model=/);
      expect(content).not.toContain('Copilot-');
      expect(content).not.toContain('$0.42');
      expect(content).not.toContain('=~');
    });

    it('does not write a MODE= line (field removed in 3.0)', async () => {
      setupWorkspace('/project');
      await writeTrackingFile(sampleStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).not.toContain('MODE=');
      expect(content).not.toMatch(/^MODE=/m);
    });

    it('handles stats with no models', async () => {
      setupWorkspace('/project');

      const emptyStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T10:30:00Z',
        models: {},
        totalTokens: 0,
        interactions: 0,
        totalAiCredits: 0,
      };

      await writeTrackingFile(emptyStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).toContain('SINCE=2024-01-15T10:30:00Z');
      expect(content).toContain('INTERACTIONS=0');
      expect(content).toContain('TOTAL_AI_CREDITS=0.00');
      expect(content).not.toContain('TOTAL_COST_USD');
      expect(content).not.toMatch(/^MODEL_/m);
    });

    it('omits TR_ trailer lines when totalAiCredits is zero', async () => {
      setupWorkspace('/project');
      mockGetTrailerConfig.mockReturnValue({
        estimatedCost: 'Copilot-Est-Cost',
        aiCredits: 'Copilot-AI-Credits',
        aiCreditsPerModel: 'Copilot-AI-Credits-Models',
      });

      const zeroStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T10:30:00Z',
        models: {},
        totalTokens: 0,
        interactions: 0,
        totalAiCredits: 0,
      };

      await writeTrackingFile(zeroStats);
      const content = mockWriteTextFile.mock.calls[0][1];

      expect(content).not.toContain('TR_');
    });
  });

  describe('parseTrackingFileContent', () => {
    it('parses a valid v0.6 tracking file', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=15',
        'TOTAL_AI_CREDITS=42.31',
        'MODEL_gpt-4.1_INPUT_TOKENS=1500',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=800',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=200',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_AIC=7.34',
        'MODEL_claude-sonnet-4.6_INPUT_TOKENS=500',
        'MODEL_claude-sonnet-4.6_OUTPUT_TOKENS=300',
        'MODEL_claude-sonnet-4.6_CACHE_READ_TOKENS=1200',
        'MODEL_claude-sonnet-4.6_CACHE_CREATION_TOKENS=100',
        'MODEL_claude-sonnet-4.6_COST_AIC=34.97',
        '',
      ].join('\n');

      const result = parseTrackingFileContent(content);

      expect(result).not.toBeNull();
      expect(result!.since).toBe('2024-01-15T10:30:00Z');
      expect(result!.interactions).toBe(15);
      expect(result!.models['gpt-4.1']).toMatchObject({
        inputTokens: 1500,
        outputTokens: 800,
        cacheReadTokens: 200,
        cacheCreationTokens: 0,
      });
      expect(result!.models['gpt-4.1'].costAic).toBeCloseTo(7.34, 8);
      expect(result!.models['claude-sonnet-4.6']).toMatchObject({
        inputTokens: 500,
        outputTokens: 300,
        cacheReadTokens: 1200,
        cacheCreationTokens: 100,
      });
      expect(result!.models['claude-sonnet-4.6'].costAic).toBeCloseTo(34.97, 8);
    });

    it('returns null for empty content', () => {
      expect(parseTrackingFileContent('')).toBeNull();
      expect(parseTrackingFileContent('   ')).toBeNull();
      expect(parseTrackingFileContent('\n\n')).toBeNull();
    });

    it('returns null when SINCE is missing', () => {
      const content = [
        'INTERACTIONS=1',
        'TOTAL_AI_CREDITS=10.00',
        'MODEL_gpt-4.1_INPUT_TOKENS=50',
      ].join('\n');

      expect(parseTrackingFileContent(content)).toBeNull();
    });

    it('returns null when SINCE is not a valid date', () => {
      const content = [
        'SINCE=not-a-date',
        'TOTAL_AI_CREDITS=10.00',
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

    it('accepts a file with SINCE + TOTAL_AI_CREDITS and no MODEL_ lines', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=0',
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
        'MODEL_gpt-4.1_COST_AIC=1.00',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(result!.models['gpt-4.1'].costAic).toBe(1);
    });

    it('ignores TR_ lines', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=5',
        'TOTAL_AI_CREDITS=12.00',
        'MODEL_gpt-4.1_INPUT_TOKENS=100',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=200',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=0',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_AIC=12.00',
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
        'TOTAL_AI_CREDITS=10.00',
        'COMPLETELY_UNKNOWN=foo',
        'random text with no equals',
        '=missing-key',
        'MODEL_gpt-4.1_INPUT_TOKENS=100',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=50',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=0',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_AIC=10.00',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(result!.models['gpt-4.1'].inputTokens).toBe(100);
    });

    it('skips MODEL_ lines with non-numeric values', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=1',
        'TOTAL_AI_CREDITS=5.00',
        'MODEL_gpt-4.1_INPUT_TOKENS=100',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=not-a-number',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=0',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_AIC=5.00',
      ].join('\n');

      const result = parseTrackingFileContent(content);
      expect(result).not.toBeNull();
      expect(result!.models['gpt-4.1'].inputTokens).toBe(100);
      expect(result!.models['gpt-4.1'].outputTokens).toBe(0);
      expect(result!.models['gpt-4.1'].costAic).toBe(5);
    });

    it('roundtrips with writeTrackingFile output (models field preserved)', async () => {
      setupWorkspace('/project');
      await writeTrackingFile(sampleStats);
      const written = mockWriteTextFile.mock.calls[0][1];

      const result = parseTrackingFileContent(written);
      expect(result).not.toBeNull();
      expect(result!.since).toBe(sampleStats.since);
      expect(result!.interactions).toBe(sampleStats.interactions);
      const { costAic: gptCost, ...gptRest } = result!.models['gpt-4.1'];
      const { costAic: gptExpectedCost, ...gptExpectedRest } = sampleStats.models['gpt-4.1'];
      expect(gptRest).toEqual(gptExpectedRest);
      expect(gptCost).toBeCloseTo(gptExpectedCost, 8);
      const { costAic: claudeCost, ...claudeRest } = result!.models['claude-sonnet-4.6'];
      const { costAic: claudeExpectedCost, ...claudeExpectedRest } = sampleStats.models['claude-sonnet-4.6'];
      expect(claudeRest).toEqual(claudeExpectedRest);
      expect(claudeCost).toBeCloseTo(claudeExpectedCost, 8);
    });

    it('silently ignores MODE=files line (parser is mode-agnostic at restore time)', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=15',
        'TOTAL_AI_CREDITS=42.31',
        'MODE=files',
        'MODEL_gpt-4.1_INPUT_TOKENS=1500',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=800',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=200',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_AIC=7.34',
        '',
      ].join('\n');

      const result = parseTrackingFileContent(content);

      expect(result).not.toBeNull();
      expect(result!.since).toBe('2024-01-15T10:30:00Z');
      expect(result!.interactions).toBe(15);
      expect(result!.models['gpt-4.1']).toMatchObject({
        inputTokens: 1500,
        outputTokens: 800,
        cacheReadTokens: 200,
        cacheCreationTokens: 0,
      });
    });

    it('silently ignores MODE=telemetry line', () => {
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=15',
        'TOTAL_AI_CREDITS=42.31',
        'MODE=telemetry',
        'MODEL_gpt-4.1_INPUT_TOKENS=1500',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=800',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=200',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_AIC=7.34',
        '',
      ].join('\n');

      const result = parseTrackingFileContent(content);

      expect(result).not.toBeNull();
      expect(result!.since).toBe('2024-01-15T10:30:00Z');
      expect(result!.models['gpt-4.1'].inputTokens).toBe(1500);
    });

    it('tolerates legacy 0.6.x file with TOTAL_COST_USD and per-model _COST_USD keys', () => {
      // Dev-host tracking files written before this commit have legacy USD
      // keys alongside TOTAL_AI_CREDITS + *_TOKENS. The new parser must
      // silently drop the legacy keys without rejecting the file: tokens
      // restore correctly, per-model costAic is 0 (lost), and the file is
      // still recognised as new-format so we don't clobber it as legacy.
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=15',
        'TOTAL_COST_USD=0.1530',
        'TOTAL_AI_CREDITS=15.30',
        'MODEL_gpt-4.1_INPUT_TOKENS=1500',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=800',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=200',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_USD=0.1530',
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
        costAic: 0,
      });
    });

    it('preserves sub-cent per-model costs through a write/parse round-trip', async () => {
      // A handful of input tokens against a $2/M rate produces costs in the
      // 1e-5 range. The legacy 4-decimal rounding zeroed these out; the
      // higher per-model precision keeps them intact so totals don't drift
      // after a restart.
      setupWorkspace('/project');
      const tinyStats: TrackingStats = {
        since: '2024-01-15T10:30:00Z',
        lastUpdated: '2024-01-15T10:30:00Z',
        models: {
          'gpt-4.1': {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costAic: 0.002,
          },
        },
        totalTokens: 15,
        interactions: 1,
        totalAiCredits: 0.002,
      };

      await writeTrackingFile(tinyStats);
      const written = mockWriteTextFile.mock.calls[0][1];
      const result = parseTrackingFileContent(written);

      expect(result).not.toBeNull();
      expect(result!.models['gpt-4.1'].costAic).toBeCloseTo(0.002, 8);
    });
  });

  describe('readTrackingFile', () => {
    it('reads and parses a v0.6 tracking file', async () => {
      setupWorkspace('/project');
      const content = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=5',
        'TOTAL_AI_CREDITS=10.00',
        'MODEL_gpt-4.1_INPUT_TOKENS=100',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=200',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=0',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_AIC=10.00',
        '',
      ].join('\n');
      mockReadTextFile.mockResolvedValue(content);

      const result = await readTrackingFile();

      expect(result.kind).toBe('restored');
      if (result.kind !== 'restored') return;
      expect(result.stats.since).toBe('2024-01-15T10:30:00Z');
      expect(result.stats.interactions).toBe(5);
      expect(result.stats.models['gpt-4.1']).toEqual({
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costAic: 10,
      });
    });

    it('returns absent when no workspace folder', async () => {
      clearWorkspace();
      expect(await readTrackingFile()).toEqual({ kind: 'absent' });
    });

    it('returns absent when readTextFile returns null (file missing or transient I/O)', async () => {
      // readTextFile collapses both ENOENT and transient errors to null;
      // we can't tell them apart, so we treat both as absent and don't
      // overwrite.
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(null);

      expect(await readTrackingFile()).toEqual({ kind: 'absent' });
    });

    it('returns absent for empty file (truncated by commit hook)', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue('');

      expect(await readTrackingFile()).toEqual({ kind: 'absent' });
    });

    it('returns legacy for v0.5.x tracking file (caller should overwrite)', async () => {
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

      expect(await readTrackingFile()).toEqual({ kind: 'legacy' });
    });

    it('returns absent for a partial write of the current schema (no legacy markers)', async () => {
      // Simulates a write that was interrupted after the first couple of
      // lines (power loss, crash, or non-atomic remote FS provider). The
      // file has content but is missing TOTAL_AI_CREDITS and any MODEL_*
      // keys, so parseTrackingFileContent returns null. Without positive
      // legacy markers, the caller must NOT overwrite — that would stomp
      // a folder's accumulated stats on the next activation.
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(
        ['SINCE=2024-01-15T10:30:00Z', 'INTERAC'].join('\n'),
      );

      expect(await readTrackingFile()).toEqual({ kind: 'absent' });
    });

    it('returns absent for arbitrary unrelated content (no legacy markers)', async () => {
      // Defends against a foreign tool writing to <gitdir>/copilot-budget,
      // or filesystem corruption that yields garbage. Treat as absent so
      // we don't overwrite something we don't understand.
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue('hello world\nnot our format\n');

      expect(await readTrackingFile()).toEqual({ kind: 'absent' });
    });
  });

  describe('Tracker integration with legacy-parsed RestoredStats', () => {
    it('recomputes totalAiCredits from fresh tokens, ignoring dropped legacy _COST_USD', async () => {
      // Legacy 0.6.x dev-host file: TOTAL_AI_CREDITS + tokens are preserved,
      // but per-model _COST_USD keys are silently dropped on parse, so
      // restored costAic is 0 per model. After a tracker scan picks up fresh
      // session activity, totalAiCredits should match the freshly computed
      // cost — not 0, not the legacy 15.30, not double-counted.
      const legacyContent = [
        'SINCE=2024-01-15T10:30:00Z',
        'INTERACTIONS=15',
        'TOTAL_COST_USD=0.1530',
        'TOTAL_AI_CREDITS=15.30',
        'MODEL_gpt-4.1_INPUT_TOKENS=1500',
        'MODEL_gpt-4.1_OUTPUT_TOKENS=800',
        'MODEL_gpt-4.1_CACHE_READ_TOKENS=200',
        'MODEL_gpt-4.1_CACHE_CREATION_TOKENS=0',
        'MODEL_gpt-4.1_COST_USD=0.1530',
        '',
      ].join('\n');

      const restored = parseTrackingFileContent(legacyContent);
      expect(restored).not.toBeNull();
      expect(restored!.models['gpt-4.1'].costAic).toBe(0);

      const FRESH_COST_AIC = 42.5;
      (tokenRates.computeCost as jest.Mock).mockReturnValue(FRESH_COST_AIC);
      // initialize() snapshots an empty baseline so subsequent fresh activity
      // shows up as a positive delta on update().
      let aggregateBatch: PerModelAggregate[] = [];
      const reader: OTelReader = {
        isAvailable: () => true,
        aggregateSince: () => aggregateBatch,
        getLatestTimestamp: () => 0,
        close: () => {},
      };

      const tracker = new Tracker(reader, () => ['session-1']);
      tracker.setPreviousStats(restored!);
      await tracker.initialize();

      aggregateBatch = [
        {
          model: 'gpt-4.1',
          chats: 5,
          inputTokens: 2000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ];

      await tracker.update();
      const stats = tracker.getStats();

      expect(stats.totalAiCredits).toBeCloseTo(FRESH_COST_AIC, 6);
      expect(stats.totalAiCredits).not.toBe(0);
      expect(stats.totalAiCredits).not.toBeCloseTo(15.3, 2);
      expect(stats.totalAiCredits).not.toBeCloseTo(FRESH_COST_AIC * 2, 6);
    });
  });

  describe('isTrackingFileTruncated', () => {
    beforeEach(() => {
      mockFsStat.mockReset();
    });

    it('returns true when the file exists with 0 bytes (hook just consumed trailers)', async () => {
      setupWorkspace('/project');
      mockFsStat.mockResolvedValue({ size: 0, type: 1, ctime: 0, mtime: 0 } as any);
      expect(await isTrackingFileTruncated()).toBe(true);
    });

    it('returns false when the file has content', async () => {
      setupWorkspace('/project');
      mockFsStat.mockResolvedValue({ size: 128, type: 1, ctime: 0, mtime: 0 } as any);
      expect(await isTrackingFileTruncated()).toBe(false);
    });

    it('returns false when stat fails (missing or transient I/O — same outcome)', async () => {
      setupWorkspace('/project');
      mockFsStat.mockResolvedValue(null);
      expect(await isTrackingFileTruncated()).toBe(false);
    });

    it('returns false when there is no workspace', async () => {
      clearWorkspace();
      expect(await isTrackingFileTruncated()).toBe(false);
    });
  });
});
