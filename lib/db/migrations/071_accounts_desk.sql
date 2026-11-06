-- ── 071 · مكتب الحسابات المستهدفة ─────────────────────────────────
-- عشر شركات عقارية في اليوم: صاحب قرار الامتثال، بريده، ورسالة له وحده.
-- artifacts/api-server/src/lib/accounts/desk.ts ينشئ الجداول نفسها عند الإقلاع
-- لأن النشر على الخادم لا يشغّل ملفات SQL. يُعاد تشغيله بأمان.
CREATE TABLE IF NOT EXISTS accounts_desk_settings (
  user_id     integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled     boolean NOT NULL DEFAULT false,
  per_day     integer NOT NULL DEFAULT 10,
  sectors     jsonb NOT NULL DEFAULT '["عقارات"]'::jsonb,
  emirates    jsonb NOT NULL DEFAULT '[]'::jsonb,
  search_key  varchar(200),
  last_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS target_accounts (
  id               serial PRIMARY KEY,
  user_id          integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company          varchar(200) NOT NULL,
  domain           varchar(200) NOT NULL,
  website          varchar(300),
  city             varchar(120),
  sector           varchar(60),
  signal           text,
  signal_source    varchar(500),
  status           varchar(20) NOT NULL DEFAULT 'researching',
  run_date         varchar(10) NOT NULL,
  notes            text,
  email_to         varchar(254),
  email_subject    varchar(300),
  email_body       text,
  email_followups  jsonb NOT NULL DEFAULT '[]'::jsonb,
  linkedin_message text,
  linkedin_done    boolean NOT NULL DEFAULT false,
  contact_id       integer,
  sequence_id      integer,
  sent_at          timestamptz,
  opened_at        timestamptz,
  replied_at       timestamptz,
  meeting_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_target_accounts_domain UNIQUE (user_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_target_accounts_user ON target_accounts (user_id, status);
CREATE INDEX IF NOT EXISTS idx_target_accounts_day ON target_accounts (user_id, run_date);

CREATE TABLE IF NOT EXISTS target_people (
  id                serial PRIMARY KEY,
  user_id           integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id        integer NOT NULL REFERENCES target_accounts(id) ON DELETE CASCADE,
  name              varchar(160) NOT NULL,
  title             varchar(200),
  why               text,
  email             varchar(254),
  email_status      varchar(12),
  email_fallback    boolean NOT NULL DEFAULT false,
  linkedin_url      varchar(400),
  source_url        varchar(500),
  is_decision_maker boolean NOT NULL DEFAULT false,
  contact_id        integer,
  sequence_id       integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_target_people_account ON target_people (account_id);

-- صاحب Pro Count طلبه: المكتب يعمل له من أول يوم، والباقون يشغّلونه بأنفسهم.
INSERT INTO accounts_desk_settings (user_id, enabled)
  SELECT 2, true WHERE EXISTS (SELECT 1 FROM users WHERE id = 2)
  ON CONFLICT (user_id) DO NOTHING;
