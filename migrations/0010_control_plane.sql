-- Logical server identity survives a VPS replacement. Configuration secrets are encrypted.
CREATE TABLE managed_state (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  document TEXT NOT NULL,
  applied_revision INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  bound INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE managed_versions (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, revision)
);
CREATE TABLE replacements (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES servers(id),
  state TEXT NOT NULL DEFAULT 'installing',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE fleet_inbounds (
  id TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  inbound_id INTEGER NOT NULL,
  PRIMARY KEY (id, server_id)
);
