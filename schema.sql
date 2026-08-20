CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS account_state (
  account_id TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT,
  until INTEGER DEFAULT 0,
  hits INTEGER DEFAULT 0,
  fail_streak INTEGER DEFAULT 0,
  ok INTEGER DEFAULT 0,
  fail INTEGER DEFAULT 0,
  last_error TEXT,
  last_ok INTEGER,
  last_fail INTEGER
);
