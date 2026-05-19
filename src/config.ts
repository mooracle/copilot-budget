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

export interface TrailerConfig {
  estimatedCost: string | false;
  aiCredits: string | false;
  aiCreditsPerModel: string | false;
}

function sanitizeTrailerKey(value: unknown, fallback: string | false): string | false {
  if (value === false) return false;
  if (typeof value !== 'string') return fallback;
  const sanitized = value.replace(/[\n\r=/\\]/g, '');
  return sanitized || false;
}

export function getTrailerConfig(): TrailerConfig {
  const c = cfg();
  return {
    estimatedCost: sanitizeTrailerKey(c.get('commitHook.trailers.estimatedCost', false), false),
    aiCredits: sanitizeTrailerKey(c.get('commitHook.trailers.aiCredits', 'Copilot-AI-Credits'), 'Copilot-AI-Credits'),
    aiCreditsPerModel: sanitizeTrailerKey(c.get('commitHook.trailers.aiCreditsPerModel', false), false),
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
