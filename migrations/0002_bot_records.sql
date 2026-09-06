-- Separate user preferences, expiring interaction views, and operational health
-- from authoritative match cursors. No existing state is reset or rewritten.
CREATE TABLE IF NOT EXISTS bot_records (
  record_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT
);
CREATE INDEX IF NOT EXISTS bot_records_expiry ON bot_records(expires_at);
