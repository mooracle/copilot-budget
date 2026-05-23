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
import { __configStore } from './__mocks__/vscode';
import { discoverSessionIds, getDiscoveryDiagnostics } from './sessionDiscovery';

beforeEach(() => {
  jest.resetAllMocks();
  mockOs.homedir.mockReturnValue('/home/testuser');
  mockOs.platform.mockReturnValue('darwin');
  for (const k of Object.keys(__configStore)) delete __configStore[k];
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

function transcriptsDirFor(storageUri: vscode.Uri): string {
  return path.join(
    path.dirname(storageUri.fsPath),
    'GitHub.copilot-chat',
    'transcripts',
  );
}

function legacyDirFor(storageUri: vscode.Uri): string {
  return path.join(path.dirname(storageUri.fsPath), 'chatSessions');
}

describe('discoverSessionIds', () => {
  it('returns [] when storageUri is undefined', () => {
    const ids = discoverSessionIds(undefined);
    expect(ids).toEqual([]);
    expect(mockFs.readdirSync).not.toHaveBeenCalled();
  });

  it('returns [] when neither directory exists', () => {
    mockFs.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const ids = discoverSessionIds(makeStorageUri());
    expect(ids).toEqual([]);
  });

  it('returns session IDs (UUID stems) from the new transcripts directory', () => {
    const storageUri = makeStorageUri();
    const transcriptsDir = transcriptsDirFor(storageUri);

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === transcriptsDir) {
        return [
          dirent('11111111-2222-3333-4444-555555555555.jsonl', false),
          dirent('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl', false),
        ] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const ids = discoverSessionIds(storageUri);
    expect(ids).toEqual([
      '11111111-2222-3333-4444-555555555555',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ]);
  });

  it('falls back to the legacy chatSessions directory when transcripts is empty', () => {
    const storageUri = makeStorageUri();
    const legacyDir = legacyDirFor(storageUri);

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === legacyDir) {
        return [dirent('legacy-uuid.jsonl', false)] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const ids = discoverSessionIds(storageUri);
    expect(ids).toEqual(['legacy-uuid']);
  });

  it('merges IDs from both directories, primary scanned first', () => {
    const storageUri = makeStorageUri();
    const transcriptsDir = transcriptsDirFor(storageUri);
    const legacyDir = legacyDirFor(storageUri);

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      const dir = p.toString();
      if (dir === transcriptsDir) {
        return [dirent('aaa.jsonl', false)] as any;
      }
      if (dir === legacyDir) {
        return [dirent('bbb.jsonl', false)] as any;
      }
      throw new Error(`ENOENT: ${dir}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const ids = discoverSessionIds(storageUri);
    // Primary directory results come first
    expect(ids).toEqual(['aaa', 'bbb']);
  });

  it('dedupes IDs that appear in both directories by stem', () => {
    const storageUri = makeStorageUri();
    const transcriptsDir = transcriptsDirFor(storageUri);
    const legacyDir = legacyDirFor(storageUri);

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      const dir = p.toString();
      if (dir === transcriptsDir) {
        return [
          dirent('shared.jsonl', false),
          dirent('only-new.jsonl', false),
        ] as any;
      }
      if (dir === legacyDir) {
        return [
          dirent('shared.jsonl', false),
          dirent('only-old.jsonl', false),
        ] as any;
      }
      throw new Error(`ENOENT: ${dir}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const ids = discoverSessionIds(storageUri);
    expect(ids).toEqual(['shared', 'only-new', 'only-old']);
  });

  it('returns only .jsonl files (excludes legacy .json and other extensions)', () => {
    const storageUri = makeStorageUri();
    const transcriptsDir = transcriptsDirFor(storageUri);

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === transcriptsDir) {
        return [
          dirent('legacy-session.json', false),
          dirent('session2.jsonl', false),
          dirent('readme.txt', false),
        ] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const ids = discoverSessionIds(storageUri);
    expect(ids).toEqual(['session2']);
  });

  it('filters out non-session filenames (embeddings, index, cache, etc.) via NON_SESSION_PATTERNS', () => {
    const storageUri = makeStorageUri();
    const transcriptsDir = transcriptsDirFor(storageUri);

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === transcriptsDir) {
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

    const ids = discoverSessionIds(storageUri);
    expect(ids).toEqual(['actual-session']);
  });

  it('skips zero-byte files', () => {
    const storageUri = makeStorageUri();
    const transcriptsDir = transcriptsDirFor(storageUri);

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === transcriptsDir) {
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

    const ids = discoverSessionIds(storageUri);
    expect(ids).toEqual(['session']);
  });

  it('skips subdirectories inside the transcripts directory', () => {
    const storageUri = makeStorageUri();
    const transcriptsDir = transcriptsDirFor(storageUri);

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === transcriptsDir) {
        return [
          dirent('nested', true),
          dirent('session.jsonl', false),
        ] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 100 } as any);

    const ids = discoverSessionIds(storageUri);
    expect(ids).toEqual(['session']);
  });

  it('skips files older than sessionMaxAgeDays (default 7)', () => {
    const storageUri = makeStorageUri();
    const transcriptsDir = transcriptsDirFor(storageUri);

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === transcriptsDir) {
        return [
          dirent('fresh.jsonl', false),
          dirent('stale.jsonl', false),
        ] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });

    const now = Date.now();
    const fiveDays = 5 * 86_400_000;
    const tenDays = 10 * 86_400_000;
    mockFs.statSync.mockImplementation((p: fs.PathLike) => {
      const name = p.toString();
      if (name.endsWith('fresh.jsonl')) return { size: 100, mtimeMs: now - fiveDays } as any;
      return { size: 100, mtimeMs: now - tenDays } as any;
    });

    const ids = discoverSessionIds(storageUri);
    expect(ids).toEqual(['fresh']);
  });

  it('respects custom sessionMaxAgeDays value', () => {
    const storageUri = makeStorageUri();
    const transcriptsDir = transcriptsDirFor(storageUri);
    __configStore['copilot-budget.sessionMaxAgeDays'] = 30;

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === transcriptsDir) {
        return [dirent('twoWeeksOld.jsonl', false)] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({
      size: 100,
      mtimeMs: Date.now() - 14 * 86_400_000,
    } as any);

    const ids = discoverSessionIds(storageUri);
    expect(ids).toEqual(['twoWeeksOld']);
  });

  it('scans all files when sessionMaxAgeDays=0 (filter disabled)', () => {
    const storageUri = makeStorageUri();
    const transcriptsDir = transcriptsDirFor(storageUri);
    __configStore['copilot-budget.sessionMaxAgeDays'] = 0;

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === transcriptsDir) {
        return [dirent('ancient.jsonl', false)] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({
      size: 100,
      mtimeMs: Date.now() - 365 * 86_400_000,
    } as any);

    const ids = discoverSessionIds(storageUri);
    expect(ids).toEqual(['ancient']);
  });

  it('resolves transcripts and legacy paths one level up from storageUri', () => {
    // Regression guard for the one-`..`-vs-two mistake.
    const storageUri = vscode.Uri.file(
      '/path/workspaceStorage/abc123/pub.ext',
    );
    const expectedTranscriptsDir =
      '/path/workspaceStorage/abc123/GitHub.copilot-chat/transcripts';
    const expectedLegacyDir = '/path/workspaceStorage/abc123/chatSessions';

    const seenPaths: string[] = [];
    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      seenPaths.push(p.toString());
      return [] as any;
    });

    discoverSessionIds(storageUri);
    expect(seenPaths).toEqual([expectedTranscriptsDir, expectedLegacyDir]);
  });
});

describe('getDiscoveryDiagnostics', () => {
  it('returns disabled shape when storageUri is undefined', () => {
    const diag = getDiscoveryDiagnostics(undefined);
    expect(diag.platform).toBe('darwin');
    expect(diag.homedir).toBe('/home/testuser');
    expect(diag.storageUri).toBeNull();
    expect(diag.transcriptsDir).toBeNull();
    expect(diag.legacyChatSessionsDir).toBeNull();
    expect(diag.filesFound).toEqual([]);
    expect(mockFs.readdirSync).not.toHaveBeenCalled();
  });

  it('returns both paths and session IDs found when storageUri is defined', () => {
    const storageUri = makeStorageUri('xyz789');
    const transcriptsDir = transcriptsDirFor(storageUri);
    const legacyDir = legacyDirFor(storageUri);

    mockFs.readdirSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
      if (p.toString() === transcriptsDir) {
        return [dirent('chat.jsonl', false)] as any;
      }
      throw new Error(`ENOENT: ${p}`);
    });
    mockFs.statSync.mockReturnValue({ size: 200 } as any);

    const diag = getDiscoveryDiagnostics(storageUri);
    expect(diag.platform).toBe('darwin');
    expect(diag.homedir).toBe('/home/testuser');
    expect(diag.storageUri).toBe(storageUri.fsPath);
    expect(diag.transcriptsDir).toBe(transcriptsDir);
    expect(diag.legacyChatSessionsDir).toBe(legacyDir);
    expect(diag.filesFound).toEqual(['chat']);
  });
});
