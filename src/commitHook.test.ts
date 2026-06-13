import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as gitDir from './gitDir';
import * as fsUtils from './fsUtils';

jest.mock('fs', () => ({ chmodSync: jest.fn() }));
jest.mock('./gitDir');
jest.mock('./fsUtils');

const _mockFs = fs as jest.Mocked<typeof fs>;

const mockVscode = vscode as any;
const mockResolveHooksDir = gitDir.resolveHooksDir as jest.MockedFunction<typeof gitDir.resolveHooksDir>;
const mockReadTextFile = fsUtils.readTextFile as jest.MockedFunction<typeof fsUtils.readTextFile>;
const mockWriteTextFile = fsUtils.writeTextFile as jest.MockedFunction<typeof fsUtils.writeTextFile>;
const mockVscodeStat = mockVscode.workspace.fs.stat as jest.Mock;

const FAKE_STAT = { type: 1, ctime: 0, mtime: 0, size: 100 } as any;
const FILE_NOT_FOUND_ERROR = vscode.FileSystemError.FileNotFound();

const MARKER = '# Copilot Budget prepare-commit-msg hook';

function setupWorkspace(rootPath: string, hooksDirPath?: string) {
  mockVscode.workspace.workspaceFolders = [
    { uri: vscode.Uri.file(rootPath), name: 'test', index: 0 },
  ];
  mockResolveHooksDir.mockResolvedValue(
    vscode.Uri.file(hooksDirPath ?? rootPath + '/.git/hooks'),
  );
}

function clearWorkspace() {
  mockVscode.workspace.workspaceFolders = undefined;
  mockResolveHooksDir.mockResolvedValue(null);
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

    it('returns false when resolveHooksDir returns null', async () => {
      mockVscode.workspace.workspaceFolders = [
        { uri: vscode.Uri.file('/project'), name: 'test', index: 0 },
      ];
      mockResolveHooksDir.mockResolvedValue(null);

      expect(await isHookInstalled()).toBe(false);
    });
  });

  describe('installHook', () => {
    it('writes hook script with marker', async () => {
      setupWorkspace('/project');
      mockVscodeStat.mockRejectedValue(FILE_NOT_FOUND_ERROR);
      mockReadTextFile.mockResolvedValue(null);
      mockWriteTextFile.mockResolvedValue(undefined);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);

      const result = await installHook();

      expect(result).toBe(true);
      // Two hooks are installed: prepare-commit-msg (written first) and
      // post-commit.
      expect(mockWriteTextFile).toHaveBeenCalledTimes(2);
      const [hookUri, content] = mockWriteTextFile.mock.calls[0];
      expect(hookUri.path).toMatch(/\.git\/hooks\/prepare-commit-msg$/);
      expect(content).toContain(MARKER);
      expect(content).toContain('#!/bin/sh');
      expect(content).toContain('TRACKING_FILE=');
      expect(content).toContain("grep '^TR_'");
      expect(content).toContain("sed 's/^TR_");
      const [postUri, postContent] = mockWriteTextFile.mock.calls[1];
      expect(postUri.path).toMatch(/\.git\/hooks\/post-commit$/);
      // The post-commit script carries the shared recognition marker (the
      // substring that install/uninstall match on), not the prepare-specific
      // comment line.
      expect(postContent).toContain('# Copilot Budget');
      expect(postContent).toContain('#!/bin/sh');
      // Only one "installed" toast even though two files were written.
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Copilot Budget: Commit hook installed.',
      );
    });

    it('creates hooks directory via vscode.workspace.fs.createDirectory', async () => {
      setupWorkspace('/project');
      mockVscodeStat.mockRejectedValue(FILE_NOT_FOUND_ERROR);
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
      mockVscodeStat.mockResolvedValue(FAKE_STAT);
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
      mockVscodeStat.mockResolvedValue(FAKE_STAT);
      mockReadTextFile.mockResolvedValue(`#!/bin/sh\n${MARKER}\nold script`);
      mockWriteTextFile.mockResolvedValue(undefined);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);

      const result = await installHook();

      expect(result).toBe(true);
      expect(mockWriteTextFile).toHaveBeenCalledTimes(2);
      expect(mockVscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('returns false when no workspace folder', async () => {
      const result = await installHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('installs hook in common git dir for worktrees', async () => {
      setupWorkspace('/worktrees/feature', '/repo/.git/hooks');
      mockVscodeStat.mockRejectedValue(FILE_NOT_FOUND_ERROR);
      mockReadTextFile.mockResolvedValue(null);
      mockWriteTextFile.mockResolvedValue(undefined);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);

      const result = await installHook();

      expect(result).toBe(true);
      const [hookUri] = mockWriteTextFile.mock.calls[0];
      expect(hookUri.path).toMatch(/\/repo\/\.git\/hooks\/prepare-commit-msg$/);
    });

    it('installs hook into a custom core.hooksPath directory (e.g. .husky/)', async () => {
      // When the repo (or husky/lefthook) sets core.hooksPath, resolveHooksDir
      // returns that location instead of <gitCommonDir>/hooks. The install
      // should land there so git actually runs our script.
      setupWorkspace('/project', '/project/.husky');
      mockVscodeStat.mockRejectedValue(FILE_NOT_FOUND_ERROR);
      mockReadTextFile.mockResolvedValue(null);
      mockWriteTextFile.mockResolvedValue(undefined);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);

      const result = await installHook();

      expect(result).toBe(true);
      const [hookUri] = mockWriteTextFile.mock.calls[0];
      expect(hookUri.path).toBe('/project/.husky/prepare-commit-msg');
      const dirUri = mockVscode.workspace.fs.createDirectory.mock.calls[0][0];
      expect(dirUri.path).toBe('/project/.husky');
    });

    it('returns false when write fails', async () => {
      setupWorkspace('/project');
      mockVscodeStat.mockRejectedValue(FILE_NOT_FOUND_ERROR);
      mockReadTextFile.mockResolvedValue(null);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);
      mockWriteTextFile.mockRejectedValue(new Error('EACCES'));

      const result = await installHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to install'),
      );
    });

    it('refuses to install when stat fails with a non-FileNotFound error', async () => {
      // A permission / transient / provider stat error must NOT be treated
      // as "no hook exists". Proceeding would bypass the marker check and
      // potentially overwrite a third-party hook.
      setupWorkspace('/project');
      mockVscodeStat.mockRejectedValue(
        vscode.FileSystemError.NoPermissions('hook dir locked'),
      );

      const result = await installHook();

      expect(result).toBe(false);
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to check commit hook file'),
      );
    });

    it('refuses to install when hook file exists but is unreadable', async () => {
      // stat() reports the file exists but read failed (permission/IO).
      // Without this check, the marker check below would be skipped and a
      // third-party hook could be silently overwritten.
      setupWorkspace('/project');
      mockVscodeStat.mockResolvedValue(FAKE_STAT);
      mockReadTextFile.mockResolvedValue(null);

      const result = await installHook();

      expect(result).toBe(false);
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read commit hook file'),
      );
    });
  });

  describe('uninstallHook', () => {
    it('removes a Copilot Budget hook', async () => {
      setupWorkspace('/project');
      mockVscodeStat.mockResolvedValue(FAKE_STAT);
      mockReadTextFile.mockResolvedValue(`#!/bin/sh\n${MARKER}\nscript`);
      mockVscode.workspace.fs.delete.mockResolvedValue(undefined);

      const result = await uninstallHook();

      expect(result).toBe(true);
      // Both hooks are removed: prepare-commit-msg (first) and post-commit.
      expect(mockVscode.workspace.fs.delete).toHaveBeenCalledTimes(2);
      const deleteUri = mockVscode.workspace.fs.delete.mock.calls[0][0];
      expect(deleteUri.path).toMatch(/\.git\/hooks\/prepare-commit-msg$/);
      const deleteUri2 = mockVscode.workspace.fs.delete.mock.calls[1][0];
      expect(deleteUri2.path).toMatch(/\.git\/hooks\/post-commit$/);
      // One "removed" toast for the pair.
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Copilot Budget: Commit hook removed.',
      );
    });

    it('refuses to remove a non-Copilot Budget hook', async () => {
      setupWorkspace('/project');
      mockVscodeStat.mockResolvedValue(FAKE_STAT);
      mockReadTextFile.mockResolvedValue('#!/bin/sh\n# husky hook\n');

      const result = await uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.workspace.fs.delete).not.toHaveBeenCalled();
      expect(mockVscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('not installed by Copilot Budget'),
      );
    });

    it('returns true when there is no hook file to remove (intent already met)', async () => {
      // Treating "nothing to remove" as success lets the panel/toggleCommitHook
      // command safely persist commitHook.enabled=false without drifting out
      // of sync with disk state. Only a FileNotFound error counts as "missing".
      setupWorkspace('/project');
      mockVscodeStat.mockRejectedValue(FILE_NOT_FOUND_ERROR);

      const result = await uninstallHook();

      expect(result).toBe(true);
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Copilot Budget: No commit hook to remove.',
      );
    });

    it('returns false when stat fails with a non-FileNotFound error', async () => {
      // Permission / transient / provider errors must surface as failure —
      // collapsing them to "no hook to remove" would let the caller persist
      // commitHook.enabled=false while the hook may still exist on disk
      // (then `onConfigChanged` would re-install it on the next config tick).
      setupWorkspace('/project');
      mockVscodeStat.mockRejectedValue(
        vscode.FileSystemError.NoPermissions('hook dir locked'),
      );

      const result = await uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(mockVscode.workspace.fs.delete).not.toHaveBeenCalled();
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to check commit hook file'),
      );
    });

    it('returns false when hook file exists but is unreadable', async () => {
      // stat() succeeds (file is on disk) but readTextFile returns null —
      // a permission or transient FS error. We must NOT report "no hook to
      // remove" here, because the file is still in place and the caller
      // would persist commitHook.enabled=false out of sync with disk.
      setupWorkspace('/project');
      mockVscodeStat.mockResolvedValue(FAKE_STAT);
      mockReadTextFile.mockResolvedValue(null);

      const result = await uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(mockVscode.workspace.fs.delete).not.toHaveBeenCalled();
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read commit hook file'),
      );
    });

    it('returns false when no workspace folder', async () => {
      const result = await uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('returns false when delete fails', async () => {
      setupWorkspace('/project');
      mockVscodeStat.mockResolvedValue(FAKE_STAT);
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
    let prepareContent: string;
    let postCommitContent: string;

    beforeEach(async () => {
      setupWorkspace('/project');
      mockVscodeStat.mockRejectedValue(FILE_NOT_FOUND_ERROR);
      mockReadTextFile.mockResolvedValue(null);
      mockVscode.workspace.fs.createDirectory.mockResolvedValue(undefined);
      prepareContent = '';
      postCommitContent = '';
      mockWriteTextFile.mockImplementation(async (uri: any, data: string) => {
        if (uri.path.endsWith('prepare-commit-msg')) prepareContent = data;
        else if (uri.path.endsWith('post-commit')) postCommitContent = data;
      });
      await installHook();
    });

    it('includes essential shell logic', () => {
      expect(prepareContent).toContain('case "$COMMIT_SOURCE"');
      expect(prepareContent).toContain('merge|commit)');
      expect(prepareContent).toContain('squash_sum_trailers');
      expect(prepareContent).toContain('rebase-merge');
      expect(prepareContent).toContain('rebase-apply');
      expect(prepareContent).toContain('git rev-parse --git-dir');
      expect(prepareContent).not.toContain('git rev-parse --show-toplevel');
      expect(prepareContent).toContain('$GIT_DIR/copilot-budget');
      expect(prepareContent).toContain('>> "$COMMIT_MSG_FILE"');
    });

    it('uses generic TR_ grep pattern for trailers', () => {
      expect(prepareContent).toContain("grep '^TR_'");
      expect(prepareContent).toContain("sed 's/^TR_");
      expect(prepareContent).not.toContain('AI-Premium-Requests:');
      expect(prepareContent).not.toContain('AI-Est-Cost:');
      expect(prepareContent).not.toContain('AI-Total-Tokens:');
      expect(prepareContent).not.toContain('AI-Commit-Tokens:');
    });

    it('is a dumb pipe with no accumulation logic', () => {
      expect(prepareContent).not.toContain('git log -1');
      expect(prepareContent).not.toContain('trailers:key=');
      expect(prepareContent).not.toContain('validate_num');
      expect(prepareContent).not.toContain('PREV_');
      expect(prepareContent).not.toContain('TOTAL_');
      expect(prepareContent).not.toContain('CURRENT_');
    });

    it('reads TR_ lines for trailer output', () => {
      expect(prepareContent).toContain("grep '^TR_' \"$TRACKING_FILE\"");
      expect(prepareContent).not.toContain("grep '^MODEL ' \"$TRACKING_FILE\"");
      expect(prepareContent).not.toContain('PREMIUM_REQUESTS');
    });

    it('skips appending when no TR_ lines exist', () => {
      expect(prepareContent).toContain("TR_LINES=$(grep '^TR_' \"$TRACKING_FILE\") || true");
      expect(prepareContent).toContain("case \"$TR_LINES\" in '') rm -f \"$PENDING\"; exit 0");
    });

    it('gates entirely on TR_ presence (no PREMIUM_REQUESTS gate)', () => {
      expect(prepareContent).not.toContain('PREMIUM_REQUESTS=');
      expect(prepareContent).not.toContain("case \"$PREMIUM\"");
    });

    it('appends a properly formatted git trailer block', () => {
      // sed converts each `TR_<name>=<value>` line to `<name>: <value>`
      expect(prepareContent).toContain("sed 's/^TR_\\([^=]*\\)=/\\1: /'");
      // blank-line separator before trailers
      expect(prepareContent).toContain("printf '\\n\\n'");
    });

    it('defers truncation: writes the pending marker, does NOT truncate the tracking file', () => {
      // prepare-commit-msg drops a marker instead of truncating, so a cancelled
      // commit can't reset the counter (issue #10). Truncation now lives in
      // the post-commit hook.
      expect(prepareContent).toContain(': > "$PENDING"');
      expect(prepareContent).not.toContain(': > "$TRACKING_FILE"');
      expect(prepareContent).toContain('copilot-budget.pending');
    });

    it('clears a stale pending marker on every non-trailer path', () => {
      // merge/commit, rebase, squash, and the no-tracking / no-TR_ exits must
      // all rm the marker so post-commit never consumes usage that was never
      // attributed to a commit.
      expect(prepareContent).toContain('merge|commit) rm -f "$PENDING"; exit 0');
      expect(prepareContent).toContain("case \"$TR_LINES\" in '') rm -f \"$PENDING\"; exit 0");
    });

    it('post-commit hook truncates the tracking file on the marker, rebase-guarded', () => {
      expect(postCommitContent).toContain('#!/bin/sh');
      expect(postCommitContent).toContain('# Copilot Budget');
      expect(postCommitContent).toContain('git rev-parse --git-dir');
      // Rebase guard: replayed commits must not reset the counter.
      expect(postCommitContent).toContain('rebase-merge');
      expect(postCommitContent).toContain('rebase-apply');
      // Acts only on the marker, then truncates the tracking file.
      expect(postCommitContent).toContain('[ -f "$PENDING" ] || exit 0');
      expect(postCommitContent).toContain('rm -f "$PENDING"');
      expect(postCommitContent).toContain(': > "$GIT_DIR/copilot-budget"');
    });
  });
});
