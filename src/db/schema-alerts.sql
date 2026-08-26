-- ccledger alerting schema, applied whole by migration 4 via db.exec().
--
-- The two tables themselves came with migration 1, straight from the shape
-- `schema.sql` declares. What migration 4 adds is everything evaluation and
-- delivery need that a column list could not say: the indexes, plus — because
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, in migrate.ts — the columns
-- recording what became of each webhook.
--
-- Same rule as the other schema files: every statement is IF NOT EXISTS, so a
-- database left half-migrated by a crash can be brought forward by hand.

-- One fire per rule per member per window, enforced by the database rather than
-- by the check that precedes the insert.
--
-- The check is still there and does the ordinary work. This index is what holds
-- when two batches from the same member are evaluated before either has
-- finished delivering: the second insert loses to the constraint, its
-- `INSERT OR IGNORE` reports nothing changed, and no second webhook is sent.
-- Without it the debounce would be a read followed much later by a write, which
-- is not a debounce at all.
--
-- COALESCE because `alert_fires.member_id` is nullable and SQLite counts two
-- NULLs as distinct in a unique index. Every write in this program supplies a
-- member, so the wrapper only matters if that ever stops being true — which is
-- exactly the kind of change that would otherwise silently disable the debounce.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_fires_window
  ON alert_fires (rule_id, COALESCE(member_id, ''), window_start);

-- The dashboard's recent-fires list, newest first.
CREATE INDEX IF NOT EXISTS idx_alert_fires_fired_at ON alert_fires (fired_at DESC);

-- Evaluation runs on every ingest and opens by asking which rules apply to one
-- member: the ones naming them, plus the ones naming nobody.
CREATE INDEX IF NOT EXISTS idx_alert_rules_member ON alert_rules (member_id);
