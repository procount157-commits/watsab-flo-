-- ── 063 · حارس إرسال واتساب، ولغة التصميم ───────────────────────
-- صاحب العمل (١٩ أكتوبر): رسائل مكررة للرقم نفسه، وكمية كبيرة في وقت واحد،
-- وتصاميم إنجليزية تُرسل مع نص عربي. فهد (العمليات) يحرس الإرسال، وكل ما
-- يمنعه يُسجَّل هنا.
CREATE TABLE IF NOT EXISTS wa_guard_events (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        varchar(12) NOT NULL,
  phone       varchar(50),
  campaign_id integer,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_guard_events_user ON wa_guard_events (user_id, created_at DESC);

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS lang varchar(6);
-- كل صورة تُعاد قراءتها مرة لتُعرف لغة كلامها.
UPDATE media_assets SET vision_at = NULL WHERE lang IS NULL;
