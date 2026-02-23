import { initSqlite, readSessionsFromVscdb, isSqliteReady, disposeSqlite } from './sqliteReader';

jest.mock('fs');
jest.mock('./logger');

const mockExec = jest.fn();
const mockClose = jest.fn();
const mockDatabase = jest.fn().mockImplementation(() => ({
  exec: mockExec,
  close: mockClose,
}));

jest.mock('sql.js', () => {
  return jest.fn().mockImplementation(() =>
    Promise.resolve({
      Database: mockDatabase,
    })
  );
});

const fs = require('fs');

describe('sqliteReader', () => {
  beforeEach(() => {
    disposeSqlite();
    jest.clearAllMocks();
    fs.readFileSync.mockReturnValue(Buffer.from('mock-wasm'));
  });

  describe('initSqlite', () => {
    it('initializes sql.js successfully', async () => {
      const result = await initSqlite();
      expect(result).toBe(true);
      expect(isSqliteReady()).toBe(true);
    });

    it('returns true immediately if already initialized', async () => {
      await initSqlite();
      const initSqlJs = require('sql.js');
      (initSqlJs as jest.Mock).mockClear();

      const result = await initSqlite();
      expect(result).toBe(true);
      expect(initSqlJs).not.toHaveBeenCalled();
    });

    it('returns false when sql.js fails to load', async () => {
      const initSqlJs = require('sql.js');
      (initSqlJs as jest.Mock).mockImplementationOnce(() =>
        Promise.reject(new Error('WASM load failed'))
      );

      const result = await initSqlite();
      expect(result).toBe(false);
      expect(isSqliteReady()).toBe(false);
    });

    it('returns false when WASM file cannot be read', async () => {
      fs.readFileSync.mockImplementationOnce(() => {
        throw new Error('ENOENT');
      });

      const result = await initSqlite();
      expect(result).toBe(false);
      expect(isSqliteReady()).toBe(false);
    });
  });

  describe('isSqliteReady', () => {
    it('returns false before init', () => {
      expect(isSqliteReady()).toBe(false);
    });

    it('returns true after successful init', async () => {
      await initSqlite();
      expect(isSqliteReady()).toBe(true);
    });

    it('returns false after dispose', async () => {
      await initSqlite();
      disposeSqlite();
      expect(isSqliteReady()).toBe(false);
    });
  });

  describe('readSessionsFromVscdb', () => {
    beforeEach(async () => {
      await initSqlite();
      // Reset readFileSync to return db buffer for vscdb reads
      fs.readFileSync.mockReturnValue(Buffer.from('mock-db'));
    });

    it('returns JSON strings when key exists', () => {
      mockExec.mockReturnValue([
        { columns: ['value'], values: [['{"sessions": []}']]}
      ]);

      const result = readSessionsFromVscdb('/path/to/state.vscdb');
      expect(result).toEqual(['{"sessions": []}']);
      expect(mockDatabase).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(mockClose).toHaveBeenCalled();
    });

    it('returns multiple rows when multiple values exist', () => {
      mockExec.mockReturnValue([
        { columns: ['value'], values: [['{"a":1}'], ['{"b":2}']]}
      ]);

      const result = readSessionsFromVscdb('/path/to/state.vscdb');
      expect(result).toEqual(['{"a":1}', '{"b":2}']);
    });

    it('returns empty array when key does not exist', () => {
      mockExec.mockReturnValue([]);

      const result = readSessionsFromVscdb('/path/to/state.vscdb');
      expect(result).toEqual([]);
      expect(mockClose).toHaveBeenCalled();
    });

    it('returns empty array when result has no rows', () => {
      mockExec.mockReturnValue([{ columns: ['value'], values: [] }]);

      const result = readSessionsFromVscdb('/path/to/state.vscdb');
      expect(result).toEqual([]);
    });

    it('returns empty array on corrupt database', () => {
      mockDatabase.mockImplementationOnce(() => {
        throw new Error('not a database');
      });

      const result = readSessionsFromVscdb('/path/to/corrupt.vscdb');
      expect(result).toEqual([]);
    });

    it('returns empty array when table does not exist', () => {
      mockExec.mockImplementationOnce(() => {
        throw new Error('no such table: ItemTable');
      });

      const result = readSessionsFromVscdb('/path/to/state.vscdb');
      expect(result).toEqual([]);
      expect(mockClose).toHaveBeenCalled();
    });

    it('returns empty array when file cannot be read', () => {
      fs.readFileSync.mockImplementationOnce(() => {
        throw new Error('ENOENT');
      });

      const result = readSessionsFromVscdb('/path/to/missing.vscdb');
      expect(result).toEqual([]);
    });

    it('returns empty array when not initialized', () => {
      disposeSqlite();
      const result = readSessionsFromVscdb('/path/to/state.vscdb');
      expect(result).toEqual([]);
    });

    it('skips non-string values in rows', () => {
      mockExec.mockReturnValue([
        { columns: ['value'], values: [[null], ['{"valid": true}'], [123]] }
      ]);

      const result = readSessionsFromVscdb('/path/to/state.vscdb');
      expect(result).toEqual(['{"valid": true}']);
    });

    it('skips empty string values', () => {
      mockExec.mockReturnValue([
        { columns: ['value'], values: [[''], ['{"data": 1}']] }
      ]);

      const result = readSessionsFromVscdb('/path/to/state.vscdb');
      expect(result).toEqual(['{"data": 1}']);
    });
  });

  describe('disposeSqlite', () => {
    it('resets sql module state', async () => {
      await initSqlite();
      expect(isSqliteReady()).toBe(true);
      disposeSqlite();
      expect(isSqliteReady()).toBe(false);
    });

    it('can be called multiple times safely', () => {
      disposeSqlite();
      disposeSqlite();
      expect(isSqliteReady()).toBe(false);
    });

    it('allows re-initialization after dispose', async () => {
      await initSqlite();
      disposeSqlite();
      const result = await initSqlite();
      expect(result).toBe(true);
      expect(isSqliteReady()).toBe(true);
    });
  });
});
