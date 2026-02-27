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

export type PlanSetting = 'auto' | 'free' | 'pro' | 'pro+' | 'business' | 'enterprise';

export function getPlanSetting(): PlanSetting {
  return cfg().get<PlanSetting>('plan', 'auto');
}

export interface TrailerConfig {
  premiumRequests: string | false;
  estimatedCost: string | false;
  model: string | false;
}

export function getTrailerConfig(): TrailerConfig {
  const c = cfg();
  return {
    premiumRequests: c.get<string | false>('commitHook.trailers.premiumRequests', 'Copilot-Premium-Requests'),
    estimatedCost: c.get<string | false>('commitHook.trailers.estimatedCost', 'Copilot-Est-Cost'),
    model: c.get<string | false>('commitHook.trailers.model', false),
  };
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
