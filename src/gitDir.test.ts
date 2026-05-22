import { resolveGitDir, resolveGitCommonDir, resolveHooksDir } from './gitDir';
import * as vscode from 'vscode';
import { stat, readTextFile } from './fsUtils';
import { execFile } from 'child_process';

jest.mock('./fsUtils');
jest.mock('child_process', () => ({ execFile: jest.fn() }));

const mockStat = stat as jest.MockedFunction<typeof stat>;
const mockReadTextFile = readTextFile as jest.MockedFunction<typeof readTextFile>;
const mockExecFile = execFile as unknown as jest.Mock;

// Stub execFile (callback-style) so each test can declare what git config
// returns. Default: key unset (exit 1).
function mockCoreHooksPath(value: string | null) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
    if (value === null) {
      const err = new Error('exit 1') as NodeJS.ErrnoException;
      err.code = '1' as unknown as string;
      cb(err, '', '');
    } else {
      cb(null, value + '\n', '');
    }
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCoreHooksPath(null);
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

describe('resolveHooksDir', () => {
  it('falls back to <gitCommonDir>/hooks when core.hooksPath is unset', async () => {
    mockCoreHooksPath(null);
    mockStat.mockResolvedValue({ type: vscode.FileType.Directory } as vscode.FileStat);
    mockReadTextFile.mockResolvedValue(null); // no commondir file

    const result = await resolveHooksDir(vscode.Uri.file('/project'));
    expect(result?.path).toBe('/project/.git/hooks');
  });

  it('uses an absolute core.hooksPath verbatim', async () => {
    mockCoreHooksPath('/opt/global-hooks');

    const result = await resolveHooksDir(vscode.Uri.file('/project'));
    expect(result?.path).toBe('/opt/global-hooks');
    // No need to consult the git dir when a custom path is set.
    expect(mockStat).not.toHaveBeenCalled();
  });

  it('resolves a relative core.hooksPath against the worktree root (husky convention)', async () => {
    mockCoreHooksPath('.husky');

    const result = await resolveHooksDir(vscode.Uri.file('/project'));
    expect(result?.path).toBe('/project/.husky');
  });

  it('treats whitespace-only core.hooksPath as unset', async () => {
    mockCoreHooksPath('   ');
    mockStat.mockResolvedValue({ type: vscode.FileType.Directory } as vscode.FileStat);
    mockReadTextFile.mockResolvedValue(null);

    const result = await resolveHooksDir(vscode.Uri.file('/project'));
    expect(result?.path).toBe('/project/.git/hooks');
  });

  it('returns null when git binary is unavailable AND .git is missing', async () => {
    // execFile fails (ENOENT) AND .git doesn't exist — no place to install.
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      cb(err, '', '');
    });
    mockStat.mockResolvedValue(null);

    const result = await resolveHooksDir(vscode.Uri.file('/no-such-dir'));
    expect(result).toBeNull();
  });

  it('falls back to <gitCommonDir>/hooks when git binary is unavailable but .git exists', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      cb(err, '', '');
    });
    mockStat.mockResolvedValue({ type: vscode.FileType.Directory } as vscode.FileStat);
    mockReadTextFile.mockResolvedValue(null);

    const result = await resolveHooksDir(vscode.Uri.file('/project'));
    expect(result?.path).toBe('/project/.git/hooks');
  });
});
