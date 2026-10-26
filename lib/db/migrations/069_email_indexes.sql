-- ── 069 · فهارس نتائج البريد ─────────────────────────────────────
-- ربط الرسائل بمتابعات المهام كان يقرأ الجدول كله (٢٦ أكتوبر). يُعاد تشغيله بأمان.
CREATE INDEX IF NOT EXISTS idx_email_messages_sequence_job ON email_messages (sequence_job_id) WHERE sequence_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_sequence_jobs_sequence ON email_sequence_jobs (sequence_id);
