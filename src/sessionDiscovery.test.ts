import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('fs');
jest.mock('os');
jest.mock('./logger');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

// Must import after mocks are set up
import { getVSCodeUserPaths, discoverSessionFiles, discoverVscdbFiles, getDiscoveryDiagnostics } from './sessionDiscovery';

beforeEach(() => {
  jest.resetAllMocks();
  mockOs.homedir.mockReturnValue('/home/testuser');
});

describe('getVSCodeUserPaths', () => {
  it('returns macOS paths when platform is darwin', () => {
    mockOs.platform.mockReturnValue('darwin');
    const paths = getVSCodeUserPaths();

    expect(paths).toContain(
      '/home/testuser/Library/Application Support/Code/User',
    );
    expect(paths).toContain(
      '/home/testuser/Library/Application Support/Code - Insiders/User',
    );
    expect(paths).toContain(
      '/home/testuser/Library/Application Support/Cursor/User',
    );
    // Remote paths always included
    expect(paths).toContain('/home/testuser/.vscode-server/data/User');
  });

  it('returns Linux paths when platform is linux', () => {
    mockOs.platform.mockReturnValue('linux');
    const paths = getVSCodeUserPaths();

    expect(paths).toContain('/home/testuser/.config/Code/User');
    expect(paths).toContain('/home/testuser/.config/Code - Insiders/User');
    expect(paths).toContain('/home/testuser/.config/VSCodium/User');
  });

  it('respects XDG_CONFIG_HOME on Linux', () => {
    mockOs.platform.mockReturnValue('linux');
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/custom/config';
    try {
      const paths = getVSCodeUserPaths();
      expect(paths).toContain('/custom/config/Code/User');
    } finally {
      if (origXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = origXdg;
      }
    }
  });

  it('returns Windows paths when platform is win32', () => {
    mockOs.platform.mockReturnValue('win32');
    const origAppData = process.env.APPDATA;
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    try {
      const paths = getVSCodeUserPaths();
      expect(paths).toContain(
        path.join('C:\\Users\\test\\AppData\\Roaming', 'Code', 'User'),
      );
    } finally {
      if (origAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = origAppData;
      }
    }
  });

  it('includes all 5 VS Code variants', () => {
    mockOs.platform.mockReturnValue('darwin');
    const paths = getVSCodeUserPaths();
    const variants = ['Code', 'Code - Insiders', 'Code - Exploration', 'VSCodium', 'Cursor'];
    for (const v of variants) {
      expect(paths.some((p) => p.includes(v))).toBe(true);
    }
  });

  it('includes remote server paths', () => {
    mockOs.platform.mockReturnValue('linux');
    const paths = getVSCodeUserPaths();
    expect(paths).toContain('/home/testuser/.vscode-server/data/User');
    expect(paths).toContain('/home/testuser/.vscode-server-insiders/data/User');
    expect(paths).toContain('/home/testuser/.vscode-remote/data/User');
  });
});

describe('discoverSessionFiles', () => {
  // Helper to set up a virtual filesystem
  function setupMockFs(existingPaths: Set<string>, dirEntries: Record<string, fs.Dirent[]>, fileStats?: Record<string, { size: number }>) {
    mockOs.platform.mockReturnValue('darwin');

    mockFs.existsSync.mockImplementation((p: fs.PathLike) => existingPaths.has(p.toString()));

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      const entries = dirEntries[p.toString()];
      if (!entries) throw new Error(`ENOENT: ${p}`);
      return entries as any;
    });

    mockFs.statSync.mockImplementation((p: fs.PathLike) => {
      const stats = fileStats?.[p.toString()];
      if (stats) return stats as any;
      return { size: 100 } as any;
    });
  }

  function dirent(name: string, isDir: boolean): fs.Dirent {
    return {
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
      path: '',
      parentPath: '',
    };
  }

  it('returns empty array when no VS Code paths exist', () => {
    setupMockFs(new Set(), {});
    const files = discoverSessionFiles();
    expect(files).toEqual([]);
  });

  it('finds session files in workspaceStorage/*/chatSessions/', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const wsStorage = path.join(userPath, 'workspaceStorage');
    const chatDir = path.join(wsStorage, 'abc123', 'chatSessions');

    mockOs.platform.mockReturnValue('darwin');
    mockFs.existsSync.mockImplementation((p: fs.PathLike) =>
      new Set([userPath, wsStorage, chatDir]).has(p.toString()),
    );
    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      const key = p.toString();
      if (key === wsStorage) return ['abc123'] as any;
      if (key === chatDir) return [dirent('session1.json', false), dirent('session2.jsonl', false)] as any;
      throw new Error(`ENOENT: ${key}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const files = discoverSessionFiles();
    expect(files).toContain(path.join(chatDir, 'session1.json'));
    expect(files).toContain(path.join(chatDir, 'session2.jsonl'));
    expect(files).toHaveLength(2);
  });

  it('finds session files in globalStorage/emptyWindowChatSessions/', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const emptyWindow = path.join(userPath, 'globalStorage', 'emptyWindowChatSessions');

    setupMockFs(new Set([userPath, emptyWindow]), {
      [emptyWindow]: [dirent('chat.json', false), dirent('readme.txt', false)],
    });

    const files = discoverSessionFiles();
    expect(files).toContain(path.join(emptyWindow, 'chat.json'));
    expect(files).toHaveLength(1); // readme.txt excluded
  });

  it('finds session files in globalStorage/github.copilot-chat/ recursively', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const copilotChat = path.join(userPath, 'globalStorage', 'github.copilot-chat');
    const subDir = path.join(copilotChat, 'sessions');

    setupMockFs(new Set([userPath, copilotChat]), {
      [copilotChat]: [dirent('sessions', true), dirent('data.json', false)],
      [subDir]: [dirent('s1.json', false), dirent('s2.jsonl', false)],
    });

    const files = discoverSessionFiles();
    expect(files).toContain(path.join(copilotChat, 'data.json'));
    expect(files).toContain(path.join(subDir, 's1.json'));
    expect(files).toContain(path.join(subDir, 's2.jsonl'));
    expect(files).toHaveLength(3);
  });

  it('finds session files in globalStorage/github.copilot/ recursively', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const copilot = path.join(userPath, 'globalStorage', 'github.copilot');
    const subDir = path.join(copilot, 'sessions');

    setupMockFs(new Set([userPath, copilot]), {
      [copilot]: [dirent('sessions', true), dirent('usage.json', false)],
      [subDir]: [dirent('s1.json', false)],
    });

    const files = discoverSessionFiles();
    expect(files).toContain(path.join(copilot, 'usage.json'));
    expect(files).toContain(path.join(subDir, 's1.json'));
    expect(files).toHaveLength(2);
  });

  it('finds session files in workspaceStorage/*/github.copilot-chat/', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const wsStorage = path.join(userPath, 'workspaceStorage');
    const wsCopilotChat = path.join(wsStorage, 'ws1', 'github.copilot-chat');

    mockOs.platform.mockReturnValue('darwin');
    mockFs.existsSync.mockImplementation((p: fs.PathLike) =>
      new Set([userPath, wsStorage, wsCopilotChat]).has(p.toString()),
    );
    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      const key = p.toString();
      if (key === wsStorage) return ['ws1'] as any;
      if (key === wsCopilotChat) return [dirent('data.json', false)] as any;
      throw new Error(`ENOENT: ${key}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const files = discoverSessionFiles();
    expect(files).toContain(path.join(wsCopilotChat, 'data.json'));
  });

  it('finds session files in workspaceStorage/*/github.copilot/', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const wsStorage = path.join(userPath, 'workspaceStorage');
    const wsCopilot = path.join(wsStorage, 'ws1', 'github.copilot');

    mockOs.platform.mockReturnValue('darwin');
    mockFs.existsSync.mockImplementation((p: fs.PathLike) =>
      new Set([userPath, wsStorage, wsCopilot]).has(p.toString()),
    );
    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      const key = p.toString();
      if (key === wsStorage) return ['ws1'] as any;
      if (key === wsCopilot) return [dirent('usage.json', false)] as any;
      throw new Error(`ENOENT: ${key}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const files = discoverSessionFiles();
    expect(files).toContain(path.join(wsCopilot, 'usage.json'));
  });

  it('deduplicates files found in multiple scan categories', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const copilotChat = path.join(userPath, 'globalStorage', 'github.copilot-chat');
    // Simulate the same file found twice (e.g., overlapping scan patterns)
    const sharedFile = path.join(copilotChat, 'session.json');

    setupMockFs(new Set([userPath, copilotChat]), {
      [copilotChat]: [dirent('session.json', false)],
    });

    const files = discoverSessionFiles();
    // The file appears in the copilot-chat scan; dedup ensures it's only once
    const count = files.filter((f) => f === sharedFile).length;
    expect(count).toBe(1);
  });

  it('filters out non-session files (embeddings, index, cache, etc.)', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const copilotChat = path.join(userPath, 'globalStorage', 'github.copilot-chat');

    setupMockFs(new Set([userPath, copilotChat]), {
      [copilotChat]: [
        dirent('commandEmbeddings.json', false),
        dirent('index.json', false),
        dirent('cache.json', false),
        dirent('preferences.json', false),
        dirent('settings.json', false),
        dirent('myconfig.json', false),
        dirent('actual-session.json', false),
      ],
    });

    const files = discoverSessionFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('actual-session.json');
  });

  it('skips empty files (size === 0)', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const copilotChat = path.join(userPath, 'globalStorage', 'github.copilot-chat');

    setupMockFs(
      new Set([userPath, copilotChat]),
      {
        [copilotChat]: [dirent('session.json', false), dirent('empty.json', false)],
      },
      {
        [path.join(copilotChat, 'session.json')]: { size: 500 },
        [path.join(copilotChat, 'empty.json')]: { size: 0 },
      },
    );

    const files = discoverSessionFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('session.json');
  });

  it('handles filesystem errors gracefully', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';

    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      if (p.toString() === userPath) return true;
      return false;
    });
    // No readdirSync calls should fail (paths don't exist)
    mockFs.readdirSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    // Should not throw
    const files = discoverSessionFiles();
    expect(files).toEqual([]);
  });
});

describe('discoverVscdbFiles', () => {
  it('finds state.vscdb in workspaceStorage directories', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const wsStorage = path.join(userPath, 'workspaceStorage');
    const vscdbPath = path.join(wsStorage, 'abc123', 'state.vscdb');

    mockOs.platform.mockReturnValue('darwin');
    mockFs.existsSync.mockImplementation((p: fs.PathLike) =>
      new Set([wsStorage, vscdbPath]).has(p.toString()),
    );
    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === wsStorage) return ['abc123'] as any;
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 4096 } as any);

    const files = discoverVscdbFiles();
    expect(files).toContain(vscdbPath);
    expect(files).toHaveLength(1);
  });

  it('skips empty vscdb files', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const wsStorage = path.join(userPath, 'workspaceStorage');
    const vscdbPath = path.join(wsStorage, 'abc123', 'state.vscdb');

    mockOs.platform.mockReturnValue('darwin');
    mockFs.existsSync.mockImplementation((p: fs.PathLike) =>
      new Set([wsStorage, vscdbPath]).has(p.toString()),
    );
    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === wsStorage) return ['abc123'] as any;
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 0 } as any);

    const files = discoverVscdbFiles();
    expect(files).toEqual([]);
  });

  it('handles missing workspaceStorage gracefully', () => {
    mockOs.platform.mockReturnValue('darwin');
    mockFs.existsSync.mockReturnValue(false);

    const files = discoverVscdbFiles();
    expect(files).toEqual([]);
  });

  it('finds vscdb files across multiple workspaces', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const wsStorage = path.join(userPath, 'workspaceStorage');
    const vscdb1 = path.join(wsStorage, 'ws1', 'state.vscdb');
    const vscdb2 = path.join(wsStorage, 'ws2', 'state.vscdb');

    mockOs.platform.mockReturnValue('darwin');
    mockFs.existsSync.mockImplementation((p: fs.PathLike) =>
      new Set([wsStorage, vscdb1, vscdb2]).has(p.toString()),
    );
    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === wsStorage) return ['ws1', 'ws2'] as any;
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 8192 } as any);

    const files = discoverVscdbFiles();
    expect(files).toContain(vscdb1);
    expect(files).toContain(vscdb2);
    expect(files).toHaveLength(2);
  });

  it('handles filesystem errors gracefully', () => {
    const userPath = '/home/testuser/Library/Application Support/Code/User';
    const wsStorage = path.join(userPath, 'workspaceStorage');

    mockOs.platform.mockReturnValue('darwin');
    mockFs.existsSync.mockImplementation((p: fs.PathLike) =>
      p.toString() === wsStorage,
    );
    mockFs.readdirSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const files = discoverVscdbFiles();
    expect(files).toEqual([]);
  });
});

describe('getDiscoveryDiagnostics', () => {
  it('returns platform, homedir, candidatePaths, filesFound, and vscdbFilesFound', () => {
    mockOs.platform.mockReturnValue('darwin');
    mockOs.homedir.mockReturnValue('/home/testuser');
    mockFs.existsSync.mockReturnValue(false);

    const diag = getDiscoveryDiagnostics();

    expect(diag.platform).toBe('darwin');
    expect(diag.homedir).toBe('/home/testuser');
    expect(diag.candidatePaths).toBeInstanceOf(Array);
    expect(diag.candidatePaths.length).toBeGreaterThan(0);
    expect(diag.candidatePaths[0]).toHaveProperty('path');
    expect(diag.candidatePaths[0]).toHaveProperty('exists');
    expect(diag.filesFound).toEqual([]);
    expect(diag.vscdbFilesFound).toEqual([]);
  });

  it('marks existing paths correctly', () => {
    mockOs.platform.mockReturnValue('darwin');
    const userPath = '/home/testuser/Library/Application Support/Code/User';

    mockFs.existsSync.mockImplementation((p: fs.PathLike) => p.toString() === userPath);
    mockFs.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const diag = getDiscoveryDiagnostics();
    const codeEntry = diag.candidatePaths.find((c) => c.path === userPath);
    expect(codeEntry).toBeDefined();
    expect(codeEntry!.exists).toBe(true);

    const missingEntries = diag.candidatePaths.filter((c) => c.path !== userPath);
    for (const entry of missingEntries) {
      expect(entry.exists).toBe(false);
    }
  });
});
