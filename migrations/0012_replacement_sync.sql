-- Polling and switching share one durable replacement lease.
ALTER TABLE replacements ADD COLUMN lease TEXT;
ALTER TABLE replacements ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE replacements ADD COLUMN verified_revisions TEXT NOT NULL DEFAULT '{}';
