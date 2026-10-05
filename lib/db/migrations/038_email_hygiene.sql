-- Hold back the addresses most likely to bounce. The account's first bounces
-- were not dead domains (all five had mail servers) but people who had left
-- large brokerages: a personal mailbox at a company where another personal
-- mailbox already bounced is the riskiest address on the list. On by default;
-- such addresses stay in their lists and can be sent to by switching it off.
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS skip_risky BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE email_contacts ADD COLUMN IF NOT EXISTS mx_checked_at TIMESTAMPTZ;
