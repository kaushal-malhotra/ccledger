-- ccledger schema. Applied whole by migration 1 via db.exec().
--
-- Every statement is IF NOT EXISTS: the migration runner is the authority on
-- what has run, and a half-stamped database must still be re-runnable by hand.

CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

-- Keyed on Claude Code's `user.id`, which is a per-installation random id from
-- ~/.claude.json — not an account. One member can own several installs.
CREATE TABLE IF NOT EXISTS installs (
  id             TEXT PRIMARY KEY,
  member_id      TEXT NOT NULL REFERENCES members(id),
  hostname       TEXT,
  os_type        TEXT,
  os_version     TEXT,
  arch           TEXT,
  cc_version     TEXT,
  terminal_type  TEXT,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL
);

-- `id` is client_request_id, else request_id, else a hash of
-- (session_id, ts, input_tokens, output_tokens). INSERT OR IGNORE against this
-- primary key is what makes at-least-once OTLP delivery idempotent.
CREATE TABLE IF NOT EXISTS requests (
  id                     TEXT PRIMARY KEY,
  ts                     INTEGER NOT NULL,
  member_id              TEXT NOT NULL REFERENCES members(id),
  install_id             TEXT,
  session_id             TEXT,
  prompt_id              TEXT,
  model                  TEXT,
  model_family           TEXT,
  input_tokens           INTEGER DEFAULT 0,
  output_tokens          INTEGER DEFAULT 0,
  cache_read_tokens      INTEGER DEFAULT 0,
  cache_creation_tokens  INTEGER DEFAULT 0,
  cost_micros            INTEGER DEFAULT 0,
  duration_ms            INTEGER,
  query_source           TEXT,
  speed                  TEXT,
  effort                 TEXT
);

-- "window" is a SQLite keyword (window functions), so it is quoted here and in
-- every query that touches this table.
CREATE TABLE IF NOT EXISTS alert_rules (
  id           TEXT PRIMARY KEY,
  member_id    TEXT,
  "window"     TEXT NOT NULL,
  metric       TEXT NOT NULL,
  threshold    REAL NOT NULL,
  webhook_url  TEXT,
  enabled      INTEGER DEFAULT 1
);

-- `value` is REAL because the metric it records may be a percentage share or a
-- dollar figure, not just a token count.
CREATE TABLE IF NOT EXISTS alert_fires (
  id            TEXT PRIMARY KEY,
  rule_id       TEXT NOT NULL REFERENCES alert_rules(id),
  member_id     TEXT,
  fired_at      INTEGER NOT NULL,
  value         REAL NOT NULL,
  window_start  INTEGER NOT NULL
);

-- The three dashboard access paths: a date range, one member over a date range,
-- and the by-model breakdown.
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests (ts);
CREATE INDEX IF NOT EXISTS idx_requests_member_ts ON requests (member_id, ts);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests (model);
