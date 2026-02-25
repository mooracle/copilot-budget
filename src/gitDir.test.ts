import { resolveGitDir, resolveGitCommonDir } from './gitDir';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveGitDir', () => {
  it('returns root/.git when .git is a directory', () => {
    mockFs.statSync.mockReturnValue({ isDirectory: () => true } as any);

    expect(resolveGitDir('/project')).toBe(path.join('/project', '.git'));
  });

  it('resolves relative gitdir from .git file', () => {
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as any);
    mockFs.readFileSync.mockReturnValue('gitdir: ../.git/worktrees/my-branch\n');

    const result = resolveGitDir('/repos/my-branch');
    expect(result).toBe(path.resolve('/repos/my-branch', '../.git/worktrees/my-branch'));
  });

  it('returns absolute gitdir path from .git file', () => {
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as any);
    mockFs.readFileSync.mockReturnValue('gitdir: /home/user/repo/.git/worktrees/feature\n');

    expect(resolveGitDir('/some/worktree')).toBe('/home/user/repo/.git/worktrees/feature');
  });

  it('returns null when .git does not exist', () => {
    mockFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(resolveGitDir('/nonexistent')).toBeNull();
  });

  it('returns null when .git file has invalid content', () => {
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as any);
    mockFs.readFileSync.mockReturnValue('not a valid gitdir reference\n');

    expect(resolveGitDir('/project')).toBeNull();
  });

  it('returns null when .git file cannot be read', () => {
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as any);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(resolveGitDir('/project')).toBeNull();
  });
});

describe('resolveGitCommonDir', () => {
  it('returns git dir when no commondir file exists (regular repo)', () => {
    // statSync: .git is a directory
    mockFs.statSync.mockReturnValue({ isDirectory: () => true } as any);
    // readFileSync: commondir file does not exist
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(resolveGitCommonDir('/project')).toBe(path.join('/project', '.git'));
  });

  it('follows commondir file in worktree to reach shared git dir', () => {
    // statSync: .git is a file (not a directory)
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as any);
    // readFileSync called twice: first for .git file, then for commondir
    mockFs.readFileSync
      .mockReturnValueOnce('gitdir: /repo/.git/worktrees/feature\n')
      .mockReturnValueOnce('../..\n');

    const result = resolveGitCommonDir('/worktrees/feature');
    expect(result).toBe(path.resolve('/repo/.git/worktrees/feature', '../..'));
  });

  it('handles absolute commondir path', () => {
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as any);
    mockFs.readFileSync
      .mockReturnValueOnce('gitdir: /repo/.git/worktrees/feature\n')
      .mockReturnValueOnce('/repo/.git\n');

    expect(resolveGitCommonDir('/worktrees/feature')).toBe('/repo/.git');
  });

  it('returns null when resolveGitDir returns null', () => {
    mockFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(resolveGitCommonDir('/nonexistent')).toBeNull();
  });

  it('returns git dir for submodule (no commondir file)', () => {
    mockFs.statSync.mockReturnValue({ isDirectory: () => false } as any);
    mockFs.readFileSync
      .mockReturnValueOnce('gitdir: /repo/.git/modules/my-sub\n')
      .mockImplementationOnce(() => { throw new Error('ENOENT'); });

    expect(resolveGitCommonDir('/repo/my-sub')).toBe('/repo/.git/modules/my-sub');
  });
});
