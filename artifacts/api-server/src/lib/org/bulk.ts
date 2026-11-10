// ── «اعتماد كل المؤهل»: زرٌّ يضغطه صاحب الحساب ─────────────────────
// يعتمد ما يجتاز بوابته وحده، كلٌّ بدالته العادية، وصاحب الجلسة هو الفاعل في كل سطر تدقيق:
//   • مقترحات التعليمات: عيّنة ظل سليمة واحدة على الأقل في ٧ أيام بلا failed_checks ولا mixed
//     (shadowGate بلا بديل no_model_path) ← approveProposal (يفعّل ويحفظ نسخة الإرجاع).
//     ما لم يُجرَّب (not_covered، أو بلا عيّنة) يُترك ويُكتب سببه «لم يُجرَّب» أمام صاحب العمل.
//     المقترحات غير التعليمات (تسعير، حدود، إعدادات…) تُترك ويُقال لماذا.
//   • صفوف الاعتراضات: دليلها من المعرفة المعتمدة (proof.status = approved_knowledge) ← decidePersuasion.
//     ما دليله «يحتاج موافقة المالك» أو بلا دليل يُترك، والكتيبات تُقرَّر واحدةً واحدة.
//   • المهام waiting_for_approval ← approveTask العادية.
// لا يمسّ أوضاع الإرسال ولا المتابعة ولا إعدادات التواصل ولا الحدود ولا الدروس. لا شيء يُرسل هنا.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { audit } from "./controls";
import { shadowGate } from "./auto-apply";
import { approveProposal } from "./proposals";
import { approveTask } from "./tasks";
import { OWNER_ACTION_TYPE, settleOwnerAction } from "./tickets";
import { REAL_TASK } from "./sim-schema";

export type BulkKind = "proposal" | "objection" | "playbook" | "task";
export interface BulkItem { kind: BulkKind; id: number; label: string; result: "approved" | "skipped" | "failed"; why: string }

/** ما ينظر فيه الزر، بلا تغيير: نفس البوابات، ليعرضه التأكيد قبل الضغط. */
export async function bulkApprove(userId: number, actor: number, o: { dryRun?: boolean } = {}): Promise<{ items: BulkItem[]; approved: number; skipped: number; failed: number; dryRun: boolean }> {
  const items: BulkItem[] = [];
  const dry = !!o.dryRun;

  // ١. المقترحات
  const props = (await db.execute<any>(sql`SELECT change_id, target, category, risk FROM improvement_proposals WHERE user_id = ${userId} AND status = 'proposed' ORDER BY change_id`)).rows;
  for (const p of props) {
    const id = Number(p.change_id);
    const label = String(p.target ?? p.category ?? `#${id}`);
    if (!String(p.target ?? "").startsWith("prompt:")) { items.push({ kind: "proposal", id, label, result: "skipped", why: `ليس مقترح تعليمات (${p.category ?? "؟"}): يُقرَّر يدوياً` }); continue; }
    const gate = await shadowGate(userId, { change_id: id, target: p.target }, { requireSamples: true });
    if (!gate.ok) { items.push({ kind: "proposal", id, label, result: "skipped", why: gate.why }); continue; }
    if (dry) { items.push({ kind: "proposal", id, label, result: "approved", why: `سيُعتمد ويُفعَّل: ${gate.why}` }); continue; }
    try { await approveProposal(userId, id, actor); items.push({ kind: "proposal", id, label, result: "approved", why: `اعتُمد وفُعّل: ${gate.why}` }); }
    catch (err: any) { items.push({ kind: "proposal", id, label, result: "failed", why: String(err?.message ?? err).slice(0, 300) }); }
  }

  // ٢. الاعتراضات والكتيبات المعلّقة
  const know = (await db.execute<any>(sql`SELECT id, key, value FROM account_knowledge WHERE user_id = ${userId} AND approval_status = 'pending'
      AND (key LIKE 'objection.%' OR key LIKE 'playbook.%') ORDER BY key`).catch(() => ({ rows: [] as any[] }))).rows;
  for (const k of know) {
    const id = Number(k.id), key = String(k.key);
    if (key.startsWith("playbook.")) { items.push({ kind: "playbook", id, label: key, result: "skipped", why: "الكتيّب يُقرَّر واحداً واحداً من صفحة الإقناع" }); continue; }
    let v: any = null;
    try { v = JSON.parse(String(k.value)); } catch {}
    const proof = v?.proof;
    if (!proof) { items.push({ kind: "objection", id, label: key, result: "skipped", why: "بلا دليل" }); continue; }
    if (proof.status !== "approved_knowledge") { items.push({ kind: "objection", id, label: key, result: "skipped", why: "دليله يحتاج موافقة المالك" }); continue; }
    if (dry) { items.push({ kind: "objection", id, label: key, result: "approved", why: "سيُعتمد: دليله من المعرفة المعتمدة" }); continue; }
    const r = await db.execute(sql`UPDATE account_knowledge SET approval_status = 'approved', last_verified_at = now() WHERE id = ${id} AND user_id = ${userId} AND approval_status = 'pending' RETURNING id`);
    if (r.rows.length) await audit({ userId, action: "lesson.approved", actor, kind: "account", meta: { id, layer: "account", key, via: "bulk" } });
    items.push({ kind: "objection", id, label: key, result: r.rows.length ? "approved" : "skipped", why: r.rows.length ? "اعتُمد: دليله من المعرفة المعتمدة" : "تغيّرت حالته" });
  }

  // ٣. المهام التي تنتظر الموافقة
  const tasks = (await db.execute<any>(sql`SELECT task_id, task_type, title FROM employee_tasks WHERE user_id = ${userId} AND status = 'waiting_for_approval' AND ${REAL_TASK} ORDER BY task_id`)).rows;
  for (const t of tasks) {
    const id = Number(t.task_id), label = String(t.title ?? t.task_type);
    if (dry) { items.push({ kind: "task", id, label, result: "approved", why: "ستُعتمد بالموافقة العادية" }); continue; }
    let r = await approveTask(userId, id, actor).catch(() => null);
    if (r?.taskType === OWNER_ACTION_TYPE) r = (await settleOwnerAction(userId, id, actor).catch(() => null)) ?? r;
    items.push({ kind: "task", id, label, result: r ? "approved" : "skipped", why: r ? `اعتُمدت (${r.status})` : "تغيّرت حالتها" });
  }

  const count = (x: BulkItem["result"]) => items.filter((i) => i.result === x).length;
  const res = { items, approved: count("approved"), skipped: count("skipped"), failed: count("failed"), dryRun: dry };
  if (!dry) await audit({ userId, action: "approvals.bulk", actor, kind: "owner", count: res.approved, meta: { approved: res.approved, skipped: res.skipped, failed: res.failed } });
  return res;
}
