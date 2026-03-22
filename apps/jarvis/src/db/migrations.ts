// apps/jarvis/src/db/migrations.ts
// Применяет schema.sql к SQLite БД через better-sqlite3.
// TODO: установить better-sqlite3 в apps/jarvis/

import * as fs from 'fs';
import * as path from 'path';

// Lazy import: better-sqlite3 не установлен до npm install в apps/jarvis/
type BetterSqlite3Database = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown };
};

let _db: BetterSqlite3Database | null = null;

function getDb(): BetterSqlite3Database {
  if (_db) return _db;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as new (
    path: string,
    opts?: object,
  ) => BetterSqlite3Database;
  const dbPath = path.resolve(__dirname, '..', '..', 'data', 'jarvis.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(dbPath);
  return _db;
}

/**
 * Применяет schema.sql к БД.
 * Идемпотентна — использует IF NOT EXISTS.
 */
export function migrate(): void {
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  getDb().exec(sql);
  console.log('[jarvis:migrate] schema applied');
}
