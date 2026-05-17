import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('fs');
jest.mock('os');
jest.mock('./logger');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

// Must import after mocks are set up
import * as vscode from 'vscode';
import { discoverSessionFiles, getDiscoveryDiagnostics } from './sessionDiscovery';

beforeEach(() => {
  jest.resetAllMocks();
  mockOs.homedir.mockReturnValue('/home/testuser');
  mockOs.platform.mockReturnValue('darwin');
});

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
    parentPath: '',
  };
}

/** Helper: storageUri = .../workspaceStorage/<hash>/publisher.ext */
function makeStorageUri(hash = 'abc123'): vscode.Uri {
  return vscode.Uri.file(
    `/home/testuser/Library/Application Support/Code/User/workspaceStorage/${hash}/mooracle.copilot-budget`,
  );
}

describe('discoverSessionFiles', () => {
  it('returns [] when storageUri is undefined', () => {
    const files = discoverSessionFiles(undefined);
    expect(files).toEqual([]);
    expect(mockFs.readdirSync).not.toHaveBeenCalled();
  });

  it('returns [] when the chatSessions directory does not exist', () => {
    mockFs.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const files = discoverSessionFiles(makeStorageUri());
    expect(files).toEqual([]);
  });

  it('returns only .jsonl files from the chatSessions directory', () => {
    const storageUri = makeStorageUri();
    const chatDir = path.join(
      path.dirname(storageUri.fsPath),
      'chatSessions',
    );

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === chatDir) {
        return [
          dirent('legacy-session.json', false),
          dirent('session2.jsonl', false),
          dirent('readme.txt', false),
        ] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const files = discoverSessionFiles(storageUri);
    expect(files).toEqual([path.join(chatDir, 'session2.jsonl')]);
  });

  it('filters out non-session filenames (embeddings, index, cache, etc.)', () => {
    const storageUri = makeStorageUri();
    const chatDir = path.join(
      path.dirname(storageUri.fsPath),
      'chatSessions',
    );

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === chatDir) {
        return [
          dirent('commandEmbeddings.jsonl', false),
          dirent('index.jsonl', false),
          dirent('cache.jsonl', false),
          dirent('preferences.jsonl', false),
          dirent('settings.jsonl', false),
          dirent('myconfig.jsonl', false),
          dirent('actual-session.jsonl', false),
        ] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const files = discoverSessionFiles(storageUri);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('actual-session.jsonl');
  });

  it('skips zero-byte files', () => {
    const storageUri = makeStorageUri();
    const chatDir = path.join(
      path.dirname(storageUri.fsPath),
      'chatSessions',
    );

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === chatDir) {
        return [
          dirent('session.jsonl', false),
          dirent('empty.jsonl', false),
        ] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockImplementation((p: fs.PathLike) => {
      if (p.toString().endsWith('empty.jsonl')) return { size: 0 } as any;
      return { size: 500 } as any;
    });

    const files = discoverSessionFiles(storageUri);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('session.jsonl');
  });

  it('skips subdirectories inside chatSessions', () => {
    const storageUri = makeStorageUri();
    const chatDir = path.join(
      path.dirname(storageUri.fsPath),
      'chatSessions',
    );

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === chatDir) {
        return [
          dirent('nested', true),
          dirent('session.jsonl', false),
        ] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const files = discoverSessionFiles(storageUri);
    expect(files).toEqual([path.join(chatDir, 'session.jsonl')]);
  });

  it('resolves chatSessions one level up from storageUri', () => {
    // Regression guard for the one-`..`-vs-two mistake.
    const storageUri = vscode.Uri.file(
      '/path/workspaceStorage/abc123/pub.ext',
    );
    const expectedChatDir = '/path/workspaceStorage/abc123/chatSessions';

    const seenPaths: string[] = [];
    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      seenPaths.push(p.toString());
      return [] as any;
    });

    discoverSessionFiles(storageUri);
    expect(seenPaths).toEqual([expectedChatDir]);
  });
});

describe('getDiscoveryDiagnostics', () => {
  it('returns disabled shape when storageUri is undefined', () => {
    const diag = getDiscoveryDiagnostics(undefined);
    expect(diag.platform).toBe('darwin');
    expect(diag.homedir).toBe('/home/testuser');
    expect(diag.storageUri).toBeNull();
    expect(diag.chatSessionsDir).toBeNull();
    expect(diag.filesFound).toEqual([]);
    expect(mockFs.readdirSync).not.toHaveBeenCalled();
  });

  it('returns paths and files found when storageUri is defined', () => {
    const storageUri = makeStorageUri('xyz789');
    const chatDir = path.join(
      path.dirname(storageUri.fsPath),
      'chatSessions',
    );

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === chatDir) {
        return [dirent('chat.jsonl', false)] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 200 } as any);

    const diag = getDiscoveryDiagnostics(storageUri);
    expect(diag.platform).toBe('darwin');
    expect(diag.homedir).toBe('/home/testuser');
    expect(diag.storageUri).toBe(storageUri.fsPath);
    expect(diag.chatSessionsDir).toBe(chatDir);
    expect(diag.filesFound).toEqual([path.join(chatDir, 'chat.jsonl')]);
  });
});
