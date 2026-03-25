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

  // ── New task system columns (workflow_status + rich fields) ──────────
  // Legacy DB might already have some of these columns; ALTER is wrapped for idempotency.
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'todo'"); } catch {}
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))"); } catch {}
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''"); } catch {}
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'task'"); } catch {}
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 3"); } catch {}
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN size TEXT NOT NULL DEFAULT 'm'"); } catch {}
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN deadline TEXT"); } catch {}
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN assignee TEXT"); } catch {}
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'"); } catch {}
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'"); } catch {}
  try { getDb().exec("ALTER TABLE tasks ADD COLUMN recurrence_rule TEXT"); } catch {}
  try { getDb().exec('ALTER TABLE tasks ADD COLUMN recurrence_parent_id INTEGER'); } catch {}
  try { getDb().exec('ALTER TABLE tasks ADD COLUMN recurrence_root_id INTEGER'); } catch {}
  try { getDb().exec('ALTER TABLE tasks ADD COLUMN recurrence_next_due_at TEXT'); } catch {}
  try { getDb().exec('ALTER TABLE tasks ADD COLUMN recurrence_last_generated_at TEXT'); } catch {}

  // Bootstrap workflow_status for legacy rows.
  try {
    getDb().exec(
      `UPDATE tasks
       SET workflow_status = CASE
         WHEN status = 'done' THEN 'done'
         ELSE COALESCE(workflow_status, 'todo')
       END
       WHERE workflow_status IS NULL`,
    );
  } catch {
    // no-op
  }

  // ── New task system tables ────────────────────────────────────────────
  // (Usually created by schema.sql, but keep idempotent safety for older DBs)
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS task_dependencies (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        TEXT    NOT NULL,
        task_id        INTEGER NOT NULL,
        dependency_id INTEGER NOT NULL,
        kind           TEXT    NOT NULL DEFAULT 'blocking',
        created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_id, dependency_id, kind)
      )
    `);
  } catch {}
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT    NOT NULL,
        task_id     INTEGER NOT NULL,
        event_type  TEXT    NOT NULL,
        actor       TEXT    NOT NULL DEFAULT 'system',
        note        TEXT,
        payload     TEXT    NOT NULL DEFAULT '{}',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch {}
  try {
    getDb().exec('CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id, kind)');
    getDb().exec('CREATE INDEX IF NOT EXISTS idx_task_dependencies_dep  ON task_dependencies(dependency_id, kind)');
    getDb().exec('CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at DESC)');
  } catch {}
  // Добавляем колонку если её ещё нет (идемпотентно)
  try {
    getDb().exec('ALTER TABLE facts ADD COLUMN last_accessed_at TEXT');
  } catch {
    // Колонка уже существует — игнорируем
  }
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS training_samples (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
        user_id           TEXT    NOT NULL,
        user_message      TEXT    NOT NULL,
        assistant_reply   TEXT    NOT NULL,
        tool_calls        TEXT,
        context_snapshot  TEXT,
        quality           INTEGER DEFAULT NULL
      )
    `);
    getDb().exec(
      'CREATE INDEX IF NOT EXISTS idx_training_user ON training_samples(user_id)'
    );
  } catch {
    // уже существует — игнорируем
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

export function seedCoreMemoryIfEmpty(userId: string): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT COUNT(*) as cnt FROM core_memory WHERE user_id = ?')
    .get(userId) as { cnt: number };
  if (existing.cnt > 0) return;

  const content = JSON.stringify({
    user: {
      name: 'Создатель',
      role: 'основатель проекта Основа',
      style: null,
      current_focus: 'разработка языка Основа и экосистемы'
    },
    project: {
      name: 'Основа',
      stack: 'TypeScript, язык Основа, SQLite, Android',
      state: 'активная разработка',
      description: 'Закрытая технологическая экосистема с языком программирования на русском. Фабрика генерирует приложения автономно. ОСИРИС — персональный ассистент. Репозиторий: mmpfrmvbg/osnova-fabrica.',
      horizon: 'собственная ОС, всё на языке Основа, VLIW-ready'
    },
    meta: {
      interaction_count: 0,
      last_session: null
    }
  });

  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO core_memory (user_id, content, updated_at, version) VALUES (?, ?, ?, 1)'
  ).run(userId, content, now);

  console.log('[osiris:seed] coreMemory seeded for', userId);
}
