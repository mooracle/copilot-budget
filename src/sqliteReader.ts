import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

interface SqlJsDatabase {
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  close(): void;
}

interface SqlJsModule {
  Database: new (data: Uint8Array) => SqlJsDatabase;
}

let sqlModule: SqlJsModule | null = null;

/**
 * Load the sql.js WASM module. Returns true on success, false on failure.
 * Subsequent calls return immediately if already initialized.
 */
export async function initSqlite(): Promise<boolean> {
  if (sqlModule) {
    return true;
  }
  try {
    const initSqlJs = require('sql.js');
    const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
    const wasmBinary = fs.readFileSync(wasmPath);
    sqlModule = await initSqlJs({ wasmBinary });
    log('sqliteReader: sql.js initialized successfully');
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`sqliteReader: failed to initialize sql.js: ${message}`);
    return false;
  }
}

/**
 * Returns true if sql.js has been loaded and is ready to use.
 */
export function isSqliteReady(): boolean {
  return sqlModule !== null;
}

/**
 * Read Copilot session JSON strings from a state.vscdb SQLite file.
 * Returns an array of JSON strings (one per matching row).
 * Returns [] on any error (corrupt DB, missing table, locked file, etc.).
 */
export function readSessionsFromVscdb(vscdbPath: string): string[] {
  if (!sqlModule) {
    return [];
  }
  let db: SqlJsDatabase | null = null;
  try {
    const fileBuffer = fs.readFileSync(vscdbPath);
    db = new sqlModule.Database(new Uint8Array(fileBuffer));
    const results = db.exec(
      "SELECT value FROM ItemTable WHERE key = 'interactive.sessions'"
    );
    if (results.length === 0 || results[0].values.length === 0) {
      return [];
    }
    const values: string[] = [];
    for (const row of results[0].values) {
      if (typeof row[0] === 'string' && row[0]) {
        values.push(row[0]);
      }
    }
    return values;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`sqliteReader: error reading ${vscdbPath}: ${message}`);
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Clean up the sql.js module reference.
 */
export function disposeSqlite(): void {
  sqlModule = null;
}
