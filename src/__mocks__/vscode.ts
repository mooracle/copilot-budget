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
  fs: {
    stat: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    delete: jest.fn(),
    createDirectory: jest.fn(),
  },
};

export const authentication = {
  getSession: jest.fn(async () => null),
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
  createOutputChannel: jest.fn((name: string) => ({
    name,
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  })),
  showInformationMessage: jest.fn(async () => undefined),
  showWarningMessage: jest.fn(async () => undefined),
  showErrorMessage: jest.fn(async () => undefined),
  showQuickPick: jest.fn(async () => undefined),
};

export const __commandCallbacks: Record<string, (...args: any[]) => any> = {};

export const commands = {
  registerCommand: jest.fn((command: string, callback: (...args: any[]) => any) => {
    __commandCallbacks[command] = callback;
    return { dispose: () => {} };
  }),
};

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum QuickPickItemKind {
  Default = 0,
  Separator = -1,
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class Uri {
  readonly scheme: string;
  readonly path: string;
  readonly fsPath: string;

  private constructor(scheme: string, filePath: string) {
    this.scheme = scheme;
    this.path = filePath;
    this.fsPath = filePath;
  }

  static file(filePath: string): Uri {
    return new Uri('file', filePath);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path, ...segments].join('/').replace(/\/+/g, '/');
    return new Uri(base.scheme, joined);
  }

  with(change: { scheme?: string; path?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.path ?? this.path,
    );
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
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

export enum TaskScope {
  Global = 1,
  Workspace = 2,
}

export enum TaskRevealKind {
  Always = 1,
  Silent = 2,
  Never = 3,
}

export class ShellExecution {
  constructor(
    public command: string,
    public args?: string[],
  ) {}
}

export class Task {
  public presentationOptions: any = {};
  constructor(
    public definition: any,
    public scope: any,
    public name: string,
    public source: string,
    public execution?: any,
  ) {}
}

export const tasks = {
  executeTask: jest.fn(async () => undefined),
  onDidEndTaskProcess: jest.fn(() => ({ dispose: () => {} })),
};
