-- ── 064 · جدار الحماية من الحظر ─────────────────────────────────
-- صاحب العمل (١٩ أكتوبر): «تم تقييد الحساب لأنه أرسل رسائل كثيرة جداً في
-- وقت واحد — ابنِ جدار حماية قوياً جداً ضد الحظر، حلاً جذرياً». ما حدث:
-- ٣٢ رسالة باردة في ثلاث دقائق (حلقتان لحملةٍ واحدة)، ثم رسالة كل دقيقة،
-- والحد اليومي كان ١٥٠٠. بعدها ١٥ انقطاعاً في ثلاث ساعات. هنا حالة الجدار
-- وسجلّه ودفتر كل رسالة أذن بها.
CREATE TABLE IF NOT EXISTS wa_firewall (
  user_id             integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode                varchar(14) NOT NULL DEFAULT 'normal',
  frozen_until        timestamptz,
  reason              text,
  convalescent_until  timestamptz,
  manual_freeze       boolean NOT NULL DEFAULT false,
  cold_daily_cap      integer,
  interactive_allowed boolean NOT NULL DEFAULT false,
  paused_campaigns    jsonb NOT NULL DEFAULT '[]',
  freezes             integer NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wa_firewall_sends (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone       varchar(50) NOT NULL,
  kind        varchar(10) NOT NULL,
  cold        boolean NOT NULL,
  message_id  varchar(120),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_firewall_sends_user ON wa_firewall_sends (user_id, at);
CREATE TABLE IF NOT EXISTS wa_firewall_events (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        varchar(16) NOT NULL,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_firewall_events_user ON wa_firewall_events (user_id, created_at);

-- الحساب المقيّد اليوم يبدأ مجمّداً ٧٢ ساعة ثم في نقاهة أسبوعين. والمحل
-- وبقية الحسابات تبدأ في نقاهة: الحد الجديد يُطبّق على الجميع من اليوم.
INSERT INTO wa_firewall (user_id, mode, frozen_until, reason, convalescent_until, freezes)
SELECT id, CASE WHEN id = 2 THEN 'frozen' ELSE 'convalescent' END,
  CASE WHEN id = 2 THEN now() + interval '72 hours' END,
  CASE WHEN id = 2 THEN 'واتساب قيّد الحساب بعد ٣٢ رسالة في ثلاث دقائق — تجميد ٧٢ ساعة ثم نقاهة أسبوعين' END,
  now() + interval '14 days' + CASE WHEN id = 2 THEN interval '72 hours' ELSE interval '0' END,
  CASE WHEN id = 2 THEN 1 ELSE 0 END
FROM users ON CONFLICT (user_id) DO NOTHING;
