-- The owner's morning brief from شمّة: one Telegram message at a set hour
-- with what waits for him, who is hot, what is late, and what broke.
CREATE TABLE IF NOT EXISTS brief_settings (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  -- Gulf hour
  hour          INTEGER NOT NULL DEFAULT 8,
  last_sent_on  DATE
);

-- Every time the machine slept, as the wake detector saw it. Before this it
-- was a log line; the brief now says "the Mac slept 3 times last night".
CREATE TABLE IF NOT EXISTS host_sleeps (
  id          SERIAL PRIMARY KEY,
  woke_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seconds     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_sleeps ON host_sleeps (woke_at DESC);
