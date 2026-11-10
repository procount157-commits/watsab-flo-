// ── السيناريو التجريبي من أوله إلى آخره (§20) ───────────────────────
// على بيانات اختبار الحساب نفسه (sim_fixtures، is_test دائماً)، داخل المحاكاة:
//   ١ جاسم يحلل حملة ضعيفة ← تذكرة بدليلها
//   ٢ منصور يراجع ← تذكرة مربوطة بها
//   ٣ سلمى تخطط ← تذكرة تخطيط
//   ٤ نورة تعيد الكتابة بمسارها الحقيقي (نداء نموذج واحد محسوب من سقف اليوم)
//   ٥ ماجد يقبل أو يعيد بملاحظات، بفحوصه الحقيقية
//   ٦ البوابة ترفض في المحاكاة ويُسجَّل تنفيذٌ تجريبي
//   ٧ جاسم يستلم حدث النتيجة
//   ٨ درسٌ مرشّح معلّق — في سجل السيناريو وحده، لا في ذاكرة أي موظف
// كل خطوة صفٌّ في sim_e2e_steps. التذاكر في employee_tasks بنوعٍ يبدأ بـ sim_ فلا تدخل
// بطاقةً ولا لوحةً ولا وقائع المدير (REAL_TASK). لا رقم من هنا يختلط برقمٍ حقيقي.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { asAgent } from "../agent-context";
import { logger } from "../logger";
import { accountHalted } from "./controls";
import { gateSend } from "./gateway";
import { callsToday, SHADOW_DAILY_CALLS } from "./shadow";
import { ensureSimTables } from "./sim-schema";
import { newSimContext, withSimulation, SIM_TASK_PREFIX, type SimContext } from "./simulation";
import { createTask } from "./tasks";
import { handoffTicket } from "./tickets";
import { employeeKeyOf } from "./departments";

export const E2E_CALLS = 3;
export const WEAK_FIXTURE = {
  kind: "weak_campaign", label: "حملة ضعيفة — بيانات اختبار",
  data: {
    test_data: true, name: "[اختبار] حملة ضعيفة", sector: "عقارات", goal: "اجتماع تعريفي مع شركات الوساطة العقارية حول الامتثال لمكافحة غسل الأموال",
    subject: "Our services", lead: "We are the best accounting firm in the UAE and we offer world-class solutions for every company. Contact us now, last chance!",
    sent: 120, opened: 9, clicked: 0, replied: 1, positive: 0, bounced: 7,
  },
} as const;

const rows = async <T = any>(q: any): Promise<T[]> => (await db.execute<any>(q)).rows as T[];

// ── التذاكر: الاقتران في مكانٍ واحد ────────────────────────────────
// تذاكر المسار A: الأولى تذكرةٌ مكلَّف بها مفتاح جاسم، وكل ما بعدها تسليمٌ (handoffTicket)
// تذكرةً ابنةً لأبيها. النوع يبدأ بـ sim_ فلا تدخل أي عدٍّ حقيقي (REAL_TASK).
export interface SimTicket { taskId: number }
export async function openTicket(userId: number, t: { owner: string; by: string; type: string; parent?: number | null; title: string; evidence: unknown; runId: number }): Promise<SimTicket> {
  const input = { title: t.title, evidence: t.evidence, simulation: true, test_data: true, simRunId: t.runId };
  const by = { kind: "employee" as const, id: employeeKeyOf(t.by) };
  const idempotencyKey = `sim_e2e:${t.runId}:${t.type}`;
  const actionType = `${SIM_TASK_PREFIX}${t.type}`;
  if (t.parent != null) {
    const child = await handoffTicket(userId, t.parent, { to: employeeKeyOf(t.owner), title: t.title, input, actionType, priority: "low", idempotencyKey }, by);
    return { taskId: child.taskId };
  }
  const { task } = await createTask({
    userId, ownerRole: t.owner, createdByRole: t.by, taskType: actionType, actionType, priorityLevel: "low", maxRetries: 0,
    title: t.title, assignedTo: employeeKeyOf(t.owner), createdBy: by, input, idempotencyKey,
  });
  return { taskId: task.taskId };
}
export async function closeTicket(userId: number, t: SimTicket, output: unknown, status: "completed" | "failed" = "completed"): Promise<void> {
  const out = JSON.stringify({ ...(output as object), simulation: true });
  await db.execute(sql`UPDATE employee_tasks SET status = ${status}, completed_at = now(), updated_at = now(), output_refs = ${out}::jsonb, actual_output = ${out}::jsonb
    WHERE task_id = ${t.taskId} AND user_id = ${userId} AND left(task_type, ${SIM_TASK_PREFIX.length}) = ${SIM_TASK_PREFIX}`);
}

// ── التحليل بالكود ─────────────────────────────────────────────────
export interface Finding { code: string; note: string; value?: number }
/** ما يراه جاسم في الحملة: نسبٌ من أرقامها هي، وكلمات الحارس في نصها. Pure. */
export function analyseCampaign(f: { sent: number; opened: number; replied: number; positive: number; bounced: number; subject: string; lead: string }, guard: (t: string[]) => string[]): Finding[] {
  const out: Finding[] = [];
  const rate = (n: number) => (f.sent > 0 ? Math.round((n / f.sent) * 1000) / 10 : 0);
  if (rate(f.opened) < 15) out.push({ code: "low_open", note: `فتح ${rate(f.opened)}٪ من ${f.sent}: العنوان لا يقول شيئاً عن القارئ`, value: rate(f.opened) });
  if (f.positive === 0) out.push({ code: "no_positive", note: `لا رد نافع من ${f.sent}`, value: 0 });
  if (rate(f.bounced) >= 5) out.push({ code: "bounce", note: `ارتداد ${rate(f.bounced)}٪: القائمة تحتاج تنظيفاً قبل أي موجة`, value: rate(f.bounced) });
  for (const g of guard([f.subject, f.lead])) out.push({ code: "guard", note: g });
  if (f.subject.split(/\s+/).length <= 2) out.push({ code: "vague_subject", note: `العنوان «${f.subject}» عام` });
  return out;
}

// ── السجل ─────────────────────────────────────────────────────────
async function step(runId: number, userId: number, n: number, s: { role: string | null; name: string | null; kind: string; title: string; detail?: unknown; ticket?: SimTicket | null; parent?: SimTicket | null }) {
  await db.execute(sql`INSERT INTO sim_e2e_steps (run_id, user_id, step, actor_role, actor_name, kind, title, detail, ticket_id, parent_ticket_id)
    VALUES (${runId}, ${userId}, ${n}, ${s.role}, ${s.name}, ${s.kind}, ${s.title}, ${JSON.stringify(s.detail ?? null)}::jsonb, ${s.ticket?.taskId ?? null}, ${s.parent?.taskId ?? null})`);
}

async function fixtureFor(userId: number): Promise<{ id: number; data: typeof WEAK_FIXTURE.data }> {
  await db.execute(sql`INSERT INTO sim_fixtures (user_id, kind, label, data, is_test) VALUES (${userId}, ${WEAK_FIXTURE.kind}, ${WEAK_FIXTURE.label}, ${JSON.stringify(WEAK_FIXTURE.data)}::jsonb, true)
    ON CONFLICT (user_id, kind, label) DO NOTHING`);
  const [f] = await rows<any>(sql`SELECT id, data FROM sim_fixtures WHERE user_id = ${userId} AND kind = ${WEAK_FIXTURE.kind} AND label = ${WEAK_FIXTURE.label}`);
  return { id: Number(f.id), data: f.data };
}

export interface E2eDeps {
  /** مسار نورة. الافتراضي writeCampaign الحقيقي داخل المحاكاة. */
  write?: (userId: number, input: { goal: string; notes: string; angle: string }) => Promise<{ subjects: string[]; html: string } | null>;
}

const realWrite: NonNullable<E2eDeps["write"]> = async (userId, input) => {
  const { writeCampaign } = await import("../email/agent");
  const r = await writeCampaign(userId, { filter: {}, goal: input.goal, notes: input.notes, angle: input.angle, role: "email" });
  return r ? { subjects: r.draft.subjects, html: r.draft.html } : null;
};

export interface E2eResult { runId: number; status: "succeeded" | "failed"; steps: number; accepted: boolean | null; modelCalls: number; sandbox: unknown[]; error?: string }

/** السيناريو كله لحساب الطلب. لا يرسل شيئاً، ولا يكتب إلا تذاكر sim_ وصفوف السيناريو. */
export async function runE2e(userId: number, deps: E2eDeps = {}): Promise<E2eResult> {
  await ensureSimTables();
  if (await accountHalted(userId, "org_sim_e2e")) throw new Error("الحساب موقوف: لا سيناريو تجريبي");
  const fx = await fixtureFor(userId);
  const [run] = await rows<any>(sql`INSERT INTO sim_e2e_runs (user_id, fixture_id) VALUES (${userId}, ${fx.id}) RETURNING id`);
  const runId = Number(run.id);
  const left = Math.max(0, SHADOW_DAILY_CALLS - (await callsToday(userId)));
  const ctx: SimContext = newSimContext({ userId, kind: "e2e", runId: `e2e:${runId}`, budget: Math.min(E2E_CALLS, left) });
  const { formatIssues, guardCheck, tooSimilar } = await import("../email/team");
  const { brief } = await import("../email/agent");
  let n = 0;
  let accepted: boolean | null = null;
  try {
    await withSimulation(ctx, async () => {
      const f = fx.data;
      // ١ جاسم
      const findings = analyseCampaign(f, (t) => guardCheck(t, ""));
      const t1 = await openTicket(userId, { owner: "email_analyst", by: "email_analyst", type: "analysis", title: `تحليل «${f.name}»`, evidence: { fixtureId: fx.id, metrics: { sent: f.sent, opened: f.opened, replied: f.replied, positive: f.positive, bounced: f.bounced }, findings }, runId });
      await closeTicket(userId, t1, { findings: findings.length });
      await step(runId, userId, ++n, { role: "email_analyst", name: "جاسم", kind: "analysis", title: `حلّل «${f.name}» ووجد ${findings.length} مشكلة`, detail: { fixtureId: fx.id, findings }, ticket: t1 });
      // ٢ منصور
      const rewrite = findings.some((x) => x.code === "no_positive" || x.code === "guard" || x.code === "low_open");
      const decision = rewrite ? "إعادة كتابة بزاوية جديدة، وتنظيف القائمة قبل أي موجة" : "لا تغيير";
      const t2 = await openTicket(userId, { owner: "email_manager", by: "email_analyst", type: "review", parent: t1.taskId, title: `مراجعة تحليل جاسم`, evidence: { from: t1.taskId, decision }, runId });
      await closeTicket(userId, t2, { decision });
      await step(runId, userId, ++n, { role: "email_manager", name: "منصور", kind: "review", title: `راجع وقرّر: ${decision}`, detail: { decision }, ticket: t2, parent: t1 });
      // ٣ سلمى
      const plan = { angle: "مهلة goAML للوسطاء", audience: f.sector, cleanFirst: findings.some((x) => x.code === "bounce"), notes: findings.map((x) => x.note).join("؛ ") };
      const t3 = await openTicket(userId, { owner: "email_strategist", by: "email_manager", type: "plan", parent: t2.taskId, title: "خطة الموجة المصحّحة", evidence: plan, runId });
      await closeTicket(userId, t3, plan);
      await step(runId, userId, ++n, { role: "email_strategist", name: "سلمى", kind: "plan", title: `خطّطت: زاوية «${plan.angle}»${plan.cleanFirst ? "، وتنظيف القائمة أولاً" : ""}`, detail: plan, ticket: t3, parent: t2 });
      // ٤ نورة
      const t4 = await openTicket(userId, { owner: "email", by: "email_strategist", type: "revision", parent: t3.taskId, title: "إعادة كتابة الحملة", evidence: { plan: t3.taskId }, runId });
      const draft = ctx.budget.left > 0
        ? await asAgent(userId, "email", () => (deps.write ?? realWrite)(userId, { goal: f.goal, notes: `بيانات اختبار. ما وجده جاسم: ${plan.notes}`, angle: plan.angle })).catch(() => null)
        : null;
      await closeTicket(userId, t4, { written: !!draft, subjects: draft?.subjects ?? [] }, draft ? "completed" : "failed");
      await step(runId, userId, ++n, { role: "email", name: "نورة", kind: "revision", title: draft ? `كتبت نسخة جديدة: «${draft.subjects[0] ?? ""}»` : (ctx.budget.left <= 0 && ctx.budget.used === 0 ? "لم تكتب: سقف نداءات اليوم نفد" : "لم تكتب: لا مسودة من النموذج"),
        detail: draft ? { subjects: draft.subjects, html: draft.html } : { budgetLeft: ctx.budget.left }, ticket: t4, parent: t3 });
      // ٥ ماجد
      const knowledge = await brief(userId, [f.sector], 3500, { lessons: false }).catch(() => "");
      const issues = draft ? [...formatIssues(draft.html), ...guardCheck([...draft.subjects, draft.html], knowledge), ...(tooSimilar(draft.html, [f.lead]) ? ["تشبه الحملة الضعيفة نفسها"] : [])] : ["لا نص يُراجع"];
      accepted = issues.length === 0;
      const t5 = await openTicket(userId, { owner: "email_guard", by: "email", type: "guard", parent: t4.taskId, title: "مراجعة ماجد", evidence: { issues }, runId });
      await closeTicket(userId, t5, { accepted, issues });
      await step(runId, userId, ++n, { role: "email_guard", name: "ماجد", kind: accepted ? "accepted" : "returned", title: accepted ? "قبل النسخة" : `أعادها بـ ${issues.length} ملاحظة`, detail: { issues }, ticket: t5, parent: t4 });
      // ٦ البوابة
      const gate = await gateSend({ userId, channel: "email", kind: "campaign", recipient: "fixture@sim.invalid", role: "email" });
      await step(runId, userId, ++n, { role: null, name: "البوابة", kind: "sandbox_execution", title: gate.allowed ? "خطأ: البوابة سمحت في المحاكاة" : `رفضت (${gate.code}) وسُجّل تنفيذ تجريبي`, detail: { gate, sandbox: ctx.sandbox.at(-1) ?? null, accepted } });
      if (gate.allowed) throw new Error("البوابة سمحت داخل المحاكاة");
      // ٧ جاسم يستلم النتيجة
      const outcome = { accepted, issues: issues.length, gate: gate.code, sandbox: true };
      const t6 = await openTicket(userId, { owner: "email_analyst", by: "email_guard", type: "outcome", parent: t1.taskId, title: "نتيجة الدورة", evidence: outcome, runId });
      await closeTicket(userId, t6, outcome);
      await step(runId, userId, ++n, { role: "email_analyst", name: "جاسم", kind: "outcome_event", title: `استلم النتيجة: ${accepted ? "قُبلت النسخة" : "أُعيدت"}، ولم يخرج شيء`, detail: outcome, ticket: t6, parent: t1 });
      // ٨ درسٌ مرشّح
      const lesson = accepted
        ? `زاوية «${plan.angle}» مع ملخص يبدأ بواقعة القطاع تجاوزت فحوص ماجد على حملة ضعيفة`
        : `إعادة كتابة «${f.name}» لم تمرّ: ${issues.slice(0, 2).join("؛ ")}`;
      await step(runId, userId, ++n, { role: "email_analyst", name: "جاسم", kind: "learning_candidate", title: "درسٌ مرشّح ينتظر المراجعة", detail: { status: "pending", lesson, source: `sim_e2e:${runId}`, test_data: true, note: "من بيانات اختبار: لا يدخل ذاكرة أحد" } });
    });
    await db.execute(sql`UPDATE sim_e2e_runs SET status = 'succeeded', finished_at = now(), model_calls = ${ctx.budget.used}, summary = ${JSON.stringify({ steps: n, accepted, sandbox: ctx.sandbox })}::jsonb WHERE id = ${runId}`);
    return { runId, status: "succeeded", steps: n, accepted, modelCalls: ctx.budget.used, sandbox: ctx.sandbox };
  } catch (err: any) {
    const error = String(err?.message ?? err).slice(0, 500);
    logger.warn({ userId, runId, err: error }, "السيناريو التجريبي فشل");
    await db.execute(sql`UPDATE sim_e2e_runs SET status = 'failed', finished_at = now(), model_calls = ${ctx.budget.used}, error = ${error}, summary = ${JSON.stringify({ steps: n, sandbox: ctx.sandbox })}::jsonb WHERE id = ${runId}`);
    return { runId, status: "failed", steps: n, accepted, modelCalls: ctx.budget.used, sandbox: ctx.sandbox, error };
  }
}

export async function e2eRuns(userId: number, limit = 20) {
  await ensureSimTables();
  return rows(sql`SELECT id, status, fixture_id, model_calls, summary, error, started_at, finished_at FROM sim_e2e_runs WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`);
}
export async function e2eRun(userId: number, runId: number) {
  await ensureSimTables();
  const [run] = await rows(sql`SELECT r.*, f.label AS fixture_label, f.data AS fixture, f.is_test FROM sim_e2e_runs r LEFT JOIN sim_fixtures f ON f.id = r.fixture_id WHERE r.id = ${runId} AND r.user_id = ${userId}`);
  if (!run) return null;
  const steps = await rows(sql`SELECT step, actor_role, actor_name, kind, title, detail, ticket_id, parent_ticket_id, created_at FROM sim_e2e_steps WHERE run_id = ${runId} AND user_id = ${userId} ORDER BY step`);
  return { run, steps };
}
