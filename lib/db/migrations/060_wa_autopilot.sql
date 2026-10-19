-- ── 060 · حملات واتساب التلقائية ─────────────────────────────────
-- صاحب العمل: «يعمل الحملات تلقائياً: يختار حملة، يجرّبها، يأخذ منها
-- الدروس، ثم يوقف الأخرى — مع حساب الحظر والحد اليومي». الطيار يكتب
-- نسختين لكل قطاع أو قائمة، يجرّبهما على عيّنتين صغيرتين، يحكم بالردود
-- والضغطات، ويرسل الفائزة لموجة. مطفأ حتى يشغّله صاحب العمل.
CREATE TABLE IF NOT EXISTS wa_autopilot (
  user_id      integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT false,
  mode         varchar(10) NOT NULL DEFAULT 'approve',
  test_size    integer NOT NULL DEFAULT 20,
  wave_size    integer NOT NULL DEFAULT 150,
  daily_share  integer NOT NULL DEFAULT 60,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wa_autopilot_tests (
  id               serial PRIMARY KEY,
  user_id          integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           varchar(20) NOT NULL DEFAULT 'awaiting_approval',
  target_kind      varchar(10) NOT NULL,
  target           varchar(120) NOT NULL,
  service          varchar(12),
  variants         jsonb NOT NULL DEFAULT '[]'::jsonb,
  results          jsonb,
  winner           varchar(4),
  insight          text,
  wave_campaign_id integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  judged_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_wa_ap_tests_user ON wa_autopilot_tests (user_id, status);
