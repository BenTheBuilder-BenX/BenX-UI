CREATE TABLE usage_refresh_settings (id INTEGER PRIMARY KEY CHECK(id=1), interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(interval_minutes IN (0,15,60,180,360,1440)), version INTEGER NOT NULL DEFAULT 1);
INSERT INTO usage_refresh_settings(id) VALUES(1);
CREATE TABLE usage_refresh_state (server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE, attempted_at INTEGER NOT NULL DEFAULT 0, refreshed_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
