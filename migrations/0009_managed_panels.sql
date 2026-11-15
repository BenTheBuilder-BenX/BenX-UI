ALTER TABLE servers ADD COLUMN parent_id TEXT REFERENCES servers(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX one_managed_panel_per_server ON servers(parent_id) WHERE parent_id IS NOT NULL;
