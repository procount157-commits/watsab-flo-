// ── Internal assistant ────────────────────────────────────────────
// The operator's own bot. Unlike the customer-facing replier it is allowed to
// reason freely — it is talking to the business owner, not their customers —
// but it is given real numbers rather than left to guess at them, because an
// assistant that invents this week's delivery rate is worse than none.

import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import {
  db, assistantThreadsTable, assistantMessagesTable,
  campaignsTable, messageLogs, contactsTable, contactGroupsTable,
  leadSourcesTable, followUpJobsTable, knowledgeBaseTable,
  unsubscribedPhonesTable,
} from "@workspace/db";
import { getStatus } from "./whatsapp";
import { getProfile } from "./knowledge";
import { getDailySentCount, getEffectiveDailyLimit } from "./daily-limit";
import { complete, activeProvider } from "./llm";
import { logger } from "./logger";
import { overview as emailOverview } from "./email/service";
import { INTERVIEW_KIND, INTERVIEW_DONE, QUESTIONS, STOP, interviewPrompt, managerFor, harvest, applyHarvest } from "./onboarding";
import { asWorker } from "./agent-context";

/** How much of a thread is replayed to the model. */
const HISTORY_TURNS = 24;

/**
 * A snapshot of the account, assembled per request.
 *
 * Deliberately concrete: counts and rates the assistant would otherwise be
 * asked about and would have to invent.
 */
export async function buildContext(userId: number): Promise<string> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);

  const [
    profile, wa, campaignStats, contactStats, sentWeek,
    leadStats, followUps, kbCount, optOuts, dailyUsed, dailyLimit,
  ] = await Promise.all([
    getProfile(userId),
    Promise.resolve(getStatus(userId)),
    db.select({
      total:   sql<number>`count(*)`,
      running: sql<number>`count(*) filter (where ${campaignsTable.status} = 'running')`,
      paused:  sql<number>`count(*) filter (where ${campaignsTable.status} in ('paused','auto_paused'))`,
      done:    sql<number>`count(*) filter (where ${campaignsTable.status} = 'completed')`,
    }).from(campaignsTable).where(eq(campaignsTable.userId, userId)),
    db.select({ groups: sql<number>`count(distinct ${contactGroupsTable.id})`, contacts: sql<number>`count(${contactsTable.id})` })
      .from(contactGroupsTable)
      .leftJoin(contactsTable, eq(contactsTable.groupId, contactGroupsTable.id))
      .where(eq(contactGroupsTable.userId, userId)),
    db.select({
      sent:      sql<number>`count(*) filter (where ${messageLogs.status} = 'sent')`,
      failed:    sql<number>`count(*) filter (where ${messageLogs.status} = 'failed')`,
      delivered: sql<number>`count(${messageLogs.deliveredAt})`,
      read:      sql<number>`count(${messageLogs.readAt})`,
    }).from(messageLogs)
      .innerJoin(campaignsTable, eq(messageLogs.campaignId, campaignsTable.id))
      .where(and(eq(campaignsTable.userId, userId), gte(messageLogs.createdAt, since))),
    db.select({
      total: sql<number>`count(*)`,
      ad:    sql<number>`count(*) filter (where ${leadSourcesTable.source} = 'ad')`,
      hot:   sql<number>`count(*) filter (where ${leadSourcesTable.lastIntent} = 'interested')`,
    }).from(leadSourcesTable).where(eq(leadSourcesTable.userId, userId)),
    db.select({
      pending: sql<number>`count(*) filter (where ${followUpJobsTable.status} = 'pending')`,
      sent:    sql<number>`count(*) filter (where ${followUpJobsTable.status} = 'sent')`,
    }).from(followUpJobsTable).where(eq(followUpJobsTable.userId, userId)),
    db.select({ n: count() }).from(knowledgeBaseTable).where(eq(knowledgeBaseTable.userId, userId)),
    db.select({ n: count() }).from(unsubscribedPhonesTable).where(eq(unsubscribedPhonesTable.userId, userId)),
    getDailySentCount(userId),
    getEffectiveDailyLimit(userId),
  ]);

  const c = campaignStats[0], ct = contactStats[0], w = sentWeek[0], l = leadStats[0], f = followUps[0];
  const em = await emailOverview(userId).catch(() => null);
  const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
  const weekSent = Number(w?.sent ?? 0);

  return [
    profile?.name ? `النشاط: ${profile.name}${profile.industry ? ` — ${profile.industry}` : ""}` : "",
    profile?.description ? `الوصف: ${profile.description}` : "",
    "",
    `واتساب: ${wa?.connected ? "متصل" : "غير متصل"}`,
    `الحصة اليوم: ${dailyUsed} من ${dailyLimit} (متبقٍ ${Math.max(0, dailyLimit - dailyUsed)})`,
    "",
    `الحملات: ${c?.total ?? 0} إجمالاً — ${c?.running ?? 0} تعمل، ${c?.paused ?? 0} متوقفة، ${c?.done ?? 0} مكتملة`,
    `القوائم: ${ct?.groups ?? 0} قائمة تضم ${ct?.contacts ?? 0} رقماً`,
    `آخر 7 أيام: أُرسلت ${weekSent}، فشلت ${w?.failed ?? 0}، وصلت ${w?.delivered ?? 0} (${pct(Number(w?.delivered ?? 0), weekSent)})، قُرئت ${w?.read ?? 0} (${pct(Number(w?.read ?? 0), weekSent)})`,
    `العملاء: ${l?.total ?? 0} — منهم ${l?.ad ?? 0} من إعلانات و${l?.hot ?? 0} مهتمون`,
    `المتابعات: ${f?.pending ?? 0} مجدولة، ${f?.sent ?? 0} أُرسلت`,
    `قاعدة المعرفة: ${kbCount[0]?.n ?? 0} عنصراً · ألغوا الاشتراك: ${optOuts[0]?.n ?? 0}`,
    em ? `البريد (٧ أيام): أُرسل ${em.week.sent}، فتح ${em.week.openRate ?? "—"}%، رد ${em.week.replyRate ?? "—"}%، ارتداد ${em.week.bounceRate ?? "—"}% · جهات اتصال نشطة ${em.contacts.active} · في الطابور ${em.queue.queued}${em.configured ? "" : " · (المُرسِل غير مضبوط)"}` : "",
  ].filter(Boolean).join("\n");
}

function systemPrompt(context: string): string {
  return [
    "أنت مساعد داخلي لصاحب نشاط يستخدم منصة «واتساب ماركتر» لإدارة حملاته على واتساب.",
    "أنت تتحدث إلى صاحب النشاط نفسه أو موظفيه، لا إلى عملائه.",
    "",
    "أسلوبك: مباشر وعملي وبالعربية. أجب باختصار ما لم يُطلب التفصيل.",
    "",
    "قواعد:",
    "- الأرقام أدناه حقيقية من حسابه الآن. استند إليها ولا تخترع رقماً غيرها.",
    "- إن سُئلت عن شيء لا تعرفه من هذه البيانات، قل ذلك صراحة واقترح أين يجده في المنصة.",
    "- حين تنصح بشأن الحظر أو الإرسال، تذكّر أن جودة القائمة وموافقة أصحابها أهم بكثير من سرعة الإرسال.",
    "",
    "الوضع الحالي للحساب:",
    context,
  ].join("\n");
}

export async function listThreads(userId: number) {
  return db.select().from(assistantThreadsTable)
    .where(eq(assistantThreadsTable.userId, userId))
    .orderBy(desc(assistantThreadsTable.updatedAt)).limit(50);
}

export async function getThreadMessages(userId: number, threadId: number) {
  return db.select().from(assistantMessagesTable)
    .where(and(eq(assistantMessagesTable.userId, userId), eq(assistantMessagesTable.threadId, threadId)))
    .orderBy(assistantMessagesTable.createdAt);
}

export interface ChatResult {
  threadId: number;
  reply: string | null;
  provider: string;
  error?: string;
}

/**
 * Continue (or start) a thread.
 *
 * The whole thread is stored, but only the last HISTORY_TURNS are replayed —
 * enough for the assistant to follow the conversation without every request
 * growing until the model refuses it.
 */
export async function chat(userId: number, threadId: number | null, message: string): Promise<ChatResult> {
  let tid = threadId;
  const [thread] = tid
    ? await db.select().from(assistantThreadsTable).where(and(eq(assistantThreadsTable.id, tid), eq(assistantThreadsTable.userId, userId))).limit(1)
    : [];
  if (tid && !thread) tid = null;
  if (!tid) {
    const [t] = await db.insert(assistantThreadsTable).values({
      userId,
      // Named from the opening line, which is almost always what it is about.
      title: message.slice(0, 60) + (message.length > 60 ? "…" : ""),
    }).returning();
    tid = t!.id;
  }

  await db.insert(assistantMessagesTable).values({ threadId: tid, userId, role: "user", content: message });

  const provider = activeProvider();
  if (provider === "none") {
    return {
      threadId: tid, reply: null, provider,
      error: "لا يوجد نموذج مضبوط. أضف مفتاحاً مجانياً في .env — الخيارات في صفحة «معرفة البوت».",
    };
  }

  const history = await getThreadMessages(userId, tid);

  // The interview is the manager asking the owner about the business; the
  // ordinary assistant is the owner asking about the account. Different
  // prompt, different ending: the interview closes by writing the profile
  // and the knowledge entries, and the code reads them out of the reply.
  const interviewing = thread?.kind === INTERVIEW_KIND;
  let system: string;
  if (interviewing) {
    const answered = history.filter((m) => m.role === "user").length;   // includes this message
    const finishing = STOP.test(message) || answered > QUESTIONS.length;
    system = interviewPrompt(await managerFor(userId), Math.min(answered, QUESTIONS.length), finishing);
  } else {
    system = systemPrompt(await buildContext(userId));
  }

  const out = await asWorker(userId, "assistant", () => complete([
    { role: "system", content: system },
    ...history.slice(-HISTORY_TURNS).map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    })),
  ], interviewing ? 60_000 : 30_000));

  if (!out?.text) {
    return { threadId: tid, reply: null, provider, error: "النموذج لم يستجب — جرّب مرة أخرى أو بدّل المزوّد." };
  }

  let reply = out.text;
  if (interviewing) {
    const h = harvest(reply);
    if (h && (h.entries.length || Object.keys(h.profile).length)) {
      const done = await applyHarvest(userId, h);
      await db.update(assistantThreadsTable).set({ kind: INTERVIEW_DONE }).where(eq(assistantThreadsTable.id, tid));
      reply = [
        `كتبتُ ${done.entries} مدخلاً في قاعدة المعرفة وحدّثت ${done.profileFields} من حقول الملف.`,
        "راجعها في صفحة «معرفة البوت» وعدّل ما تشاء — ثم فعّل الرد التلقائي من هناك حين تكون جاهزاً.",
        "",
        reply.replace(/\[الملف\][\s\S]*?\[\/الملف\]/, "").replace(/\[معرفة\][\s\S]*?\[\/معرفة\]/, "").trim(),
      ].filter(Boolean).join("\n");
    }
  }

  await db.insert(assistantMessagesTable).values({
    threadId: tid, userId, role: "assistant", content: reply, provider: out.provider,
  });
  await db.update(assistantThreadsTable).set({ updatedAt: new Date() }).where(eq(assistantThreadsTable.id, tid));

  logger.info({ userId, threadId: tid, provider: out.provider, interviewing }, "assistant replied");
  return { threadId: tid, reply, provider: out.provider };
}

export async function deleteThread(userId: number, threadId: number) {
  await db.delete(assistantThreadsTable)
    .where(and(eq(assistantThreadsTable.id, threadId), eq(assistantThreadsTable.userId, userId)));
}
