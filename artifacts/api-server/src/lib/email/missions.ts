// ── Missions: نورة working an audience towards a goal ────────────
// The owner picks the target and states the goal; she does the rest, in
// stages, and each stage waits for evidence rather than a timer alone:
//
//   draft             she writes: two subjects, the body, a follow-up for
//                     those who open and do not reply, and one for those who
//                     never open.
//   awaiting_approval the owner reads it, edits it if they like, approves.
//                     (On by default. Off, she sends what she wrote.)
//   sending           a campaign on the audience with the two subjects tested
//                     on a slice; when the test is decided she writes down
//                     which subject won for that sector.
//   following_up      once the campaign has been out long enough to be read,
//                     openers who did not reply get the warm follow-up and
//                     non-openers the cold one — two audiences, two angles.
//   done              the report — by subject, by city, by sector — and what
//                     she learned, into her memory, and to the owner.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db, emailMissionsTable, emailMissionLogTable, emailCampaignsTable, emailSegmentsTable, emailSequencesTable,
  emailSequenceJobsTable, emailMessagesTable, emailContactsTable, type EmailMission, type SegmentFilter,
} from "@workspace/db";
import { logger } from "../logger";
import { notify, esc } from "../telegram";
import { startCampaign, enrolInSequence } from "./service";
import { writeCampaign, rememberLesson, learnFrom, type EmailDraft } from "./agent";
import { count, describe } from "./segments";
import { EMAIL_LANGUAGE, isEnglish, NOT_ENGLISH } from "./language";
import { trackingActive, retestHeld } from "./service";
import { activity, guardCheck, onDuty, type EmailRole } from "./team";
import { knowledgeText } from "./knowledge-docs";

async function log(missionId: number, text: string, kind = "note") {
  await db.insert(emailMissionLogTable).values({ missionId, kind, text: text.slice(0, 2000) });
}
async function set(id: number, patch: Partial<typeof emailMissionsTable.$inferInsert>) {
  await db.update(emailMissionsTable).set({ ...patch, lastRunAt: new Date() }).where(eq(emailMissionsTable.id, id));
}

export async function createMission(userId: number, input: {
  name: string; goal: string; filter: SegmentFilter; language?: string; tone?: string | null; requireApproval?: boolean; followAfterHours?: number;
  agentRole?: EmailRole; sourceListId?: number | null;
}) {
  const [m] = await db.insert(emailMissionsTable).values({
    userId, name: input.name.slice(0, 160), goal: input.goal.slice(0, 2000), filter: input.filter,
    language: EMAIL_LANGUAGE, tone: input.tone ?? null,
    requireApproval: input.requireApproval !== false,
    // Day 3: the first follow-up, by default.
    followAfterHours: Math.min(24 * 14, Math.max(24, Number(input.followAfterHours) || 72)),
    agentRole: input.agentRole ?? null, sourceListId: input.sourceListId ?? null,
  }).returning();
  await log(m!.id, `أُنشئت المهمة: ${describe(input.filter)} — ${input.goal.slice(0, 200)}`, "start");
  return m!;
}

/** Launch what was approved: the campaign with its subject test, and the two follow-up sequences. */
async function launch(m: EmailMission, d: EmailDraft) {
  const filter = m.filter as SegmentFilter;
  const n = await count(m.userId, filter, true);
  if (!n) { await log(m.id, "لا أحد في الجمهور يمكن مراسلته — أُوقفت المهمة", "error"); await set(m.id, { status: "paused" }); return; }

  const [seg] = await db.insert(emailSegmentsTable).values({ userId: m.userId, name: `مهمة: ${m.name}`.slice(0, 160), filter }).returning();
  const [camp] = await db.insert(emailCampaignsTable).values({
    userId: m.userId, name: m.name, segmentId: seg!.id, missionId: m.id, createdBy: "agent",
    // With opens measured, the test slice is read after a day — enough time for a B2B inbox to be opened.
    subject: d.subjects[0]!, subjectB: d.subjects[1] ?? null, abPct: d.subjects[1] && n >= 40 ? 20 : 0, abWaitHours: (await trackingActive(m.userId)) ? 24 : 4,
    html: d.html, status: "draft",
  }).returning();
  // The sequence after the first email: day 3 the touch for what they did (opened → a new angle and a
  // question; did not open → the same offer, shorter, under a new subject), day 7 something useful,
  // day 14 the last note. Each stops the moment they reply, unsubscribe or bounce.
  const tail = [
    ...d.followups.filter((f) => f.audience === "value").slice(0, 1).map((f) => ({ afterHours: 96, subject: f.subject, html: f.html })),
    ...d.followups.filter((f) => f.audience === "breakup").slice(0, 1).map((f) => ({ afterHours: 264, subject: f.subject, html: f.html })),
  ];
  const seqFor = async (audience: "warm" | "cold") => {
    const first = d.followups.filter((f) => f.audience === audience).slice(0, 1).map((f) => ({ afterHours: 0, subject: f.subject, html: f.html }));
    const steps = [...first, ...tail];
    if (!steps.length) return null;
    const [s] = await db.insert(emailSequencesTable).values({
      userId: m.userId, name: `${m.name} — ${audience === "warm" ? "فتح ولم يرد" : "لم يفتح"}`.slice(0, 160), steps, stopOnReply: true, isActive: true,
    }).returning();
    return s!.id;
  };
  const [warm, cold] = await Promise.all([seqFor("warm"), seqFor("cold")]);
  const r = await startCampaign(m.userId, camp!.id);
  await set(m.id, { stage: "sending", campaignId: camp!.id, warmSequenceId: warm, coldSequenceId: cold, pending: null });
  await activity(m.userId, (m.agentRole as EmailRole | null) ?? "email", "send", `بدأ إرسال «${m.name}» إلى ${r.queued} شركة.`, { missionId: m.id, campaignId: camp!.id });
  await log(m.id, `بدأ الإرسال إلى ${r.queued} شركة${(r as any).ab ? ` — اختبار عنوانين على ${(r as any).ab.a + (r as any).ab.b} منهم` : ""}.`, "send");
}

/** The owner's yes — with the draft as they edited it. */
export async function approve(userId: number, id: number, edited?: Partial<EmailDraft>) {
  const [m] = await db.select().from(emailMissionsTable).where(and(eq(emailMissionsTable.id, id), eq(emailMissionsTable.userId, userId))).limit(1);
  if (!m || m.stage !== "awaiting_approval" || !m.pending) throw new Error("لا شيء ينتظر الموافقة");
  const d = { ...(m.pending as EmailDraft), ...(edited ?? {}) } as EmailDraft;
  if (![d.html, ...d.subjects].every(isEnglish)) throw new Error(NOT_ENGLISH);
  // Nobody to send to is said now, and the mission keeps waiting — approving
  // it into a pause, with nothing said, read as "approval does not work".
  const n = await count(userId, m.filter as SegmentFilter, true);
  if (!n) throw new Error(`لا أحد في جمهور هذه الحملة يمكن مراسلته الآن (${describe(m.filter as SegmentFilter)}). ارفع القائمة أو غيّر الجمهور، ثم وافق.`);
  await db.update(emailMissionsTable).set({ status: "active", pending: d as any }).where(eq(emailMissionsTable.id, m.id));
  await log(m.id, "وافق صاحب العمل.", "approve");
  await launch({ ...m, status: "active" }, d);
}

/** Who a waiting mission goes to, changed before the owner approves it. */
export async function setAudience(userId: number, id: number, filter: SegmentFilter) {
  const [m] = await db.select().from(emailMissionsTable).where(and(eq(emailMissionsTable.id, id), eq(emailMissionsTable.userId, userId))).limit(1);
  if (!m || !["draft", "awaiting_approval"].includes(m.stage)) throw new Error("لا يمكن تغيير جمهور مهمة بدأ إرسالها");
  await db.update(emailMissionsTable).set({ filter, status: "active" }).where(eq(emailMissionsTable.id, id));
  await log(id, `غيّر صاحب العمل الجمهور: ${describe(filter)} — ${await count(userId, filter, true)} يمكن مراسلتهم.`, "note");
}

/** One step for one mission. Safe to call at any time; each stage checks its own evidence. */
export async function runMission(m: EmailMission): Promise<void> {
  if (m.status !== "active") return;
  const filter = m.filter as SegmentFilter;
  const sectors = filter.sectors ?? [];

  if (m.stage === "draft") {
    const role = (m.agentRole as EmailRole | null) ?? "email";
    const w = await writeCampaign(m.userId, { filter, goal: m.goal, language: m.language, tone: m.tone, role });
    if (!w) { await log(m.id, "تعذّرت الكتابة — النموذج لم يستجب. أحاول في الجولة القادمة.", "error"); await set(m.id, {}); return; }
    await log(m.id, `كتبت الحملة (${w.provider}): «${w.draft.subjects.join("» / «")}» — ${w.draft.why}`, "write");
    await activity(m.userId, role, "write", `كتب حملة «${m.name}» لـ ${w.audience.count} شركة: «${w.draft.subjects[0]}»`, { missionId: m.id });
    // ماجد reads it before anything goes out on its own; what he finds sends it to the owner instead.
    if (!m.requireApproval && ![w.draft.html, ...w.draft.subjects].every(isEnglish)) {
      await set(m.id, { stage: "awaiting_approval", pending: w.draft as any });
      await log(m.id, NOT_ENGLISH, "error");
      return;
    }
    if (!m.requireApproval && (await onDuty(m.userId, "email_guard"))) {
      const knowledge = await knowledgeText(m.userId);
      const issues = guardCheck([...w.draft.subjects, w.draft.html, ...w.draft.followups.flatMap((f) => [f.subject, f.html])], knowledge);
      if (issues.length) {
        await set(m.id, { stage: "awaiting_approval", pending: w.draft as any });
        await log(m.id, `أوقفها حارس الجودة قبل الإرسال: ${issues.join(" · ")}`, "error");
        await activity(m.userId, "email_guard", "hold", `أوقف «${m.name}» حتى تراجعها: ${issues.slice(0, 3).join(" · ")}`, { missionId: m.id, issues });
        await notify(m.userId, `<b>🛡️ ماجد أوقف حملة «${esc(m.name)}» قبل الإرسال</b>\n${issues.slice(0, 4).map((i) => `• ${esc(i)}`).join("\n")}\nراجعها من البريد → المهام.`).catch(() => {});
        return;
      }
      await activity(m.userId, "email_guard", "pass", `راجع «${m.name}»: لا أرقام خارج المعرفة ولا مبالغة — يُرسل.`, { missionId: m.id });
    }
    if (m.requireApproval) {
      await set(m.id, { stage: "awaiting_approval", pending: w.draft as any });
      await notify(m.userId, `<b>📧 نورة كتبت حملة «${esc(m.name)}» وتنتظر موافقتك</b>\n${esc(w.audience.description)} — ${w.audience.count} شركة\nالعنوان: ${esc(w.draft.subjects[0]!)}\nافتح البريد → المهام.`).catch(() => {});
    } else {
      await launch({ ...m, pending: w.draft as any }, w.draft);
    }
    return;
  }

  if (m.stage === "sending" && m.campaignId) {
    const [c] = await db.select().from(emailCampaignsTable).where(eq(emailCampaignsTable.id, m.campaignId)).limit(1);
    if (!c) return;
    // Almost nobody opened the test slice: the rest was held. New subjects, a fresh slice — twice at most.
    if (c.status === "paused" && c.lowOpenAt) { await rescueSubjects(m, c); return; }
    // The subject test, once decided, is a lesson for this sector.
    const learned = await db.select({ id: emailMissionLogTable.id }).from(emailMissionLogTable)
      .where(and(eq(emailMissionLogTable.missionId, m.id), eq(emailMissionLogTable.kind, "ab"))).limit(1);
    if (c.abWinner && !learned.length) {
      const win = c.abWinner === "B" ? c.subjectB! : c.subject, lose = c.abWinner === "B" ? c.subject : c.subjectB!;
      const topic = sectors.length === 1 ? sectors[0]! : null;
      await rememberLesson(m.userId, "win", `عنوان فاز في الاختبار: «${win}»`, topic);
      await rememberLesson(m.userId, "loss", `عنوان خسر في الاختبار: «${lose}»`, topic);
      await log(m.id, `حُسم اختبار العنوان: فاز «${win}». حفظته في ذاكرتي${topic ? ` لقطاع ${topic}` : ""}.`, "ab");
    }
    const [{ q }] = await db.select({ q: sql<number>`count(*)` }).from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.campaignId, c.id), inArray(emailMessagesTable.status, ["queued", "ab_hold"])));
    const lastSent = c.completedAt ?? null;
    if (Number(q) === 0 && lastSent && Date.now() - new Date(lastSent).getTime() > m.followAfterHours * 3_600_000) {
      await followUp(m, c.id);
    }
    return;
  }

  if (m.stage === "following_up") {
    const seqIds = [m.warmSequenceId, m.coldSequenceId].filter((x): x is number => !!x);
    const [{ p }] = seqIds.length
      ? await db.select({ p: sql<number>`count(*)` }).from(emailSequenceJobsTable).where(and(inArray(emailSequenceJobsTable.sequenceId, seqIds), eq(emailSequenceJobsTable.status, "pending")))
      : [{ p: 0 }];
    // Two days after the last follow-up went out, the mission is over.
    const [{ last }] = seqIds.length
      ? await db.select({ last: sql<Date | null>`max(${emailMessagesTable.sentAt})` }).from(emailMessagesTable)
          .innerJoin(emailSequenceJobsTable, eq(emailSequenceJobsTable.id, emailMessagesTable.sequenceJobId))
          .where(inArray(emailSequenceJobsTable.sequenceId, seqIds))
      : [{ last: null }];
    if (Number(p) === 0 && (!last || Date.now() - new Date(last).getTime() > 48 * 3_600_000)) await finish(m);
    return;
  }
}

/** Openers who did not reply, and non-openers — two audiences, two follow-ups. */
async function followUp(m: EmailMission, campaignId: number) {
  const rows = await db.select({ contactId: emailMessagesTable.contactId, opened: emailMessagesTable.openedAt, replied: emailMessagesTable.repliedAt, status: emailMessagesTable.status, cstatus: emailContactsTable.status })
    .from(emailMessagesTable).innerJoin(emailContactsTable, eq(emailContactsTable.id, emailMessagesTable.contactId))
    .where(eq(emailMessagesTable.campaignId, campaignId));
  const ok = rows.filter((r) => r.status === "sent" && !r.replied && r.cstatus === "active" && r.contactId);
  const warm = ok.filter((r) => r.opened).map((r) => r.contactId!);
  const cold = ok.filter((r) => !r.opened).map((r) => r.contactId!);
  const w = m.warmSequenceId && warm.length ? await enrolInSequence(m.userId, m.warmSequenceId, warm) : { enrolled: 0 };
  const c = m.coldSequenceId && cold.length ? await enrolInSequence(m.userId, m.coldSequenceId, cold) : { enrolled: 0 };
  await set(m.id, { stage: "following_up" });
  await log(m.id, `المتابعة: ${w.enrolled} فتحوا ولم يردوا ← زاوية جديدة؛ ${c.enrolled} لم يفتحوا ← عنوان أقصر مختلف.`, "follow");
  await activity(m.userId, "email_followup", "follow", `«${m.name}»: ${w.enrolled} فتحوا ولم يردوا ← متابعة بزاوية جديدة، ${c.enrolled} لم يفتحوا ← عنوان أقصر.`, { missionId: m.id });
}

/** The numbers, by subject, city and sector. Used live and at the end. */
export async function missionReport(m: EmailMission) {
  if (!m.campaignId) return null;
  const seqIds = [m.warmSequenceId, m.coldSequenceId].filter((x): x is number => !!x);
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const base = sql`(${emailMessagesTable.campaignId} = ${m.campaignId}${seqIds.length ? sql` or ${emailMessagesTable.sequenceJobId} in (select id from email_sequence_jobs where sequence_id in (${sql.join(seqIds.map((i) => sql`${i}`), sql`, `)}))` : sql``})`;
  const agg = {
    sent: sql<number>`count(*) filter (where ${emailMessagesTable.sentAt} is not null)`,
    opened: sql<number>`count(*) filter (where ${emailMessagesTable.openedAt} is not null)`,
    clicked: sql<number>`count(*) filter (where ${emailMessagesTable.clickedAt} is not null)`,
    replied: sql<number>`count(*) filter (where ${emailMessagesTable.repliedAt} is not null)`,
    bounced: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'bounced')`,
  };
  const shape = (r: any) => ({ sent: Number(r.sent), opened: Number(r.opened), clicked: Number(r.clicked), replied: Number(r.replied), bounced: Number(r.bounced),
    openRate: rate(Number(r.opened), Number(r.sent)), replyRate: rate(Number(r.replied), Number(r.sent)) });
  const [[total], byVariant, byCity, bySector, byStage] = await Promise.all([
    db.select(agg).from(emailMessagesTable).where(base),
    db.select({ k: emailMessagesTable.variant, ...agg }).from(emailMessagesTable).where(and(eq(emailMessagesTable.campaignId, m.campaignId), sql`${emailMessagesTable.variant} is not null`)).groupBy(emailMessagesTable.variant),
    db.select({ k: emailContactsTable.city, ...agg }).from(emailMessagesTable).innerJoin(emailContactsTable, eq(emailContactsTable.id, emailMessagesTable.contactId)).where(base).groupBy(emailContactsTable.city).orderBy(sql`2 desc`).limit(12),
    db.select({ k: emailContactsTable.sector, ...agg }).from(emailMessagesTable).innerJoin(emailContactsTable, eq(emailContactsTable.id, emailMessagesTable.contactId)).where(base).groupBy(emailContactsTable.sector).orderBy(sql`2 desc`).limit(12),
    // By step of the path: the first email, day 3 (opened / not opened), day 7, day 14.
    db.select({ k: sql<string>`case when ${emailMessagesTable.campaignId} = ${m.campaignId} then 'first'
        when ${emailSequenceJobsTable.stepIndex} = 1 then 'value' when ${emailSequenceJobsTable.stepIndex} >= 2 then 'breakup'
        when ${emailSequenceJobsTable.sequenceId} = ${m.warmSequenceId ?? -1} then 'warm' else 'cold' end`, ...agg })
      .from(emailMessagesTable).leftJoin(emailSequenceJobsTable, eq(emailSequenceJobsTable.id, emailMessagesTable.sequenceJobId)).where(base).groupBy(sql`1`),
  ]);
  const [c] = await db.select().from(emailCampaignsTable).where(eq(emailCampaignsTable.id, m.campaignId)).limit(1);
  return {
    total: shape(total ?? {}),
    subjects: byVariant.map((r) => ({ variant: r.k, subject: r.k === "B" ? c?.subjectB : c?.subject, ...shape(r) })),
    winner: c?.abWinner ?? null,
    byStage: byStage.map((r) => ({ stage: r.k, ...shape(r) })),
    byCity: byCity.map((r) => ({ city: r.k ?? "—", ...shape(r) })),
    bySector: bySector.map((r) => ({ sector: r.k ?? "غير مصنف", ...shape(r) })),
  };
}

async function finish(m: EmailMission) {
  const report = await missionReport(m);
  const lessons = report ? await learnFrom(m.userId, (m.filter as SegmentFilter).sectors ?? [], report).catch(() => []) : [];
  await set(m.id, { stage: "done", report: { ...report, lessons } as any });
  await log(m.id, lessons.length ? `انتهت المهمة. تعلّمت: ${lessons.join(" · ")}` : "انتهت المهمة.", "done");
  const t = report?.total;
  await notify(m.userId, [
    `<b>📧 انتهت مهمة «${esc(m.name)}»</b>`,
    t ? `أُرسل ${t.sent} · فتح ${t.openRate}% · رد ${t.replyRate}% (${t.replied})` : "",
    report?.winner ? `العنوان الفائز: ${esc(report.subjects.find((s) => s.variant === report.winner)?.subject ?? "")}` : "",
    ...lessons.map((l) => `• ${esc(l)}`),
  ].filter(Boolean).join("\n")).catch(() => {});
}

export async function runMissions(): Promise<void> {
  const active = await db.select().from(emailMissionsTable)
    .where(and(eq(emailMissionsTable.status, "active"), inArray(emailMissionsTable.stage, ["draft", "sending", "following_up"])));
  for (const m of active) {
    try { await runMission(m); }
    catch (err) { await log(m.id, `خطأ: ${String((err as any)?.message ?? err).slice(0, 300)}`, "error").catch(() => {}); }
  }
}

export function startMissionWorker(): void {
  setTimeout(() => {
    void runMissions().catch(() => {});
    setInterval(() => void runMissions().catch((e) => logger.warn({ err: String(e?.message ?? e) }, "missions sweep failed")), 10 * 60_000);
  }, 90_000);
  logger.info("مهام نورة بدأت");
}

export async function missionsFor(userId: number) {
  const rows = await db.select().from(emailMissionsTable).where(eq(emailMissionsTable.userId, userId)).orderBy(desc(emailMissionsTable.createdAt));
  return Promise.all(rows.map(async (m) => ({
    ...m,
    audience: describe(m.filter as SegmentFilter),
    audienceCount: await count(userId, m.filter as SegmentFilter, true),
    log: await db.select().from(emailMissionLogTable).where(eq(emailMissionLogTable.missionId, m.id)).orderBy(desc(emailMissionLogTable.createdAt)).limit(30),
    live: m.campaignId && m.stage !== "done" ? await missionReport(m).catch(() => null) : null,
  })));
}

/**
 * The open-rate checkpoint's second half. The test slice was read and almost
 * nobody opened, so the rest is held (service.decideAbTests). The writer gives
 * two new subjects with different angles and they go to a fresh slice of the
 * held; after two such rounds the problem is taken to be delivery — the inbox
 * is not seeing the email at all — and the campaign waits for the owner.
 */
async function rescueSubjects(m: EmailMission, c: typeof emailCampaignsTable.$inferSelect) {
  if (c.abRound >= 2) {
    const [already] = await db.select({ id: emailMissionLogTable.id }).from(emailMissionLogTable).where(and(eq(emailMissionLogTable.missionId, m.id), eq(emailMissionLogTable.kind, "deliverability"))).limit(1);
    if (already) return;
    const why = "بقيت نسبة الفتح منخفضة بعد عنوانين جديدين مرتين — المشكلة غالباً في التسليم لا في العنوان: الرسائل تصل إلى السبام أو لا تصل. افحص SPF وDKIM وDMARC من إعدادات البريد، وخفّض حصة اليوم أسبوعاً، ثم استأنف الحملة.";
    await log(m.id, why, "deliverability");
    await activity(m.userId, "email_guard", "hold", `«${m.name}»: ${why}`, { missionId: m.id, campaignId: c.id });
    await notify(m.userId, `<b>🛡️ ماجد: حملة «${esc(m.name)}» متوقفة</b>\n${esc(why)}`).catch(() => {});
    return;
  }
  const filter = m.filter as SegmentFilter;
  const w = await writeCampaign(m.userId, {
    filter, role: (m.agentRole as EmailRole | null) ?? "email",
    goal: `${m.goal}\n\nThe first subjects were opened by almost nobody: «${c.subject}» and «${c.subjectB ?? ""}». Write two NEW subjects with completely different angles (a question about their business; a specific fact from the knowledge base) — short, no hype, the company name in at least one. Keep the email body as it is.`,
  });
  const subjects = w?.draft.subjects.filter((x) => isEnglish(x)).slice(0, 2) ?? [];
  if (subjects.length < 2) { await log(m.id, "تعذّرت كتابة عنوانين جديدين — أحاول في الجولة القادمة.", "error"); return; }
  const r = await retestHeld(c.id, subjects[0]!, subjects[1]!);
  await log(m.id, `نسبة الفتح كانت منخفضة — جُرّب عنوانان جديدان على ${r.slice} من ${r.held} المنتظرين: «${subjects[0]}» / «${subjects[1]}».`, "ab");
  await activity(m.userId, (m.agentRole as EmailRole | null) ?? "email", "rescue", `أعاد كتابة عنوان «${m.name}» بعد فتح منخفض، وجرّبه على ${r.slice} شركة.`, { missionId: m.id, campaignId: c.id });
}
