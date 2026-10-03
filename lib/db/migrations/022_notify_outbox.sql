-- Reports that survive the laptop going to sleep.
--
-- The owner said no reports ever reached Telegram. They were sent: the code
-- calls notify() on every campaign launch, every guard hold, every reply. What
-- happened to them is in two numbers — this Mac sleeps after one minute on
-- battery and did so three times in the hour this was written, and the
-- application log carries 1,734 network failures. notify() caught each one,
-- logged it, returned false, and the report was gone for good.
--
-- A message is written down before it is sent now, and a failure is a retry
-- rather than an ending.
--
-- Apply with:  psql "$DATABASE_URL" -f lib/db/migrations/022_notify_outbox.sql
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS notify_outbox (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  -- What it is about, so a burst of the same kind can be collapsed.
  kind        VARCHAR(40) NOT NULL DEFAULT 'general',
  -- pending | sent | dead
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  -- Backs off: a laptop that is asleep now is likely asleep in ten seconds.
  next_try_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON notify_outbox (status, next_try_at);
CREATE INDEX IF NOT EXISTS idx_outbox_user ON notify_outbox (user_id, created_at DESC);
