-- Delivered and read, for every message we send — not only campaigns. The
-- owner asked «هل قرأها أحد؟» about follow-ups and there was no record.
ALTER TABLE wa_thread_messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE wa_thread_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
