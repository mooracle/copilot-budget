// Minimal VS Code API mock for unit tests
// Store for overriding config values in tests
export const __configStore: Record<string, any> = {};
export const __configChangeListeners: Array<(e: any) => void> = [];

export const workspace = {
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T => {
      const fullKey = section ? `${section}.${key}` : key;
      return fullKey in __configStore ? __configStore[fullKey] : (defaultValue as T);
    },
    has: () => false,
    inspect: () => undefined,
    update: async () => {},
  }),
  workspaceFolders: undefined as any,
  onDidChangeConfiguration: (listener: (e: any) => void) => {
    __configChangeListeners.push(listener);
    return {
      dispose: () => {
        const idx = __configChangeListeners.indexOf(listener);
        if (idx >= 0) __configChangeListeners.splice(idx, 1);
      },
    };
  },
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
