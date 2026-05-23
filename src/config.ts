import * as vscode from 'vscode';
import { log } from './logger';
import { errorMessage } from './utils';

const SECTION = 'copilot-budget';

// Upstream Copilot Chat setting that turns the OTel SQLite exporter on. When
// true, Copilot Chat writes per-request spans (with measured cache splits) to
// `agent-traces.db` next to its globalStorage folder. We only ever flip this
// to true via our budget panel — never to false (see CLAUDE.md / plan §246).
export const OTEL_SECTION = 'github.copilot.chat.otel';
export const OTEL_KEY = 'dbSpanExporter.enabled';

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function isEnabled(): boolean {
  return cfg().get<boolean>('enabled', true);
}

export function getDisplayCurrency(): 'aic' | 'usd' {
  const v = cfg().get<string>('displayCurrency', 'aic');
  return v === 'usd' ? 'usd' : 'aic';
}

export function isCommitHookEnabled(): boolean {
  return cfg().get<boolean>('commitHook.enabled', false);
}

export function getSessionMaxAgeDays(): number {
  const v = cfg().get<number>('sessionMaxAgeDays', 7);
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 7;
  return v;
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

export function isOTelDbExporterEnabled(): boolean {
  return vscode.workspace
    .getConfiguration(OTEL_SECTION)
    .get<boolean>(OTEL_KEY, false);
}

// On first activation in a workspace where the upstream OTel setting is unset
// at both Global and Workspace scope, flip it to true at Workspace scope so
// Copilot Chat starts emitting spans. Explicit user choice (either scope) is
// respected — we never overwrite. Failures are logged but never thrown so a
// transient setting-write error does not block activation.
export async function autoEnableOTel(): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration(OTEL_SECTION);
    const inspected = cfg.inspect(OTEL_KEY);
    const explicitlySet =
      inspected?.globalValue !== undefined ||
      inspected?.workspaceValue !== undefined;
    if (explicitlySet) return;
    await cfg.update(OTEL_KEY, true, vscode.ConfigurationTarget.Workspace);
  } catch (err) {
    log(`autoEnableOTel: failed to write setting — ${errorMessage(err)}`);
  }
}
