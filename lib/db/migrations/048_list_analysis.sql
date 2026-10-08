-- سلمى's reading of a list: what is in it, what is wrong with it, and which
-- campaign each part of it should get — written when the list is uploaded.
ALTER TABLE email_lists ADD COLUMN IF NOT EXISTS analysis JSONB;
ALTER TABLE email_lists ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;
