import { resolveGitDir, resolveGitCommonDir } from './gitDir';
import * as vscode from 'vscode';
import { stat, readTextFile } from './fsUtils';

jest.mock('./fsUtils');

const mockStat = stat as jest.MockedFunction<typeof stat>;
const mockReadTextFile = readTextFile as jest.MockedFunction<typeof readTextFile>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveGitDir', () => {
  it('returns root/.git when .git is a directory', async () => {
    mockStat.mockResolvedValue({ type: vscode.FileType.Directory } as vscode.FileStat);

    const result = await resolveGitDir(vscode.Uri.file('/project'));
    expect(result?.path).toBe('/project/.git');
  });

  it('resolves relative gitdir from .git file', async () => {
    mockStat.mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat);
    mockReadTextFile.mockResolvedValue('gitdir: ../.git/worktrees/my-branch\n');

    const result = await resolveGitDir(vscode.Uri.file('/repos/my-branch'));
    expect(result?.path).toBe('/repos/.git/worktrees/my-branch');
  });

  it('returns absolute gitdir path from .git file', async () => {
    mockStat.mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat);
    mockReadTextFile.mockResolvedValue('gitdir: /home/user/repo/.git/worktrees/feature\n');

    const result = await resolveGitDir(vscode.Uri.file('/some/worktree'));
    expect(result?.path).toBe('/home/user/repo/.git/worktrees/feature');
  });

  it('returns null when .git does not exist', async () => {
    mockStat.mockResolvedValue(null);

    const result = await resolveGitDir(vscode.Uri.file('/nonexistent'));
    expect(result).toBeNull();
  });

  it('returns null when .git file has invalid content', async () => {
    mockStat.mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat);
    mockReadTextFile.mockResolvedValue('not a valid gitdir reference\n');

    const result = await resolveGitDir(vscode.Uri.file('/project'));
    expect(result).toBeNull();
  });

  it('returns null when .git file cannot be read', async () => {
    mockStat.mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat);
    mockReadTextFile.mockResolvedValue(null);

    const result = await resolveGitDir(vscode.Uri.file('/project'));
    expect(result).toBeNull();
  });
});

describe('resolveGitCommonDir', () => {
  it('returns git dir when no commondir file exists (regular repo)', async () => {
    mockStat.mockResolvedValue({ type: vscode.FileType.Directory } as vscode.FileStat);
    mockReadTextFile.mockResolvedValue(null);

    const result = await resolveGitCommonDir(vscode.Uri.file('/project'));
    expect(result?.path).toBe('/project/.git');
  });

  it('follows commondir file in worktree to reach shared git dir', async () => {
    mockStat.mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat);
    mockReadTextFile
      .mockResolvedValueOnce('gitdir: /repo/.git/worktrees/feature\n')
      .mockResolvedValueOnce('../..\n');

    const result = await resolveGitCommonDir(vscode.Uri.file('/worktrees/feature'));
    expect(result?.path).toBe('/repo/.git');
  });

  it('handles absolute commondir path', async () => {
    mockStat.mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat);
    mockReadTextFile
      .mockResolvedValueOnce('gitdir: /repo/.git/worktrees/feature\n')
      .mockResolvedValueOnce('/repo/.git\n');

    const result = await resolveGitCommonDir(vscode.Uri.file('/worktrees/feature'));
    expect(result?.path).toBe('/repo/.git');
  });

  it('returns null when resolveGitDir returns null', async () => {
    mockStat.mockResolvedValue(null);

    const result = await resolveGitCommonDir(vscode.Uri.file('/nonexistent'));
    expect(result).toBeNull();
  });

  it('returns git dir for submodule (no commondir file)', async () => {
    mockStat.mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat);
    mockReadTextFile
      .mockResolvedValueOnce('gitdir: /repo/.git/modules/my-sub\n')
      .mockResolvedValueOnce(null);

    const result = await resolveGitCommonDir(vscode.Uri.file('/repo/my-sub'));
    expect(result?.path).toBe('/repo/.git/modules/my-sub');
  });
});
