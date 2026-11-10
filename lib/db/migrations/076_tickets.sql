-- ── التذاكر وسجل الأفعال (Track A) ─────────────────────────────────
-- employee_tasks تصير تذكرة: حقول العمل، والحالات draft/waiting_for_owner/blocked، ومفتاح إيقاف للتذكرة (org_controls scope 'task').
-- ticket_action_events: سطرٌ لكل فعلٍ له معنى، ويُحذف بعد ٩٠ يوماً؛ التذاكر تبقى.
-- النشر لا يشغّل ملفات SQL: TICKET_SQL في artifacts/api-server/src/lib/org/ledger.ts ينفّذ النص نفسه عند الإقلاع،
-- وorg-tickets.test.ts يقارن الاثنين.
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS objective text;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS assigned_to varchar(60);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS created_by_kind varchar(12);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS created_by_id varchar(80);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS related_customer_id integer;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS related_campaign_id integer;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS related_conversation_id varchar(120);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS action_type varchar(60);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS expected_output text;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS actual_output jsonb;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS duration_ms integer;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS failure_code varchar(40);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS next_action text;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS handoff_target varchar(60);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS audit_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'employee_tasks' AND column_name = 'priority_level') THEN
      SET LOCAL lock_timeout = '10s';
      ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS priority_level varchar(10) GENERATED ALWAYS AS (CASE WHEN priority <= 25 THEN 'critical' WHEN priority <= 75 THEN 'high' WHEN priority <= 150 THEN 'normal' ELSE 'low' END) STORED;
    END IF;
  END $$;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS retryable boolean;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS responsible_party varchar(60);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS approval_payload_hash varchar(64);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS approved_payload_hash varchar(64);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS approved_by integer;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS due_at timestamptz;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_tasks_status' AND pg_get_constraintdef(oid) LIKE '%waiting_for_owner%') THEN
      ALTER TABLE employee_tasks DROP CONSTRAINT IF EXISTS employee_tasks_status;
      ALTER TABLE employee_tasks ADD CONSTRAINT employee_tasks_status CHECK (status IN ('draft','pending','queued','running','waiting_for_dependency','waiting_for_approval','waiting_for_owner','blocked','completed','failed','cancelled','expired'));
    END IF;
  END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_controls_scope' AND pg_get_constraintdef(oid) LIKE '%''task''%') THEN
      ALTER TABLE org_controls DROP CONSTRAINT IF EXISTS org_controls_scope;
      ALTER TABLE org_controls ADD CONSTRAINT org_controls_scope CHECK (scope IN ('global','account','department','employee','channel','task'));
    END IF;
  END $$;
CREATE INDEX IF NOT EXISTS idx_employee_tasks_assigned ON employee_tasks (user_id, assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_employee_tasks_due_at ON employee_tasks (user_id, due_at) WHERE due_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS ticket_action_events (
    id bigserial PRIMARY KEY, ticket_id integer NOT NULL REFERENCES employee_tasks(task_id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60), actor_kind varchar(12), actor_id varchar(80),
    action_type varchar(60) NOT NULL, input jsonb, output jsonb, status varchar(20) NOT NULL, evidence jsonb,
    attempt_no integer NOT NULL DEFAULT 1, idempotency_key varchar(200), provider varchar(40), model varchar(120),
    execution_id bigint, duration_ms integer, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ticket_events_status CHECK (status IN ('ok','allowed','refused','failed','started','info')));
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_action_events (ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_ticket_events_user ON ticket_action_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_events_created ON ticket_action_events (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_events_attempt ON ticket_action_events (user_id, idempotency_key, attempt_no) WHERE idempotency_key IS NOT NULL;
