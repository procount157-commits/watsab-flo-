-- ── تشغيل الموظفين: النبض، التنفيذ، الطابور ─────────────────────────
-- النشر لا يشغّل ملفات SQL: ORG_RUNTIME_SQL في artifacts/api-server/src/lib/org/schema.ts
-- ينفّذ النص نفسه عند الإقلاع، وorg-runtime.test.ts يقارن الاثنين.
ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS last_started_at timestamptz;
ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS last_completed_at timestamptz;
ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS last_success_at timestamptz;
ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS last_failure_at timestamptz;
ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS last_execution_id bigint;
ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS worker_id varchar(80);
ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS interval_sec integer;
ALTER TABLE employee_executions ADD COLUMN IF NOT EXISTS kind varchar(60);
ALTER TABLE employee_executions ADD COLUMN IF NOT EXISTS duration_ms integer;
ALTER TABLE employee_executions ADD COLUMN IF NOT EXISTS model_calls integer NOT NULL DEFAULT 0;
ALTER TABLE employee_executions ADD COLUMN IF NOT EXISTS worker_id varchar(80);
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_employee_tasks_due ON employee_tasks (priority, next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_employee_tasks_lease ON employee_tasks (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_employee_tasks_expiry ON employee_tasks (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employee_tasks_inbox ON employee_tasks (user_id, owner_role, task_type, status);
CREATE INDEX IF NOT EXISTS idx_employee_executions_running ON employee_executions (started_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_employee_executions_started ON employee_executions (started_at);
CREATE INDEX IF NOT EXISTS idx_execution_events_created ON execution_events (created_at);
CREATE INDEX IF NOT EXISTS idx_learning_events_angle ON learning_events (user_id, (evidence->>'angle'), created_at);
CREATE INDEX IF NOT EXISTS idx_email_inbound_domain ON email_inbound (user_id, lower(split_part(from_email, '@', 2)));
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS stale_released_at timestamptz;
