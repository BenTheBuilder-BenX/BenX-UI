CREATE TABLE operation_settings (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('manual','automatic')), version INTEGER NOT NULL DEFAULT 1);
-- Preserve existing installations; new deployments without servers start in Manual.
INSERT INTO operation_settings(id,mode) SELECT 1, CASE WHEN EXISTS(SELECT 1 FROM servers) THEN 'automatic' ELSE 'manual' END;
ALTER TABLE managed_state ADD COLUMN requested_revision INTEGER NOT NULL DEFAULT 0;
UPDATE managed_state SET requested_revision=revision WHERE phase IN ('pending','applying','running','syncing');
