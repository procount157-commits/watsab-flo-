-- ── 061 · حارسا الارتداد ─────────────────────────────────────────
-- قرار صاحب العمل (١٩ أكتوبر): «نفّذ حلول الارتداد كلها».
--   ١. كل عنوانٍ يُسأل عنه خادمه قبل الإرسال: هل الصندوق موجود؟
--   ٢. كل ملفٍ جديد يُجرَّب على خمسين عنواناً؛ فوق ٨٪ ارتداد يتوقف الملف.
ALTER TABLE email_contacts ADD COLUMN IF NOT EXISTS mailbox varchar(10);
ALTER TABLE email_contacts ADD COLUMN IF NOT EXISTS mailbox_checked_at timestamptz;

CREATE TABLE IF NOT EXISTS email_source_trials (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      varchar(60) NOT NULL,
  status      varchar(10) NOT NULL DEFAULT 'sampling',
  sample      integer NOT NULL DEFAULT 50,
  attempted   integer NOT NULL DEFAULT 0,
  bad         integer NOT NULL DEFAULT 0,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  UNIQUE (user_id, source)
);

-- الملفات الموجودة تُحكم بما أُرسل منها حتى الآن: ثلاثون فأكثر وفوق ٨٪
-- يتوقف (ملف «منشآت أخرى»: ١٣٫٥٪)، خمسون فأكثر تحته ينجح، والباقي عيّنة.
INSERT INTO email_source_trials (user_id, source, status, attempted, bad, note, decided_at)
SELECT user_id, source, st, sent, bad,
  CASE st WHEN 'failed' THEN 'أوقفه الارتداد قبل الحارس: ' || bad || ' من ' || sent
          WHEN 'passed' THEN 'نجح قبل الحارس: ' || bad || ' من ' || sent END,
  CASE WHEN st <> 'sampling' THEN now() END
FROM (
  SELECT *, CASE WHEN sent >= 30 AND bad * 100.0 / sent > 8 THEN 'failed' WHEN sent >= 50 THEN 'passed' ELSE 'sampling' END AS st
  FROM (
    SELECT user_id, source,
      count(*) FILTER (WHERE last_sent_at IS NOT NULL)::int AS sent,
      count(*) FILTER (WHERE status = 'bounced')::int AS bad
    FROM email_contacts WHERE source LIKE 'ملف:%' GROUP BY 1, 2
  ) a
) s
ON CONFLICT (user_id, source) DO NOTHING;
