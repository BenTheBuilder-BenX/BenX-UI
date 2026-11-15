CREATE TABLE server_policy (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE tunnels (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES servers(id),
  target_id TEXT NOT NULL REFERENCES servers(id),
  state TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
