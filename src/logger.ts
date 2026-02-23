import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Copilot Budget');
  }
  return channel;
}

export function log(message: string): void {
  const ch = getOutputChannel();
  const timestamp = new Date().toISOString();
  ch.appendLine(`[${timestamp}] ${message}`);
}

export function disposeLogger(): void {
  if (channel) {
    channel.dispose();
    channel = null;
  }
}
