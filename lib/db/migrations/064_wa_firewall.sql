-- ── 064 · الحاجز التلقائي من الحظر، بسلّمٍ إلى ١٥٠٠ ───────────────
-- صاحب العمل (٢٠ أكتوبر): «أبني جدار لكل حد… هم عملاء سابقين، ومن اختار "لا"
-- خلاص ما هرسل له تاني. بس أبنيها عشان يوصل ١٥٠٠ في اليوم بالتدريج».
-- حالة الحاجز لكل رقم، ودفتر كل رسالة أذن بها، وسجلّه. يُعاد تشغيله بأمان.
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
-- السلّم: الدرجة، منذ متى، ومتى حُكم عليها آخر مرة؛ وكلمة واتساب نفسه عن الحساب.
ALTER TABLE wa_firewall ADD COLUMN IF NOT EXISTS rung integer NOT NULL DEFAULT -1;
ALTER TABLE wa_firewall ADD COLUMN IF NOT EXISTS rung_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE wa_firewall ADD COLUMN IF NOT EXISTS rung_checked_on varchar(10);
ALTER TABLE wa_firewall ADD COLUMN IF NOT EXISTS wa_lock jsonb;
ALTER TABLE wa_firewall ADD COLUMN IF NOT EXISTS wa_cap jsonb;
ALTER TABLE wa_firewall ADD COLUMN IF NOT EXISTS wa_checked_at timestamptz;
ALTER TABLE wa_firewall ADD COLUMN IF NOT EXISTS wa_warned_status varchar(16);

CREATE TABLE IF NOT EXISTS wa_firewall_sends (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone       varchar(50) NOT NULL,
  kind        varchar(14) NOT NULL,
  cold        boolean NOT NULL,
  message_id  varchar(120),
  at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wa_firewall_sends ALTER COLUMN kind TYPE varchar(14);
CREATE INDEX IF NOT EXISTS idx_wa_firewall_sends_user ON wa_firewall_sends (user_id, at);
CREATE TABLE IF NOT EXISTS wa_firewall_events (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        varchar(16) NOT NULL,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_firewall_events_user ON wa_firewall_events (user_id, created_at);

-- النقاهة الشاملة التي فرضها الجدار السابق على كل حساب بلا سبب تُرفع؛ تجميدٌ
-- بسببٍ مذكور (قرار صاحب العمل) يبقى حتى موعده.
UPDATE wa_firewall SET mode = 'normal', convalescent_until = NULL, updated_at = now()
WHERE mode = 'convalescent' AND freezes = 0 AND reason IS NULL;

-- «من اختار لا، خلاص»: من طلب الإيقاف لا يُراسَل بعدها أبداً — ما كان مؤقتاً صار دائماً.
UPDATE unsubscribed_phones SET expires_at = NULL WHERE expires_at IS NOT NULL;
