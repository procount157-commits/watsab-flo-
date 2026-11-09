// ── جداول المنظّمة عند الإقلاع ─────────────────────────────────────
// النشر لا يشغّل ملفات SQL (انظر accounts/desk.ts)، فما في 072_org.sql يُنشأ هنا،
// بالنص نفسه: lib/__tests__/org-safety.test.ts يقارن الاثنين. يُعاد تشغيله بأمان.
//
// لماذا يُنتظر قبل الاستماع (index.ts): أعمدة bot_employees وagent_memory الجديدة
// صارت في مخطط drizzle، فأي `select()` عليهما قبل هذا الـALTER يفشل.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";

export const ORG_TABLES_SQL = [
  // ── الموجود يُوسَّع ولا يُكرَّر ──
  `ALTER TABLE bot_employees ADD COLUMN IF NOT EXISTS employee_key varchar(60)`,
  `ALTER TABLE bot_employees ADD COLUMN IF NOT EXISTS department varchar(40)`,
  `ALTER TABLE bot_employees ADD COLUMN IF NOT EXISTS heartbeat_interval_sec integer`,
  `ALTER TABLE bot_employees ADD COLUMN IF NOT EXISTS prompt_version integer`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_employees_key ON bot_employees (user_id, employee_key) WHERE employee_key IS NOT NULL`,
  `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS source_reference text`,
  `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS confidence numeric(4,3)`,
  `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS last_verified_at timestamptz`,
  `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS approval_status varchar(20) NOT NULL DEFAULT 'approved'`,
  `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1`,
  `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS expiry_at timestamptz`,
  // ── مفاتيح الإيقاف والسجل ──
  `CREATE TABLE IF NOT EXISTS org_controls (
    id serial PRIMARY KEY, scope varchar(12) NOT NULL, user_id integer REFERENCES users(id) ON DELETE CASCADE,
    target varchar(60) NOT NULL DEFAULT '', engaged boolean NOT NULL DEFAULT false, reason text,
    set_by integer REFERENCES users(id) ON DELETE SET NULL, set_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT org_controls_scope CHECK (scope IN ('global','account','department','employee','channel')),
    CONSTRAINT org_controls_global CHECK (scope <> 'global' OR user_id IS NULL),
    CONSTRAINT org_controls_account CHECK (scope <> 'account' OR user_id IS NOT NULL))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_org_controls ON org_controls (scope, COALESCE(user_id, 0), target)`,
  `CREATE INDEX IF NOT EXISTS idx_org_controls_user ON org_controls (user_id, engaged)`,
  `CREATE TABLE IF NOT EXISTS org_audit_log (
    id bigserial PRIMARY KEY, user_id integer REFERENCES users(id) ON DELETE CASCADE, action varchar(40) NOT NULL,
    scope varchar(12), channel varchar(20), kind varchar(30), recipient varchar(254), role varchar(60), actor integer,
    why text, count integer NOT NULL DEFAULT 1, idempotency_key varchar(200), meta jsonb, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_org_audit_user ON org_audit_log (user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_org_audit_action ON org_audit_log (action, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_org_audit_idem ON org_audit_log (COALESCE(user_id, 0), idempotency_key) WHERE idempotency_key IS NOT NULL`,
  // ── الموظف: تعليماته، نبضه، تنفيذه ──
  `CREATE TABLE IF NOT EXISTS employee_prompt_versions (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60) NOT NULL,
    version integer NOT NULL, prompt text NOT NULL, note text, active boolean NOT NULL DEFAULT false, created_by varchar(60),
    created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT uq_employee_prompt_version UNIQUE (user_id, employee_key, version))`,
  `CREATE TABLE IF NOT EXISTS employee_heartbeats (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60) NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'idle', last_beat_at timestamptz NOT NULL DEFAULT now(), next_beat_at timestamptz,
    last_error text, detail jsonb, PRIMARY KEY (user_id, employee_key),
    CONSTRAINT employee_heartbeats_status CHECK (status IN ('idle','running','stalled','halted','failed')))`,
  `CREATE TABLE IF NOT EXISTS employee_executions (
    id bigserial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60) NOT NULL,
    task_id integer, prompt_version integer, status varchar(20) NOT NULL DEFAULT 'running', model varchar(120),
    tokens_in integer, tokens_out integer, cost_usd numeric(10,5), error text, output_ref jsonb,
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    CONSTRAINT employee_executions_status CHECK (status IN ('running','succeeded','failed','halted','cancelled')))`,
  `CREATE INDEX IF NOT EXISTS idx_employee_executions_user ON employee_executions (user_id, employee_key, started_at)`,
  // ── المهام ──
  `CREATE TABLE IF NOT EXISTS employee_tasks (
    task_id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, department varchar(40),
    owner_role varchar(60) NOT NULL, created_by_role varchar(60), parent_task_id integer, task_type varchar(60) NOT NULL,
    priority integer NOT NULL DEFAULT 100, status varchar(30) NOT NULL DEFAULT 'pending',
    input_refs jsonb NOT NULL DEFAULT '[]'::jsonb, output_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    due_at timestamptz, started_at timestamptz, completed_at timestamptz,
    approval_required boolean NOT NULL DEFAULT false, approval_status varchar(20), failure_reason text,
    retry_count integer NOT NULL DEFAULT 0, max_retries integer NOT NULL DEFAULT 3, idempotency_key varchar(200),
    lease_owner varchar(80), lease_expires_at timestamptz, next_attempt_at timestamptz, dead_letter boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_employee_tasks_idem UNIQUE (user_id, idempotency_key),
    CONSTRAINT employee_tasks_status CHECK (status IN ('pending','queued','running','waiting_for_dependency','waiting_for_approval','completed','failed','cancelled','expired')),
    CONSTRAINT employee_tasks_approval CHECK (approval_status IS NULL OR approval_status IN ('pending','approved','rejected')))`,
  `CREATE INDEX IF NOT EXISTS idx_employee_tasks_queue ON employee_tasks (user_id, status, next_attempt_at, priority)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_tasks_owner ON employee_tasks (user_id, owner_role, status)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_tasks_parent ON employee_tasks (parent_task_id)`,
  `CREATE TABLE IF NOT EXISTS employee_task_dependencies (
    task_id integer NOT NULL REFERENCES employee_tasks(task_id) ON DELETE CASCADE,
    depends_on integer NOT NULL REFERENCES employee_tasks(task_id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (task_id, depends_on),
    CONSTRAINT employee_task_deps_self CHECK (task_id <> depends_on))`,
  `CREATE INDEX IF NOT EXISTS idx_employee_task_deps_on ON employee_task_dependencies (depends_on)`,
  `CREATE TABLE IF NOT EXISTS employee_feedback (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60) NOT NULL,
    task_id integer, from_role varchar(60), verdict varchar(20) NOT NULL, note text, evidence jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT employee_feedback_verdict CHECK (verdict IN ('good','bad','edit','note')))`,
  `CREATE INDEX IF NOT EXISTS idx_employee_feedback_user ON employee_feedback (user_id, employee_key, created_at)`,
  // ── الذاكرة المشتركة والتعلّم ──
  `CREATE TABLE IF NOT EXISTS department_memory (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, department varchar(40) NOT NULL,
    kind varchar(20) NOT NULL, content text NOT NULL, source_reference text, confidence numeric(4,3),
    approval_status varchar(20) NOT NULL DEFAULT 'pending', last_verified_at timestamptz, version integer NOT NULL DEFAULT 1,
    expiry_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT department_memory_approval CHECK (approval_status IN ('pending','approved','rejected')))`,
  `CREATE INDEX IF NOT EXISTS idx_department_memory_user ON department_memory (user_id, department, approval_status)`,
  `CREATE TABLE IF NOT EXISTS account_knowledge (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, key varchar(120) NOT NULL,
    value text NOT NULL, source_reference text, confidence numeric(4,3), approval_status varchar(20) NOT NULL DEFAULT 'pending',
    last_verified_at timestamptz, version integer NOT NULL DEFAULT 1, expiry_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_account_knowledge UNIQUE (user_id, key),
    CONSTRAINT account_knowledge_approval CHECK (approval_status IN ('pending','approved','rejected')))`,
  `CREATE TABLE IF NOT EXISTS learning_events (
    id bigserial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60),
    department varchar(40), event_type varchar(40) NOT NULL, outcome varchar(20), evidence jsonb, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_learning_events_user ON learning_events (user_id, event_type, created_at)`,
  `CREATE TABLE IF NOT EXISTS improvement_proposals (
    change_id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, requested_by varchar(60) NOT NULL,
    approved_by integer REFERENCES users(id) ON DELETE SET NULL, target varchar(120), reason text NOT NULL, evidence jsonb,
    old_value jsonb, new_value jsonb, impact text, status varchar(20) NOT NULL DEFAULT 'proposed', applied_at timestamptz,
    rollback_version integer, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT improvement_proposals_status CHECK (status IN ('proposed','approved','rejected','applied','rolled_back')))`,
  `CREATE INDEX IF NOT EXISTS idx_improvement_proposals_user ON improvement_proposals (user_id, status)`,
  // ── سير العمل وما يُقاس ──
  `CREATE TABLE IF NOT EXISTS workflow_executions (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, workflow varchar(80) NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'running', input jsonb, output jsonb, error text,
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    CONSTRAINT workflow_executions_status CHECK (status IN ('running','succeeded','failed','halted','cancelled')))`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_executions_user ON workflow_executions (user_id, workflow, started_at)`,
  `CREATE TABLE IF NOT EXISTS execution_events (
    id bigserial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workflow_id integer REFERENCES workflow_executions(id) ON DELETE CASCADE, task_id integer, employee_key varchar(60),
    event varchar(60) NOT NULL, detail jsonb, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_execution_events_user ON execution_events (user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_events_workflow ON execution_events (workflow_id)`,
  `CREATE TABLE IF NOT EXISTS integration_health (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, integration varchar(40) NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'unknown', detail text, last_ok_at timestamptz, last_fail_at timestamptz,
    checked_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT uq_integration_health UNIQUE (user_id, integration),
    CONSTRAINT integration_health_status CHECK (status IN ('ok','degraded','down','unknown')))`,
  `CREATE TABLE IF NOT EXISTS provider_metrics (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider varchar(40) NOT NULL,
    model varchar(120) NOT NULL DEFAULT '', day varchar(10) NOT NULL, calls integer NOT NULL DEFAULT 0, failures integer NOT NULL DEFAULT 0,
    tokens_in integer NOT NULL DEFAULT 0, tokens_out integer NOT NULL DEFAULT 0, cost_usd numeric(10,5) NOT NULL DEFAULT 0,
    CONSTRAINT uq_provider_metrics UNIQUE (user_id, provider, model, day))`,
  `CREATE TABLE IF NOT EXISTS executive_reports (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, period varchar(20) NOT NULL,
    period_key varchar(20) NOT NULL, body text NOT NULL, metrics jsonb, created_by varchar(60), created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_executive_reports UNIQUE (user_id, period, period_key))`,
  `CREATE TABLE IF NOT EXISTS employee_scorecards (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60) NOT NULL,
    period_key varchar(20) NOT NULL, score numeric(5,2), metrics jsonb, note text, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_employee_scorecards UNIQUE (user_id, employee_key, period_key))`,
];

/** ما زادته أولوية التشغيل (073_org_runtime.sql): أعمدة النبض والتنفيذ، وفهارس الطابور والاحتفاظ. */
export const ORG_RUNTIME_SQL = [
  `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS stale_released_at timestamptz`,
  `ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS last_started_at timestamptz`,
  `ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS last_completed_at timestamptz`,
  `ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS last_success_at timestamptz`,
  `ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS last_failure_at timestamptz`,
  `ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0`,
  `ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS last_execution_id bigint`,
  `ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS worker_id varchar(80)`,
  `ALTER TABLE employee_heartbeats ADD COLUMN IF NOT EXISTS interval_sec integer`,
  `ALTER TABLE employee_executions ADD COLUMN IF NOT EXISTS kind varchar(60)`,
  `ALTER TABLE employee_executions ADD COLUMN IF NOT EXISTS duration_ms integer`,
  `ALTER TABLE employee_executions ADD COLUMN IF NOT EXISTS model_calls integer NOT NULL DEFAULT 0`,
  `ALTER TABLE employee_executions ADD COLUMN IF NOT EXISTS worker_id varchar(80)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS expires_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS idx_employee_tasks_due ON employee_tasks (priority, next_attempt_at) WHERE status = 'queued'`,
  `CREATE INDEX IF NOT EXISTS idx_employee_tasks_lease ON employee_tasks (lease_expires_at) WHERE status = 'running'`,
  `CREATE INDEX IF NOT EXISTS idx_employee_tasks_expiry ON employee_tasks (expires_at) WHERE expires_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_employee_tasks_inbox ON employee_tasks (user_id, owner_role, task_type, status)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_executions_running ON employee_executions (started_at) WHERE status = 'running'`,
  `CREATE INDEX IF NOT EXISTS idx_employee_executions_started ON employee_executions (started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_events_created ON execution_events (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_learning_events_angle ON learning_events (user_id, (evidence->>'angle'), created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_email_inbound_domain ON email_inbound (user_id, lower(split_part(from_email, '@', 2)))`,
];

let tablesReady: Promise<boolean> | null = null;

/**
 * تُنشأ مرةً في العملية. الفشل لا يُحفظ: النداء التالي يحاول من جديد، وإلى أن
 * تنجح يقرأ controls.ts جدولاً غائباً فيُغلق — الإرسال موقوف لا مفتوح.
 */
export function ensureOrgTables(): Promise<boolean> {
  tablesReady ??= (async () => {
    for (const q of [...ORG_TABLES_SQL, ...ORG_RUNTIME_SQL]) await db.execute(sql.raw(q));
    return true;
  })().catch((e) => {
    tablesReady = null;
    logger.warn({ err: String(e?.message ?? e) }, "تعذّر إنشاء جداول المنظّمة");
    return false;
  });
  return tablesReady;
}
