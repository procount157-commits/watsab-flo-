-- The open-rate checkpoint: a campaign's subject test is judged after a day,
-- and when almost nobody opened, the rest is held, the subject rewritten and
-- tried again on a fresh slice — at most twice — before anything else goes.
ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS ab_round     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS low_open_at  TIMESTAMPTZ;
