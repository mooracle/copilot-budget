import * as vscode from 'vscode';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function readTextFile(uri: vscode.Uri): Promise<string | null> {
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    return decoder.decode(data);
  } catch {
    return null;
  }
}

export async function writeTextFile(
  uri: vscode.Uri,
  content: string,
): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
}

export async function stat(
  uri: vscode.Uri,
): Promise<vscode.FileStat | null> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return null;
  }
}

export async function deleteFile(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.delete(uri);
    return true;
  } catch {
    return false;
  }
}
