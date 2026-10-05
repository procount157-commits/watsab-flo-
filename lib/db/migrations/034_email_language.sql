-- English is the language email goes out in, unless the owner asks for
-- another: a default on the account, and a language on each campaign that
-- starts from it. A message is checked against its own campaign's language.
ALTER TABLE email_settings  ADD COLUMN IF NOT EXISTS default_language VARCHAR(5) NOT NULL DEFAULT 'en';
ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS language         VARCHAR(5) NOT NULL DEFAULT 'en';
-- How hard the follow-up path works: light (3 emails), normal (4), intense (6).
ALTER TABLE email_settings  ADD COLUMN IF NOT EXISTS follow_intensity VARCHAR(10) NOT NULL DEFAULT 'intense';
ALTER TABLE email_missions  ADD COLUMN IF NOT EXISTS intensity        VARCHAR(10);
