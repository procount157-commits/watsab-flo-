-- Why 8,235 contacts could vanish without anyone noticing.
--
-- Between the backups of 1 and 2 October this account lost 8,235 e-mail
-- contacts and all 20,328 list memberships. Nothing recorded who did it, from
-- where, or how many rows went — the only evidence was 1,939 queued messages
-- cancelled with "the contact was deleted before sending", and a mission that
-- approved and then failed with "nobody in this audience can be messaged".
--
-- Two things follow. Every destructive action is written down. And a bulk
-- delete keeps what it removed, so the next one is undone with a button
-- instead of a backup file and an afternoon.
--
-- Apply with:  psql "$DATABASE_URL" -f lib/db/migrations/021_email_safety.sql
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- contacts.delete | list.delete | contacts.unsubscribe | campaign.stop …
  action      VARCHAR(40) NOT NULL,
  -- How many rows it touched. The number nobody had.
  affected    INTEGER NOT NULL DEFAULT 0,
  -- owner | agent:<role> | system
  actor       VARCHAR(40) NOT NULL DEFAULT 'owner',
  -- Enough to understand it later without the rows themselves.
  detail      TEXT,
  -- The removed rows, when they can be put back.
  snapshot    JSONB,
  -- Set once restored, so one snapshot is not applied twice.
  restored_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (user_id, action, created_at DESC);
