// Minimal VS Code API mock for unit tests
// Store for overriding config values in tests
export const __configStore: Record<string, any> = {};
export const __configChangeListeners: Array<(e: any) => void> = [];
// Spy capturing every `getConfiguration(section).update(key, value, target)` call so
// tests can assert configuration writes (panel currency/OTel toggles, etc).
// Tests using this should call `__workspaceUpdate.mockClear()` in beforeEach
// since it persists across tests within the module.
export const __workspaceUpdate = jest.fn(
  async (_section: string | undefined, _key: string, _value: any, _target?: any) => {},
);

export const workspace = {
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T => {
      const fullKey = section ? `${section}.${key}` : key;
      return fullKey in __configStore ? __configStore[fullKey] : (defaultValue as T);
    },
    has: () => false,
    inspect: () => undefined,
    update: (key: string, value: any, target?: any) =>
      __workspaceUpdate(section, key, value, target),
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
  executeCommand: jest.fn(async () => undefined),
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

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
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
    // Normalize '..' segments to match VS Code behavior
    const parts = joined.split('/');
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '..') {
        stack.pop();
      } else if (part !== '.') {
        stack.push(part);
      }
    }
    return new Uri(base.scheme, stack.join('/') || '/');
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

export class FileSystemError extends Error {
  readonly code: string;
  constructor(messageOrUri?: string | Uri, code: string = 'Unknown') {
    super(typeof messageOrUri === 'string' ? messageOrUri : messageOrUri?.toString());
    this.code = code;
    this.name = 'FileSystemError';
  }
  static FileNotFound(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'FileNotFound');
  }
  static FileExists(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'FileExists');
  }
  static FileNotADirectory(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'FileNotADirectory');
  }
  static FileIsADirectory(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'FileIsADirectory');
  }
  static NoPermissions(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'NoPermissions');
  }
  static Unavailable(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'Unavailable');
  }
}

export class MarkdownString {
  value: string;
  isTrusted: boolean;
  supportHtml: boolean;
  constructor(value: string = '', supportHtml: boolean = false) {
    this.value = value;
    this.isTrusted = false;
    this.supportHtml = supportHtml;
  }
  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendCodeblock(value: string, _language?: string): MarkdownString {
    this.value += value;
    return this;
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

export interface MockExtensionContextOverrides {
  storageUri?: Uri;
  globalStorageUri?: Uri;
}

export function createMockExtensionContext(
  overrides: MockExtensionContextOverrides = {},
): any {
  return {
    subscriptions: [],
    extensionPath: '/test',
    extensionUri: Uri.file('/test'),
    globalState: { get: () => undefined, update: async () => {} },
    workspaceState: { get: () => undefined, update: async () => {} },
    storageUri: overrides.storageUri,
    globalStorageUri: overrides.globalStorageUri ?? Uri.file('/test/global'),
  };
}
