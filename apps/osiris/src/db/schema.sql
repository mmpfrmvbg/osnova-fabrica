CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  project_hint TEXT DEFAULT 'unknown',
  session_id TEXT,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  project TEXT,
  text TEXT NOT NULL,
  source_message_id INTEGER,
  importance INTEGER DEFAULT 3,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(source_message_id) REFERENCES messages(id)
);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  project TEXT,
  period_start TEXT,
  period_end TEXT,
  text TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osnova_task_id TEXT NOT NULL,
  source_message_id INTEGER,
  source_fact_id INTEGER,
  project TEXT,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
  USING fts5(text, project, content='facts', content_rowid='id');

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open'
                       CHECK(status IN ('open','done')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  done_at      TEXT,
  -- Canonical workflow status for the new task system.
  -- Keep legacy `status` (open/done) for backward compatibility.
  workflow_status TEXT NOT NULL DEFAULT 'todo',
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  description  TEXT    NOT NULL DEFAULT '',
  type         TEXT    NOT NULL DEFAULT 'task',
  priority     INTEGER NOT NULL DEFAULT 3,
  size         TEXT    NOT NULL DEFAULT 'm',
  deadline     TEXT,
  assignee     TEXT,
  tags         TEXT    NOT NULL DEFAULT '[]',
  metadata     TEXT    NOT NULL DEFAULT '{}',
  recurrence_rule TEXT,
  recurrence_parent_id INTEGER,
  recurrence_root_id   INTEGER,
  recurrence_next_due_at TEXT,
  recurrence_last_generated_at TEXT,
  project      TEXT    NOT NULL DEFAULT 'general',
  created_from TEXT    DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT    NOT NULL,
  task_id        INTEGER NOT NULL,
  dependency_id INTEGER NOT NULL,
  kind           TEXT    NOT NULL DEFAULT 'blocking',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(task_id, dependency_id, kind)
);

CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  task_id     INTEGER NOT NULL,
  event_type  TEXT    NOT NULL,
  actor       TEXT    NOT NULL DEFAULT 'system',
  note        TEXT,
  payload     TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id, kind);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_dep  ON task_dependencies(dependency_id, kind);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS connectivity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT    NOT NULL,
  online     INTEGER NOT NULL CHECK(online IN (0, 1)),
  latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS core_memory (
  user_id   TEXT    PRIMARY KEY,
  content   TEXT    NOT NULL DEFAULT '{}',
  updated_at TEXT   NOT NULL,
  version   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS session_summaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  summary       TEXT    NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  type       TEXT    NOT NULL DEFAULT 'concept',
  metadata   TEXT    NOT NULL DEFAULT '{}',
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS relations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  from_id    INTEGER NOT NULL REFERENCES entities(id),
  to_id      INTEGER NOT NULL REFERENCES entities(id),
  predicate  TEXT    NOT NULL,
  weight     REAL    NOT NULL DEFAULT 1.0,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id, name);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_id);

CREATE TABLE IF NOT EXISTS consolidation_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  ran_at        TEXT    NOT NULL,
  facts_before  INTEGER NOT NULL DEFAULT 0,
  facts_after   INTEGER NOT NULL DEFAULT 0,
  removed_ids   TEXT    NOT NULL DEFAULT '[]',
  summary       TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS thoughts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  message_id INTEGER,
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

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
);

