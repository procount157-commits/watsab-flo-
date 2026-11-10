// ── جدول ملفات الموظفين عند الإقلاع ───────────────────────────────
// النشر لا يشغّل ملفات SQL، فما في lib/db/migrations/077_dossiers.sql يُنشأ هنا بالنص
// نفسه (org-docs.test.ts يقارن الاثنين). يُعاد تشغيله بأمان.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../../logger";
import { ensureOrgTables } from "../schema";

export const DOCS_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS employee_documentation (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60) NOT NULL,
    version integer NOT NULL, status varchar(12) NOT NULL DEFAULT 'draft', sections jsonb NOT NULL, library_version integer,
    author varchar(60) NOT NULL, change_reason text, proposal_id integer, replaced_version integer,
    created_at timestamptz NOT NULL DEFAULT now(), approved_by integer REFERENCES users(id) ON DELETE SET NULL, approved_at timestamptz, activated_at timestamptz,
    CONSTRAINT employee_documentation_status CHECK (status IN ('draft','proposed','approved','active','superseded')))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_documentation_version ON employee_documentation (user_id, employee_key, version)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_documentation_active ON employee_documentation (user_id, employee_key) WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS idx_employee_documentation_user ON employee_documentation (user_id, employee_key, status)`,
];

let ready: Promise<boolean> | null = null;
/** مرةً في العملية؛ الفشل لا يُحفظ فيحاول النداء التالي. */
export function ensureDocsTables(): Promise<boolean> {
  ready ??= (async () => {
    if (!(await ensureOrgTables())) throw new Error("جداول المنظّمة لم تُنشأ");
    for (const q of DOCS_TABLES_SQL) await db.execute(sql.raw(q));
    return true;
  })().catch((e) => {
    ready = null;
    logger.warn({ err: String(e?.message ?? e) }, "تعذّر إنشاء جدول ملفات الموظفين");
    return false;
  });
  return ready;
}
