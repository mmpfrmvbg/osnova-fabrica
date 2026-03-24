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
  // core_memory table — idempotent
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS core_memory (
        user_id    TEXT    PRIMARY KEY,
        content    TEXT    NOT NULL DEFAULT '{}',
        updated_at TEXT    NOT NULL,
        version    INTEGER NOT NULL DEFAULT 1
      )
    `);
  } catch {
    // уже существует — игнорируем
  }
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       TEXT    NOT NULL,
        summary       TEXT    NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL
      )
    `);
  } catch {
    // уже существует — игнорируем
  }
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT    NOT NULL,
        name       TEXT    NOT NULL,
        type       TEXT    NOT NULL DEFAULT 'concept',
        metadata   TEXT    NOT NULL DEFAULT '{}',
        created_at TEXT    NOT NULL
      )
    `);
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS relations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT    NOT NULL,
        from_id    INTEGER NOT NULL REFERENCES entities(id),
        to_id      INTEGER NOT NULL REFERENCES entities(id),
        predicate  TEXT    NOT NULL,
        weight     REAL    NOT NULL DEFAULT 1.0,
        created_at TEXT    NOT NULL
      )
    `);
    getDb().exec('CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id, name)');
    getDb().exec('CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id)');
    getDb().exec('CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_id)');
  } catch {
    // уже существует — игнорируем
  }
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS consolidation_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       TEXT    NOT NULL,
        ran_at        TEXT    NOT NULL,
        facts_before  INTEGER NOT NULL DEFAULT 0,
        facts_after   INTEGER NOT NULL DEFAULT 0,
        removed_ids   TEXT    NOT NULL DEFAULT '[]',
        summary       TEXT    NOT NULL DEFAULT ''
      )
    `);
  } catch {
    // уже существует — игнорируем
  }
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS thoughts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT    NOT NULL,
        message_id INTEGER,
        content    TEXT    NOT NULL,
        created_at TEXT    NOT NULL
      )
    `);
  } catch {
    // уже существует — игнорируем
  }
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS autonomous_jobs (
        id             TEXT    PRIMARY KEY,
        user_id        TEXT    NOT NULL,
        goal           TEXT    NOT NULL,
        status         TEXT    NOT NULL DEFAULT 'pending',
        steps          TEXT    NOT NULL DEFAULT '[]',
        result         TEXT,
        error          TEXT,
        iteration      INTEGER NOT NULL DEFAULT 0,
        max_iterations INTEGER NOT NULL DEFAULT 20,
        created_at     TEXT    NOT NULL,
        updated_at     TEXT    NOT NULL
      )
    `);
  } catch {
    // уже существует — игнорируем
  }
  // Add project column to tasks if not exists
  try {
    getDb().exec(
      "ALTER TABLE tasks ADD COLUMN project TEXT NOT NULL DEFAULT 'general'",
    );
  } catch {
    // уже существует — игнорируем
  }
  try {
    getDb().exec(
      'ALTER TABLE tasks ADD COLUMN created_from TEXT DEFAULT NULL',
    );
  } catch {
    // уже существует — игнорируем
  }
  // Добавляем колонку если её ещё нет (идемпотентно)
  try {
    getDb().exec('ALTER TABLE facts ADD COLUMN last_accessed_at TEXT');
  } catch {
    // Колонка уже существует — игнорируем
  }
  _schemaApplied = true;
  console.log('[osiris:migrate] schema applied →', DB_PATH);
}

export function ensureInit(): void {
  migrate();
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  _schemaApplied = false;
}
