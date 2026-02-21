// Minimal VS Code API mock for unit tests
export const workspace = {
  getConfiguration: (section?: string) => ({
    get: (key: string, defaultValue?: any) => defaultValue,
    has: () => false,
    inspect: () => undefined,
    update: async () => {},
  }),
  workspaceFolders: undefined as any,
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export const window = {
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
};

export const commands = {
  registerCommand: (command: string, callback: (...args: any[]) => any) => ({
    dispose: () => {},
  }),
};

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class Uri {
  static file(path: string) {
    return { fsPath: path, scheme: 'file', path };
  }
}

export class Disposable {
  static from(...disposables: { dispose: () => any }[]) {
    return {
      dispose: () => disposables.forEach((d) => d.dispose()),
    };
  }
}

export class EventEmitter {
  event = () => ({ dispose: () => {} });
  fire() {}
  dispose() {}
}
