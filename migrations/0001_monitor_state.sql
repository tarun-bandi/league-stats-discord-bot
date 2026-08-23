CREATE TABLE IF NOT EXISTS monitor_state (
  state_key TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  updated_at TEXT NOT NULL
);
