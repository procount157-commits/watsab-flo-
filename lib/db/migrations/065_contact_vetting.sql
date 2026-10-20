-- ── 065 · فاحص الأرقام (سيف) ─────────────────────────────────────
-- صاحب العمل (٢٠ أكتوبر): «موظف جديد: قبل ما يضع الرقم في قائمة الإرسال لازم
-- يتأكد من كل رقم ويقيّمه — هل عليه واتساب ولا لا — يحلل الرقم بطريقة متقدمة».
-- حكمه على كل رقم يُحفظ على الرقم نفسه، ولا حملة إلا إلى ready؛ وكل جولة له
-- تقريرٌ يقرؤه صاحب العمل. يُعاد تشغيله بأمان.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS verdict varchar(10);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS vet_reasons jsonb;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS vetted_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_exists boolean;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS risk integer;
CREATE INDEX IF NOT EXISTS idx_contacts_group_verdict ON contacts (group_id, verdict);

CREATE TABLE IF NOT EXISTS contact_vetting_runs (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id    integer,
  trigger     varchar(12) NOT NULL,
  total       integer NOT NULL DEFAULT 0,
  ready       integer NOT NULL DEFAULT 0,
  hold        integer NOT NULL DEFAULT 0,
  rejected    integer NOT NULL DEFAULT 0,
  checked     integer NOT NULL DEFAULT 0,
  unknown     integer NOT NULL DEFAULT 0,
  reasons     jsonb NOT NULL DEFAULT '{}',
  note        text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_contact_vetting_runs_user ON contact_vetting_runs (user_id, group_id, started_at);

-- ما قاله واتساب من قبل يُنقل إلى الحكم: «ليس على واتساب» مرفوض، والباقي يُفحص.
UPDATE contacts SET verdict = 'rejected', wa_exists = false, vet_reasons = '["ليس على واتساب"]'::jsonb, vetted_at = now()
WHERE status = 'invalid' AND verdict IS NULL;
