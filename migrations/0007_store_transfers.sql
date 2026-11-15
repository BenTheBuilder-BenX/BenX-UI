ALTER TABLE telegram_orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'XTR';
ALTER TABLE telegram_orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'stars';
ALTER TABLE telegram_orders ADD COLUMN receipt TEXT NOT NULL DEFAULT '';
ALTER TABLE telegram_orders ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE telegram_orders ADD COLUMN reviewed_at INTEGER;
ALTER TABLE telegram_orders ADD COLUMN receipt_notified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_orders ADD COLUMN receipt_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE telegram_receipt_sessions (user_id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES telegram_orders(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
