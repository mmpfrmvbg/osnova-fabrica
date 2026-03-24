// apps/osiris/src/db/migrations.ts
// Применяет schema.sql через better-sqlite3.
// Экспортирует getDb() для использования в memory-engine.

import * as fs from 'fs';
import * as path from 'path';
import BetterSqlite3 from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

const DB_PATH = process.env.OSIRIS_DB_PATH
  ? path.resolve(process.env.OSIRIS_DB_PATH)
  : path.resolve(__dirname, '..', '..', 'osiris.db');

let _db: SqliteDatabase | null = null;
let _schemaApplied = false;

export function getDb(): SqliteDatabase {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new BetterSqlite3(DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

export function migrate(): void {
  if (_schemaApplied) return;
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  getDb().exec(sql);
  // Добавляем колонку если её ещё нет (идемпотентно)
  try {
    getDb().exec('ALTER TABLE facts ADD COLUMN last_accessed_at TEXT');
  } catch {
    // Колонка уже существует — игнорируем
  }
  _schemaApplied = true;
  console.log('[osiris:migrate] schema applied →', DB_PATH);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  _schemaApplied = false;
}
