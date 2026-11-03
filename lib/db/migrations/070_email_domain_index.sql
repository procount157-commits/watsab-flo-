-- ── 070 · فهرس نطاق الشركة وآخر إرسال ───────────────────────────
-- فاصل الشركة (خمسة أيام بين رسالتين إلى النطاق نفسه) يُفحَص مع كل رسالةٍ
-- يختارها العامل، وبلا هذين الفهرسين يقرأ جدول الجهات كله كل عشرين ثانية.
-- service.ts ينشئهما عند الإقلاع أيضاً لأن النشر لا يشغّل ملفات SQL. يُعاد تشغيله بأمان.
CREATE INDEX IF NOT EXISTS idx_email_contacts_domain ON email_contacts (user_id, lower(split_part(email, '@', 2)));
CREATE INDEX IF NOT EXISTS idx_email_contacts_last_sent ON email_contacts (user_id, last_sent_at);
