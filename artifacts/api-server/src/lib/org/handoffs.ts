// ── التسليم بين الموظفين ──────────────────────────────────────────
// كان tell() يكتب رسالةً في agent_messages لا يقرؤها أي prompt في البريد: تسليمٌ على
// الورق. هنا كل تسليم مهمةٌ حقيقية يقرؤها كودٌ يغيّر ما يفعله الموظف التالي، ولا تُعلَّم
// مكتملة إلا حين تُستعمل فعلاً:
//
//   جاسم ← review_results ← منصور (معالج) ← strategy_directive ← سلمى (اختيار الموجة) ونورة (الكتابة)
//   حصّة ← subject_guidance ← نورة (الكتابة) وسلمى (موجز الموجة)
//   مريم ← retarget_proposal (موافقة) ← الطيار ينشئ الموجة
//   ماجد ← employee_feedback ← الكاتب (الكتابة التالية)
//   ردود ← learning_events ← جاسم (وقائعه)
//   فشل التسليم ← delivery_failure ← راشد ومارك (معالج)
//
// كل ما يصل prompt هنا محسوبٌ من نتائج مقاسة، لا نص نموذج.

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { approvalMatches, createTask, refuseChangedPayload, registerTaskHandler, toTask, type Task } from "./tasks";
import { employeeKeyOf } from "./departments";
import { contextTicketId, noteHandoff, ticketPayload } from "./ledger";
import { angleById, TRACK_AR } from "../email/policy";

const DAY = 86_400_000;
const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const dubaiDay = (now = Date.now()) => new Date(now + 4 * 3_600_000).toISOString().slice(0, 10);
const soft = (what: string) => (err: unknown) => { logger.warn({ what, err: String((err as any)?.message ?? err).slice(0, 200) }, "تسليم تعذّر"); return null; };

// ── القراءة من صندوق موظف ─────────────────────────────────────────
export interface Inbox { taskId: number; input: any }

/**
 * أحدث مهمة سارية من هذا النوع. بعد أول استعمال تصير completed وتبقى تُقرأ حتى تنتهي
 * مهلتها أو يحلّ محلها أحدث، فالموجة الثانية في اليوم تعمل بالتوجيه نفسه لا بلا توجيه.
 */
export async function activeTask(userId: number, ownerRole: string, type: string): Promise<Inbox | null> {
  const [r] = (await db.execute<{ task_id: number; input_refs: unknown }>(sql`SELECT task_id, input_refs FROM employee_tasks
    WHERE user_id = ${userId} AND owner_role = ${ownerRole} AND task_type = ${type} AND status IN ('queued','completed')
      AND (expires_at IS NULL OR expires_at > now()) ORDER BY task_id DESC LIMIT 1`)).rows;
  return r ? { taskId: Number(r.task_id), input: r.input_refs } : null;
}

/** استُعملت فعلاً: تكتمل مرةً، ويُضاف من استعملها (آخر عشرة). */
export async function markUsed(userId: number, taskId: number, by: Record<string, unknown>): Promise<void> {
  const log = sql`CASE WHEN jsonb_typeof(output_refs) = 'array' THEN output_refs ELSE '[]'::jsonb END`;
  await db.execute(sql`UPDATE employee_tasks SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now(),
      output_refs = CASE WHEN jsonb_array_length(${log}) < 10 THEN ${log} || ${JSON.stringify([{ ...by, at: new Date().toISOString() }])}::jsonb ELSE output_refs END
    WHERE task_id = ${taskId} AND user_id = ${userId} AND status IN ('queued','completed')`);
}

/** الجديد يحلّ محل القديم: توجيهان لا يعملان معاً. */
async function supersede(userId: number, ownerRole: string, type: string, keep: number) {
  await db.execute(sql`UPDATE employee_tasks SET status = 'cancelled', failure_reason = 'حلّ محلها أحدث', updated_at = now(), expires_at = COALESCE(expires_at, now())
    WHERE user_id = ${userId} AND owner_role = ${ownerRole} AND task_type = ${type} AND task_id <> ${keep} AND status = 'queued'`);
  await db.execute(sql`UPDATE employee_tasks SET expires_at = now(), updated_at = now()
    WHERE user_id = ${userId} AND owner_role = ${ownerRole} AND task_type = ${type} AND task_id < ${keep} AND status = 'completed' AND (expires_at IS NULL OR expires_at > now())`);
}

// ── جاسم ← منصور ──────────────────────────────────────────────────
export interface Verdicts {
  overall: { sent: number; positive: number; bounceRate: number };
  angles: Array<{ key: string; label: string; verdict: string; why: string; sent: number; positive: number }>;
  avoidAngles: string[];
  decisions: Array<{ kind: string; text: string }>;
}
const pickVerdicts = (r: any): Verdicts => ({
  overall: { sent: Number(r.overall?.sent ?? 0), positive: Number(r.overall?.positive ?? 0), bounceRate: Number(r.overall?.bounceRate ?? 0) },
  angles: (r.angles ?? []).map((a: any) => ({ key: a.key, label: a.label, verdict: a.verdict, why: a.why, sent: a.sent, positive: a.positive })),
  avoidAngles: r.avoidAngles ?? [],
  decisions: (r.decisions ?? []).map((d: any) => ({ kind: d.kind, text: d.text })),
});

/** انتهى جاسم: أحكامه بأدلتها مهمةٌ لمنصور، مرةً في اليوم. */
export async function handoffReviewResults(userId: number, report: unknown): Promise<number | null> {
  // التسليم تذكرةٌ ابنة لتذكرة جاسم الحالية، ومكلَّفها مفتاح موظف لا اسم.
  const parent = contextTicketId(userId);
  const r = await createTask({
    userId, ownerRole: "email_manager", createdByRole: "email_analyst", taskType: "review_results", parentTaskId: parent,
    input: pickVerdicts(report), idempotencyKey: `review_results:${dubaiDay()}`, expiresAt: new Date(Date.now() + 2 * DAY),
    title: "أحكام النتائج من جاسم", objective: "يقرّر المدير ما يُتجنَّب وما يتقدّم من أحكامٍ بأدلتها", actionType: "review_results",
    expectedOutput: "توجيه strategy_directive لسلمى ونورة، أو لا شيء إن لم يكن ما يُقال",
  }).catch(soft("review_results"));
  if (r && !r.duplicate) await noteHandoff(userId, parent, r.task.taskId, employeeKeyOf("email_manager"));
  return r?.task.taskId ?? null;
}

// ── منصور ← سلمى ونورة ────────────────────────────────────────────
export interface Directive {
  avoidAngles: string[]; priorityAngles: string[]; prioritySectors: string[];
  /** ما يُقرأ في prompt الكاتبة: أرقام محسوبة، لا رأي نموذج. */
  lines: string[];
}

/** قرار المدير من الأحكام: ما يُتجنَّب وما يتقدّم. كودٌ لا نموذج. Pure. */
export function directiveFrom(v: Verdicts, plan?: { perDay?: number | null; waveSize?: number | null } | null): Directive {
  const off = v.angles.filter((a) => a.verdict === "rewrite" || a.verdict === "hold");
  const up = v.angles.filter((a) => a.verdict === "scale");
  const sectors = [...new Set(up.map((a) => angleById(a.key)?.sector).filter((s): s is string => !!s))];
  const lines = [
    ...off.map((a) => `لا تعيدي زاوية «${a.label}» ولا صياغتها: ${a.why}. غيّري المدخل كله.`),
    ...up.map((a) => `زاوية «${a.label}» نفعت (${a.positive} رداً نافعاً من ${a.sent} شركة): اكتبي القادم لقطاعها على نمطها.`),
    ...(plan?.perDay ? [`خطة الهدف: ${plan.perDay} شركة في اليوم.`] : []),
  ];
  return { avoidAngles: [...new Set([...off.map((a) => a.key), ...v.avoidAngles])], priorityAngles: up.map((a) => a.key), prioritySectors: sectors, lines };
}

/** مهمة strategy_directive لسلمى ونورة. لا تُنشأ إن لم يكن ثمة ما يُقال، وحكمٌ لم يتغيّر لا يتكرر. */
export async function issueDirectives(userId: number, d: Directive, source: { taskId?: number | null; from?: string } = {}): Promise<number[]> {
  if (!d.avoidAngles.length && !d.priorityAngles.length) return [];
  const made: number[] = [];
  const key = hash({ a: [...d.avoidAngles].sort(), p: [...d.priorityAngles].sort(), l: d.lines });
  for (const owner of ["email_strategist", "email"]) {
    const parent = source.taskId ?? contextTicketId(userId);
    const r = await createTask({
      userId, ownerRole: owner, createdByRole: "email_manager", parentTaskId: parent, taskType: "strategy_directive", input: d,
      idempotencyKey: `strategy_directive:${owner}:${dubaiDay()}:${key}`, expiresAt: new Date(Date.now() + 7 * DAY),
      title: "توجيه المدير للموجة والكتابة", actionType: "strategy_directive", expectedOutput: "يُقرأ في الجولة التالية ويُعلَّم مستعملاً",
    });
    if (!r.duplicate) { await supersede(userId, owner, "strategy_directive", r.task.taskId); await noteHandoff(userId, parent, r.task.taskId, employeeKeyOf(owner)); }
    made.push(r.task.taskId);
  }
  return made;
}

/** ما تعمل به سلمى هذه الجولة. فشل القراءة لا يوقف الطيار: يعمل بلا توجيه، كما كان. */
export async function strategistDirective(userId: number): Promise<(Directive & { taskId: number }) | null> {
  const t = await activeTask(userId, "email_strategist", "strategy_directive").catch(soft("directive"));
  return t ? { taskId: t.taskId, avoidAngles: t.input?.avoidAngles ?? [], priorityAngles: t.input?.priorityAngles ?? [], prioritySectors: t.input?.prioritySectors ?? [], lines: t.input?.lines ?? [] } : null;
}

/** القطاعات المقدَّمة أولاً، وبقية الترتيب كما هو. Pure. */
export function orderByPriority<T extends { sector: string }>(rows: T[], priority: string[] = []): T[] {
  const rank = (s: string) => { const i = priority.indexOf(s); return i < 0 ? priority.length : i; };
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.sector) - rank(b.r.sector) || a.i - b.i).map((x) => x.r);
}

// ── حصّة ← نورة وسلمى ─────────────────────────────────────────────
export const SUBJECT_MIN_SAMPLE = 30;
export interface SubjectPattern { subject: string; sent: number; opened: number; replied: number; rate: number }

/**
 * أفضل قوالب العناوين، وبعيّنةٍ كافية فقط. الترتيب بالرد ثم الفتح؛ وحين لا يُقاس الفتح
 * لا يدخل إلا ما جلب ردّاً، فالصفر هناك غياب قياس. عناوين التسلسلات (اسمها لا نصها) لا
 * تُكتب نمطاً. Pure.
 */
export function verifiedSubjects(o: { measurable: boolean; subjects: SubjectPattern[] }, top = 3): SubjectPattern[] {
  const rr = (s: SubjectPattern) => (s.sent ? s.replied / s.sent : 0);
  return o.subjects
    .filter((s) => s.sent >= SUBJECT_MIN_SAMPLE && !/ — الخطوة \d+$/.test(s.subject) && (o.measurable ? s.opened > 0 || s.replied > 0 : s.replied > 0))
    .sort((a, b) => rr(b) - rr(a) || (o.measurable ? b.rate - a.rate : 0))
    .slice(0, top);
}

export async function handoffSubjectGuidance(userId: number, report: { measurable: boolean; subjects: SubjectPattern[] }): Promise<number[]> {
  const patterns = verifiedSubjects(report);
  if (!patterns.length) return [];
  const made: number[] = [];
  for (const owner of ["email", "email_strategist"]) {
    const parent = contextTicketId(userId);
    const r = await createTask({
      userId, ownerRole: owner, createdByRole: "email_opens", taskType: "subject_guidance", input: { patterns, measurable: report.measurable }, parentTaskId: parent,
      idempotencyKey: `subject_guidance:${owner}:${hash(patterns)}`, expiresAt: new Date(Date.now() + 14 * DAY),
      title: "عناوين أثبتت نفسها (حصّة)", actionType: "subject_guidance", expectedOutput: "تُقرأ في الكتابة التالية",
    });
    if (!r.duplicate) { await supersede(userId, owner, "subject_guidance", r.task.taskId); await noteHandoff(userId, parent, r.task.taskId, employeeKeyOf(owner)); }
    made.push(r.task.taskId);
  }
  return made;
}

const patternLine = (p: SubjectPattern, measurable: boolean) => `«${p.subject.slice(0, 80)}» — ${p.sent} رسالة، ${measurable ? `فتح ${p.rate}٪، ` : ""}${p.replied} ردّاً`;

/** سطر سلمى في موجز الموجة، ومن أي مهمة جاء. */
export async function strategistSubjects(userId: number): Promise<{ taskId: number; line: string } | null> {
  const t = await activeTask(userId, "email_strategist", "subject_guidance").catch(soft("subjects"));
  const p: SubjectPattern[] = t?.input?.patterns ?? [];
  if (!t || !p.length) return null;
  return { taskId: t.taskId, line: `عناوين أثبتت نفسها في هذا الحساب (لا تنسخيها، اكتبي على نمطها): ${p.map((x) => patternLine(x, !!t.input?.measurable)).join(" | ")}` };
}

// ── مريم ← الطيار ─────────────────────────────────────────────────
/** الحالات التي لها فلتر جمهور حقيقي. غيرها (موعدٌ ذكره، حوّلنا لغيره) لرسالةٍ لشخص، لا لموجة. */
export const RETARGET_AUDIENCE: Record<string, string[]> = {
  clicked: ["clicked"], opened: ["opened_no_reply"], silent_many: ["sent_no_open"], silent_one: ["sent_no_open"],
};
export interface RetargetProposal { cohort: string; label: string; eligible: number; inCohort: number; angle: { brief: string; subjectHint: string; why: string; cta: string }; guards: string[]; engagement: string[] }

/** الموجة الواحدة التي تقترحها مريم. Pure. */
export function pickRetarget(plans: Array<{ cohort: string; label: string; eligible: number; inCohort: number; angle: RetargetProposal["angle"]; guards: string[]; priority: number }>): RetargetProposal | null {
  const p = plans.filter((x) => x.eligible > 0 && RETARGET_AUDIENCE[x.cohort]).sort((a, b) => a.priority - b.priority)[0];
  return p ? { cohort: p.cohort, label: p.label, eligible: p.eligible, inCohort: p.inCohort, angle: p.angle, guards: p.guards, engagement: RETARGET_AUDIENCE[p.cohort]! } : null;
}

const isoWeek = (now = new Date()) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${Math.ceil(((d.getTime() - y.getTime()) / DAY + 1) / 7)}`;
};

/** مقترحٌ واحد ينتظر موافقة صاحب العمل: تغيير استراتيجية خارجية لا يقرّره موظف. */
export async function handoffRetarget(userId: number, plans: Parameters<typeof pickRetarget>[0]): Promise<number | null> {
  const p = pickRetarget(plans);
  if (!p) return null;
  const [open] = (await db.execute(sql`SELECT 1 FROM employee_tasks WHERE user_id = ${userId} AND task_type = 'retarget_proposal' AND status = 'waiting_for_approval' LIMIT 1`)).rows;
  if (open) return null;
  const parent = contextTicketId(userId);
  const r = await createTask({
    userId, ownerRole: "email_strategist", createdByRole: "email_retarget", taskType: "retarget_proposal", input: p, approvalRequired: true, parentTaskId: parent,
    idempotencyKey: `retarget_proposal:${p.cohort}:${isoWeek()}`, expiresAt: new Date(Date.now() + 14 * DAY),
    title: `موجة إعادة استهداف: ${p.label}`.slice(0, 300), objective: p.angle.why, actionType: "retarget_proposal",
    expectedOutput: `موجةٌ لـ${p.eligible} جهة بعد موافقتك`,
  });
  if (!r.duplicate) await noteHandoff(userId, parent, r.task.taskId, employeeKeyOf("email_strategist"));
  return r.duplicate ? null : r.task.taskId;
}

/** ما وافق عليه صاحب العمل ولم تُنشأ موجته بعد. */
export async function approvedRetargets(userId: number): Promise<Array<{ taskId: number; input: RetargetProposal }>> {
  const rows = (await db.execute<any>(sql`SELECT * FROM employee_tasks
    WHERE user_id = ${userId} AND task_type = 'retarget_proposal' AND status = 'queued' AND approval_status = 'approved' AND (expires_at IS NULL OR expires_at > now()) ORDER BY task_id`)).rows;
  // ما تغيّرت حمولته بعد الموافقة لا يُنشئ موجة: يعود ينتظر موافقةً على ما هو الآن.
  const out: Array<{ taskId: number; input: RetargetProposal }> = [];
  for (const r of rows) {
    const t = toTask(r);
    if (approvalMatches(t, ticketPayload(t))) out.push({ taskId: t.taskId, input: r.input_refs });
    else await refuseChangedPayload(t, ticketPayload(t)).catch(soft("retarget payload"));
  }
  return out;
}

// ── ماجد ← الكاتب ─────────────────────────────────────────────────
/** مفتاح الملاحظة: بلا الاقتباس ولا الأرقام، فالعيب نفسه لا يتكرر بصياغتين. Pure. */
export const issueKey = (issue: string) => issue.replace(/«[^»]*»/g, "«»").replace(/[\d٠-٩]+/g, "#").replace(/\s+/g, " ").trim().slice(0, 120);

export async function recordQualityFeedback(userId: number, writerRole: string, issues: string[], ref: Record<string, unknown> = {}): Promise<number> {
  const key = employeeKeyOf(writerRole);
  let added = 0;
  for (const issue of [...new Set(issues.map((x) => x.trim()).filter(Boolean))].slice(0, 8)) {
    const k = issueKey(issue);
    const up = await db.execute(sql`UPDATE employee_feedback SET evidence = jsonb_set(COALESCE(evidence, '{}'::jsonb), '{times}', to_jsonb(COALESCE((evidence->>'times')::int, 1) + 1)), created_at = now()
      WHERE id = (SELECT id FROM employee_feedback WHERE user_id = ${userId} AND employee_key = ${key} AND from_role = 'email_guard' AND evidence->>'issueKey' = ${k} ORDER BY id DESC LIMIT 1)`);
    if (up.rowCount) continue;
    await db.execute(sql`INSERT INTO employee_feedback (user_id, employee_key, from_role, verdict, note, evidence)
      VALUES (${userId}, ${key}, 'email_guard', 'bad', ${issue.slice(0, 500)}, ${JSON.stringify({ issueKey: k, times: 1, ...ref })}::jsonb)`);
    added++;
  }
  return added;
}

export async function qualityFeedback(userId: number, writerRole: string, limit = 6): Promise<string[]> {
  const r = await db.execute<{ note: string }>(sql`SELECT note FROM employee_feedback WHERE user_id = ${userId} AND employee_key = ${employeeKeyOf(writerRole)} AND verdict = 'bad'
    AND created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT ${limit}`);
  return r.rows.map((x) => x.note);
}

// ── ما يقرؤه الكاتب ───────────────────────────────────────────────
export interface WriterGuidance { block: string; taskIds: number[] }

/** توجيه منصور، وعناوين حصّة، وملاحظات ماجد: نصاً واحداً للـprompt. فشلها لا يوقف الكتابة. */
export async function writerGuidance(userId: number, writerRole: string): Promise<WriterGuidance> {
  const [dir, subj, notes] = await Promise.all([
    activeTask(userId, "email", "strategy_directive").catch(soft("directive")),
    activeTask(userId, "email", "subject_guidance").catch(soft("subjects")),
    qualityFeedback(userId, writerRole).catch(() => [] as string[]),
  ]);
  const parts: string[] = [];
  const lines: string[] = dir?.input?.lines ?? [];
  if (lines.length) parts.push(["توجيه منصور (محسوب من نتائج مقاسة):", ...lines.map((l) => `- ${l}`)].join("\n"));
  const pat: SubjectPattern[] = subj?.input?.patterns ?? [];
  if (pat.length) parts.push([`عناوين أثبتت نفسها، بعيّنة ${SUBJECT_MIN_SAMPLE} رسالة فأكثر (اكتبي على نمطها ولا تنسخيها):`, ...pat.map((p) => `- ${patternLine(p, !!subj?.input?.measurable)}`)].join("\n"));
  if (notes.length) parts.push(["ما أوقفه ماجد من كتاباتك السابقة — لا تكرريه:", ...notes.map((n) => `- ${n}`)].join("\n"));
  return { block: parts.join("\n\n"), taskIds: [dir?.taskId, subj?.taskId].filter((x): x is number => !!x && (x === dir?.taskId ? lines.length > 0 : pat.length > 0)) };
}

// ── الردود ← جاسم ─────────────────────────────────────────────────
const POSITIVE = new Set(["interested", "question", "considering", "later", "referral"]);
const NEGATIVE = new Set(["not_interested", "opt_out", "complaint"]);
/** نيّة الرد بلغة النتائج، كما يعدّها results.ts. Pure. */
export const outcomeOf = (intent: string | null | undefined) => (intent && POSITIVE.has(intent) ? "positive" : intent && NEGATIVE.has(intent) ? "negative" : "neutral");

export async function recordReplyOutcome(userId: number, r: { messageId?: number | null; inboundId: number; contactId?: number | null; intent: string | null; temperature?: string | null }): Promise<void> {
  const [m] = r.messageId ? (await db.execute<{ id: number; track: string | null; angle: string | null }>(sql`
    SELECT ms.id, ms.track, ms.angle FROM email_messages em
    LEFT JOIN email_sequence_jobs j ON j.id = em.sequence_job_id
    JOIN email_missions ms ON ms.user_id = em.user_id AND (ms.campaign_id = em.campaign_id OR ms.warm_sequence_id = j.sequence_id OR ms.cold_sequence_id = j.sequence_id)
    WHERE em.id = ${r.messageId} AND em.user_id = ${userId} LIMIT 1`)).rows : [];
  await db.execute(sql`INSERT INTO learning_events (user_id, employee_key, department, event_type, outcome, evidence)
    VALUES (${userId}, ${employeeKeyOf("email_analyst")}, 'email', 'reply_outcome', ${outcomeOf(r.intent)}, ${JSON.stringify({
      missionId: m?.id ?? null, track: m?.track ?? null, angle: m?.angle ?? null, intent: r.intent, temperature: r.temperature ?? null,
      inboundId: r.inboundId, messageId: r.messageId ?? null, contactId: r.contactId ?? null })}::jsonb)`);
}

/** وقائع جاسم من أحداث الردود: بالزاوية، آخر ٣٠ يوماً. أرقام، لا نص أحد. */
export async function replyOutcomeFacts(userId: number): Promise<string[]> {
  const rows = (await db.execute<{ angle: string | null; track: string | null; outcome: string; n: number }>(sql`
    SELECT evidence->>'angle' AS angle, evidence->>'track' AS track, outcome, count(*)::int AS n FROM learning_events
    WHERE user_id = ${userId} AND event_type = 'reply_outcome' AND created_at > now() - interval '30 days'
    GROUP BY 1, 2, 3`)).rows;
  if (!rows.length) return [];
  const by = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = r.angle ? (angleById(r.angle)?.label ?? r.angle) : r.track ? (TRACK_AR as Record<string, string>)[r.track] ?? r.track : "بلا مهمة";
    const c = by.get(k) ?? {}; c[r.outcome] = (c[r.outcome] ?? 0) + Number(r.n); by.set(k, c);
  }
  return ["الردود كما سجّلتها ليلى، بالزاوية:", ...[...by].map(([k, c]) => `• ${k}: نافع ${c["positive"] ?? 0} · يغلق الباب ${c["negative"] ?? 0} · غير ذلك ${c["neutral"] ?? 0}`)];
}

// ── فشل التسليم ← راشد ومارك ──────────────────────────────────────
export type DeliveryFailure = "policy" | "address" | "mailbox" | "hold";
/** مهمةٌ لكل منهما، مرةً في اليوم لكل نوع: الفشل نفسه لا يصنع طابوراً. لا ترمي أبداً. */
export async function handoffDeliveryFailure(userId: number, kind: DeliveryFailure, detail: Record<string, unknown> = {}): Promise<void> {
  for (const owner of ["email_registrar", "monitor"]) {
    await createTask({
      userId, ownerRole: owner, createdByRole: "email_queue", taskType: "delivery_failure", input: { kind, ...detail }, parentTaskId: contextTicketId(userId),
      idempotencyKey: `delivery_failure:${owner}:${kind}:${dubaiDay()}`, expiresAt: new Date(Date.now() + 2 * DAY), maxRetries: 2,
      title: `فشل تسليم بريد (${kind})`, actionType: "delivery_failure", priorityLevel: "high", expectedOutput: "مطابقة السجل أو فحص المراقب، بحكمٍ مكتوب",
    }).catch(soft("delivery_failure"));
  }
}

// ── سير العمل ─────────────────────────────────────────────────────
export async function startWorkflow(userId: number, workflow: string, input: unknown): Promise<number | null> {
  const r = await db.execute<{ id: number }>(sql`INSERT INTO workflow_executions (user_id, workflow, input) VALUES (${userId}, ${workflow}, ${JSON.stringify(input ?? null)}::jsonb) RETURNING id`).catch(soft("workflow"));
  return r ? Number(r.rows[0]!.id) : null;
}
export async function workflowStep(userId: number, workflowId: number | null, role: string, event: string, detail?: unknown): Promise<void> {
  await db.execute(sql`INSERT INTO execution_events (user_id, workflow_id, employee_key, event, detail) VALUES (${userId}, ${workflowId}, ${employeeKeyOf(role)}, ${event.slice(0, 60)}, ${detail === undefined ? null : JSON.stringify(detail)}::jsonb)`).catch(soft("workflow step"));
}
export async function finishWorkflow(workflowId: number | null, status: "succeeded" | "failed" | "cancelled" | "halted", output?: unknown, error?: string | null): Promise<void> {
  if (!workflowId) return;
  await db.execute(sql`UPDATE workflow_executions SET status = ${status}, output = ${output === undefined ? null : JSON.stringify(output)}::jsonb, error = ${error ?? null}, finished_at = now() WHERE id = ${workflowId}`).catch(soft("workflow end"));
}
/** سير عمل الشركة ما زال مفتوحاً؟ لتكمله المزامنة حين تخرج الرسالة فعلاً. */
export async function openWorkflowFor(userId: number, workflow: string, accountId: number): Promise<number | null> {
  const [r] = (await db.execute<{ id: number }>(sql`SELECT id FROM workflow_executions WHERE user_id = ${userId} AND workflow = ${workflow} AND status = 'running' AND input->>'accountId' = ${String(accountId)} ORDER BY id DESC LIMIT 1`)).rows;
  return r ? Number(r.id) : null;
}

// ── المعالجات ─────────────────────────────────────────────────────
export function registerOrgHandlers(): void {
  registerTaskHandler("review_results", {
    external: false,
    // منصور يقرأ الأحكام ويقرّر: كودٌ بلا نموذج، ومخرجه مهمتان تغيّران الجولة التالية.
    run: async (t: Task) => {
      const made = await issueDirectives(t.userId, directiveFrom(t.inputRefs as Verdicts), { taskId: t.taskId });
      return { directives: made };
    },
  });
  registerTaskHandler("delivery_failure", {
    external: false,
    run: async (t: Task) => {
      if (t.ownerRole === "monitor") {
        // مارك يفحص الآن بدل أن ينتظر مروره. فحصٌ داخلي، ولا يراسل عميلاً.
        const { runMonitorFor } = await import("../monitor-agent");
        const r: any = await runMonitorFor(t.userId);
        return { level: r?.level ?? null };
      }
      const { reconcile } = await import("../email/ledger");
      const { activity } = await import("../email/team");
      const led = await reconcile(t.userId);
      const bad = led.findings.filter((f) => f.state === "fail").map((f) => f.title);
      await activity(t.userId, "email_registrar", "delivery_failure", `فشل تسليم (${(t.inputRefs as any)?.kind ?? "?"}): طابقت السجل — ${led.verdict}${bad.length ? ` · ${bad.slice(0, 3).join("، ")}` : ""}.`, { taskId: t.taskId }).catch(() => {});
      return { verdict: led.verdict, failing: bad };
    },
  });
}

