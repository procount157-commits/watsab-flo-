// ── منصور: مدير البريد، وحلقته ────────────────────────────────────
// طلب صاحب العمل: مديرٌ يوظّف، ويبني للفريق حلقةً قوية، وأهم من فيها
// من يحلّل النتائج — «وأريد كل شيءٍ آلياً تماماً».
//
// والآلية الكاملة لا تعني أن يقرّر نموذجٌ لغوي ماذا يُرسَل ولمن. تلك
// طريق الاجتماع الذي أعلن فيه مديرٌ حادثةً لم تقع فبنى زملاؤه عليها.
// فالحلقة هنا **كود**: كل خطوةٍ فيها حسابٌ أو قاعدة، ونتيجتها رقم.
// والنموذج يُستدعى مرتين فقط — ليكتب المحلّل حكمه، وليكتب المدير تقريره
// — ولا يُسأل في أيٍّ منهما عن رقمٍ ولا يملك أن يُطلق موجة.
//
// الدورة، كل ست ساعات:
//   ١ · الفريق     من ينقص يُعيَّن، ومن أُوقف يُذكر بأثره
//   ٢ · السجل      ما يُصلَح بلا خطر يُصلَح (راشد)
//   ٣ · النتائج    حكمٌ لكل مسارٍ وقطاعٍ وزاوية (جاسم)
//   ٤ · القرارات   زوايا تُوقَف وتُقدَّم، دروسٌ تُكتب في ذاكرة الكاتبة
//   ٥ · الاستهداف  ما خرج عن السياسة يُوقَف
//   ٦ · الموجات    بالنسبة ٨٠/٢٠ وبالزاوية التالية (سلمى ← نورة ← ماجد)
//   ٧ · التقرير    مرةً في اليوم لصاحب العمل
//
// وما يوقف الحلقة عن الإرسال ليس إذن أحد، بل السمعة: ارتدادٌ فوق الحد
// أو مزوّدٌ يرفض رسائلنا — وهذه بوابات في الكود لا رأيٌ في تقرير.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, botEmployeesTable, emailMissionsTable, emailAgentActivityTable, type SegmentFilter } from "@workspace/db";
import { complete } from "../llm";
import { asAgent } from "../agent-context";
import { notify, esc } from "../telegram";
import { logger } from "../logger";
import { EMAIL_TEAM, EMAIL_TEAM_DEFS, activity, ensureEmailTeam, onDuty, teamVoice, type EmailRole } from "./team";
import { getAutopilot, runAutopilot, saveAutopilot } from "./autopilot";
import { MEASURES } from "../graph/goals";
import { planForGoal, GOAL_METRICS, STATE_AR, type GoalMetric, type Plan } from "./goal-plan";
import { warmupCap } from "./health";
import { signals } from "./service";
import { pauseCampaign, getSettings } from "./service";
import { reconcile, repair, type LedgerFinding } from "./ledger";
import { resultsReport, resultsFacts, VERDICT_AR, type ResultsReport } from "./results";
import { MIX, TRACK_AR, isTargeted, mixShare, policyBrief, angleById } from "./policy";
import { rememberLesson } from "./agent";
import { say } from "../agent-comms";
import { runDesk, type DeskReport } from "../data-desk/desk";
import { evaluateDesk, evaluationFacts, type Evaluation } from "../team/evaluate";
import { verdictFor } from "./service";

/** الإصلاحات التي يأذن بها المدير بلا رجوع: كلها تُعيد السجل إلى ما حدث فعلاً. */
const SAFE_REPAIRS: Array<NonNullable<LedgerFinding["repair"]>> = ["resync_counters", "cancel_orphans", "mark_bounced", "restore_policy_rejected"];

/** أثر غياب كل دور — يُقال هذا لصاحب العمل، لا اسم الدور. */
const GAP: Partial<Record<EmailRole, string>> = {
  email: "لا أحد يكتب الحملات — الموجات تُخطَّط ولا تُكتب",
  email_strategist: "لا أحد يخطّط الموجات — لا جمهور جديد يُراسَل",
  email_followup: "لا أحد يتابع من فتح أو نقر — الردود تأتي من المتابعة لا من الأولى",
  email_replies: "لا أحد يصنّف الردود ويكتب مسودّاتها",
  email_guard: "لا أحد يراجع الرسائل قبل خروجها ولا يراقب صحة الإرسال",
  email_analyst: "لا أحد يحكم على النتائج — الحلقة ترسل ولا تتعلّم",
};

export interface Staffing { total: number; hired: string[]; offDuty: Array<{ role: EmailRole; name: string; gap: string }> }

/** ١ · الفريق: الناقص يُعيَّن، والموقوف يُذكر بأثره. */
export async function staff(userId: number): Promise<Staffing> {
  const before = await db.select({ role: botEmployeesTable.role }).from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), inArray(botEmployeesTable.role, [...EMAIL_TEAM])));
  const team = await ensureEmailTeam(userId);
  const had = new Set(before.map((b) => b.role));
  const hired = team.filter((e) => !had.has(e.role)).map((e) => `${e.name} (${e.title})`);
  const offDuty = team.filter((e) => !e.isActive).map((e) => ({
    role: e.role as EmailRole, name: e.name,
    gap: GAP[e.role as EmailRole] ?? `${e.title ?? e.role} متوقف`,
  }));
  return { total: team.length, hired, offDuty };
}

/** ٥ · ما خرج عن السياسة يُوقَف: مهمةٌ قطاعاتها كلها خارج الاستهداف. */
export async function enforceTargeting(userId: number): Promise<string[]> {
  const ms = await db.select().from(emailMissionsTable)
    .where(and(eq(emailMissionsTable.userId, userId), eq(emailMissionsTable.status, "active"),
      inArray(emailMissionsTable.stage, ["draft", "awaiting_approval", "sending"])));
  const out: string[] = [];
  for (const m of ms) {
    const sectors = ((m.filter as SegmentFilter | null)?.sectors ?? []);
    if (!sectors.length || sectors.some((s) => isTargeted(s))) continue;
    await db.update(emailMissionsTable).set({ status: "paused" }).where(eq(emailMissionsTable.id, m.id));
    if (m.campaignId) await pauseCampaign(userId, m.campaignId, `قطاع ${sectors.join("، ")} خارج الاستهداف — أوقفها مدير البريد بسياسة صاحب العمل`).catch(() => {});
    out.push(`«${m.name.slice(0, 60)}» (${sectors.join("، ")})`);
  }
  return out;
}

/** ٤ · الدروس: ما نجح وما فشل يُكتب في ذاكرة الكاتبة، فتقرؤه قبل الحملة القادمة. */
async function recordLessons(userId: number, r: ResultsReport): Promise<number> {
  let n = 0;
  for (const a of r.angles) {
    const meta = angleById(a.key);
    if (!meta) continue;
    if (a.verdict === "scale") {
      await rememberLesson(userId, "win", `زاوية «${meta.label}» لقطاع ${meta.sector} (${TRACK_AR[meta.track]}) جلبت ${a.positive} رداً نافعاً من ${a.sent} شركة. اكتبي القادم لهذا القطاع على نمطها.`, meta.sector); n++;
    } else if (a.verdict === "rewrite") {
      await rememberLesson(userId, "loss", `زاوية «${meta.label}» لقطاع ${meta.sector} لم تنفع: ${a.why}. لا تعيدي صياغتها — غيّري المدخل كله.`, meta.sector); n++;
    }
  }
  if (r.decisions.some((d) => d.kind === "policy")) {
    await rememberLesson(userId, "loss", "مزوّد البريد رفض رسائلنا كإزعاج حين تكرّر نصٌّ واحد مئات المرات. كل موجةٍ بزاويةٍ وعنوانٍ مختلفين فعلاً عن سابقتها.", null); n++;
  }
  return n;
}

// ── الهدف: ما يعطيه صاحب العمل لمنصور ─────────────────────────────
export interface ManagerGoal { id: number; title: string; metric: GoalMetric; target: number; startsAt: Date; deadline: Date; inherited: boolean }

/** هدف المدير: ما سُلِّم له، وإلا هدف الحساب العام إن كان مقياسه مما يقيسه البريد. */
export async function managerGoal(userId: number): Promise<ManagerGoal | null> {
  const rows = (await db.execute<any>(sql`
    SELECT id, title, metric, target, starts_at, deadline, assignee FROM goals
    WHERE user_id = ${userId} AND status = 'active' AND (assignee = 'email_manager' OR assignee IS NULL)
    ORDER BY (assignee = 'email_manager') DESC NULLS LAST, id DESC`)).rows;
  const g = rows.find((r) => r.metric in GOAL_METRICS);
  if (!g) return null;
  return { id: Number(g.id), title: g.title, metric: g.metric, target: Number(g.target), startsAt: new Date(g.starts_at), deadline: new Date(g.deadline), inherited: g.assignee !== "email_manager" };
}

/** صاحب العمل يعطي الهدف. يحلّ محلّ هدف المدير السابق، ولا يمسّ أهداف غيره. */
export async function giveGoal(userId: number, g: { metric: GoalMetric; target: number; deadline: Date; title?: string }) {
  if (!(g.metric in GOAL_METRICS)) throw new Error("مقياس غير معروف");
  if (!(g.target > 0 && g.target <= 100_000)) throw new Error("الرقم بين ١ و١٠٠٬٠٠٠");
  if (!(g.deadline.getTime() > Date.now() + 86_400_000)) throw new Error("الموعد بعد يوم على الأقل");
  await db.execute(sql`UPDATE goals SET status = 'replaced' WHERE user_id = ${userId} AND assignee = 'email_manager' AND status = 'active'`);
  const title = (g.title?.trim() || `${g.target} ${GOAL_METRICS[g.metric].unit} قبل ${g.deadline.toLocaleDateString("en-GB")}`).slice(0, 200);
  const r = await db.execute<{ id: number }>(sql`INSERT INTO goals (user_id, title, metric, target, deadline, counter_metrics, anchor, assignee)
    VALUES (${userId}, ${title}, ${g.metric}, ${Math.floor(g.target)}, ${g.deadline}, '["email_bounce_pct"]'::jsonb, ${g.metric === "clients_won" ? "clients_won" : null}, 'email_manager') RETURNING id`);
  await activity(userId, "email_manager", "goal", `استلمتُ الهدف: ${title}. أحسب الخطة وأبدأ في هذه الدورة.`);
  return Number(r.rows[0]!.id);
}

export interface GoalState { goal: ManagerGoal; current: number; plan: Plan; changed: string[] }

/** الهدف ← الخطة ← ما يملكه المدير يُنفَّذ (حجم الموجة)، وما لا يملكه يُرفع. */
export async function workTheGoal(userId: number, r: ResultsReport, apply = true): Promise<GoalState | null> {
  const goal = await managerGoal(userId);
  if (!goal) return null;
  const w = { userId, from: goal.startsAt, to: new Date(Math.min(Date.now() + 1, goal.deadline.getTime())) };
  const all = { userId, from: new Date(Date.now() - 365 * 86_400_000), to: new Date(Date.now() + 1) };
  const [current, meetings, clients, cfg, s, sig] = await Promise.all([
    MEASURES[goal.metric]!.read(w), MEASURES.meetings!.read(all), MEASURES.clients_won!.read(all),
    getAutopilot(userId), getSettings(userId), signals(userId).catch(() => null),
  ]);
  const capacity = s ? warmupCap(s.dailyCap, sig?.senderAgeDays ?? 365, s.warmup) : 0;
  const plan = planForGoal({
    metric: goal.metric, target: goal.target, current, startsAt: goal.startsAt, deadline: goal.deadline,
    observed: { companies: r.overall.sent, replied: r.overall.replied, positive: r.overall.positive, meetings, clients },
    dailyCapacity: capacity, readyAudience: r.audience.reduce((a, x) => a + x.ready, 0),
    waveSize: cfg.waveSize, approvalMode: cfg.mode !== "auto",
  });
  const changed: string[] = [];
  // السمعة قبل الهدف: إن رفض المزوّد نصّنا فالطيار يُصغّر الموجة بنفسه، ولا يكبّرها المدير.
  const reputationHold = r.decisions.some((d) => d.kind === "policy") || r.overall.bounceRate >= 5;
  if (apply && plan.state !== "done" && !reputationHold && plan.waveSize !== cfg.waveSize) {
    await saveAutopilot(userId, { waveSize: plan.waveSize });
    changed.push(`حجم الموجة ${cfg.waveSize} ← ${plan.waveSize} (الهدف يحتاج ${plan.perDay} شركة يومياً)`);
  } else if (reputationHold && plan.state === "behind") {
    changed.push("لم أكبّر الموجة رغم التأخر: السمعة أولاً — المزوّد رفض نصّنا أو الارتداد فوق الحد");
  }
  return { goal, current, plan, changed };
}

export function goalFacts(g: GoalState | null): string {
  if (!g) return "الهدف: لم يضع صاحب العمل هدفاً لمدير البريد — أعمل بالسياسة وحدها.";
  const p = g.plan;
  return [
    `الهدف${g.goal.inherited ? " (هدف الحساب العام)" : ""}: ${g.goal.title} — ${GOAL_METRICS[g.goal.metric].label}. الحال: ${STATE_AR[p.state]}.`,
    p.summary,
    ...g.changed.map((c) => `• نفّذتُ: ${c}`),
    ...p.blockers.map((b) => `• يمنع الهدف: ${b}`),
    ...p.assumptions.map((a) => `• ${a}`),
  ].join("\n");
}

export interface CycleResult {
  at: Date;
  staffing: Staffing;
  repairs: Array<{ what: string; done: number }>;
  results: ResultsReport;
  paused: string[];
  autopilot: { ran: boolean; why?: string; waves: number; nurtures: number; stages: number };
  sending: { level: string; reasons: string[]; mode: string; enabled: boolean };
  lessons: number;
  goal: GoalState | null;
  desk?: DeskReport | null;
  evaluations?: Evaluation[];
  brief: { verdict: string; did: string[]; decided: string[]; needs: string[] } | null;
}

/** ما يُعطى للمدير ليكتب تقريره: وقائع الدورة، لا شيء غيرها. */
export function cycleFacts(c: Omit<CycleResult, "brief">): string {
  const r = c.results, sh = mixShare(r.mix.state);
  return [
    goalFacts(c.goal),
    `الفريق: ${c.staffing.total} موظفاً.${c.staffing.hired.length ? ` عُيّن في هذه الدورة: ${c.staffing.hired.join("، ")}.` : ""}${c.staffing.offDuty.length ? ` متوقفون: ${c.staffing.offDuty.map((o) => `${o.name} — ${o.gap}`).join("؛ ")}.` : " كلهم على رأس العمل."}`,
    `الإرسال: الطيار ${c.sending.enabled ? "يعمل" : "متوقف"}، ${c.sending.mode === "auto" ? "آلي بلا موافقة" : "ينتظر موافقة صاحب العمل على كل حملة"}. صحة المُرسِل: ${c.sending.level}${c.sending.reasons.length ? ` (${c.sending.reasons.slice(0, 2).join("؛ ")})` : ""}.`,
    `النسبة (آخر ${r.days} يوماً): AML ${Math.round(sh.aml * 100)}٪ · خدمات ${Math.round(sh.services * 100)}٪ — المستهدف ${MIX.aml * 100}/${MIX.services * 100}.`,
    `النتائج بالشركة: ${r.overall.sent} شركة راسلناها · ${r.overall.positive} رداً نافعاً · ${r.overall.replied} رداً حقيقياً · ارتداد ${r.overall.bounceRate}٪ · رفض المزوّد ${r.overall.rejected} رسالة.`,
    ...r.tracks.map((t) => `• ${t.label}: ${t.sent} شركة، ${t.positive} رداً نافعاً، ارتداد ${t.bounceRate}٪ ← ${VERDICT_AR[t.verdict].label}`),
    r.angles.length ? "الزوايا:" : "لا زاوية مسمّاة اكتملت عيّنتها بعد.",
    ...r.angles.map((a) => `• ${a.label}: ${a.sent} شركة، ${a.positive} نافعاً ← ${VERDICT_AR[a.verdict].label} (${a.why})`),
    ...r.addressTypes.slice(0, 2).map((a) => `• ${a.label}: ارتداد ${a.bounceRate}٪ من ${a.sent}`),
    `الجمهور الجاهز: ${r.audience.map((a) => `${a.sector} ${a.ready}`).join(" · ")}.`,
    `هذه الدورة: ${c.autopilot.waves} موجة جديدة، ${c.autopilot.nurtures} متابعة${c.autopilot.why ? ` — ${c.autopilot.why}` : ""}.`,
    c.desk ? `البيانات: ${c.desk.headline}${c.desk.clearance.notes.length ? ` التنظيف: ${c.desk.clearance.notes.slice(0, 2).join("؛ ")}.` : ""}${c.desk.model.asked ? ` قرأ المصنّف ${c.desk.model.asked} اسماً وحسم ${c.desk.model.settled}.` : ""}` : "",
    c.evaluations?.length ? "تقييم الموظفين:" : "", c.evaluations?.length ? evaluationFacts(c.evaluations) : "",
    c.paused.length ? `أوقفتُ لخروجها عن الاستهداف: ${c.paused.join("؛ ")}.` : "",
    c.repairs.length ? `أصلحتُ في السجل: ${c.repairs.map((x) => `${x.what} (${x.done})`).join("؛ ")}.` : "",
    r.decisions.length ? "قراراتٌ نُفّذت:" : "", ...r.decisions.map((d) => `• ${d.text}`),
    r.needsOwner.length ? "يحتاج صاحب العمل:" : "", ...r.needsOwner.map((x) => `• ${x}`),
  ].filter(Boolean).join("\n");
}

const MANAGER_RULES = [
  "أنت تكتب تقرير الدورة لصاحب العمل. الدورة انتهت وقراراتها نُفّذت — أنت تُخبر، لا تقترح ما كان يمكن فعله.",
  "",
  "قواعد لا تُخالف:",
  "١. لا رقم ولا حالة ولا حادثة ليست في «وقائع الدورة». ما لم يُذكر فيها لم يحدث.",
  "٢. لا تسمِّ حملةً ناجحة لأنها خرجت. النجاح ردٌّ نافع من شركة، والعيّنة دون خمسين لا يُحكم عليها.",
  "٣. رفض المزوّد لرسائلنا ليس ارتداداً، والارتداد ليس رفضاً. لا تخلطهما في جملة.",
  "٤. إن لم تُطلَق موجةٌ فقل السبب الذي في الوقائع — ولا تعتذر ولا تعد.",
  "٥. «يحتاجك» لما لا يُحلّ بلا يد صاحب العمل فقط. ما قرّرتَه أنت لا يُطلب فيه إذن.",
  "٦. لا تُعدّل الاستهداف ولا النسبة ولا تقترح تعديلهما: هما قرار صاحب العمل.",
  "٧. الهدف أول سطر في الحكم: كم تحقّق من كم، وهل نحن على المسار. ما «يمنع الهدف» يُكتب في «يحتاجك» بأرقامه كما هي.",
  "٨. النسبة المفترضة تُسمّى افتراضاً. لا تقدّم تقديراً على أنه قياس.",
  "",
  "اكتب بهذا الشكل بالضبط ولا تزد:",
  "الحكم: <سطر واحد — الهدف: كم من كم وحاله، ثم حال البريد برقم واحد>",
  "فعلتُ:",
  "- <ما نُفّذ في هذه الدورة — نقطتان إلى أربع، كلٌّ برقمه>",
  "قرّرتُ:",
  "- <القرارات وسبب كلٍّ — نقطة إلى ثلاث. إن لم يكن قرارٌ فاكتب: لا قرار جديد>",
  "يحتاجك:",
  "- <ما يحتاج يد صاحب العمل — أو: لا شيء>",
].join("\n");

async function writeBrief(userId: number, facts: string): Promise<CycleResult["brief"]> {
  const voice = await teamVoice(userId, "email_manager");
  const out = await asAgent(userId, "email_manager", () => complete([
    { role: "system", content: [voice, "", policyBrief(), "", MANAGER_RULES].join("\n") },
    { role: "user", content: `وقائع الدورة:\n${facts}` },
  ], 60_000)).catch(() => null);
  if (!out?.text) return null;
  const sec = (name: string, next: string) =>
    (new RegExp(`${name}\\s*[:：]\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:${next})\\s*[:：]|$)`).exec(out.text)?.[1] ?? "")
      .split("\n").map((l) => l.replace(/^[-•*\s]+/, "").trim()).filter((l) => l.length > 2).slice(0, 5);
  return {
    verdict: /الحكم\s*[:：]\s*(.+)/.exec(out.text)?.[1]?.trim() ?? "",
    did: sec("فعلتُ", "قرّرتُ|يحتاجك"), decided: sec("قرّرتُ", "يحتاجك"), needs: sec("يحتاجك", "$^"),
  };
}

/** الدورة كاملةً. `brief: false` تُسقط نداء النموذج — للدورات بين التقارير. */
export async function runManagerCycle(userId: number, opts: { brief?: boolean; notifyOwner?: boolean; force?: boolean } = {}): Promise<CycleResult | null> {
  // المدير موظف: إن أوقفه صاحب العمل توقّفت حلقته، وبقي الطيار كما كان.
  await ensureEmailTeam(userId);
  if (!(await onDuty(userId, "email_manager")) && !opts.force) return null;

  const staffing = await staff(userId);
  if (staffing.hired.length) await activity(userId, "email_manager", "hire", `عيّنتُ: ${staffing.hired.join("، ")}.`);

  // ٢ · السجل
  const repairs: CycleResult["repairs"] = [];
  const led = await reconcile(userId).catch(() => null);
  for (const f of led?.findings ?? []) {
    if (f.repair && SAFE_REPAIRS.includes(f.repair) && f.n > 0) {
      const x = await repair(userId, f.repair).catch(() => null);
      if (x?.done) { repairs.push(x); await activity(userId, "email_registrar", "repair", `${x.what} — ${x.done} صفاً. (بإذن المدير)`); }
    }
  }

  // ٢ب · البيانات — ماجد ينظّف ثم بدور تصنّف، وكلٌّ يسلّم التالي برسالة.
  const desk = await runDesk(userId, { channel: "email", listId: null, trigger: "manager" }).catch((err) => {
    logger.warn({ userId, err: String(err?.message ?? err) }, "مكتب البيانات داخل دورة المدير تعذّر"); return null;
  });

  // ٣ · النتائج  ٤ · القرارات
  const results = await resultsReport(userId);
  const lessons = await recordLessons(userId, results).catch(() => 0);
  const goal = await workTheGoal(userId, results).catch((err) => { logger.warn({ userId, err: String(err?.message ?? err) }, "خطة الهدف تعذّرت"); return null; });
  if (goal?.changed.length) await activity(userId, "email_manager", "plan", `الهدف «${goal.goal.title}»: ${goal.changed.join("؛ ")}.`, { goalId: goal.goal.id, perDay: goal.plan.perDay });
  for (const d of results.decisions) await sayOnceDaily(userId, "email_analyst", "decision", d.text);

  // ── الكلام على حوافّ القراف ──
  // الموظفون كانوا يعملون ولا يتكلّمون: فريق البريد كله صفر رسائل في
  // شهر. والحلقة تدور على تسليمٍ من واحدٍ لآخر، فكل تسليمٍ هنا رسالةٌ
  // بما يحتاجه مستلمها — تُرى في غرفة الفريق وتدخل تعليماته في عمله التالي.
  const o = results.overall;
  await tell(userId, "email_analyst", "email_manager", "report",
    `حكمي على آخر ${results.days} يوماً: ${o.sent} شركة راسلناها، ${o.positive} ردّاً نافعاً، ارتداد ${o.bounceRate}٪${o.rejected ? `، والمزوّد رفض ${o.rejected} رسالة` : ""}. ${results.decisions.length ? results.decisions.slice(0, 2).map((d) => d.text).join(" ") : "لا قرار جديد: العيّنات لم تكتمل."}`);
  for (const a of results.angles.filter((x) => x.verdict === "scale" || x.verdict === "rewrite").slice(0, 2)) {
    await tell(userId, "email_analyst", "email", "directive", `زاوية «${a.label}»: ${VERDICT_AR[a.verdict].label} — ${a.why}. ${a.verdict === "scale" ? "اكتبي القادم لقطاعها على نمطها." : "لا تعيدي صياغتها: غيّري المدخل كله."}`);
  }
  if (goal) await tell(userId, "email_manager", "email_strategist", "directive",
    `خطة هذه الدورة: ${goal.plan.perDay} شركة في اليوم، وموجة بحجم ${goal.plan.waveSize ?? "—"}. النسبة الآن AML ${Math.round(mixShare(results.mix.state).aml * 100)}٪ والمستهدف ${MIX.aml * 100}٪.${results.avoidAngles.length ? ` تجنّبي زوايا حكم عليها جاسم بالفشل (${results.avoidAngles.length}).` : ""}`);

  // ٤ب · التقييم — درجةٌ لكل موظف من أرقامه، ومهمةٌ تصله من المدير.
  const evaluations = await evaluateDesk(userId, {
    desk: "email", manager: "email_manager", managerName: "منصور",
    roles: EMAIL_TEAM.filter((r) => r !== "email_manager"),
  }).catch(() => [] as Evaluation[]);

  // ٥ · الاستهداف
  const paused = await enforceTargeting(userId).catch(() => [] as string[]);
  if (paused.length) await activity(userId, "email_manager", "hold", `أوقفتُ ${paused.length} مهمة لقطاعاتٍ خارج الاستهداف: ${paused.join("؛ ")}.`);

  // ٦ · الموجات — والطيار نفسه يحمل بوابة السمعة والنسبة والزاوية
  const cfg = await getAutopilot(userId);
  const health = await verdictFor(userId).catch(() => null);
  const autopilot = await runAutopilot(userId).catch((err) => {
    logger.warn({ userId, err: String(err?.message ?? err) }, "جولة الطيار داخل دورة المدير تعذّرت");
    return { ran: false, why: "تعذّرت جولة الطيار", waves: 0, nurtures: 0, stages: 0 };
  });

  const base = {
    at: new Date(), staffing, repairs, results, paused, autopilot, lessons, goal, desk, evaluations,
    sending: { level: health?.level ?? "غير معروف", reasons: health?.reasons ?? [], mode: cfg.mode, enabled: cfg.enabled },
  };

  // ٧ · التقرير
  let brief: CycleResult["brief"] = null;
  if (opts.brief !== false) {
    brief = await writeBrief(userId, cycleFacts(base));
    // القرارات وما يحتاج صاحب العمل من الكود — النموذج يكتب الحكم وما فُعل.
    if (brief) {
      const decided = [
        ...results.decisions.map((d) => d.text),
        ...paused.map((p) => `أوقفتُ لخروجها عن الاستهداف: ${p}`),
        ...(evaluations ?? []).filter((e) => e.task).map((e) => `${e.name}: ${e.task}`),
      ];
      brief.decided = decided.length ? decided.slice(0, 5) : ["لا قرار جديد: العيّنات لم تكتمل."];
      brief.needs = results.needsOwner.length ? results.needsOwner.slice(0, 4) : ["لا شيء."];
    }
    if (brief) {
      const text = [brief.verdict, "فعلتُ:", ...brief.did.map((x) => `• ${x}`), "قرّرتُ:", ...brief.decided.map((x) => `• ${x}`), "يحتاجك:", ...brief.needs.map((x) => `• ${x}`)].join("\n");
      await activity(userId, "email_manager", "brief", text, { waves: autopilot.waves, mix: results.mix.state });
      if (opts.notifyOwner) {
        await notify(userId, [
          "<b>🧭 منصور — تقرير البريد</b>",
          esc(brief.verdict),
          brief.did.length ? "<b>فعلتُ</b>" : "", ...brief.did.map((x) => `• ${esc(x)}`),
          brief.decided.length ? "<b>قرّرتُ</b>" : "", ...brief.decided.map((x) => `• ${esc(x)}`),
          brief.needs.length ? "<b>يحتاجك</b>" : "", ...brief.needs.map((x) => `• ${esc(x)}`),
        ].filter(Boolean).join("\n")).catch(() => {});
      }
    }
  }
  logger.info({ userId, waves: autopilot.waves, paused: paused.length, repairs: repairs.length, lessons, brief: !!brief }, "دورة مدير البريد");
  return { ...base, brief };
}

/** رسالةٌ بين موظفَين، مرةً في اليوم للنص نفسه — الدورة كل ست ساعات. */
async function tell(userId: number, fromRole: string, toRole: string, kind: "report" | "directive" | "handoff", body: string) {
  const [again] = (await db.execute(sql`SELECT 1 FROM agent_messages WHERE user_id = ${userId} AND from_role = ${fromRole} AND to_role = ${toRole} AND body = ${body.slice(0, 2000)} AND created_at > now() - interval '24 hours' LIMIT 1`)).rows;
  if (!again) await say({ userId, fromRole, toRole, kind, body }).catch(() => {});
}

async function sayOnceDaily(userId: number, role: EmailRole, action: string, text: string) {
  const [again] = (await db.execute(sql`SELECT 1 FROM email_agent_activity WHERE user_id = ${userId} AND role = ${role} AND text = ${text.slice(0, 2000)} AND created_at > now() - interval '24 hours' LIMIT 1`)).rows;
  if (!again) await activity(userId, role, action, text);
}

/** آخر تقرير وآخر قرارات — للواجهة، بلا نداء نموذج. */
export async function managerState(userId: number) {
  const [results, cfg, team, last] = await Promise.all([
    resultsReport(userId), getAutopilot(userId), ensureEmailTeam(userId),
    db.execute<any>(sql`SELECT text, created_at AS at FROM email_agent_activity WHERE user_id = ${userId} AND role = 'email_manager' AND action = 'brief' ORDER BY created_at DESC LIMIT 1`),
  ]);
  const log = await db.execute<any>(sql`
    SELECT role, action, text, created_at AS at FROM email_agent_activity
    WHERE user_id = ${userId} AND ((role = 'email_manager') OR (role = 'email_analyst' AND action = 'decision') OR (role = 'email_strategist' AND action IN ('wave','skip','wait')))
    ORDER BY created_at DESC LIMIT 25`);
  const s = await getSettings(userId);
  const goal = await workTheGoal(userId, results, false).catch(() => null);
  return {
    goal: goal ? { ...goal.goal, current: goal.current, plan: goal.plan, state: STATE_AR[goal.plan.state], metricLabel: GOAL_METRICS[goal.goal.metric].label } : null,
    metrics: Object.entries(GOAL_METRICS).map(([key, v]) => ({ key, label: v.label })),
    policy: policyBrief(), results,
    autopilot: { enabled: cfg.enabled, mode: cfg.mode, waveSize: cfg.waveSize, dailyCap: s?.dailyCap ?? null },
    team: team.map((e) => ({ role: e.role, name: e.name, title: e.title, avatar: e.avatar, active: e.isActive, isNew: !EMAIL_TEAM_DEFS.slice(0, 6).some((d) => d.role === e.role) })),
    brief: ((last as any).rows ?? last)[0] ?? null,
    log: (log as any).rows ?? log,
  };
}

/** كل ست ساعات دورة، وتقريرٌ لصاحب العمل مرةً في اليوم. */
export function startManagerLoop(): void {
  const SIX_H = 6 * 3_600_000;
  const lastBrief = new Map<number, number>();
  const round = async () => {
    // حيث الطيار يعمل فقط: نسخةُ الخادم الموقوفة لا تُدير حلقةً ثانية
    // على البيانات نفسها.
    const rows = await db.execute<{ user_id: number }>(sql`SELECT user_id FROM email_autopilot WHERE enabled = true`);
    for (const u of rows.rows) {
      const userId = Number(u.user_id);
      const due = Date.now() - (lastBrief.get(userId) ?? 0) > 20 * 3_600_000;
      const r = await runManagerCycle(userId, { brief: due, notifyOwner: due }).catch((err) => {
        logger.warn({ userId, err: String(err?.message ?? err) }, "دورة المدير تعذّرت"); return null;
      });
      if (r?.brief) lastBrief.set(userId, Date.now());
    }
  };
  setTimeout(() => { void round(); setInterval(() => void round(), SIX_H); }, 5 * 60_000);
  logger.info("حلقة مدير البريد بدأت — دورة كل ست ساعات");
}
