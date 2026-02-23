import { installHook, uninstallHook, isHookInstalled } from './commitHook';
import * as fs from 'fs';
import * as vscode from 'vscode';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockVscode = vscode as any;

const MARKER = '# Copilot Budget prepare-commit-msg hook';

function setupWorkspace(rootPath: string) {
  mockVscode.workspace.workspaceFolders = [
    { uri: { fsPath: rootPath }, name: 'test', index: 0 },
  ];
}

function clearWorkspace() {
  mockVscode.workspace.workspaceFolders = undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearWorkspace();
});

describe('commitHook', () => {
  describe('isHookInstalled', () => {
    it('returns true when hook file contains the marker', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockReturnValue(`#!/bin/sh\n${MARKER}\nsome script`);

      expect(isHookInstalled()).toBe(true);
    });

    it('returns false when hook file does not contain the marker', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockReturnValue('#!/bin/sh\n# some other hook\n');

      expect(isHookInstalled()).toBe(false);
    });

    it('returns false when hook file does not exist', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(isHookInstalled()).toBe(false);
    });

    it('returns false when no workspace folder', () => {
      expect(isHookInstalled()).toBe(false);
    });
  });

  describe('installHook', () => {
    it('writes hook script with marker and correct permissions', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      (mockFs.existsSync as jest.Mock).mockReturnValue(true);
      mockFs.writeFileSync.mockImplementation(() => {});

      const result = installHook();

      expect(result).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
      const [hookPath, content, options] = mockFs.writeFileSync.mock.calls[0] as any;
      expect(hookPath).toMatch(/\.git[/\\]hooks[/\\]prepare-commit-msg$/);
      expect(content).toContain(MARKER);
      expect(content).toContain('#!/bin/sh');
      expect(content).toContain('TRACKING_FILE=');
      expect(content).toContain('TOTAL_TOKENS=');
      expect(content).toContain('AI Budget:');
      expect(options.mode).toBe(0o755);
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Copilot Budget: Commit hook installed.',
      );
    });

    it('creates hooks directory if it does not exist', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      (mockFs.existsSync as jest.Mock).mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => '' as any);
      mockFs.writeFileSync.mockImplementation(() => {});

      const result = installHook();

      expect(result).toBe(true);
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.git[/\\]hooks$/),
        { recursive: true },
      );
    });

    it('refuses to overwrite a non-Copilot Budget hook', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockReturnValue('#!/bin/sh\n# husky hook\nexit 0\n');

      const result = installHook();

      expect(result).toBe(false);
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
      expect(mockVscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('already exists'),
      );
    });

    it('overwrites an existing Copilot Budget hook', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockReturnValue(`#!/bin/sh\n${MARKER}\nold script`);
      (mockFs.existsSync as jest.Mock).mockReturnValue(true);
      mockFs.writeFileSync.mockImplementation(() => {});

      const result = installHook();

      expect(result).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    });

    it('returns false when no workspace folder', () => {
      const result = installHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('No workspace folder'),
      );
    });

    it('returns false when write fails', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      (mockFs.existsSync as jest.Mock).mockReturnValue(true);
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      const result = installHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to install'),
      );
    });
  });

  describe('uninstallHook', () => {
    it('removes a Copilot Budget hook', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockReturnValue(`#!/bin/sh\n${MARKER}\nscript`);
      mockFs.unlinkSync.mockImplementation(() => {});

      const result = uninstallHook();

      expect(result).toBe(true);
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.git[/\\]hooks[/\\]prepare-commit-msg$/),
      );
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Copilot Budget: Commit hook removed.',
      );
    });

    it('refuses to remove a non-Copilot Budget hook', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockReturnValue('#!/bin/sh\n# husky hook\n');

      const result = uninstallHook();

      expect(result).toBe(false);
      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
      expect(mockVscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('not installed by Copilot Budget'),
      );
    });

    it('handles no hook file gracefully', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Copilot Budget: No commit hook to remove.',
      );
    });

    it('returns false when no workspace folder', () => {
      const result = uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('No workspace folder'),
      );
    });

    it('returns false when unlink fails', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockReturnValue(`#!/bin/sh\n${MARKER}\nscript`);
      mockFs.unlinkSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      const result = uninstallHook();

      expect(result).toBe(false);
      expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove'),
      );
    });
  });

  describe('hook script content', () => {
    it('includes essential shell logic', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      (mockFs.existsSync as jest.Mock).mockReturnValue(true);
      let writtenContent = '';
      mockFs.writeFileSync.mockImplementation((_p: any, data: any) => {
        writtenContent = data;
      });

      installHook();

      // Skips merge, squash, and amend commits
      expect(writtenContent).toContain('case "$COMMIT_SOURCE"');
      expect(writtenContent).toContain('merge|squash|commit');
      // Uses git rev-parse to find repo root
      expect(writtenContent).toContain('git rev-parse --show-toplevel');
      // Reads the tracking file
      expect(writtenContent).toContain('.git/copilot-budget');
      // Builds model list
      expect(writtenContent).toContain("grep '^MODEL '");
      // Appends to commit message
      expect(writtenContent).toContain('>> "$COMMIT_MSG_FILE"');
      // Resets tracking file
      expect(writtenContent).toContain(': > "$TRACKING_FILE"');
    });

    it('validates numeric fields before arithmetic expansion', () => {
      setupWorkspace('/project');
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      (mockFs.existsSync as jest.Mock).mockReturnValue(true);
      let writtenContent = '';
      mockFs.writeFileSync.mockImplementation((_p: any, data: any) => {
        writtenContent = data;
      });

      installHook();

      // Hook must validate inp and out are numeric before using in $((..))
      expect(writtenContent).toContain('*[!0-9]*) continue');
    });
  });
});
