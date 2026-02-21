import * as vscode from 'vscode';

const SECTION = 'copilot-budget';

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function isEnabled(): boolean {
  return cfg().get<boolean>('enabled', true);
}

export function isCommitHookEnabled(): boolean {
  return cfg().get<boolean>('commitHook.enabled', false);
}

export function onConfigChanged(
  callback: (e: vscode.ConfigurationChangeEvent) => void,
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      callback(e);
    }
  });
}
