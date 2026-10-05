-- One topic, every channel: an email newsletter, a LinkedIn post, an
-- Instagram caption and a TikTok script written from the same idea, on one
-- date of the weekly content calendar.
CREATE TABLE IF NOT EXISTS content_plans (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic             TEXT NOT NULL,
  publish_on        DATE NOT NULL,
  channels          JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_template_id INTEGER,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_plans ON content_plans (user_id, publish_on);
ALTER TABLE social_content ADD COLUMN IF NOT EXISTS plan_id INTEGER;
