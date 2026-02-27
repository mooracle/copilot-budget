import * as vscode from 'vscode';

const SECTION = 'copilot-budget';

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function isEnabled(): boolean {
  return cfg().get<boolean>('enabled', true);
}

export function isCommitHookEnabled(): boolean {
  return cfg().get<boolean>('commitHook.enabled', true);
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

function sanitizeTrailerKey(value: unknown, fallback: string | false): string | false {
  if (value === false) return false;
  if (typeof value !== 'string') return fallback;
  const sanitized = value.replace(/[\n\r=]/g, '');
  return sanitized || false;
}

export function getTrailerConfig(): TrailerConfig {
  const c = cfg();
  return {
    premiumRequests: sanitizeTrailerKey(c.get('commitHook.trailers.premiumRequests', 'Copilot-Premium-Requests'), 'Copilot-Premium-Requests'),
    estimatedCost: sanitizeTrailerKey(c.get('commitHook.trailers.estimatedCost', 'Copilot-Est-Cost'), 'Copilot-Est-Cost'),
    model: sanitizeTrailerKey(c.get('commitHook.trailers.model', false), false),
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
