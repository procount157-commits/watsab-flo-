// ── المرحلة ٥: تفعيل التعليمات الداخلية منخفضة الخطر وحده ──────────────
// مقترح تعليماتٍ معلَّق يُفعَّل آلياً فقط إن:
//   • مدخل المكتبة externalBehavior = false (فئته prompt_internal وخطره low) — يُسأل مرتين:
//     من صف المقترح ومن المكتبة نفسها، فما يمسّ الناس لا يمرّ أبداً ويبقى لصاحب الحساب؛
//   • والظل في آخر ٧ أيام له عيّنةٌ واحدة على الأقل (same/better) ولا failed_checks ولا no_output؛
//   • أو لا مسار نموذج للموظف (no_model_path) وملفه كامل (١٩ قسماً غير فارغ).
// التفعيل يمرّ على activatePrompt نفسه (نسخة سابقة + rollback_version)، ويُسجَّل
// proposal.auto_applied منخفض الخطر مع «الإرجاع متاح». يعمل بعد الظل اليومي وبعد
// POST /org/sim/shadow/run. كل استعلامٍ مقيَّد بحسابٍ واحد.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { accountHalted, audit, isHalted } from "./controls";
import { PROMPT_LIBRARY } from "./prompts";
import { activatePrompt, classifyPrompt } from "./proposals";
import { missingSections } from "./docs/model";

export const SHADOW_WINDOW_DAYS = 7;
export type GateBasis = "shadow" | "no_model_path";
export interface GateResult { ok: boolean; basis: GateBasis | null; why: string; samples: number; failed: number }

const keyOf = (target: string | null | undefined) => (target?.startsWith("prompt:") ? target.slice(7) : null);

/**
 * بوابة الظل لمقترح تعليمات. requireSamples: لا يقبل بديل no_model_path (الاعتماد الجماعي).
 * لا يرمي: الجدول الغائب = لا ظل = لا يمرّ.
 */
export async function shadowGate(userId: number, p: { change_id: number; target: string | null }, o: { now?: Date; requireSamples?: boolean } = {}): Promise<GateResult> {
  const key = keyOf(p.target);
  const entry = key ? PROMPT_LIBRARY[key] : undefined;
  const no = (why: string, samples = 0, failed = 0): GateResult => ({ ok: false, basis: null, why, samples, failed });
  if (!key || !entry) return no("ليس مقترح تعليماتٍ في المكتبة");
  const since = new Date((o.now ?? new Date()).getTime() - SHADOW_WINDOW_DAYS * 86_400_000);
  let c: any;
  try {
    [c] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE verdict IN ('same','better'))::int AS good,
        count(*) FILTER (WHERE verdict = 'failed_checks')::int AS failed, count(*) FILTER (WHERE verdict = 'no_output')::int AS empty,
        count(*) FILTER (WHERE verdict = 'no_model_path')::int AS nopath
      FROM shadow_runs WHERE user_id = ${userId} AND employee_key = ${key} AND created_at >= ${since}
        AND library_version = ${String(entry.version)} AND (proposal_id IS NULL OR proposal_id = ${p.change_id})`)).rows;
  } catch { return no("لا ظل لهذا الحساب بعد"); }
  const good = Number(c?.good ?? 0), failed = Number(c?.failed ?? 0), empty = Number(c?.empty ?? 0), nopath = Number(c?.nopath ?? 0);
  if (failed > 0) return no(`خالف فحصاً في الظل (${failed} عيّنة failed_checks)`, good, failed);
  if (empty > 0) return no(`المقترح لم يكتب شيئاً في ${empty} عيّنة`, good, failed);
  if (good >= 1) return { ok: true, basis: "shadow", why: `${good} عيّنة سليمة في الظل خلال ${SHADOW_WINDOW_DAYS} أيام، بلا مخالفة`, samples: good, failed: 0 };
  if (o.requireSamples) return no(nopath ? "لا مسار نموذج: لا عيّنة ظل تُعتمد بها" : `لا عيّنة ظل في آخر ${SHADOW_WINDOW_DAYS} أيام`);
  if (!nopath) return no(`لا عيّنة ظل في آخر ${SHADOW_WINDOW_DAYS} أيام`);
  // بلا مسار نموذج: الملف الذي سيُفعَّل (بذرة نسخة المكتبة الحالية) يجب أن يكون كاملاً.
  const [d] = (await db.execute<any>(sql`SELECT sections FROM employee_documentation WHERE user_id = ${userId} AND employee_key = ${key} AND author = 'system.seed'
      AND library_version = ${entry.version} AND status IN ('draft','proposed','approved') ORDER BY version DESC LIMIT 1`).catch(() => ({ rows: [] as any[] }))).rows;
  if (!d) return no("لا مسار نموذج، ولا ملف موظف لنسخة المكتبة الحالية");
  const missing = missingSections(d.sections ?? {});
  if (missing.length) return no(`لا مسار نموذج، والملف ناقص (${missing.length} قسماً فارغاً)`);
  return { ok: true, basis: "no_model_path", why: "لا مسار نموذج لهذا الموظف، وملفه كامل", samples: 0, failed: 0 };
}

export interface AutoResult { changeId: number; employeeKey: string; applied: boolean; why: string; basis?: GateBasis | null; version?: number; rollbackVersion?: number }

/** يمرّ على مقترحات الحساب المعلّقة منخفضة الخطر وحدها. لا يمسّ ما يؤثر في الناس. لا يرمي. */
export async function autoApplyLowRisk(userId: number, o: { trigger?: string; now?: Date } = {}): Promise<AutoResult[]> {
  const out: AutoResult[] = [];
  try {
    if (await accountHalted(userId, "org_auto_apply")) return out;
    const pending = (await db.execute<any>(sql`SELECT change_id, target, category, risk FROM improvement_proposals WHERE user_id = ${userId} AND status = 'proposed'
        AND target LIKE 'prompt:%' AND risk = 'low' AND category = 'prompt_internal' ORDER BY change_id`)).rows;
    for (const p of pending) {
      const changeId = Number(p.change_id);
      const key = keyOf(p.target)!;
      const entry = PROMPT_LIBRARY[key];
      // المكتبة هي الحكم، لا صف المقترح: ما يؤثر فيما يخرج للناس يبقى لصاحب الحساب.
      if (!entry || entry.externalBehavior !== false || classifyPrompt(entry).risk !== "low") { out.push({ changeId, employeeKey: key, applied: false, why: "يؤثر فيما يخرج للناس: ينتظر صاحب الحساب" }); continue; }
      const [emp] = (await db.execute<any>(sql`SELECT role FROM bot_employees WHERE user_id = ${userId} AND employee_key = ${key} LIMIT 1`)).rows;
      if (!emp) { out.push({ changeId, employeeKey: key, applied: false, why: "الموظف ليس في هذا الحساب" }); continue; }
      const halt = await isHalted({ userId, role: emp.role });
      if (halt.halted) { out.push({ changeId, employeeKey: key, applied: false, why: `موقوف: ${halt.reason ?? ""}`.trim() }); continue; }
      const gate = await shadowGate(userId, { change_id: changeId, target: p.target }, { now: o.now });
      if (!gate.ok) { out.push({ changeId, employeeKey: key, applied: false, why: gate.why }); continue; }
      const note = `اعتُمد آلياً: منخفض الخطر (${gate.basis === "shadow" ? "الظل" : "بلا مسار نموذج وملف كامل"}). الإرجاع متاح.`;
      const [claimed] = (await db.execute<any>(sql`UPDATE improvement_proposals SET status = 'approved', decision_note = ${note}
        WHERE change_id = ${changeId} AND user_id = ${userId} AND status = 'proposed' AND risk = 'low' RETURNING change_id`)).rows;
      if (!claimed) continue;
      try {
        const a = await activatePrompt(userId, key, { changeId, actor: null });
        await audit({ userId, action: "proposal.auto_applied", kind: "prompt_internal", role: emp.role, why: gate.why,
          meta: { changeId, employeeKey: key, risk: "low", basis: gate.basis, samples: gate.samples, version: a.version, rollbackVersion: a.previousVersion, rollbackAvailable: true, trigger: o.trigger ?? "manual" } });
        out.push({ changeId, employeeKey: key, applied: true, why: gate.why, basis: gate.basis, version: a.version, rollbackVersion: a.previousVersion });
      } catch (err: any) {
        await db.execute(sql`UPDATE improvement_proposals SET status = 'proposed', decision_note = ${`تعذّر التفعيل الآلي: ${String(err?.message ?? err).slice(0, 300)}`}
          WHERE change_id = ${changeId} AND user_id = ${userId} AND status = 'approved'`);
        out.push({ changeId, employeeKey: key, applied: false, why: `تعذّر التفعيل: ${String(err?.message ?? err).slice(0, 200)}` });
      }
    }
  } catch (err: any) {
    logger.warn({ userId, err: String(err?.message ?? err).slice(0, 200) }, "التفعيل الآلي منخفض الخطر تعذّر");
  }
  return out;
}
