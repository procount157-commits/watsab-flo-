// ── The data collector ────────────────────────────────────────────
// Who actually read what was sent them, and who is worth chasing.
//
// The account already knew this and had no way to say it: every message
// carries a delivery and a read receipt, and all that was ever done with them
// was a per-campaign percentage. A person who opened three messages and
// answered none is the most interesting contact on the list — more interesting
// than one who never opened anything — and nothing was looking for them.
//
// The segments are computed, not guessed. A model writes the covering note for
// the report; it does not decide who belongs where, because "read but silent"
// is a fact about receipts and inventing it would be worse than useless.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db, messageLogs, campaignsTable, waThreadMessagesTable, contactSegmentsTable,
  unsubscribedPhonesTable, leadSourcesTable, botEmployeesTable,
  type ContactSegment,
} from "@workspace/db";
import { complete } from "./llm";
import { notify, esc, linkedUsers } from "./telegram";
import { say } from "./agent-comms";
import { logger } from "./logger";
import { skillsFor, skillsPreamble } from "./agent-skills";
import { asWorker } from "./agent-context";
import { accountHalted } from "./org/controls";

export const COLLECTOR_ROLE = "collector";

export type Segment =
  | "hot"          // read, and replied — a live conversation
  | "warm"         // read more than once, never replied — the valuable one
  | "curious"      // read once, never replied
  | "delivered"    // arrived, never opened
  | "unreachable"  // could not be delivered at all
  | "refused";     // asked to stop, or said no

export const SEGMENT_AR: Record<Segment, string> = {
  hot:         "مهتم ويتحدث",
  warm:        "يقرأ ولا يرد",
  curious:     "فتح الرسالة مرة",
  delivered:   "وصلته ولم يفتح",
  unreachable: "لا تصله الرسائل",
  refused:     "رفض أو طلب الإيقاف",
};

export type ContactFacts = {
  phone: string;
  sent: number; delivered: number; read: number; replied: number;
  lastReadAt: Date | null; lastReplyAt: Date | null;
  refused: boolean;
};

/**
 * Sort one contact.
 *
 * Pure, so the rules can be argued with and tested without a database. The
 * score is what orders a follow-up list, and its shape is the whole opinion of
 * this agent: repeated opens without a reply beat a single open, a recent open
 * beats an old one, and someone already talking to you does not need chasing.
 */
export function classify(f: ContactFacts, now = Date.now()): { segment: Segment; score: number; reason: string } {
  if (f.refused) {
    return { segment: "refused", score: 0, reason: "طلب الإيقاف أو رفض صراحةً — لا يُتابَع" };
  }
  if (f.replied > 0) {
    // Already in a conversation. Low chase score is not low value: someone is
    // talking to them, and a nudge on top of that reads as pestering.
    return { segment: "hot", score: 20, reason: `ردّ ${f.replied} مرة — المحادثة قائمة` };
  }
  if (f.sent > 0 && f.delivered === 0) {
    return { segment: "unreachable", score: 0, reason: "لم تصل أي رسالة — الرقم غالباً غير مسجّل على واتساب" };
  }
  if (f.read === 0) {
    return { segment: "delivered", score: 10, reason: "وصلت ولم تُفتح" };
  }

  // Read, never replied. The interesting case.
  const daysSinceRead = f.lastReadAt ? (now - f.lastReadAt.getTime()) / 86_400_000 : 99;

  // Opens are the signal, and the second open says far more than the first:
  // one can be a notification glance, two is someone coming back to it.
  let score = 40 + Math.min(35, (f.read - 1) * 18);
  // Recency, because interest decays. A month-old open is not a lead.
  if (daysSinceRead <= 1) score += 25;
  else if (daysSinceRead <= 3) score += 15;
  else if (daysSinceRead <= 7) score += 8;
  else if (daysSinceRead > 30) score -= 20;

  score = Math.max(0, Math.min(100, Math.round(score)));

  const when = daysSinceRead <= 1 ? "اليوم"
    : daysSinceRead <= 7 ? `قبل ${Math.round(daysSinceRead)} أيام`
    : `قبل ${Math.round(daysSinceRead / 7)} أسابيع`;

  return f.read >= 2
    ? { segment: "warm", score, reason: `فتح الرسائل ${f.read} مرات ولم يرد — آخر فتح ${when}` }
    : { segment: "curious", score, reason: `فتح الرسالة مرة ولم يرد — ${when}` };
}

/** Everything the receipts say, per contact. */
async function collectFacts(userId: number): Promise<ContactFacts[]> {
  const rows = await db.select({
    phone:      messageLogs.phone,
    sent:       sql<number>`count(*) filter (where ${messageLogs.sentAt} is not null)`,
    delivered:  sql<number>`count(*) filter (where ${messageLogs.deliveredAt} is not null)`,
    read:       sql<number>`count(*) filter (where ${messageLogs.readAt} is not null)`,
    lastReadAt: sql<Date | null>`max(${messageLogs.readAt})`,
  }).from(messageLogs)
    .innerJoin(campaignsTable, eq(messageLogs.campaignId, campaignsTable.id))
    .where(eq(campaignsTable.userId, userId))
    .groupBy(messageLogs.phone);

  const [replies, refusals] = await Promise.all([
    db.select({
      phone: waThreadMessagesTable.phone,
      n: sql<number>`count(*)`,
      last: sql<Date | null>`max(${waThreadMessagesTable.createdAt})`,
    }).from(waThreadMessagesTable)
      .where(and(eq(waThreadMessagesTable.userId, userId), eq(waThreadMessagesTable.fromMe, false)))
      .groupBy(waThreadMessagesTable.phone),
    db.select({ phone: unsubscribedPhonesTable.phone }).from(unsubscribedPhonesTable)
      .where(eq(unsubscribedPhonesTable.userId, userId)),
  ]);

  const replyBy = new Map(replies.map((r) => [r.phone, r]));
  const refusedSet = new Set(refusals.map((r) => r.phone));
  // Someone who said "not interested" without formally opting out should not
  // be chased either, and lead_sources is where that verdict is recorded.
  const cold = await db.select({ phone: leadSourcesTable.phone }).from(leadSourcesTable)
    .where(and(eq(leadSourcesTable.userId, userId), eq(leadSourcesTable.lastIntent, "not_interested")));
  for (const c of cold) refusedSet.add(c.phone);

  return rows.map((r) => {
    const rep = replyBy.get(r.phone);
    return {
      phone: r.phone,
      sent: Number(r.sent), delivered: Number(r.delivered), read: Number(r.read),
      replied: Number(rep?.n ?? 0),
      lastReadAt: r.lastReadAt ? new Date(r.lastReadAt) : null,
      lastReplyAt: rep?.last ? new Date(rep.last) : null,
      refused: refusedSet.has(r.phone),
    };
  });
}

/** Re-sort everyone and write it down. Returns the new distribution. */
export async function reassess(userId: number): Promise<Record<Segment, number>> {
  const facts = await collectFacts(userId);
  const counts = Object.fromEntries(Object.keys(SEGMENT_AR).map((k) => [k, 0])) as Record<Segment, number>;
  if (facts.length === 0) return counts;

  const now = Date.now();
  const rows = facts.map((f) => {
    const c = classify(f, now);
    counts[c.segment]++;
    return {
      userId, phone: f.phone, segment: c.segment, reason: c.reason, score: c.score,
      sent: f.sent, delivered: f.delivered, read: f.read, replied: f.replied,
      lastReadAt: f.lastReadAt, lastReplyAt: f.lastReplyAt, assessedAt: new Date(),
    };
  });

  // In chunks: a few thousand contacts in one statement exceeds the parameter
  // limit, and this runs against the whole list every night.
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(contactSegmentsTable).values(rows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [contactSegmentsTable.userId, contactSegmentsTable.phone],
        set: {
          segment: sql`excluded.segment`, reason: sql`excluded.reason`, score: sql`excluded.score`,
          sent: sql`excluded.sent`, delivered: sql`excluded.delivered`,
          read: sql`excluded.read`, replied: sql`excluded.replied`,
          lastReadAt: sql`excluded.last_read_at`, lastReplyAt: sql`excluded.last_reply_at`,
          assessedAt: sql`excluded.assessed_at`,
        },
      });
  }
  return counts;
}

/** Who to chase, best first. */
export async function chaseList(userId: number, limit = 10): Promise<ContactSegment[]> {
  return db.select().from(contactSegmentsTable)
    .where(and(
      eq(contactSegmentsTable.userId, userId),
      sql`${contactSegmentsTable.segment} in ('warm','curious')`,
    ))
    .orderBy(desc(contactSegmentsTable.score))
    .limit(limit);
}

const pad = (n: number) => String(n).padStart(3, " ");

/** The morning report, as Telegram HTML. */
export async function buildReport(userId: number): Promise<string> {
  const counts = await reassess(userId);
  const chase = await chaseList(userId, 8);
  const yesterday = new Date(Date.now() - 24 * 60 * 60_000);

  const [[fresh]] = await Promise.all([
    db.select({
      read:    sql<number>`count(*) filter (where ${messageLogs.readAt} >= ${yesterday})`,
      replied: sql<number>`count(distinct ${messageLogs.phone}) filter (where ${messageLogs.readAt} >= ${yesterday})`,
    }).from(messageLogs)
      .innerJoin(campaignsTable, eq(messageLogs.campaignId, campaignsTable.id))
      .where(eq(campaignsTable.userId, userId)),
  ]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const lines = [
    "<b>📊 تقرير جامع البيانات</b>",
    `<i>${new Date().toLocaleDateString("ar-AE", { timeZone: "Asia/Dubai", dateStyle: "full" })}</i>`,
    "",
    `إجمالي من تواصلنا معهم: <b>${total}</b>`,
    `فتحوا رسائلهم خلال ٢٤ ساعة: <b>${Number(fresh?.read ?? 0)}</b>`,
    "",
    "<b>التصنيف:</b>",
    ...(Object.entries(counts) as Array<[Segment, number]>)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `<code>${pad(n)}</code>  ${esc(SEGMENT_AR[k])}`),
  ];

  if (chase.length > 0) {
    lines.push("", "<b>🎯 الأولى بالمتابعة اليوم:</b>");
    for (const c of chase) {
      lines.push(`<code>${c.score}</code> <b>${esc(c.phone)}</b> — ${esc(c.reason ?? "")}`);
    }
  } else {
    lines.push("", "لا أحد يستحق متابعة اليوم — إما أن الجميع يتحدثون بالفعل أو لم يفتح أحد شيئاً.");
  }

  // A covering line, because a table of numbers does not say what changed.
  const [emp] = await db.select().from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, COLLECTOR_ROLE))).limit(1);

  const trade = skillsPreamble(await skillsFor(userId, COLLECTOR_ROLE, "internal").catch(() => []));
  const note = await asWorker(userId, COLLECTOR_ROLE, () => complete([
    { role: "system", content: [
      emp ? `أنت ${emp.name}${emp.title ? `، ${emp.title}` : ""}.` : "أنت محلل بيانات.",
      emp?.persona ?? "",
      trade,
      "اكتب سطرين بالعربية يلخّصان ما يعنيه هذا التقرير عملياً لصاحب العمل، وما أهم شيء يفعله اليوم.",
      "لا تكرر الأرقام كما هي — اشرح دلالتها. لا تستخدم HTML ولا رموزاً.",
    ].filter(Boolean).join("\n") },
    { role: "user", content: lines.join("\n").replace(/<[^>]+>/g, "") },
  ], 15_000)).catch(() => null);

  if (note?.text) lines.push("", `💬 ${esc(note.text.trim())}`);
  return lines.join("\n");
}

/** One full round: re-sort, report, and tell the team who to chase. */
export async function runCollector(userId: number) {
  const report = await buildReport(userId);
  const sent = await notify(userId, report);

  const chase = await chaseList(userId, 5);
  if (chase.length > 0) {
    await say({
      userId, fromRole: COLLECTOR_ROLE, toRole: "chief", kind: "report",
      body: ["الأولى بالمتابعة اليوم:",
        ...chase.map((c) => `- ${c.phone} (${c.score}) ${c.reason ?? ""}`)].join("\n"),
    }).catch(() => {});
  }

  logger.info({ userId, telegram: sent, chase: chase.length }, "جامع البيانات أنهى جولة");
  return { report, sent, chase };
}

/**
 * Once a day, in the morning.
 *
 * The sweep runs hourly and the report is gated on the hour, rather than a
 * timer set for 07:00: a process restarted at 07:30 would otherwise skip the
 * day entirely.
 */
export function startCollector(): void {
  const REPORT_HOUR = 8;   // Gulf time
  let lastReportDay = "";

  const sweep = async () => {
    const now = new Date();
    const gulf = new Date(now.getTime() + 4 * 60 * 60_000);
    const day = gulf.toISOString().slice(0, 10);
    if (gulf.getUTCHours() !== REPORT_HOUR || day === lastReportDay) return;
    lastReportDay = day;

    for (const userId of await linkedUsers()) {
      if (await accountHalted(userId, "collector")) continue;
      await runCollector(userId).catch((err) =>
        logger.error({ userId, err: String(err?.message ?? err) }, "فشلت جولة جامع البيانات"));
    }
  };

  setTimeout(() => { void sweep(); setInterval(() => void sweep(), 30 * 60_000); }, 4 * 60_000);
  logger.info({ hour: REPORT_HOUR }, "جامع البيانات بدأ");
}
