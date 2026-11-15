CREATE TABLE telegram_store (
  id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
  config TEXT NOT NULL, secrets TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
  webhook TEXT NOT NULL DEFAULT '', connected INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE telegram_orders (
  id TEXT PRIMARY KEY, update_key INTEGER NOT NULL UNIQUE, user_id INTEGER NOT NULL,
  product_name TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL, paid_at INTEGER, email TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL, provision TEXT NOT NULL DEFAULT '', delivery TEXT NOT NULL DEFAULT '',
  charge_id TEXT UNIQUE, lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX telegram_orders_work ON telegram_orders(status, lease_until);
CREATE INDEX telegram_orders_customer ON telegram_orders(user_id, created_at);
CREATE TABLE telegram_updates (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
