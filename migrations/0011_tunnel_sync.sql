-- Tunnel intent survives failed requests and server replacement.
ALTER TABLE tunnels ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'configured';
ALTER TABLE tunnels ADD COLUMN lease TEXT;
ALTER TABLE tunnels ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tunnels ADD COLUMN error TEXT NOT NULL DEFAULT '';
UPDATE tunnels SET desired_state='removed' WHERE state IN ('removed','removing','cleanup-required');
CREATE INDEX tunnels_sync ON tunnels(desired_state,state,updated_at);
