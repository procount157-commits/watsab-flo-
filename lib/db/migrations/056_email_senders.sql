-- ── صناديق إرسالٍ أكثر من واحد ─────────────────────────────────────
-- صندوقٌ واحد على Hostinger بسقف ٣٠٠ في اليوم، ورفض ثلاثين رسالة إزعاجاً
-- في أسبوع. والزيادة الكبيرة لا تكون بإرهاق صندوقٍ واحد بل بصناديق كثيرة
-- (Google Workspace، Microsoft 365، Zoho…) لكلٍّ سقفه وتسخينه، يُوزَّع
-- الإرسال بينها، ويُوقف منها ما يرفضه مزوّده وحده دون أن يتوقف الباقي.
--
-- الصندوق الأول يبقى في email_settings (sender_id فارغ = هو). وهذه
-- الصناديق الإضافية.
CREATE TABLE IF NOT EXISTS email_senders (
  id              serial PRIMARY KEY,
  user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           varchar(80),
  preset          varchar(20) NOT NULL DEFAULT 'custom',
  smtp_host       varchar(200) NOT NULL,
  smtp_port       integer NOT NULL DEFAULT 587,
  smtp_secure     boolean NOT NULL DEFAULT false,
  smtp_user       varchar(200) NOT NULL,
  smtp_pass       varchar(400) NOT NULL,
  from_name       varchar(120),
  from_email      varchar(200) NOT NULL,
  imap_host       varchar(200),
  imap_port       integer DEFAULT 993,
  imap_last_uid   integer NOT NULL DEFAULT 0,
  imap_last_error text,
  hourly_cap      integer NOT NULL DEFAULT 15,
  daily_cap       integer NOT NULL DEFAULT 80,
  warmup          boolean NOT NULL DEFAULT true,
  -- active | paused (صاحب العمل أوقفه) | broken (المصادقة فشلت)
  status          varchar(12) NOT NULL DEFAULT 'active',
  held_until      timestamptz,
  held_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, from_email)
);
CREATE INDEX IF NOT EXISTS idx_email_senders_user ON email_senders (user_id);

ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS sender_id integer REFERENCES email_senders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_email_messages_sender ON email_messages (sender_id, sent_at) WHERE status = 'sent';
