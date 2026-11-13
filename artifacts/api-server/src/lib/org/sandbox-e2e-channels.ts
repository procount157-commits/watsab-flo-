// ── السيناريو التجريبي على واتساب والسوشيال (§20) ──────────────────
// مثل سيناريو البريد (sandbox-e2e.ts) تماماً: بيانات اختبار الحساب نفسه (sim_fixtures، is_test)،
// داخل المحاكاة، كل خطوة صفٌّ في sim_e2e_steps، وكل خطوة عمل تذكرة sim_ مربوطة بأبيها
// وسطرٌ في سجل أفعالها (ticket_action_events)، والبوابة ترفض تحت تذكرة الفحص فيُكتب رفضها
// تحتها أيضاً. الموظفون بأدوارهم في departments.ts وأسمائهم في DEFAULT_EMPLOYEES وteamDefs.
//
// واتساب: رسالة واردة من عميل
//   ١ هال يصنّف (classifyIntent، بالكود)          ← تذكرة
//   ٢ شمّة توجّه: شكوى ← سام، وغيرها ← هال          ← تذكرة ابنة
//   ٣ هال أو سام يكتب الرد (answerFromKnowledge)   ← تذكرة ابنة
//   ٤ خالد يخطط متابعةً واحدة بزاوية جديدة          ← تذكرة ابنة
//   ٥ سيف يفحص: الرقم وقائمة الإلغاء ونص الرد       ← تذكرة ابنة
//   ٦ البوابة ترفض في المحاكاة (تحت تذكرة الفحص)
//   ٧ شمّة تستلم النتيجة                            ← تذكرة ابنة التوجيه
//   ٨ درسٌ مرشّح معلّق، في سجل السيناريو وحده
//
// السوشيال (إنستجرام أو تيك توك): تعليقٌ على منشورنا أو رسالة خاصة
//   ١ المراقب يجده ← ٢ المصنّفة تصنّفه ← ٣ الكاتب (أو مسؤول الخاص) يقترح الرد
//   ← ٤ الحارس يفحص ← ٥ البوابة ترفض ← ٦ مدير الحساب يستلم النتيجة ← ٧ درسٌ مرشّح

import { sql } from "drizzle-orm";
import { db, DEFAULT_EMPLOYEES } from "@workspace/db";
import { asAgent } from "../agent-context";
import { logger } from "../logger";
import { accountHalted } from "./controls";
import { gateSend, isOptedOut } from "./gateway";
import { recordAction, withTicket } from "./ledger";
import { callsToday, SHADOW_DAILY_CALLS } from "./shadow";
import { ensureSimTables } from "./sim-schema";
import { newSimContext, withSimulation, type SimContext } from "./simulation";
import { closeTicket, E2E_CALLS, fixtureRow, openTicket, step, type E2eResult, type SimTicket } from "./sandbox-e2e";
import type { Intent as WaIntent } from "../intent";
import type { SocialPlatform } from "../social/platforms";

export type E2eChannel = "email" | "whatsapp" | "social";
export const E2E_CHANNELS: readonly E2eChannel[] = ["email", "whatsapp", "social"];
export const SOCIAL_PLATFORMS = ["instagram", "tiktok"] as const;

export const WA_FIXTURE = {
  kind: "wa_inbound", label: "رسالة واتساب واردة — بيانات اختبار",
  data: {
    test_data: true, name: "[اختبار] عميل واتساب", phone: "971500000000",
    text: "السلام عليكم، عندي شركة مقاولات في دبي وأبغى أعرف كم تكلفة مسك الدفاتر والتسجيل في الضريبة؟",
  },
} as const;

export const SOCIAL_FIXTURE = (platform: SocialPlatform, source: "comment" | "dm") => ({
  kind: `social_${source}`, label: `${source === "dm" ? "رسالة خاصة" : "تعليق"} ${platform} — بيانات اختبار`,
  data: {
    test_data: true, platform, source, author: "test_handle",
    text: source === "dm"
      ? "مرحبا، عندنا محل ذهب في دبي ونحتاج نعرف متطلبات مكافحة غسل الأموال، هل تساعدون؟"
      : "كم سعر خدمة التدقيق لشركة ذهب في دبي؟",
  },
});

const waName = (role: string) => DEFAULT_EMPLOYEES.find((e) => e.role === role)?.name ?? role;

/** يُغلق التذكرة ويكتب فعل الخطوة في سجلها. */
async function done(userId: number, t: SimTicket, role: string, kind: string, output: Record<string, unknown>, status: "completed" | "failed" = "completed") {
  await closeTicket(userId, t, output, status);
  await recordAction({ userId, ticketId: t.taskId, role, actionType: `sim.${kind}`.slice(0, 60), status: status === "completed" ? "ok" : "failed",
    input: { simulation: true, test_data: true }, output });
}

async function begin(userId: number, worker: string, fx: { id: number }, channel: string): Promise<{ runId: number; ctx: SimContext }> {
  await ensureSimTables();
  if (await accountHalted(userId, worker)) throw new Error("الحساب موقوف: لا سيناريو تجريبي");
  const [run] = (await db.execute<any>(sql`INSERT INTO sim_e2e_runs (user_id, fixture_id, summary) VALUES (${userId}, ${fx.id}, ${JSON.stringify({ channel })}::jsonb) RETURNING id`)).rows;
  const runId = Number(run.id);
  const left = Math.max(0, SHADOW_DAILY_CALLS - (await callsToday(userId)));
  return { runId, ctx: newSimContext({ userId, kind: "e2e", runId: `e2e:${runId}`, budget: Math.min(E2E_CALLS, left) }) };
}

async function finish(userId: number, runId: number, ctx: SimContext, extra: Record<string, unknown>, n: number, accepted: boolean | null, err?: unknown): Promise<E2eResult> {
  if (err === undefined) {
    await db.execute(sql`UPDATE sim_e2e_runs SET status = 'succeeded', finished_at = now(), model_calls = ${ctx.budget.used}, summary = ${JSON.stringify({ ...extra, steps: n, accepted, sandbox: ctx.sandbox })}::jsonb WHERE id = ${runId}`);
    return { runId, status: "succeeded", steps: n, accepted, modelCalls: ctx.budget.used, sandbox: ctx.sandbox };
  }
  const error = String((err as any)?.message ?? err).slice(0, 500);
  logger.warn({ userId, runId, err: error, ...extra }, "السيناريو التجريبي فشل");
  await db.execute(sql`UPDATE sim_e2e_runs SET status = 'failed', finished_at = now(), model_calls = ${ctx.budget.used}, error = ${error}, summary = ${JSON.stringify({ ...extra, steps: n, sandbox: ctx.sandbox })}::jsonb WHERE id = ${runId}`);
  return { runId, status: "failed", steps: n, accepted, modelCalls: ctx.budget.used, sandbox: ctx.sandbox, error };
}

/** البوابة تحت تذكرة الفحص: رفضها سطرٌ في سجل تلك التذكرة. */
const gateUnder = (userId: number, t: SimTicket, role: string, i: Parameters<typeof gateSend>[0]) =>
  withTicket({ userId, role, kind: "sim_e2e", ticketId: t.taskId, executionId: null }, () => gateSend(i));

// ── واتساب ────────────────────────────────────────────────────────
/** من يأخذ المحادثة: الشكوى لسام، وكل ما عداها لهال. طلب الإيقاف لا يُرد عليه. Pure. */
export function routeWa(intent: WaIntent): { role: "sales" | "support" | null; why: string } {
  if (intent === "opt_out") return { role: null, why: "طلب الإيقاف: لا رد ولا متابعة" };
  if (intent === "complaint") return { role: "support", why: "شكوى: لسام، ولا بيع فيها" };
  return { role: "sales", why: "مهتم أو سائل: لهال" };
}
/** متابعة خالد: مرة واحدة بزاوية جديدة لمن أظهر اهتماماً، ولا شيء لغيره. Pure. */
export function planWaFollowup(intent: WaIntent): { follow: boolean; afterDays: number | null; angle: string | null; why: string } {
  if (intent === "interested" || intent === "question") return { follow: true, afterDays: 2, angle: "سؤال واحد عن الرخصة ونوع النشاط، لا تذكير", why: "أظهر اهتماماً، ومعي ما هو جديد" };
  return { follow: false, afterDays: null, angle: null, why: intent === "complaint" ? "شكوى: لا متابعة بيعية" : "لا اهتمام ظاهر: لا متابعة" };
}

export interface WaDeps {
  /** الرد. الافتراضي answerFromKnowledge الحقيقي داخل المحاكاة. */
  reply?: (userId: number, input: { text: string; role: string; name: string }) => Promise<string | null>;
}
const realWaReply: NonNullable<WaDeps["reply"]> = async (userId, i) => {
  const { answerFromKnowledge } = await import("../knowledge");
  const r = await answerFromKnowledge(userId, i.text, undefined, undefined, undefined, undefined, undefined, { history: [{ role: "user", content: i.text }], speaker: { name: i.name } });
  return r.reply;
};

export async function runWaE2e(userId: number, deps: WaDeps = {}): Promise<E2eResult> {
  const fx = await fixtureRow(userId, WA_FIXTURE);
  const { runId, ctx } = await begin(userId, "org_sim_e2e", fx, "whatsapp");
  const { classifyIntent, INTENT_LABELS_AR } = await import("../intent");
  const { guardCheck } = await import("../email/team");
  const { knowledgeText } = await import("../social/engine");
  let n = 0;
  let accepted: boolean | null = null;
  const meta = { channel: "whatsapp" };
  try {
    await withSimulation(ctx, async () => {
      const f = fx.data;
      // ١ هال يصنّف
      const verdict = classifyIntent(f.text);
      const t1 = await openTicket(userId, { owner: "sales", by: "sales", type: "wa_classify", title: `تصنيف رسالة «${f.name}»`, evidence: { fixtureId: fx.id, text: f.text, verdict }, runId });
      await done(userId, t1, "sales", "wa_classify", { intent: verdict.intent, confidence: verdict.confidence });
      await step(runId, userId, ++n, { role: "sales", name: waName("sales"), kind: "classification", title: `صنّف الرسالة: ${INTENT_LABELS_AR[verdict.intent]}`, detail: { fixtureId: fx.id, text: f.text, verdict }, ticket: t1 });
      // ٢ شمّة توجّه
      const r = routeWa(verdict.intent);
      const t2 = await openTicket(userId, { owner: "chief", by: "sales", type: "wa_route", parent: t1.taskId, title: "توجيه المحادثة", evidence: { from: t1.taskId, ...r }, runId });
      await done(userId, t2, "chief", "wa_route", r);
      await step(runId, userId, ++n, { role: "chief", name: waName("chief"), kind: "routing", title: r.role ? `وجّهتها إلى ${waName(r.role)}: ${r.why}` : r.why, detail: r, ticket: t2, parent: t1 });
      // ٣ الرد
      const replier = r.role ?? "sales";
      const t3 = await openTicket(userId, { owner: replier, by: "chief", type: "wa_reply", parent: t2.taskId, title: "الرد على العميل", evidence: { route: t2.taskId }, runId });
      const reply = r.role && ctx.budget.left > 0
        ? await asAgent(userId, replier, () => (deps.reply ?? realWaReply)(userId, { text: f.text, role: replier, name: waName(replier) })).catch(() => null)
        : null;
      await done(userId, t3, replier, "wa_reply", { written: !!reply, reply }, reply ? "completed" : "failed");
      await step(runId, userId, ++n, { role: replier, name: waName(replier), kind: "reply_draft",
        title: reply ? `كتب الرد: «${reply.slice(0, 80)}»` : !r.role ? "لا رد: طلب الإيقاف" : ctx.budget.left <= 0 && ctx.budget.used === 0 ? "لم يكتب: سقف نداءات اليوم نفد" : "لم يكتب: لا رد من النموذج",
        detail: reply ? { reply } : { budgetLeft: ctx.budget.left }, ticket: t3, parent: t2 });
      // ٤ خالد يخطط المتابعة
      const plan = planWaFollowup(verdict.intent);
      const t4 = await openTicket(userId, { owner: "followup", by: replier, type: "wa_followup", parent: t3.taskId, title: "خطة المتابعة", evidence: plan, runId });
      await done(userId, t4, "followup", "wa_followup", plan);
      await step(runId, userId, ++n, { role: "followup", name: waName("followup"), kind: "followup_plan", title: plan.follow ? `متابعة واحدة بعد ${plan.afterDays} يوم: ${plan.angle}` : `لا متابعة: ${plan.why}`, detail: plan, ticket: t4, parent: t3 });
      // ٥ سيف يفحص
      const optedOut = await isOptedOut(userId, "whatsapp", f.phone).catch(() => true);
      const knowledge = await knowledgeText(userId).catch(() => "");
      const issues = [
        ...(reply ? guardCheck([reply], knowledge) : ["لا نص يُفحص"]),
        ...(reply && reply.length > 700 ? ["أطول من أسلوب الرد في واتساب"] : []),
        ...(optedOut ? ["الرقم طلب الإيقاف"] : []),
        ...(!/^\d{10,15}$/.test(f.phone) ? ["صيغة الرقم غير صالحة"] : []),
      ];
      accepted = issues.length === 0;
      const t5 = await openTicket(userId, { owner: "vetter", by: "followup", type: "wa_check", parent: t4.taskId, title: "فحص سيف", evidence: { issues, optedOut }, runId });
      await done(userId, t5, "vetter", "wa_check", { accepted, issues });
      await step(runId, userId, ++n, { role: "vetter", name: waName("vetter"), kind: accepted ? "accepted" : "returned", title: accepted ? "الرقم والرد سليمان" : `أعاده بـ ${issues.length} ملاحظة`, detail: { issues }, ticket: t5, parent: t4 });
      // ٦ البوابة
      const gate = await gateUnder(userId, t5, replier, { userId, channel: "whatsapp", kind: "reply", recipient: f.phone, role: replier });
      await step(runId, userId, ++n, { role: null, name: "البوابة", kind: "sandbox_execution", title: gate.allowed ? "خطأ: البوابة سمحت في المحاكاة" : `رفضت (${gate.code}) وسُجّل تنفيذ تجريبي`, detail: { gate, sandbox: ctx.sandbox.at(-1) ?? null, accepted } });
      if (gate.allowed) throw new Error("البوابة سمحت داخل المحاكاة");
      // ٧ شمّة تستلم
      const outcome = { accepted, issues: issues.length, gate: gate.code, sandbox: true, intent: verdict.intent };
      const t6 = await openTicket(userId, { owner: "chief", by: "vetter", type: "wa_outcome", parent: t2.taskId, title: "تسليم النتيجة", evidence: outcome, runId });
      await done(userId, t6, "chief", "wa_outcome", outcome);
      await step(runId, userId, ++n, { role: "chief", name: waName("chief"), kind: "outcome_event", title: `استلمت النتيجة: ${accepted ? "الرد جاهز" : "أُعيد"}، ولم يخرج شيء`, detail: outcome, ticket: t6, parent: t2 });
      // ٨ درسٌ مرشّح
      const lesson = accepted ? `رسالة «${INTENT_LABELS_AR[verdict.intent]}» عن السعر: رد بسؤال عن النطاق مرّ بفحص سيف` : `الرد على «${f.name}» لم يمرّ: ${issues.slice(0, 2).join("؛ ")}`;
      await step(runId, userId, ++n, { role: "chief", name: waName("chief"), kind: "learning_candidate", title: "درسٌ مرشّح ينتظر المراجعة", detail: { status: "pending", lesson, source: `sim_e2e:${runId}`, test_data: true, note: "من بيانات اختبار: لا يدخل ذاكرة أحد" } });
    });
    return await finish(userId, runId, ctx, meta, n, accepted);
  } catch (err) {
    return finish(userId, runId, ctx, meta, n, accepted, err ?? "خطأ");
  }
}

// ── السوشيال ──────────────────────────────────────────────────────
type SocialIntent = "question" | "interested" | "praise" | "complaint" | "spam" | "stop" | "other";
/** تصنيف المصنّفة بالكود، بقواعد واتساب نفسها مترجمةً إلى أنواع السوشيال. Pure. */
export function triageSocial(i: WaIntent): { intent: SocialIntent; isLead: boolean } {
  const m: Record<WaIntent, SocialIntent> = { opt_out: "stop", complaint: "complaint", not_interested: "other", interested: "interested", question: "question", greeting: "praise", unclear: "other" };
  const intent = m[i];
  return { intent, isLead: intent === "interested" || intent === "question" };
}

export interface SocialDeps {
  reply?: (userId: number, input: { platform: SocialPlatform; source: "comment" | "dm"; author: string; text: string; intent: SocialIntent }) => Promise<string | null>;
}
const realSocialReply: NonNullable<SocialDeps["reply"]> = async (userId, i) => {
  const agent = await import("../social/agent");
  return i.source === "dm"
    ? agent.draftDmReply(userId, i.platform, i.author, [{ fromMe: false, text: i.text }])
    : agent.draftCommentReply(userId, i.platform, { author: i.author, text: i.text, intent: i.intent }, []);
};

export async function runSocialE2e(userId: number, opts: { platform?: SocialPlatform; source?: "comment" | "dm" } = {}, deps: SocialDeps = {}): Promise<E2eResult> {
  const platform: SocialPlatform = opts.platform === "tiktok" ? "tiktok" : "instagram";
  const source = opts.source === "dm" ? "dm" : "comment";
  const fx = await fixtureRow(userId, SOCIAL_FIXTURE(platform, source));
  const { runId, ctx } = await begin(userId, "org_sim_e2e", fx, "social");
  const { classifyIntent } = await import("../intent");
  const { guardText } = await import("../social/agent");
  const { knowledgeText } = await import("../social/engine");
  const { teamDefs, roleOf } = await import("../social/team");
  const team = teamDefs(platform);
  const who = (job: string) => ({ role: roleOf(platform, job as any), name: team.find((d) => d.job === job)?.name ?? job });
  const watcher = who("watcher"), triage = who("triage"), writer = who(source === "dm" ? "dm" : "writer"), guard = who("guard"), manager = who("manager");
  let n = 0;
  let accepted: boolean | null = null;
  const meta = { channel: "social", platform, source };
  try {
    await withSimulation(ctx, async () => {
      const f = fx.data;
      const what = source === "dm" ? "رسالة خاصة" : "تعليقاً";
      // ١ المراقب
      const t1 = await openTicket(userId, { owner: watcher.role, by: watcher.role, type: "soc_watch", title: `${what} من @${f.author}`, evidence: { fixtureId: fx.id, platform, source, text: f.text }, runId });
      await done(userId, t1, watcher.role, "soc_watch", { found: 1 });
      await step(runId, userId, ++n, { role: watcher.role, name: watcher.name, kind: "found", title: `وجد ${what} جديداً من @${f.author}`, detail: { fixtureId: fx.id, platform, source, text: f.text }, ticket: t1 });
      // ٢ المصنّفة
      const verdict = triageSocial(classifyIntent(f.text).intent);
      const t2 = await openTicket(userId, { owner: triage.role, by: watcher.role, type: "soc_triage", parent: t1.taskId, title: "تصنيف", evidence: verdict, runId });
      await done(userId, t2, triage.role, "soc_triage", verdict);
      await step(runId, userId, ++n, { role: triage.role, name: triage.name, kind: "classification", title: `صنّفته: ${verdict.intent}${verdict.isLead ? "، فرصة" : ""}`, detail: verdict, ticket: t2, parent: t1 });
      // ٣ الرد المقترح
      const skip = verdict.intent === "spam" || verdict.intent === "stop";
      const t3 = await openTicket(userId, { owner: writer.role, by: triage.role, type: "soc_reply", parent: t2.taskId, title: "الرد المقترح", evidence: { triage: t2.taskId }, runId });
      const reply = !skip && ctx.budget.left > 0
        ? await asAgent(userId, writer.role, () => (deps.reply ?? realSocialReply)(userId, { platform, source, author: f.author, text: f.text, intent: verdict.intent })).catch(() => null)
        : null;
      await done(userId, t3, writer.role, "soc_reply", { written: !!reply, reply }, reply ? "completed" : "failed");
      await step(runId, userId, ++n, { role: writer.role, name: writer.name, kind: "reply_draft",
        title: reply ? `اقترح الرد: «${reply.slice(0, 80)}»` : skip ? "لا رد: سبام أو طلب توقف" : ctx.budget.left <= 0 && ctx.budget.used === 0 ? "لم يكتب: سقف نداءات اليوم نفد" : "لم يكتب: لا رد من النموذج",
        detail: reply ? { reply } : { budgetLeft: ctx.budget.left }, ticket: t3, parent: t2 });
      // ٤ الحارس
      const knowledge = await knowledgeText(userId).catch(() => "");
      const issues = reply ? guardText(reply, knowledge, []) : ["لا نص يُفحص"];
      accepted = issues.length === 0;
      const t4 = await openTicket(userId, { owner: guard.role, by: writer.role, type: "soc_guard", parent: t3.taskId, title: "فحص الحارس", evidence: { issues }, runId });
      await done(userId, t4, guard.role, "soc_guard", { accepted, issues });
      await step(runId, userId, ++n, { role: guard.role, name: guard.name, kind: accepted ? "accepted" : "returned", title: accepted ? "قبل الرد" : `أعاده بـ ${issues.length} ملاحظة`, detail: { issues }, ticket: t4, parent: t3 });
      // ٥ البوابة
      const gate = await gateUnder(userId, t4, writer.role, { userId, channel: platform, kind: source === "dm" ? "reply" : "reply_comment", recipient: f.author, role: writer.role });
      await step(runId, userId, ++n, { role: null, name: "البوابة", kind: "sandbox_execution", title: gate.allowed ? "خطأ: البوابة سمحت في المحاكاة" : `رفضت (${gate.code}) وسُجّل تنفيذ تجريبي`, detail: { gate, sandbox: ctx.sandbox.at(-1) ?? null, accepted } });
      if (gate.allowed) throw new Error("البوابة سمحت داخل المحاكاة");
      // ٦ مدير الحساب
      const outcome = { accepted, issues: issues.length, gate: gate.code, sandbox: true, platform, source };
      const t5 = await openTicket(userId, { owner: manager.role, by: guard.role, type: "soc_outcome", parent: t1.taskId, title: "نتيجة الدورة", evidence: outcome, runId });
      await done(userId, t5, manager.role, "soc_outcome", outcome);
      await step(runId, userId, ++n, { role: manager.role, name: manager.name, kind: "outcome_event", title: `استلم النتيجة: ${accepted ? "الرد جاهز" : "أُعيد"}، ولم يخرج شيء`, detail: outcome, ticket: t5, parent: t1 });
      // ٧ درسٌ مرشّح
      const lesson = accepted ? `${what} «${verdict.intent}» على ${platform}: رد قصير يدعو للخاص مرّ بفحص الحارس` : `الرد على @${f.author} لم يمرّ: ${issues.slice(0, 2).join("؛ ")}`;
      await step(runId, userId, ++n, { role: manager.role, name: manager.name, kind: "learning_candidate", title: "درسٌ مرشّح ينتظر المراجعة", detail: { status: "pending", lesson, source: `sim_e2e:${runId}`, test_data: true, note: "من بيانات اختبار: لا يدخل ذاكرة أحد" } });
    });
    return await finish(userId, runId, ctx, meta, n, accepted);
  } catch (err) {
    return finish(userId, runId, ctx, meta, n, accepted, err ?? "خطأ");
  }
}

/** القناة من الطلب: البريد افتراضياً، كما كان المسار قبلها. Pure. */
export function e2eChannelOf(v: unknown): E2eChannel | null {
  if (v == null || v === "") return "email";
  return (E2E_CHANNELS as readonly string[]).includes(String(v)) ? (String(v) as E2eChannel) : null;
}
