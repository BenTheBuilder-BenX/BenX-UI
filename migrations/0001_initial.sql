PRAGMA foreign_keys = ON;
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT 'v3',
  kind TEXT NOT NULL DEFAULT 'panel',
  auth TEXT NOT NULL,
  credentials TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  subscription_url TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,
  online INTEGER NOT NULL,
  latency INTEGER NOT NULL,
  snapshot TEXT,
  error TEXT
);
CREATE INDEX health_server_time ON health(server_id, timestamp DESC);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  actor TEXT NOT NULL,
  server_id TEXT,
  action TEXT NOT NULL,
  success INTEGER NOT NULL
);
CREATE INDEX audit_time ON audit(timestamp DESC);
CREATE TABLE login_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
