-- The guard that paused every campaign and never resumed them. A hold now
-- survives a restart, counts only what happened after it, and lifts itself:
-- campaigns it paused go back to sending when it ends, while campaigns the
-- owner paused stay paused.
ALTER TABLE email_settings  ADD COLUMN IF NOT EXISTS guard_held_at    TIMESTAMPTZ;
ALTER TABLE email_settings  ADD COLUMN IF NOT EXISTS guard_hold_until TIMESTAMPTZ;
ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS paused_by        VARCHAR(10);
-- Whoever the guard paused before this is the guard's to resume.
UPDATE email_campaigns SET paused_by = 'guard' WHERE status = 'paused' AND pause_reason LIKE '%ارتدّت%';
-- Replying to a voice note in a voice note: off | mirror (answer voice with voice)
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS voice_replies VARCHAR(10) NOT NULL DEFAULT 'mirror';
