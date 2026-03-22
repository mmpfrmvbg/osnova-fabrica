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
