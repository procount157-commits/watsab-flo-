// ── ملف الموظف داخل التفعيل والإرجاع ──────────────────────────────
// proposals.ts يناديهما داخل معاملته نفسها: activatePrompt يكتب في persona النص المجمَّع من
// نسخة الملف المعتمدة، والإرجاع يعيد النسخة النشطة السابقة. لا يستورد proposals.ts (لا دورة).
// لا شيء هنا يعمل وحده: لا مؤقّت، ولا تفعيل بلا مقترح معتمد حيث يلزم (يقرّره proposals.ts).

import { sql } from "drizzle-orm";
import { PROMPT_LIBRARY } from "../prompts";
import { renderRuntime, type ApprovedKnowledge, type DossierSections } from "./model";

export class DossierRefused extends Error { constructor(msg: string, public status = 409) { super(msg); } }

const SEED_AUTHOR = "system.seed";

/** حساب الموظف كما في ملفه: الاسم والنشاط. */
export async function accountOf(q: { execute: (s: any) => Promise<{ rows: any[] }> }, userId: number): Promise<{ name: string; vertical: string | null }> {
  const [a] = (await q.execute(sql`SELECT p.name, p.vertical, u.display_name FROM users u LEFT JOIN business_profile p ON p.user_id = u.id WHERE u.id = ${userId}`)).rows as any[];
  return { name: a?.name ?? a?.display_name ?? "", vertical: a?.vertical ?? null };
}

/** معرفة الحساب المعتمدة التي تدخل التعليمات: الاعتراضات والكتيبات، المعتمد غير المنتهي وحده. */
export async function approvedPersuasionKnowledge(q: { execute: (s: any) => Promise<{ rows: any[] }> }, userId: number): Promise<ApprovedKnowledge[]> {
  const r = await q.execute(sql`SELECT key, value FROM account_knowledge WHERE user_id = ${userId} AND approval_status = 'approved'
    AND (expiry_at IS NULL OR expiry_at > now()) AND (key LIKE 'objection.%' OR key LIKE 'playbook.%') ORDER BY key LIMIT 200`);
  return (r.rows as any[]).map((x) => ({ key: String(x.key), value: String(x.value) }));
}

export interface DossierActivation { version: number; rendered: string }

/**
 * النسخة التي يفعّلها المقترح، مجمَّعةً للتشغيل، وتصير active والتي قبلها superseded. بلا رقم نسخة
 * (مقترح البذر أو تفعيل داخلي): آخر بذرةٍ لنسخة المكتبة الحالية. لا نسخة: null، ويبقى نص المكتبة.
 */
export async function activateDossier(tx: any, userId: number, employeeKey: string, dossierVersion: number | null, actor: number | null): Promise<DossierActivation | null> {
  const exists = (await tx.execute(sql`SELECT to_regclass('employee_documentation') IS NOT NULL AS ok`)).rows[0] as any;
  if (!exists?.ok) return null;
  const entry = PROMPT_LIBRARY[employeeKey];
  const [row] = (dossierVersion != null
    ? await tx.execute(sql`SELECT * FROM employee_documentation WHERE user_id = ${userId} AND employee_key = ${employeeKey} AND version = ${dossierVersion} FOR UPDATE`)
    : await tx.execute(sql`SELECT * FROM employee_documentation WHERE user_id = ${userId} AND employee_key = ${employeeKey} AND author = ${SEED_AUTHOR}
        AND library_version = ${entry?.version ?? -1} AND status IN ('draft','proposed','approved') ORDER BY version DESC LIMIT 1 FOR UPDATE`)).rows as any[];
  if (!row) {
    if (dossierVersion != null) throw new DossierRefused("نسخة الملف ليست في هذا الحساب", 404);
    return null;
  }
  if (!["draft", "proposed", "approved"].includes(row.status)) throw new DossierRefused(`نسخة الملف ${row.version} حالتها ${row.status}: لا تُفعَّل`);
  const sections = row.sections as DossierSections;
  const rendered = renderRuntime({
    employeeKey, sections, externalBehavior: entry?.externalBehavior ?? true,
    account: await accountOf(tx, userId), knowledge: await approvedPersuasionKnowledge(tx, userId),
  });
  if (!rendered.trim()) throw new DossierRefused("الملف أعاد تعليمات فارغة", 500);
  const [prev] = (await tx.execute(sql`UPDATE employee_documentation SET status = 'superseded' WHERE user_id = ${userId} AND employee_key = ${employeeKey} AND status = 'active' RETURNING version`)).rows as any[];
  await tx.execute(sql`UPDATE employee_documentation SET status = 'active', approved_by = coalesce(approved_by, ${actor}), approved_at = coalesce(approved_at, now()),
    activated_at = now(), replaced_version = ${prev ? Number(prev.version) : null} WHERE id = ${row.id}`);
  return { version: Number(row.version), rendered };
}

/** يربط النسخة بالمقترح الذي فعّلها، ليعرف الإرجاع أي نسخة يعيد. */
export async function linkDossierProposal(tx: any, userId: number, employeeKey: string, version: number, changeId: number): Promise<void> {
  await tx.execute(sql`UPDATE employee_documentation SET proposal_id = ${changeId} WHERE user_id = ${userId} AND employee_key = ${employeeKey} AND version = ${version}`);
}

/** الإرجاع: النسخة التي فعّلها المقترح تصير superseded، والتي كانت قبلها تعود active. */
export async function rollbackDossier(tx: any, userId: number, employeeKey: string, changeId: number): Promise<number | null> {
  const exists = (await tx.execute(sql`SELECT to_regclass('employee_documentation') IS NOT NULL AS ok`)).rows[0] as any;
  if (!exists?.ok) return null;
  const [row] = (await tx.execute(sql`UPDATE employee_documentation SET status = 'superseded' WHERE user_id = ${userId} AND employee_key = ${employeeKey}
    AND proposal_id = ${changeId} AND status = 'active' RETURNING replaced_version`)).rows as any[];
  if (!row) return null;
  if (row.replaced_version == null) return null;
  const [back] = (await tx.execute(sql`UPDATE employee_documentation SET status = 'active', activated_at = now() WHERE user_id = ${userId} AND employee_key = ${employeeKey}
    AND version = ${row.replaced_version} RETURNING version`)).rows as any[];
  return back ? Number(back.version) : null;
}
