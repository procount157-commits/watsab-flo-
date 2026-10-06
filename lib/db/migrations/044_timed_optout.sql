-- The «إيقاف الرسائل» button: whoever taps it is not messaged for five
-- months, then may be again. A typed «إيقاف» stays as it was — for good —
-- so expires_at is NULL for those, and a date for a button tap.
ALTER TABLE unsubscribed_phones ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_unsubscribed_expires ON unsubscribed_phones (expires_at) WHERE expires_at IS NOT NULL;
