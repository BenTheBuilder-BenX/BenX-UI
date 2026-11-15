CREATE TABLE owner_account (
  id INTEGER PRIMARY KEY CHECK(id=1),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  recovery_hash TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE installation_lock (
  id INTEGER PRIMARY KEY CHECK(id=1),
  claim_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
