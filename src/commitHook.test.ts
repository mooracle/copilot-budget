import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as gitDir from './gitDir';
import * as fsUtils from './fsUtils';

jest.mock('fs', () => ({ chmodSync: jest.fn() }));
jest.mock('./gitDir');
jest.mock('./fsUtils');

const mockFs = fs as jest.Mocked<typeof fs>;

const mockVscode = vscode as any;
const mockResolveGitCommonDir = gitDir.resolveGitCommonDir as jest.MockedFunction<typeof gitDir.resolveGitCommonDir>;
const mockReadTextFile = fsUtils.readTextFile as jest.MockedFunction<typeof fsUtils.readTextFile>;
const mockWriteTextFile = fsUtils.writeTextFile as jest.MockedFunction<typeof fsUtils.writeTextFile>;

const MARKER = '# Copilot Budget prepare-commit-msg hook';

function setupWorkspace(rootPath: string, gitCommonDirPath?: string) {
  mockVscode.workspace.workspaceFolders = [
    { uri: vscode.Uri.file(rootPath), name: 'test', index: 0 },
  ];
  mockResolveGitCommonDir.mockResolvedValue(
    vscode.Uri.file(gitCommonDirPath ?? rootPath + '/.git'),
  );
}

function clearWorkspace() {
  mockVscode.workspace.workspaceFolders = undefined;
  mockResolveGitCommonDir.mockResolvedValue(null);
}

beforeEach(() => {
  jest.clearAllMocks();
  clearWorkspace();
});

describe('commitHook', () => {
  describe('isHookInstalled', () => {
    it('returns true when hook file contains the marker', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(`#!/bin/sh\n${MARKER}\nsome script`);

      expect(await isHookInstalled()).toBe(true);
    });

    it('returns false when hook file does not contain the marker', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue('#!/bin/sh\n# some other hook\n');

      expect(await isHookInstalled()).toBe(false);
    });

    it('returns false when hook file does not exist', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(null);

      expect(await isHookInstalled()).toBe(false);
    });

    it('returns false when no workspace folder', async () => {
      expect(await isHookInstalled()).toBe(false);
    });

    it('returns false when resolveGitCommonDir returns null', async () => {
      mockVscode.workspace.workspaceFolders = [
        { uri: vscode.Uri.file('/project'), name: 'test', index: 0 },
      ];
      mockResolveGitCommonDir.mockResolvedValue(null);

      expect(await isHookInstalled()).toBe(false);
    });
  });

  describe('installHook', () => {
    it('writes hook script with marker', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(null);
      mockWriteTextFile.mockResolvedValue(undefined);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);

      const result = await installHook();

      expect(result).toBe(true);
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
      const [hookUri, content] = mockWriteTextFile.mock.calls[0];
      expect(hookUri.path).toMatch(/\.git\/hooks\/prepare-commit-msg$/);
      expect(content).toContain(MARKER);
      expect(content).toContain('#!/bin/sh');
      expect(content).toContain('TRACKING_FILE=');
      expect(content).toContain('PREMIUM_REQUESTS=');
      expect(content).toContain("grep '^TR_'");
      expect(content).toContain("sed 's/^TR_");
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Copilot Budget: Commit hook installed.',
      );
    });

    it('creates hooks directory via vscode.workspace.fs.createDirectory', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(null);
      mockWriteTextFile.mockResolvedValue(undefined);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);

      const result = await installHook();

      expect(result).toBe(true);
      expect(mockVscode.workspace.fs.createDirectory).toHaveBeenCalledTimes(1);
      const dirUri = mockVscode.workspace.fs.createDirectory.mock.calls[0][0];
      expect(dirUri.path).toMatch(/\.git\/hooks$/);
    });

    it('refuses to overwrite a non-Copilot Budget hook', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue('#!/bin/sh\n# husky hook\nexit 0\n');

      const result = await installHook();

      expect(result).toBe(false);
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(mockVscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('already exists'),
      );
    });

    it('refreshes an existing Copilot Budget hook silently', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(`#!/bin/sh\n${MARKER}\nold script`);
      mockWriteTextFile.mockResolvedValue(undefined);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);

      const result = await installHook();

      expect(result).toBe(true);
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
      expect(mockVscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('returns false when no workspace folder', async () => {
      const result = await installHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('No workspace folder'),
      );
    });

    it('installs hook in common git dir for worktrees', async () => {
      setupWorkspace('/worktrees/feature', '/repo/.git');
      mockReadTextFile.mockResolvedValue(null);
      mockWriteTextFile.mockResolvedValue(undefined);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);

      const result = await installHook();

      expect(result).toBe(true);
      const [hookUri] = mockWriteTextFile.mock.calls[0];
      expect(hookUri.path).toMatch(/\/repo\/\.git\/hooks\/prepare-commit-msg$/);
    });

    it('returns false when write fails', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(null);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);
      mockWriteTextFile.mockRejectedValue(new Error('EACCES'));

      const result = await installHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to install'),
      );
    });
  });

  describe('uninstallHook', () => {
    it('removes a Copilot Budget hook', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(`#!/bin/sh\n${MARKER}\nscript`);
      mockVscode.workspace.fs.delete.mockResolvedValue(undefined);

      const result = await uninstallHook();

      expect(result).toBe(true);
      expect(mockVscode.workspace.fs.delete).toHaveBeenCalledTimes(1);
      const deleteUri = mockVscode.workspace.fs.delete.mock.calls[0][0];
      expect(deleteUri.path).toMatch(/\.git\/hooks\/prepare-commit-msg$/);
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Copilot Budget: Commit hook removed.',
      );
    });

    it('refuses to remove a non-Copilot Budget hook', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue('#!/bin/sh\n# husky hook\n');

      const result = await uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.workspace.fs.delete).not.toHaveBeenCalled();
      expect(mockVscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('not installed by Copilot Budget'),
      );
    });

    it('handles no hook file gracefully', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(null);

      const result = await uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Copilot Budget: No commit hook to remove.',
      );
    });

    it('returns false when no workspace folder', async () => {
      const result = await uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('No workspace folder'),
      );
    });

    it('returns false when delete fails', async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(`#!/bin/sh\n${MARKER}\nscript`);
      mockVscode.workspace.fs.delete.mockRejectedValue(new Error('EACCES'));

      const result = await uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove'),
      );
    });
  });

  describe('hook script content', () => {
    let writtenContent: string;

    beforeEach(async () => {
      setupWorkspace('/project');
      mockReadTextFile.mockResolvedValue(null);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);
      writtenContent = '';
      mockWriteTextFile.mockImplementation(async (_uri: any, data: string) => {
        writtenContent = data;
      });
      await installHook();
    });

    it('includes essential shell logic', () => {
      expect(writtenContent).toContain('case "$COMMIT_SOURCE"');
      expect(writtenContent).toContain('merge|squash|commit');
      expect(writtenContent).toContain('git rev-parse --git-dir');
      expect(writtenContent).not.toContain('git rev-parse --show-toplevel');
      expect(writtenContent).toContain('$GIT_DIR/copilot-budget');
      expect(writtenContent).toContain('>> "$COMMIT_MSG_FILE"');
      expect(writtenContent).toContain(': > "$TRACKING_FILE"');
    });

    it('uses generic TR_ grep pattern for trailers', () => {
      expect(writtenContent).toContain("grep '^TR_'");
      expect(writtenContent).toContain("sed 's/^TR_");
      expect(writtenContent).not.toContain('AI-Premium-Requests:');
      expect(writtenContent).not.toContain('AI-Est-Cost:');
      expect(writtenContent).not.toContain('AI-Total-Tokens:');
      expect(writtenContent).not.toContain('AI-Commit-Tokens:');
    });

    it('is a dumb pipe with no accumulation logic', () => {
      expect(writtenContent).not.toContain('git log -1');
      expect(writtenContent).not.toContain('trailers:key=');
      expect(writtenContent).not.toContain('awk');
      expect(writtenContent).not.toContain('validate_num');
      expect(writtenContent).not.toContain('PREV_');
      expect(writtenContent).not.toContain('TOTAL_');
      expect(writtenContent).not.toContain('CURRENT_');
    });

    it('reads premium requests for skip check', () => {
      expect(writtenContent).toContain("grep '^PREMIUM_REQUESTS=' \"$TRACKING_FILE\"");
      expect(writtenContent).not.toContain("grep '^ESTIMATED_COST=' \"$TRACKING_FILE\"");
    });

    it('reads TR_ lines for trailer output', () => {
      expect(writtenContent).toContain("grep '^TR_' \"$TRACKING_FILE\"");
      expect(writtenContent).not.toContain("grep '^MODEL ' \"$TRACKING_FILE\"");
    });

    it('skips appending when no TR_ lines exist', () => {
      expect(writtenContent).toContain("TR_LINES=$(grep '^TR_' \"$TRACKING_FILE\") || true");
      expect(writtenContent).toContain("case \"$TR_LINES\" in '') : > \"$TRACKING_FILE\"; exit 0");
    });

    it('skips when no premium requests', () => {
      expect(writtenContent).toContain("case \"$PREMIUM\" in ''|0|0.00) exit 0");
    });
  });
});
