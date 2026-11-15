ALTER TABLE servers ADD COLUMN is_candidate INTEGER NOT NULL DEFAULT 0;
UPDATE servers SET is_candidate=1 WHERE id IN (SELECT candidate_id FROM replacements) OR parent_id IN (SELECT candidate_id FROM replacements);
