// ── جداول المحاكاة والظل عند الإقلاع ───────────────────────────────
// النشر لا يشغّل ملفات SQL: ما في 075_shadow.sql يُنشأ هنا بالنص نفسه، وorg-shadow.test.ts
// يقارن الاثنين. يُعاد تشغيله بأمان. ومعها أعمدة تقرير المدير الجديدة (§8).

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { SIM_TASK_PREFIX } from "./simulation";

export const ORG_SIM_SQL = [
  `CREATE TABLE IF NOT EXISTS shadow_runs (
    id bigserial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, batch_id varchar(60) NOT NULL,
    employee_key varchar(60) NOT NULL, proposal_id integer, library_version varchar(20), sample_ref jsonb, input_excerpt text,
    current_output text, proposed_output text, current_issues jsonb NOT NULL DEFAULT '[]'::jsonb, proposed_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
    verdict varchar(20) NOT NULL, detail text, model_calls integer NOT NULL DEFAULT 0, trigger varchar(20) NOT NULL DEFAULT 'manual',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT shadow_runs_verdict CHECK (verdict IN ('failed_checks','better','same','no_output','no_model_path','no_samples','budget')))`,
  `CREATE INDEX IF NOT EXISTS idx_shadow_runs_user ON shadow_runs (user_id, employee_key, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_shadow_runs_proposal ON shadow_runs (user_id, proposal_id)`,
  `CREATE TABLE IF NOT EXISTS sim_fixtures (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind varchar(40) NOT NULL, label varchar(120) NOT NULL,
    data jsonb NOT NULL, is_test boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sim_fixtures_test CHECK (is_test), CONSTRAINT uq_sim_fixtures UNIQUE (user_id, kind, label))`,
  `CREATE TABLE IF NOT EXISTS sim_e2e_runs (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, status varchar(20) NOT NULL DEFAULT 'running',
    fixture_id integer REFERENCES sim_fixtures(id) ON DELETE SET NULL, model_calls integer NOT NULL DEFAULT 0, summary jsonb, error text,
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    CONSTRAINT sim_e2e_runs_status CHECK (status IN ('running','succeeded','failed')))`,
  `CREATE INDEX IF NOT EXISTS idx_sim_e2e_runs_user ON sim_e2e_runs (user_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS sim_e2e_steps (
    id bigserial PRIMARY KEY, run_id integer NOT NULL REFERENCES sim_e2e_runs(id) ON DELETE CASCADE, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    step integer NOT NULL, actor_role varchar(60), actor_name varchar(60), kind varchar(40) NOT NULL, title text NOT NULL, detail jsonb,
    ticket_id integer, parent_ticket_id integer, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT uq_sim_e2e_step UNIQUE (run_id, step))`,
  `CREATE INDEX IF NOT EXISTS idx_sim_e2e_steps_run ON sim_e2e_steps (run_id, step)`,
  `ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS verified_metrics jsonb`,
  `ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS overdue_tickets jsonb`,
  `ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS assigned_ticket_ids jsonb`,
  `ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS data_gaps jsonb`,
  `ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS confidence varchar(10)`,
];

let ready: Promise<boolean> | null = null;
/** مرةً في العملية؛ الفشل لا يُحفظ. ensureOrgTables قبلها: executive_reports منه. */
export function ensureSimTables(): Promise<boolean> {
  ready ??= (async () => {
    const { ensureOrgTables } = await import("./schema");
    await ensureOrgTables();
    for (const q of ORG_SIM_SQL) await db.execute(sql.raw(q));
    return true;
  })().catch((e) => {
    ready = null;
    logger.warn({ err: String(e?.message ?? e) }, "تعذّر إنشاء جداول المحاكاة");
    return false;
  });
  return ready;
}

/** تذكرة عمل حقيقية: لا تجريبية (sim_)، ولا «سجل عمليات» يومي (ops_daily، دفترٌ لا عمل).
 * يُضاف إلى كل عدٍّ على employee_tasks يدخل بطاقةً أو لوحةً أو وقائع المدير. */
export const OPS_DAILY_TYPE = "ops_daily";
export const REAL_TASK = sql.raw(`(left(task_type, ${SIM_TASK_PREFIX.length}) <> '${SIM_TASK_PREFIX}' AND task_type <> '${OPS_DAILY_TYPE}')`);
