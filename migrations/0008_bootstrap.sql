CREATE TABLE bootstrap_jobs (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
