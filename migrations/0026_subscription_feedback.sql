ALTER TABLE subscriptions ADD COLUMN rating INTEGER CHECK (rating BETWEEN 1 AND 5);

CREATE TABLE subscription_sellers (
  owner_id TEXT PRIMARY KEY REFERENCES team_members(id) ON DELETE CASCADE,
  support TEXT NOT NULL,
  purchase TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
