// ── The follow-up officer ─────────────────────────────────────────
// Walks the ladder — 1h, 6h, 12h, 1 day, 3 days, 1 week, 1 month — and argues
// each step before taking it.
//
// The ladder already existed and fired on a timer. A timer knows the hour and
// nothing else: not whether this person has ever opened a message, not whether
// the number is under pressure right now, not whether a seventh nudge at
// someone who has ignored six is worth the complaint it invites. Those are the
// three questions that decide whether a follow-up helps or costs, and none of
// them is about the clock.
//
// So each step is put to two colleagues, because they answer different
// questions and would give different answers:
//
//   شمّة  — is this person worth another message, and what should it say?
//   فهد   — can the number afford to send anything at all right now?
//
// Operations has a veto and the manager does not. Risk to the number is not a
// trade-off against one more lead: a banned number ends every conversation at
// once, and no individual follow-up is worth that.
//
// Nothing is sent while the sequence is in dry_run, which is how it ships. The
// full argument runs, the message is drafted, the verdict is recorded — and
// the owner can read a week of the team's judgement before trusting it.

import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  db, followUpJobsTable, followUpSequencesTable, followupDeliberationsTable,
  contactSegmentsTable, waThreadMessagesTable, botEmployeesTable,
  unsubscribedPhonesTable, leadSourcesTable,
} from "@workspace/db";
import { getControls, gather, decide } from "./ops-agent";
import { SEGMENT_AR, type Segment } from "./collector-agent";
import { complete } from "./llm";
import { say } from "./agent-comms";
import { getDailySentCount, getEffectiveDailyLimit } from "./daily-limit";
import { logger } from "./logger";
import { getCard, cardText } from "./lead-card";

export const FOLLOWUP_ROLE = "followup";

/** Human labels for the ladder, for the board and the argument. */
export const STEP_LABELS = ["بعد ساعة", "بعد ٦ ساعات", "بعد ١٢ ساعة", "بعد يوم", "بعد ٣ أيام", "بعد أسبوع", "بعد شهر"];

export type Verdict = "send" | "hold" | "drop";

export type Evidence = {
  phone: string; step: number;
  segment: Segment | null; opens: number; replies: number;
  followUpsSent: number;
  /** Hours since anything at all passed between us and them. */
  quietHours: number | null;
  optedOut: boolean;
  lastIntent: string | null;
};

async function evidence(userId: number, phone: string, step: number): Promise<Evidence> {
  const [[seg], [thread], [out], [lead], [sentSteps]] = await Promise.all([
    db.select().from(contactSegmentsTable)
      .where(and(eq(contactSegmentsTable.userId, userId), eq(contactSegmentsTable.phone, phone))).limit(1),
    db.select({
      replies: sql<number>`count(*) filter (where ${waThreadMessagesTable.fromMe} = false)`,
      last:    sql<Date | null>`max(${waThreadMessagesTable.createdAt})`,
    }).from(waThreadMessagesTable)
      .where(and(eq(waThreadMessagesTable.userId, userId), eq(waThreadMessagesTable.phone, phone))),
    db.select({ n: sql<number>`count(*)` }).from(unsubscribedPhonesTable)
      .where(and(eq(unsubscribedPhonesTable.userId, userId), eq(unsubscribedPhonesTable.phone, phone))),
    db.select({ intent: leadSourcesTable.lastIntent }).from(leadSourcesTable)
      .where(and(eq(leadSourcesTable.userId, userId), eq(leadSourcesTable.phone, phone))).limit(1),
    db.select({ n: sql<number>`count(*)` }).from(followUpJobsTable)
      .where(and(eq(followUpJobsTable.userId, userId), eq(followUpJobsTable.phone, phone),
                 eq(followUpJobsTable.status, "sent"))),
  ]);

  return {
    phone, step,
    segment: (seg?.segment as Segment) ?? null,
    opens: seg?.read ?? 0,
    replies: Number(thread?.replies ?? 0),
    followUpsSent: Number(sentSteps?.n ?? 0),
    quietHours: thread?.last ? Math.round((Date.now() - new Date(thread.last).getTime()) / 3_600_000) : null,
    optedOut: Number(out?.n ?? 0) > 0,
    lastIntent: lead?.intent ?? null,
  };
}

/**
 * The rules that need no discussion.
 *
 * Anything a model could get wrong and a customer would feel is settled here,
 * before either colleague is asked. Deliberation is for the genuinely
 * arguable case; "they asked us to stop" is not one.
 */
export function hardRules(e: Evidence): { verdict: Verdict; reason: string } | null {
  if (e.optedOut) return { verdict: "drop", reason: "طلب الإيقاف — لا متابعة بأي حال" };
  if (e.lastIntent === "not_interested") return { verdict: "drop", reason: "قال صراحةً إنه غير مهتم" };
  if (e.lastIntent === "complaint") return { verdict: "drop", reason: "لديه شكوى مفتوحة — المتابعة التسويقية تزيدها" };
  if (e.replies > 0 && (e.quietHours ?? 999) < 24) {
    return { verdict: "hold", reason: "ردّ خلال ٢٤ ساعة — المحادثة حيّة ولا تحتاج تذكيراً" };
  }
  // Someone who never opened anything and has already had three nudges is not
  // going to be reached by a fourth; they are going to report it.
  if (e.opens === 0 && e.followUpsSent >= 3) {
    return { verdict: "drop", reason: "٣ متابعات بلا فتح واحد — الاستمرار يدعو للشكوى" };
  }
  return null;
}

export async function opsVerdict(userId: number): Promise<{ ok: boolean; view: string }> {
  const [controls, signals] = await Promise.all([getControls(userId), gather(userId)]);
  const d = decide(signals);

  if (controls.holdUntil && new Date(controls.holdUntil).getTime() > Date.now()) {
    return { ok: false, view: `الإرسال موقوف حالياً — ${controls.reason ?? "قرار تشغيلي"}` };
  }
  if (d.level === "critical") {
    return { ok: false, view: `حالة الرقم حرجة: ${d.findings[0]}` };
  }

  const [used, limit] = await Promise.all([
    getDailySentCount(userId).catch(() => 0),
    getEffectiveDailyLimit(userId).catch(() => 0),
  ]);
  const ceiling = controls.dailyCeiling ? Math.min(limit, controls.dailyCeiling) : limit;
  if (ceiling > 0 && used / ceiling >= 0.9) {
    // Campaigns are what the quota is for. A follow-up is worth less than a
    // first contact and should be the thing that yields.
    return { ok: false, view: `الحصة شبه مستهلكة (${used}/${ceiling}) — الأولوية للحملات` };
  }
  if (Number(controls.throttle) > 1) {
    return { ok: true, view: `الرقم تحت إبطاء ${controls.throttle}× — أرسل، لكن بحذر` };
  }
  return { ok: true, view: `الرقم سليم، ${used} من ${ceiling} اليوم` };
}

/** The manager's call: worth another message, and what should it say? */
async function managerVerdict(
  userId: number, e: Evidence, opsView: string,
): Promise<{ verdict: Verdict; reason: string; draft: string | null }> {
  const [manager] = await db.select().from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, "chief"))).limit(1);

  const history = await db.select({ fromMe: waThreadMessagesTable.fromMe, text: waThreadMessagesTable.text })
    .from(waThreadMessagesTable)
    .where(and(eq(waThreadMessagesTable.userId, userId), eq(waThreadMessagesTable.phone, e.phone)))
    .orderBy(desc(waThreadMessagesTable.createdAt)).limit(6);

  const card = await getCard(userId, e.phone).catch(() => null);
  const facts = [
    `المرحلة: ${STEP_LABELS[e.step] ?? `رقم ${e.step + 1}`} (المتابعة رقم ${e.step + 1} من ٧).`,
    `فتح رسائلنا: ${e.opens} مرة.`,
    `ردّ علينا: ${e.replies} مرة.`,
    `متابعات أُرسلت له سابقاً: ${e.followUpsSent}.`,
    e.segment ? `تصنيف ريم: ${SEGMENT_AR[e.segment]}.` : "",
    e.quietHours !== null ? `آخر تواصل قبل ${e.quietHours} ساعة.` : "لم يحدث أي تواصل ثنائي بعد.",
    `رأي فهد عن حالة الرقم: ${opsView}`,
    // What the team knows about this lead and where the sale stands. A
    // follow-up that ignores a stated objection or re-asks a known fact is
    // the reason a seventh message gets a block instead of a reply.
    card ? `\n${cardText(card)}` : "",
    history.length ? `\nآخر ما دار:\n${history.reverse().map((h) => `${h.fromMe ? "نحن" : "العميل"}: ${(h.text ?? "").slice(0, 150)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");

  const out = await complete([
    { role: "system", content: [
      manager ? `أنت ${manager.name}${manager.title ? `، ${manager.title}` : ""}.` : "أنت مديرة مبيعات.",
      manager?.persona ?? "",
      "",
      "يسألك موظف المتابعة: هل نرسل لهذا العميل رسالة متابعة الآن؟",
      "قرّري بناءً على سلوكه هو — هل يفتح رسائلنا؟ كم مرة تابعنا معه بلا نتيجة؟ — لا بناءً على أن الوقت حان.",
      "من لم يفتح شيئاً ولم يرد، تكرار التذكير معه يضرّ ولا ينفع.",
      "",
      "أجيبي بهذا الشكل بالضبط:",
      "القرار: أرسل | أجّل | أوقف",
      "السبب: <سطر واحد>",
      "الرسالة: <نص الرسالة إن كان القرار أرسل، وإلا اتركيه فارغاً>",
      "",
      "إن قررتِ الإرسال فاكتبي الرسالة كما يكتبها إنسان على واتساب: قصيرة، تذكر شيئاً يخصّه هو،",
      "بلا تحية مكرّرة وبلا «نتشرف» و«لا تتردد»، وبلا سؤال مصطنع في آخرها.",
      "كل متابعة يجب أن تختلف عمّا قبلها — لا تُعيدي صياغة الرسالة السابقة.",
    ].filter(Boolean).join("\n") },
    { role: "user", content: facts },
  ]);

  if (!out?.text) {
    // A model that cannot be reached must not become an accidental yes.
    return { verdict: "hold", reason: "تعذّر الوصول لمديرة المبيعات — أُجّل القرار", draft: null };
  }

  const text = out.text;
  const decision = /القرار\s*[:：]\s*(أرسل|أجّل|أجل|أوقف)/.exec(text)?.[1] ?? "أجّل";
  const reason = /السبب\s*[:：]\s*(.+)/.exec(text)?.[1]?.trim() ?? "";
  const draft = /الرسالة\s*[:：]\s*([\s\S]+)/.exec(text)?.[1]?.trim() ?? null;

  const verdict: Verdict = decision === "أرسل" ? "send" : decision === "أوقف" ? "drop" : "hold";
  return { verdict, reason, draft: verdict === "send" ? (draft || null) : null };
}

export type Deliberation = {
  phone: string; step: number; verdict: Verdict; reason: string;
  managerView: string; opsView: string; draft: string | null;
  evidence: Evidence; executed: boolean;
};

/** Argue one step and record the argument. */
export async function deliberate(userId: number, phone: string, step: number, jobId?: number): Promise<Deliberation> {
  const e = await evidence(userId, phone, step);

  const hard = hardRules(e);
  if (hard) {
    const d: Deliberation = {
      phone, step, verdict: hard.verdict, reason: hard.reason,
      managerView: "—", opsView: "—", draft: null, evidence: e, executed: false,
    };
    await record(userId, d, jobId);
    return d;
  }

  // Operations first, and it has the veto: asking the manager to compose a
  // message the number cannot afford to send wastes a model call and invites
  // the temptation to send it anyway.
  const ops = await opsVerdict(userId);
  if (!ops.ok) {
    const d: Deliberation = {
      phone, step, verdict: "hold", reason: `فهد اعترض: ${ops.view}`,
      managerView: "—", opsView: ops.view, draft: null, evidence: e, executed: false,
    };
    await record(userId, d, jobId);
    return d;
  }

  const mgr = await managerVerdict(userId, e, ops.view);
  const d: Deliberation = {
    phone, step, verdict: mgr.verdict, reason: mgr.reason,
    managerView: `${mgr.verdict === "send" ? "أرسل" : mgr.verdict === "drop" ? "أوقف" : "أجّل"} — ${mgr.reason}`,
    opsView: ops.view, draft: mgr.draft, evidence: e, executed: false,
  };
  await record(userId, d, jobId);
  return d;
}

async function record(userId: number, d: Deliberation, jobId?: number): Promise<void> {
  await db.insert(followupDeliberationsTable).values({
    userId, jobId: jobId ?? null, phone: d.phone, step: d.step,
    segment: d.evidence.segment, opens: d.evidence.opens,
    verdict: d.verdict, reason: d.reason,
    managerView: d.managerView, opsView: d.opsView, draft: d.draft,
    executed: d.executed,
  });
}

/**
 * Work everything that is due.
 *
 * Returns what was decided rather than what was sent, because in dry-run those
 * are different things and the difference is the point.
 */
export async function runFollowUpOfficer(userId: number, max = 15) {
  const [sequence] = await db.select().from(followUpSequencesTable)
    .where(and(eq(followUpSequencesTable.userId, userId), eq(followUpSequencesTable.isActive, true)))
    .limit(1);
  if (!sequence) return { dryRun: true, decided: [] as Deliberation[], note: "لا يوجد تسلسل متابعة نشط" };

  const due = await db.select().from(followUpJobsTable)
    .where(and(
      eq(followUpJobsTable.userId, userId),
      eq(followUpJobsTable.status, "pending"),
      lte(followUpJobsTable.dueAt, new Date()),
    ))
    .orderBy(asc(followUpJobsTable.dueAt))
    .limit(max);

  const decided: Deliberation[] = [];
  for (const job of due) {
    const d = await deliberate(userId, job.phone, job.stepIndex, job.id);
    decided.push(d);

    if (d.verdict === "drop") {
      await db.update(followUpJobsTable).set({ status: "cancelled" })
        .where(and(eq(followUpJobsTable.userId, userId), eq(followUpJobsTable.phone, job.phone),
                   eq(followUpJobsTable.status, "pending")));
      continue;
    }
    if (d.verdict === "hold") {
      // Pushed back rather than cancelled: the reason was about now.
      await db.update(followUpJobsTable)
        .set({ dueAt: new Date(Date.now() + 6 * 60 * 60_000) })
        .where(eq(followUpJobsTable.id, job.id));
      continue;
    }
    // verdict === "send", and this is where the dry run stops.
    if (sequence.dryRun) continue;

    // Live sending is deliberately not wired yet: the owner asked for the
    // machinery to be ready and quiet. When it is switched on, this is the
    // single place that changes.
  }

  if (decided.length > 0) {
    const counts = decided.reduce((a, d) => { a[d.verdict] = (a[d.verdict] ?? 0) + 1; return a; }, {} as Record<string, number>);
    await say({
      userId, fromRole: FOLLOWUP_ROLE, toRole: "chief", kind: "report",
      body: `راجعت ${decided.length} متابعة مستحقة: ${counts["send"] ?? 0} للإرسال، ${counts["hold"] ?? 0} مؤجلة، ${counts["drop"] ?? 0} موقوفة.` +
            (sequence.dryRun ? " (وضع التجربة — لم يُرسل شيء)" : ""),
    }).catch(() => {});
  }

  logger.info({ userId, due: due.length, dryRun: sequence.dryRun }, "موظف المتابعة أنهى جولة");
  return { dryRun: sequence.dryRun, decided, note: null };
}

/** The last rounds of argument, for the board. */
export async function recentDeliberations(userId: number, limit = 40) {
  return db.select().from(followupDeliberationsTable)
    .where(eq(followupDeliberationsTable.userId, userId))
    .orderBy(desc(followupDeliberationsTable.createdAt))
    .limit(limit);
}
