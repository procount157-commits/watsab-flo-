-- The sectors the email team works — empty for all. Pick «عقارات» and only
-- real estate is written to, each sector with its own campaign.
ALTER TABLE email_autopilot ADD COLUMN IF NOT EXISTS sectors JSONB NOT NULL DEFAULT '[]'::jsonb;
