ALTER TABLE team_members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE team_members ADD COLUMN server_scope TEXT NOT NULL DEFAULT '{"all":false,"ids":[]}';
CREATE TABLE workspace_settings (id INTEGER PRIMARY KEY CHECK(id=1), owner_path TEXT NOT NULL UNIQUE);
