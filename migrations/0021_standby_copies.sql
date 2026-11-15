CREATE TABLE standby_copies (
  target_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  source_revision INTEGER NOT NULL DEFAULT 0,
  target_revision INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  CHECK (source_id != target_id)
);
CREATE INDEX standby_source ON standby_copies(source_id);
