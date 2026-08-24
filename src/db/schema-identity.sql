-- ccledger identity schema, applied whole by migration 3 via db.exec().
--
-- Same rule as schema.sql: every statement is IF NOT EXISTS, so a database left
-- half-migrated by a crash can be brought forward by hand without editing it.
-- The two `members` columns this migration also adds are not here, because
-- SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; migrate.ts guards
-- those on `pragma_table_info` instead.

-- One row per outstanding invitation. The code is stored in the clear: it is
-- single-use, expires in 24 hours, and `ccledger invite` has to be able to
-- reprint nothing — a hash would buy nothing here and would cost the ability
-- to tell an admin which invitations are still open.
CREATE TABLE IF NOT EXISTS join_codes (
  code          TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  -- NULL until claimed. Never cleared: the single-use guarantee is the
  -- `used_at IS NULL` predicate on the claiming UPDATE, and it only holds
  -- because nothing in this program ever sets this column back to NULL.
  used_at       INTEGER,
  member_id     TEXT REFERENCES members(id)
);

-- Expiry sweeps scan by date, not by code.
CREATE INDEX IF NOT EXISTS idx_join_codes_expires ON join_codes (expires_at);

-- Single-row-per-key server state: the admin token hash, the server's display
-- name, the URL teammates reach it on. A table rather than a sidecar file so a
-- backup of the database is a backup of the whole server.
CREATE TABLE IF NOT EXISTS server_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
