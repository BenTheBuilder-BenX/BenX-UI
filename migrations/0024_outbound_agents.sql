-- Outbound agents need no inbound management port or shared SSH relay.
CREATE TABLE agent_connections (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  pairing_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','connected','revoked'))
);
CREATE TABLE agent_commands (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES agent_connections(server_id) ON DELETE CASCADE,
  request TEXT NOT NULL,
  response TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','claimed','completed','expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX agent_commands_queue ON agent_commands(server_id,state,created_at);
