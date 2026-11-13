// ── Campaigns, the queue, the ladder, and the events ─────────────
// One queue per account: campaigns and sequences both enqueue rows into
// email_messages and a single worker drains them at the account's pace —
// hourly and daily caps, sending hours, a jittered gap, and whatever the
// deliverability verdict says on top. Every send, open, click, reply,
// bounce and unsubscribe is an event row, and the counters on the campaign
// are derived from those rather than trusted.

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  db, emailSettingsTable, emailContactsTable, emailListsTable, emailListMembersTable,
  emailCampaignsTable, emailSequencesTable, emailSequenceJobsTable, emailMessagesTable,
  emailEventsTable, emailSegmentsTable, type EmailSettings, type EmailStep, type EmailContact,
} from "@workspace/db";
import { resolve as resolveSegment } from "./segments";
import { isEmailSendingTime, emailWindowNote } from "../sending-hours";
import { isRoleAddress } from "./importer";
import { logger } from "../logger";
import { notify, esc } from "../telegram";
import { sendEmail, SendError, EmailHalted, EmailSuppressed, isConfigured, messageIdFor } from "./provider";
import { accountHalted, isHalted, platformHalted } from "../org/controls";
import { newToken, renderEmail, firstName, companyName, personalize, unsubscribeUrl } from "./tracking";
import { publicBase, durable } from "./public-url";
import { brandOf } from "./layout";
import { asLanguage, matchesLanguage, wrongLanguage } from "./language";
import { assessEmail, sendGapMs, warmupCap, splitAb, pickWinner, type EmailVerdict } from "./health";
import { byRisk, domainSignals, verifyDomains, holdRiskyQueued } from "./hygiene";
import { activity } from "./team";
import { afterSend, awaitingVerdict, beforeSend } from "./bounce-guard";
import { pickSender, markSent, markBroken, holdBouncingSenders, capacityToday } from "./senders";
import { receipt } from "../graph/receipts";
import { beat, runAs } from "../org/runtime";
import { handoffDeliveryFailure } from "../org/handoffs";
import { INELIGIBLE_AR, domainsInOtherCampaigns, notBlockedByDesk, notFromDeadMission, notHeldStale, staleIneligible, staleMessage } from "../org/queue";
import { everyMs } from "../org/workers";

/**
 * العنوان العام لم يكن يُقرأ إلا من البيئة، ولم تكن للواجهة سبيلٌ إليه —
 * فظلّ فارغاً، وخرجت ٥٦٠ رسالةً بلا بكسلٍ ولا رابطٍ متتبَّع، وبقي
 * «الفتحات: ٠» يُقرأ نتيجةً وهو غياب قياس. الآن الإعداد أولاً.
 */
const SECRET   = () => process.env["SESSION_SECRET"] ?? "wam";

// ── Settings ──────────────────────────────────────────────────────
export async function getSettings(userId: number): Promise<EmailSettings | null> {
  const [s] = await db.select().from(emailSettingsTable).where(eq(emailSettingsTable.userId, userId)).limit(1);
  return s ?? null;
}

// ── Events ────────────────────────────────────────────────────────
export type EventType = "open" | "click" | "reply" | "bounce" | "unsubscribe" | "complaint" | "sent" | "failed";

export async function recordEvent(userId: number, messageId: number | null, type: EventType, extra: { url?: string; meta?: Record<string, unknown> } = {}) {
  await db.insert(emailEventsTable).values({ userId, messageId, type, url: extra.url ?? null, meta: extra.meta ?? {} });
  if (!messageId) return;

  const [m] = await db.select().from(emailMessagesTable).where(eq(emailMessagesTable.id, messageId)).limit(1);
  if (!m) return;
  const now = new Date();
  const counter = { open: "openCount", click: "clickCount", reply: "replyCount", bounce: "bounceCount", unsubscribe: "unsubCount" } as const;

  if (type === "open") {
    await db.update(emailMessagesTable).set({ openedAt: m.openedAt ?? now, openCount: sql`${emailMessagesTable.openCount} + 1` }).where(eq(emailMessagesTable.id, messageId));
    if (m.contactId) await db.update(emailContactsTable).set({ lastOpenedAt: now }).where(eq(emailContactsTable.id, m.contactId));
    if (m.campaignId && !m.openedAt) await db.update(emailCampaignsTable).set({ openCount: sql`${emailCampaignsTable.openCount} + 1` }).where(eq(emailCampaignsTable.id, m.campaignId));
    // A sequence that stops on open.
    if (m.sequenceJobId && !m.openedAt) await stopSequenceIf(m.sequenceJobId, "stopOnOpen", "فتح الرسالة");
  } else if (type === "click") {
    await db.update(emailMessagesTable).set({ clickedAt: m.clickedAt ?? now, clickCount: sql`${emailMessagesTable.clickCount} + 1`, openedAt: m.openedAt ?? now }).where(eq(emailMessagesTable.id, messageId));
    if (m.campaignId && !m.clickedAt) await db.update(emailCampaignsTable).set({ clickCount: sql`${emailCampaignsTable.clickCount} + 1` }).where(eq(emailCampaignsTable.id, m.campaignId));
    // A person who clicked is warm now, not in a week: her next rung comes
    // within a day. The 48-hour gap between any two mails still holds.
    if (m.contactId && !m.clickedAt) await pullNextRung(userId, m.contactId, CLICK_PULL_HOURS).catch(() => {});
  } else if (type === "reply") {
    await db.update(emailMessagesTable).set({ repliedAt: m.repliedAt ?? now }).where(eq(emailMessagesTable.id, messageId));
    if (m.contactId) await db.update(emailContactsTable).set({ lastRepliedAt: now }).where(eq(emailContactsTable.id, m.contactId));
    if (m.campaignId && !m.repliedAt) await db.update(emailCampaignsTable).set({ replyCount: sql`${emailCampaignsTable.replyCount} + 1` }).where(eq(emailCampaignsTable.id, m.campaignId));
    if (m.contactId) await cancelSequencesFor(userId, m.contactId, "ردّ على البريد");
  } else if (type === "bounce" || type === "complaint") {
    await db.update(emailMessagesTable).set({ status: "bounced", bouncedAt: now }).where(eq(emailMessagesTable.id, messageId));
    if (m.contactId) {
      await db.update(emailContactsTable).set({ status: type === "bounce" ? "bounced" : "complained" }).where(eq(emailContactsTable.id, m.contactId));
      await cancelSequencesFor(userId, m.contactId, type === "bounce" ? "ارتدّ البريد" : "بلّغ عن إزعاج");
    }
    if (m.campaignId) await db.update(emailCampaignsTable).set({ bounceCount: sql`${emailCampaignsTable.bounceCount} + 1` }).where(eq(emailCampaignsTable.id, m.campaignId));
  } else if (type === "unsubscribe") {
    if (m.contactId) {
      await db.update(emailContactsTable).set({ status: "unsubscribed" }).where(eq(emailContactsTable.id, m.contactId));
      await cancelSequencesFor(userId, m.contactId, "ألغى الاشتراك");
    }
    if (m.campaignId) await db.update(emailCampaignsTable).set({ [counter.unsubscribe]: sql`${emailCampaignsTable.unsubCount} + 1` }).where(eq(emailCampaignsTable.id, m.campaignId));
  }
}

export const CLICK_PULL_HOURS = 24;

/** The contact's next pending rung brought forward to within `hours`, if it was later. */
export async function pullNextRung(userId: number, contactId: number, hours: number): Promise<boolean> {
  const r = await db.execute(sql`UPDATE email_sequence_jobs SET due_at = now() + make_interval(hours => ${hours})
    WHERE id = (SELECT id FROM email_sequence_jobs WHERE user_id = ${userId} AND contact_id = ${contactId} AND status = 'pending' ORDER BY due_at LIMIT 1)
      AND due_at > now() + make_interval(hours => ${hours})`);
  return (r.rowCount ?? 0) > 0;
}

/**
 * The thread a follow-up joins: every mail already sent to this contact with
 * a Message-ID, oldest first. The subject is the first one's with «Re:».
 */
export async function threadFor(userId: number, contactId: number, exceptId: number, sequenceJobId?: number | null): Promise<{ subject: string; inReplyTo: string; references: string[] } | null> {
  // تسلسلات مكتب الحسابات رسالةٌ شخصية جديدة: خيطها رسائلها هي فقط، لا حملةٌ قديمة وصلت info@ نفسه.
  const own = sequenceJobId ? (await db.execute<{ id: number }>(sql`SELECT s.id FROM email_sequence_jobs j JOIN email_sequences s ON s.id = j.sequence_id
    WHERE j.id = ${sequenceJobId} AND s.name LIKE ${ACCOUNTS_SEQUENCE_PREFIX + "%"}`)).rows[0]?.id ?? null : null;
  const prev = await db.select({ hdr: emailMessagesTable.messageIdHdr, subject: emailMessagesTable.subject }).from(emailMessagesTable)
    .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.contactId, contactId), eq(emailMessagesTable.status, "sent"),
      sql`${emailMessagesTable.messageIdHdr} is not null`, sql`${emailMessagesTable.id} <> ${exceptId}`,
      own ? sql`${emailMessagesTable.sequenceJobId} in (select id from email_sequence_jobs where sequence_id = ${own})` : sql`true`))
    .orderBy(asc(emailMessagesTable.sentAt)).limit(20);
  if (!prev.length) return null;
  return { subject: replySubject(prev[0]!.subject), inReplyTo: prev[prev.length - 1]!.hdr!, references: prev.map((p) => p.hdr!) };
}

/** اسم كل تسلسلٍ ينشئه مكتب الحسابات المستهدفة يبدأ به (lib/accounts/pipeline.ts). */
export const ACCOUNTS_SEQUENCE_PREFIX = "مكتب الحسابات · ";

/** «Re: » once, however many times the subject has been answered. Pure. */
export function replySubject(subject: string): string {
  return `Re: ${subject.replace(/^\s*((re|fwd?|رد)\s*:\s*)+/i, "").trim()}`;
}

export async function messageByToken(token: string) {
  const [m] = await db.select().from(emailMessagesTable).where(eq(emailMessagesTable.token, token)).limit(1);
  return m ?? null;
}

// ── Campaigns ─────────────────────────────────────────────────────
/** Queue a campaign: one message per active member of its list. */
export async function startCampaign(userId: number, campaignId: number): Promise<{ queued: number; skipped: number }> {
  const [c] = await db.select().from(emailCampaignsTable)
    .where(and(eq(emailCampaignsTable.id, campaignId), eq(emailCampaignsTable.userId, userId))).limit(1);
  if (!c) throw new Error("الحملة غير موجودة");
  // The owner's rule, before anything else: email goes out in English.
  if (![c.html, c.subject, c.subjectB ?? ""].every((t) => matchesLanguage(t, asLanguage(c.language)))) throw new Error(wrongLanguage(asLanguage(c.language)));
  if (!c.listId && !c.segmentId) throw new Error("الحملة بلا قائمة ولا جمهور");
  // The owner resuming a campaign the checkpoint held: his decision — the rest goes with the current subject.
  if (c.lowOpenAt || c.abRound > 0) {
    await db.update(emailMessagesTable).set({ status: "queued", subject: c.subject, variant: null })
      .where(and(eq(emailMessagesTable.campaignId, c.id), eq(emailMessagesTable.status, "ab_hold")));
    await db.update(emailCampaignsTable).set({ lowOpenAt: null, abWinner: c.abWinner ?? "A", abDecidedAt: c.abDecidedAt ?? new Date() }).where(eq(emailCampaignsTable.id, c.id));
  }
  const s = await getSettings(userId);
  if (!isConfigured(s)) throw new Error("إعدادات البريد غير مكتملة — اضبط المُرسِل أولاً");

  // A list, or a saved audience resolved now — so a segment is who matches
  // on the day the campaign starts, not when it was drawn up.
  let members: Array<{ c: EmailContact }>;
  if (c.segmentId) {
    const [seg] = await db.select().from(emailSegmentsTable).where(eq(emailSegmentsTable.id, c.segmentId)).limit(1);
    members = (await resolveSegment(userId, (seg?.filter ?? {}) as any)).map((x) => ({ c: x }));
  } else {
    members = await db.select({ c: emailContactsTable }).from(emailListMembersTable)
      .innerJoin(emailContactsTable, eq(emailContactsTable.id, emailListMembersTable.contactId))
      .where(eq(emailListMembersTable.listId, c.listId!));
  }

  // One message per contact per campaign — a resume must not double up.
  const already = new Set((await db.select({ contactId: emailMessagesTable.contactId }).from(emailMessagesTable)
    .where(eq(emailMessagesTable.campaignId, c.id))).map((r) => r.contactId));

  // Every domain is looked up before its first send, not only those imported
  // after the check existed — then the riskiest addresses are held back and
  // the rest go lowest-risk first (see hygiene.ts).
  const unverified = members.map((m) => m.c).filter((x) => x.status === "active" && !inTruce(x) && x.mxOk == null && !already.has(x.id)).map((x) => x.id);
  if (unverified.length) {
    await verifyDomains(userId, unverified, { maxDomains: 800 }).catch(() => null);
    const fresh = new Map((await db.select({ id: emailContactsTable.id, mxOk: emailContactsTable.mxOk }).from(emailContactsTable).where(inArray(emailContactsTable.id, unverified))).map((r) => [r.id, r.mxOk]));
    for (const m of members) if (fresh.has(m.c.id)) m.c.mxOk = fresh.get(m.c.id) ?? null;
  }
  let queued = 0, skipped = 0;
  const batch: Array<typeof emailMessagesTable.$inferInsert> = [];
  const sendable = members.map((m) => m.c).filter((contact) => {
    const ok = contact.status === "active" && !inTruce(contact) && contact.mxOk !== false && !already.has(contact.id);
    if (!ok) skipped++;
    return ok;
  });
  const { kept: ranked, held: risky } = byRisk(sendable, await domainSignals(userId), s!.skipRisky);
  skipped += risky;
  // عنوانٌ واحد لكل شركة في الموجة: ٣٦٪ من الجهات عناوين دور، وكثيرٌ من
  // الشركات لها ثلاثة وأربعة عناوين — وثلاث رسائل في أسبوعٍ على نطاقٍ واحد
  // تُقرأ إزعاجاً لا اهتماماً. الباقون ينتظرون حملةً تالية.
  const { kept: oneEach, dropped: extras } = onePerCompany(ranked);
  skipped += extras;
  // ولا شركةٌ في حملتين نشطتين: لها دورها في الموجة التالية، بعد أن تنتهي الأولى.
  const elsewhere = await domainsInOtherCampaigns(userId, c.id);
  const eligible = oneEach.filter((x) => !elsewhere.has(companyDomain(x.email) ?? ""));
  skipped += oneEach.length - eligible.length;

  // A subject test on a slice of the list, the rest held until it is decided.
  // Only on a fresh start: a resumed campaign has already made its choice.
  const testing = !!c.subjectB && c.abPct > 0 && !c.abWinner && already.size === 0;
  const split = testing ? splitAb(eligible.length, c.abPct) : { a: eligible.length, b: 0, held: 0 };
  // Variants are drawn at random, so risk does not bias the test; the queue itself keeps the low-risk-first order.
  const variantOf = new Map((testing ? [...eligible].sort(() => Math.random() - 0.5) : eligible).map((x, i) => [x.id, i]));
  eligible.forEach((contact) => {
    const i = variantOf.get(contact.id)!;
    const variant = !testing ? null : i < split.a ? "A" : i < split.a + split.b ? "B" : null;
    const held = testing && variant === null;
    batch.push({
      userId, campaignId: c.id, contactId: contact.id, toEmail: contact.email,
      subject: variant === "B" ? c.subjectB! : c.subject, token: newToken(),
      status: held ? "ab_hold" : "queued", variant,
    });
    queued++;
  });
  for (let i = 0; i < batch.length; i += 200) await db.insert(emailMessagesTable).values(batch.slice(i, i + 200));

  await db.update(emailCampaignsTable).set({ status: "sending", startedAt: c.startedAt ?? new Date(), pauseReason: null, pausedBy: null })
    .where(eq(emailCampaignsTable.id, c.id));
  logger.info({ userId, campaignId: c.id, queued, skipped, risky, ab: testing ? split : null }, "حملة بريد بدأت");
  return { queued, skipped, risky, ab: testing ? split : null } as { queued: number; skipped: number; risky: number; ab?: typeof split | null };
}

export async function pauseCampaign(userId: number, campaignId: number, reason: string | null = null) {
  await db.update(emailCampaignsTable).set({ status: "paused", pauseReason: reason, pausedBy: "owner" })
    .where(and(eq(emailCampaignsTable.id, campaignId), eq(emailCampaignsTable.userId, userId)));
}

// ── Sequences ─────────────────────────────────────────────────────
export async function enrolInSequence(userId: number, sequenceId: number, contactIds: number[]): Promise<{ enrolled: number; skipped: number }> {
  const [seq] = await db.select().from(emailSequencesTable)
    .where(and(eq(emailSequencesTable.id, sequenceId), eq(emailSequencesTable.userId, userId))).limit(1);
  if (!seq) throw new Error("التسلسل غير موجود");
  const steps = (seq.steps as EmailStep[]) ?? [];
  if (!steps.length) throw new Error("التسلسل بلا خطوات");

  const contacts = contactIds.length
    ? await db.select().from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), inArray(emailContactsTable.id, contactIds)))
    : [];
  const active = await db.select({ contactId: emailSequenceJobsTable.contactId }).from(emailSequenceJobsTable)
    .where(and(eq(emailSequenceJobsTable.userId, userId), eq(emailSequenceJobsTable.sequenceId, sequenceId), eq(emailSequenceJobsTable.status, "pending")));
  const inFlight = new Set(active.map((a) => a.contactId));

  let enrolled = 0, skipped = 0;
  const rows: Array<typeof emailSequenceJobsTable.$inferInsert> = [];
  const base = Date.now();
  // Spread the first rung over an hour so an import of five hundred does not
  // land as one burst; later rungs keep their offsets.
  for (const c of contacts) {
    if (c.status !== "active" || inTruce(c) || c.mxOk === false || inFlight.has(c.id)) { skipped++; continue; }
    const spread = Math.random() * 60 * 60_000;
    steps.forEach((st, i) => rows.push({
      userId, sequenceId, contactId: c.id, stepIndex: i,
      dueAt: new Date(base + spread + Math.max(0, Number(st.afterHours) || 0) * 3_600_000),
    }));
    enrolled++;
  }
  for (let i = 0; i < rows.length; i += 200) await db.insert(emailSequenceJobsTable).values(rows.slice(i, i + 200));
  logger.info({ userId, sequenceId, enrolled, skipped }, "تسجيل في تسلسل بريد");
  return { enrolled, skipped };
}

const inTruce = (c: { quietUntil?: Date | null }) => !!c.quietUntil && new Date(c.quietUntil) > new Date();

export async function cancelSequencesFor(userId: number, contactId: number, reason: string): Promise<number> {
  const r = await db.update(emailSequenceJobsTable).set({ status: "cancelled", error: reason })
    .where(and(eq(emailSequenceJobsTable.userId, userId), eq(emailSequenceJobsTable.contactId, contactId), eq(emailSequenceJobsTable.status, "pending")))
    .returning({ id: emailSequenceJobsTable.id });
  return r.length;
}

/** Mail providers anyone can have: a reply from one gmail.com address says nothing about another. */
export const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com", "me.com", "aol.com", "msn.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com", "zoho.com", "emirates.net.ae", "eim.ae",
  // من القائمة الحيّة: صناديق شخصية لا شركات (٤٤ عنواناً لـ٤٤ جهة في ymail وحده).
  "ymail.com", "rocketmail.com", "mail.ru", "yandex.ru", "hotmail.co.uk", "yahoo.co.in", "outlook.sa", "gmx.de", "web.de", "rediffmail.com", "qq.com", "163.com"]);

/** The company's domain of an address, or null for a free mailbox. Pure. */
export function companyDomain(email: string): string | null {
  const d = String(email).trim().toLowerCase().split("@")[1] ?? "";
  return d && d.includes(".") && !FREE_MAIL.has(d) ? d : null;
}

/**
 * عنوانٌ واحد لكل نطاق شركة، والبريد الحر معفى. المفضَّل عنوان الدور
 * (info@ …): في هذا الحساب يرتدّ أربع مرات أقل من العناوين الشخصية؛ وإلا
 * فالأول في الترتيب (الأقل خطراً). Pure.
 */
export function onePerCompany<T extends { email: string }>(contacts: T[]): { kept: T[]; dropped: number } {
  const best = new Map<string, number>();
  contacts.forEach((c, i) => {
    const d = companyDomain(c.email);
    if (!d) return;
    const cur = best.get(d);
    if (cur == null || (isRoleAddress(c.email) && !isRoleAddress(contacts[cur]!.email))) best.set(d, i);
  });
  const keep = new Set(best.values());
  const kept = contacts.filter((c, i) => !companyDomain(c.email) || keep.has(i));
  return { kept, dropped: contacts.length - kept.length };
}

/** Every pending rung to anyone at the same company stops, as theirs did. */
export async function stopCompany(userId: number, email: string): Promise<number> {
  const domain = companyDomain(email);
  if (!domain) return 0;
  const r = await db.execute(sql`UPDATE email_sequence_jobs j SET status = 'cancelled', error = ${`زميلٌ في ${domain} ردّ`}
    FROM email_contacts c WHERE c.id = j.contact_id AND j.user_id = ${userId} AND j.status = 'pending'
      AND lower(split_part(c.email, '@', 2)) = ${domain}`);
  return r.rowCount ?? 0;
}

async function stopSequenceIf(jobId: number, flag: "stopOnOpen" | "stopOnReply", reason: string) {
  const [job] = await db.select().from(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.id, jobId)).limit(1);
  if (!job) return;
  const [seq] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, job.sequenceId)).limit(1);
  if (seq?.[flag]) await cancelSequencesFor(job.userId, job.contactId, reason);
}

/**
 * Turn due rungs into queued messages. Runs every minute.
 *
 * Not for an account with no sender: a queue that grows while nothing can
 * leave turns a week of follow-ups into one burst the day the sender is set
 * up. The rungs stay pending until there is a way out.
 */
export async function enqueueDueSequenceSteps(now = new Date(), onlyUserId?: number): Promise<number> {
  if (await platformHalted()) return 0;
  const configured = db.select({ userId: emailSettingsTable.userId }).from(emailSettingsTable)
    .where(sql`${emailSettingsTable.fromEmail} is not null and (${emailSettingsTable.smtpHost} is not null or ${emailSettingsTable.apiKey} is not null)`);
  const due = await db.select().from(emailSequenceJobsTable)
    .where(and(eq(emailSequenceJobsTable.status, "pending"), lt(emailSequenceJobsTable.dueAt, now), inArray(emailSequenceJobsTable.userId, configured),
      onlyUserId ? eq(emailSequenceJobsTable.userId, onlyUserId) : sql`true`))
    .orderBy(asc(emailSequenceJobsTable.dueAt)).limit(200);
  let n = 0;
  for (const job of due) {
    // حسابٌ موقوف: الدرجة تبقى pending، وتُعاد حين يعود، ولا تُحسب متأخرة ولا تُسقط.
    if (await accountHalted(job.userId, "email.sequence")) continue;
    const [seq] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, job.sequenceId)).limit(1);
    const step = ((seq?.steps as EmailStep[]) ?? [])[job.stepIndex];
    const [contact] = await db.select().from(emailContactsTable).where(eq(emailContactsTable.id, job.contactId)).limit(1);
    if (!seq?.isActive || !step || !contact || contact.status !== "active" || inTruce(contact)) {
      await db.update(emailSequenceJobsTable).set({ status: "skipped", error: !seq?.isActive ? "التسلسل موقوف" : !step ? "خطوة غير موجودة" : "جهة الاتصال غير نشطة" })
        .where(eq(emailSequenceJobsTable.id, job.id));
      continue;
    }
    // Anything more than a week overdue is not a follow-up any more.
    if (now.getTime() - new Date(job.dueAt).getTime() > 7 * 24 * 3_600_000) {
      await db.update(emailSequenceJobsTable).set({ status: "skipped", error: "تأخر أكثر من أسبوع" }).where(eq(emailSequenceJobsTable.id, job.id));
      continue;
    }
    const [m] = await db.insert(emailMessagesTable).values({
      userId: job.userId, sequenceJobId: job.id, contactId: contact.id, toEmail: contact.email,
      subject: personalize(step.subject, varsFor(contact)), token: newToken(), status: "queued",
    }).returning({ id: emailMessagesTable.id });
    await db.update(emailSequenceJobsTable).set({ status: "sent", messageId: m!.id }).where(eq(emailSequenceJobsTable.id, job.id));
    n++;
  }
  return n;
}

// ── The worker ────────────────────────────────────────────────────
export function varsFor(c: EmailContact | null, s?: EmailSettings | null): Record<string, string | null | undefined> {
  return {
    // No person's name means no first name: the template's own fallback
    // ("Hello {{first_name|there}}") speaks, not "Hello WEST LEGEND … L.L.C".
    name: c?.name || companyName(c?.company) || "", first_name: firstName(c?.name),
    company: companyName(c?.company), company_legal: c?.company ?? "", email: c?.email ?? "", city: c?.city ?? "", industry: c?.industry ?? "",
    sender: s?.fromName ?? "", sender_email: s?.fromEmail ?? "",
  };
}

const lastSentAt = new Map<number, number>();
const heldUntil  = new Map<number, number>();
/** Accounts whose queue was already swept for risky addresses this process. */
const acted = new Set<number>();

/** The hold is over: what the guard paused goes back to sending. What the owner paused stays. */
export async function liftHold(userId: number) {
  heldUntil.delete(userId);
  acted.delete(userId);
  await db.update(emailSettingsTable).set({ guardHoldUntil: null }).where(eq(emailSettingsTable.userId, userId));
  const r = await db.update(emailCampaignsTable).set({ status: "sending", pauseReason: null, pausedBy: null })
    .where(and(eq(emailCampaignsTable.userId, userId), eq(emailCampaignsTable.status, "paused"), eq(emailCampaignsTable.pausedBy, "guard"))).returning({ id: emailCampaignsTable.id });
  if (r.length) {
    await activity(userId, "email_guard", "resume", `انتهت مهلة الإيقاف — استُؤنفت ${r.length} حملة`).catch(() => {});
    await notify(userId, `<b>📧 استُؤنف إرسال البريد</b>\nانتهت مهلة الحارس واستُؤنفت ${r.length} حملة.`).catch(() => {});
  }
  return r.length;
}

export async function signals(userId: number) {
  // A hold is lifted by time, not re-armed by what caused it: once the guard
  // has held, only what happened after that counts toward the next verdict.
  const [st] = await db.select({ heldAt: emailSettingsTable.guardHeldAt }).from(emailSettingsTable).where(eq(emailSettingsTable.userId, userId)).limit(1);
  const dayAgo = new Date(Date.now() - 24 * 3_600_000);
  const day = st?.heldAt && st.heldAt > dayAgo ? st.heldAt : dayAgo;
  const [[row], [first]] = await Promise.all([
    db.select({
      sent:  sql<number>`count(*) filter (where ${emailEventsTable.type} = 'sent')`,
      bounced: sql<number>`count(*) filter (where ${emailEventsTable.type} = 'bounce')`,
      complaints: sql<number>`count(*) filter (where ${emailEventsTable.type} = 'complaint')`,
      unsub: sql<number>`count(*) filter (where ${emailEventsTable.type} = 'unsubscribe')`,
      opened: sql<number>`count(distinct ${emailEventsTable.messageId}) filter (where ${emailEventsTable.type} = 'open')`,
      replied: sql<number>`count(*) filter (where ${emailEventsTable.type} = 'reply')`,
    }).from(emailEventsTable).where(and(eq(emailEventsTable.userId, userId), gte(emailEventsTable.createdAt, day))),
    db.select({ at: emailMessagesTable.sentAt }).from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.status, "sent"))).orderBy(asc(emailMessagesTable.sentAt)).limit(1),
  ]);
  const ageDays = first?.at ? Math.floor((Date.now() - new Date(first.at).getTime()) / 86_400_000) : 0;
  return {
    sent24h: Number(row?.sent ?? 0), bounced24h: Number(row?.bounced ?? 0), complaints24h: Number(row?.complaints ?? 0),
    unsubscribed24h: Number(row?.unsub ?? 0), opened24h: Number(row?.opened ?? 0), replied24h: Number(row?.replied ?? 0),
    senderAgeDays: ageDays,
  };
}

export async function verdictFor(userId: number): Promise<EmailVerdict> {
  return assessEmail(await signals(userId));
}

// ── لماذا لا يخرج شيء ─────────────────────────────────────────────
// صاحب العمل يرى الطابور ممتلئاً والعدّاد ساكناً ولا يُقال له لماذا. كل
// خروجٍ مبكر من `drainOne` يكتب سبباً قصيراً هنا، وأول إرسالٍ ناجح يمحوه.
const stalls = new Map<number, { why: string; at: number }>();
const stall = (userId: number, why: string): false => { stalls.set(userId, { why, at: Date.now() }); return false; };
/** آخر سببٍ لتوقّف طابور هذا الحساب، أو null إن كان يُرسل. */
export const stallReason = (userId: number) => stalls.get(userId) ?? null;
const holdNote = (until: number) => `إيقاف الحارس حتى ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(until))}`;

/** كم رسالةً تخرج لحساب في مرورٍ واحد: صناديق كثيرة حرّة لا تنتظر عشرين ثانيةً لكل واحدة. */
export const MAX_PER_TICK = 6;

/** One pass over every account with something queued. Runs every 20 s. */
export async function drainQueues(): Promise<void> {
  const accounts = await db.selectDistinct({ userId: emailMessagesTable.userId }).from(emailMessagesTable)
    .where(eq(emailMessagesTable.status, "queued"));
  // العامل مرّ على كل حسابٍ له مُرسِل، ولو لم يجد ما يرسله: طابورٌ فارغ ليس عاملاً ميتاً.
  const seen = new Set(accounts.map((a) => a.userId));
  for (const u of await drainWatched()) if (!seen.has(u)) await beat(u, DRAIN_ROLE, { kind: "drain_empty" });
  // البريد البارد في أيام العمل وساعاتها فقط؛ واتساب له نافذته الخاصة.
  if (!isEmailSendingTime()) {
    for (const { userId } of accounts) { stall(userId, emailWindowNote()); await beat(userId, DRAIN_ROLE, { kind: "drain_off_window" }); }
    return;
  }

  for (const { userId } of accounts) {
    try {
      // رسالةٌ واحدة في المرور كانت تعني ثلاثاً في الدقيقة مهما كثرت
      // الصناديق. الآن نكرّر ما دام صندوقٌ حرٌّ يأخذ رسالة؛ فاصل كل
      // صندوقٍ (markSent) يجعل التكرار التالي يختار غيره أو يتوقف.
      // كل عشرين ثانية: نبضٌ مجمَّع، وسطر تنفيذ كل ربع ساعة على الأكثر. drainOne يسأل المفتاح بنفسه.
      await runAs(userId, DRAIN_ROLE, { kind: "drain", respect: "none", sampleMin: 15 }, async () => {
        for (let i = 0; i < MAX_PER_TICK; i++) if (!(await drainOne(userId))) break;
      });
    } catch (err) { logger.warn({ userId, err: String((err as any)?.message ?? err) }, "فشل مرور طابور البريد"); }
  }
}

const DRAIN_ROLE = "email_queue";
let drainCache: { at: number; ids: number[] } = { at: 0, ids: [] };
/** حساباتٌ لها مُرسِل مضبوط. تُقرأ مرةً كل عشر دقائق، لا مع كل دقّة. */
async function drainWatched(): Promise<number[]> {
  if (Date.now() - drainCache.at < 10 * 60_000) return drainCache.ids;
  const rows = await db.select({ userId: emailSettingsTable.userId }).from(emailSettingsTable).where(sql`${emailSettingsTable.fromEmail} is not null`).catch(() => []);
  drainCache = { at: Date.now(), ids: rows.map((r) => r.userId) };
  return drainCache.ids;
}

/** الرسالة التالية في طابور هذا الحساب، أو لا شيء. كل ما يمنع رسالةً من الخروج الآن هنا. */
export async function nextQueued(userId: number) {
  const deskHalted = (await isHalted({ userId, role: "accounts_writer" })).halted;
  // Next in line: campaigns that are sending, and any sequence rung.
  const sending = db.select({ id: emailCampaignsTable.id }).from(emailCampaignsTable)
    .where(and(eq(emailCampaignsTable.userId, userId), eq(emailCampaignsTable.status, "sending")));
  // A follow-up waits while its sequence is switched off, and never lands
  // within two days of another email to the same company — a backlog that
  // clears slowly must not deliver step two the day after step one.
  const [m] = await db.select().from(emailMessagesTable)
    .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.status, "queued"),
      // A message of no campaign is a sequence's rung — or the leftover of a
      // deleted campaign, which has no words to send. Those were picked first,
      // failed «بلا محتوى» one per round, and took the round with them: 1,486
      // rounds in three days that should have been real emails.
      sql`((${emailMessagesTable.campaignId} is null and ${emailMessagesTable.sequenceJobId} is not null) or ${emailMessagesTable.campaignId} in (${sending}))`,
      sql`(${emailMessagesTable.sequenceJobId} is null or (
        not exists (select 1 from email_sequence_jobs j join email_sequences q on q.id = j.sequence_id where j.id = ${emailMessagesTable.sequenceJobId} and not q.is_active)
        and not exists (select 1 from email_contacts c where c.id = ${emailMessagesTable.contactId} and c.last_sent_at > now() - interval '48 hours')))`,
      // فاصل الشركة: زميلٌ على النطاق نفسه راسلناه خلال خمسة أيام، فهذه
      // تنتظر دورها — إلا البريد الحر (gmail…) فلا شركة خلفه. الفهرس 070.
      companyGapClause(emailMessagesTable.contactId),
      // ملفٌ جديد أرسل عيّنته: ما بعدها ينتظر حكمها (bounce-guard.ts).
      awaitingVerdict(emailMessagesTable.contactId),
      // حجز مكتب الحسابات: موجةٌ لا تخرج إلى شركةٍ له عندها رسالة تنتظر، وإلا أخّرها فاصل الشركة خمسة أيام.
      notBlockedByDesk(emailMessagesTable.contactId, emailMessagesTable.sequenceJobId, ACCOUNTS_SEQUENCE_PREFIX),
      // أقدم من أسبوع: لا تخرج وحدها، أيّاً كان نوعها (queueReview ثم /queue-review/release).
      notHeldStale(emailMessagesTable.createdAt, emailMessagesTable.staleReleasedAt),
      // ولو أُفرج عنها: مهمتها إن تُركت بعد ذلك تُمسكها من جديد.
      notFromDeadMission(emailMessagesTable.campaignId, emailMessagesTable.createdAt),
      // مفتاح قسم مكتب الحسابات يمسك رسائله وحدها، والموجات تكمل. لا تُنتقى فلا تسدّ الطابور.
      deskHalted ? sql`NOT EXISTS (SELECT 1 FROM email_sequence_jobs hj JOIN email_sequences hq ON hq.id = hj.sequence_id WHERE hj.id = ${emailMessagesTable.sequenceJobId} AND hq.name LIKE ${ACCOUNTS_SEQUENCE_PREFIX + "%"})` : sql`true`))
    // رسالة مكتب الحسابات مكتوبةٌ لشخصٍ بعينه، ولا تقف خلف طابور الموجات: أول
    // تسعٍ منها انتظرت خلف ١٢٠٦ رسائل أقدمها من ٢٦ أكتوبر (٩ نوفمبر).
    .orderBy(sql`(EXISTS (SELECT 1 FROM email_sequence_jobs dj JOIN email_sequences dq ON dq.id = dj.sequence_id WHERE dj.id = ${emailMessagesTable.sequenceJobId} AND dq.name LIKE ${ACCOUNTS_SEQUENCE_PREFIX + "%"})) DESC`,
      // ما فُحص صندوقه أولاً: ١١–١٣ نوفمبر ارتدّ ٧٫٤٪ ممّا خرج بلا فحص و١٫٤٪ ممّا ثبت
      // صندوقه، وثلثا الارتداد من الأول. غير المفحوص ينتظر الفاحص (precheck) ولا يُحرم.
      sql`(SELECT CASE coalesce(fc.mailbox, '') WHEN 'ok' THEN 0 WHEN 'catchall' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END FROM email_contacts fc WHERE fc.id = ${emailMessagesTable.contactId})`,
      asc(emailMessagesTable.createdAt)).limit(1);
  return m ?? null;
}

/** يعيد true حين استهلك فتحة صندوق (أرسل أو حاول)، وfalse حين لا شيء يخرج الآن. */
export async function drainOne(userId: number): Promise<boolean> {
  const s = await getSettings(userId);
  if (!isConfigured(s)) return stall(userId, "إعدادات البريد غير مكتملة");
  // مفتاح الإيقاف: الطابور كما هو، والسبب يُرى — ولا تُنتقى رسالة أصلاً.
  const halt = await isHalted({ userId, channel: "email", department: "email" });
  if (halt.halted) return stall(userId, `مفتاح الإيقاف: ${halt.reason}`);

  const now = Date.now();
  if ((heldUntil.get(userId) ?? 0) > now) return stall(userId, holdNote(heldUntil.get(userId)!));
  // A hold written to the account outlives a restart; when it ends, what it paused resumes.
  if (s!.guardHoldUntil) {
    if (s!.guardHoldUntil.getTime() > now) { heldUntil.set(userId, s!.guardHoldUntil.getTime()); return stall(userId, holdNote(s!.guardHoldUntil.getTime())); }
    await liftHold(userId);
  }

  const sig = await signals(userId);
  const v = assessEmail(sig);
  // Bounces: the cause is acted on — the riskiest queued addresses are
  // dropped — whether the verdict is a hold or only a slowdown.
  if (sig.bounced24h >= 3 && !acted.has(userId)) {
    acted.add(userId);
    const r = await holdRiskyQueued(userId).catch(() => ({ held: 0, of: 0 }));
    if (r.held) await activity(userId, "email_guard", "hold", `حجز ${r.held} عنواناً عالي الخطر من ${r.of} في الطابور بعد ${sig.bounced24h} ارتدادات — الباقي يُرسل`).catch(() => {});
  }
  if (v.holdMinutes > 0) {
    const until = new Date(now + v.holdMinutes * 60_000);
    heldUntil.set(userId, until.getTime());
    await db.update(emailSettingsTable).set({ guardHeldAt: new Date(now), guardHoldUntil: until }).where(eq(emailSettingsTable.userId, userId));
    await db.update(emailCampaignsTable).set({ status: "paused", pauseReason: v.reasons.join(" "), pausedBy: "guard" })
      .where(and(eq(emailCampaignsTable.userId, userId), eq(emailCampaignsTable.status, "sending")));
    await notify(userId, `<b>📧 أوقفنا إرسال البريد ${v.holdMinutes} دقيقة</b>\n${esc(v.reasons.join("\n"))}\nيستأنف وحده حين تنتهي المهلة.`).catch(() => {});
    logger.warn({ userId, reasons: v.reasons }, "email sending held");
    await handoffDeliveryFailure(userId, "hold", { reasons: v.reasons.slice(0, 3), minutes: v.holdMinutes });
    return stall(userId, holdNote(until.getTime()));
  }

  // Pace and caps, per mailbox: the next message goes out of whichever
  // mailbox has used least of its day, within its hour and its gap. The
  // first mailbox keeps the account's caps and warm-up; the others their own.
  await holdBouncingSenders(userId).then((held) => Promise.all(held.map((x) =>
    activity(userId, "email_guard", "hold", `أمهلتُ الصندوق ${x.email} يوماً: ارتداد ${x.pct}٪. الصناديق الأخرى تكمل.`)))).catch(() => {});
  const pick = await pickSender(userId, s!, {
    dailyCap: warmupCap(s!.dailyCap, sig.senderAgeDays, s!.warmup), hourlyCap: s!.hourlyCap, gapMs: sendGapMs(s!.hourlyCap, v.throttle),
  }, v.throttle, now);
  if (!pick) return stall(userId, "كل الصناديق عند سقفها أو في فاصلها");

  const m = await nextQueued(userId);
  if (!m) {
    await completeFinishedCampaigns(userId);
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(emailMessagesTable).where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.status, "queued")));
    return stall(userId, Number(n) ? "لا رسالة مؤهلة الآن (فاصل الشركة ٥ أيام / عيّنة الملف / تتابع موقوف / أقدم من أسبوع تنتظر المراجعة)" : "الطابور فارغ");
  }

  // A message whose contact was deleted is nobody's to send any more.
  if (!m.contactId) {
    await db.update(emailMessagesTable).set({ status: "cancelled", error: "ألغيت: جهة الاتصال حُذفت" }).where(eq(emailMessagesTable.id, m.id));
    return stall(userId, "رسالة بلا جهة اتصال أُلغيت — التالية في المرور القادم");
  }
  const [contact] = await db.select().from(emailContactsTable).where(eq(emailContactsTable.id, m.contactId)).limit(1);
  if (contact && inTruce(contact)) {
    await db.update(emailMessagesTable).set({ status: "cancelled", error: `ألغيت: هدنة حتى ${new Date(contact.quietUntil!).toISOString().slice(0, 10)} — ${contact.quietReason ?? "طلبها ردُّه"}` }).where(eq(emailMessagesTable.id, m.id));
    return stall(userId, "رسالة في هدنة أُلغيت — التالية في المرور القادم");
  }
  // رسالةٌ انتظرت أسبوعاً: يُعاد السؤال قبل أن تخرج. غير المؤهل بوضوح يُلغى بسببه، والباقي كما هو.
  if (contact && staleMessage(m.createdAt)) {
    const why = await staleIneligible(userId, contact).catch(() => null);
    if (why) {
      await db.update(emailMessagesTable).set({ status: "cancelled", error: INELIGIBLE_AR[why] }).where(eq(emailMessagesTable.id, m.id));
      return stall(userId, "رسالة قديمة لم تعد مؤهلة أُلغيت — التالية في المرور القادم");
    }
  }
  if (contact && contact.status !== "active") {
    await db.update(emailMessagesTable).set({ status: "failed", error: `جهة الاتصال ${contact.status}` }).where(eq(emailMessagesTable.id, m.id));
    return stall(userId, "جهة غير نشطة أُسقطت — التالية في المرور القادم");
  }

  // The body: a campaign's html, or the rung's.
  let html = "";
  if (m.campaignId) {
    const [c] = await db.select({ html: emailCampaignsTable.html }).from(emailCampaignsTable).where(eq(emailCampaignsTable.id, m.campaignId)).limit(1);
    html = c?.html ?? "";
  } else if (m.sequenceJobId) {
    const [job] = await db.select().from(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.id, m.sequenceJobId)).limit(1);
    const [seq] = job ? await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, job.sequenceId)).limit(1) : [null];
    html = ((seq?.steps as EmailStep[]) ?? [])[job?.stepIndex ?? 0]?.html ?? "";
  }
  if (!html) {
    // رسالةٌ بلا جسم خطأُ إعدادٍ لا خطأُ تسليم، و«failed» كانت تحرق
    // الجهة نهائياً: ١٧٦٢ شركة في هذا الحساب خرجت من الطابور هكذا يوم
    // ٥ أكتوبر، بعد أن حُذفت حملتها فصار `campaign_id` فارغاً. الإلغاء
    // يترك الجهة قابلةً للمراسلة في حملةٍ جديدة، والسبب مكتوبٌ صريح.
    await db.update(emailMessagesTable).set({
      status: "cancelled",
      error: m.campaignId || m.sequenceJobId
        ? "ألغيت: جسم الرسالة فارغ — أضف نصاً للحملة ثم أعد إرسالها"
        : "ألغيت: حُذفت حملتها أو تتابعها، فلم يبقَ لها نص. الجهة ما زالت قابلة للمراسلة.",
    }).where(eq(emailMessagesTable.id, m.id));
    logger.warn({ userId, messageId: m.id, campaignId: m.campaignId, sequenceJobId: m.sequenceJobId }, "رسالة بلا جسم — أُلغيت ولم تُحرق");
    return stall(userId, "رسالة بلا جسم أُلغيت — التالية في المرور القادم");
  }

  const es = pick.settings;
  // الصندوق يُسأل عنه خادمه، وعيّنة الملف تُحترم — قبل أي إرسال.
  let trialId: number | null = null;
  if (contact) {
    const g = await beforeSend(userId, contact, es.fromEmail!).catch(() => ({ send: true as const, trialId: null }));
    if (!g.send) {
      await db.update(emailMessagesTable).set({ status: "cancelled", error: g.why }).where(eq(emailMessagesTable.id, m.id));
      return stall(userId, `حارس الارتداد أوقف رسالة: ${g.why.slice(0, 80)}`);
    }
    trialId = g.trialId;
  }
  const vars = varsFor(contact, es);
  const base = await publicBase(userId);
  // البكسل عبر أي عنوانٍ حي؛ الروابط والإلغاء عبر عنوانٍ دائم فقط (public-url.ts).
  const keep = durable(base);
  const rendered = renderEmail(html + (es.signature ? `<div style="margin-top:20px">${es.signature}</div>` : ""), vars,
    { base, token: m.token, secret: SECRET(), pixel: !!es.tracking, links: !!es.tracking && !!keep },
    { base: keep, token: m.token, fromName: es.fromName ?? es.fromEmail!, fromEmail: es.fromEmail! }, brandOf(es));
  let subject = personalize(m.subject, vars);
  const messageId = messageIdFor(m.token, es.fromEmail!);
  // A follow-up is a reply in the thread she already has: «Re:» the first
  // subject, under the same conversation in her inbox — not a fresh mail
  // that reads like one more advert.
  const thread = m.sequenceJobId && m.contactId ? await threadFor(userId, m.contactId, m.id, m.sequenceJobId) : null;
  if (thread) subject = thread.subject;

  lastSentAt.set(userId, now);
  markSent(userId, pick.sender?.id ?? null, now);
  try {
    const r = await sendEmail(es, { to: m.toEmail, toName: contact?.name, subject, html: rendered.html, text: rendered.text, messageId, unsubscribeUrl: unsubscribeUrl(keep, m.token),
      inReplyTo: thread?.inReplyTo ?? null, references: thread?.references ?? null, kind: "campaign" });
    await db.update(emailMessagesTable).set({ status: "sent", sentAt: new Date(), providerId: r.providerId, messageIdHdr: messageId, subject, senderId: pick.sender?.id ?? null }).where(eq(emailMessagesTable.id, m.id));
    if (contact) await db.update(emailContactsTable).set({ lastSentAt: new Date() }).where(eq(emailContactsTable.id, contact.id));
    await afterSend(trialId).catch(() => {});
    if (m.campaignId) await db.update(emailCampaignsTable).set({ sentCount: sql`${emailCampaignsTable.sentCount} + 1` }).where(eq(emailCampaignsTable.id, m.campaignId));
    await recordEvent(userId, m.id, "sent");
    receipt({ userId, node: "sender", graph: "email", action: "send.email", subject: m.toEmail, inputRef: m.campaignId ? `campaign:${m.campaignId}` : m.sequenceJobId ? `sequence-job:${m.sequenceJobId}` : null, outputRef: `email-message:${m.id}` });
    stalls.delete(userId);
  } catch (err) {
    // انطفأ المفتاح بين الفحص والسلك: الرسالة تبقى queued كما كانت، ولا عقوبة لأحد.
    if (err instanceof EmailHalted) return stall(userId, `مفتاح الإيقاف: ${err.message}`);
    // طلب الإيقاف، كما تُسقَط الجهة غير النشطة: تفشل هذه وحدها، بلا ارتدادٍ ولا حجز.
    if (err instanceof EmailSuppressed) {
      await db.update(emailMessagesTable).set({ status: "failed", error: `جهة الاتصال: ${err.message}` }).where(eq(emailMessagesTable.id, m.id));
      return stall(userId, "جهة طلبت الإيقاف أُسقطت — التالية في المرور القادم");
    }
    const e = err as SendError;
    // The first mailbox's login refused stops the account as it always did.
    if (!pick.sender && e?.kind === "config") (e as any).kind = "policy";
    // A mailbox whose login the server refused is broken, not the message:
    // the message goes back in the queue for another mailbox.
    if (pick.sender && e?.kind === "config") {
      await markBroken(pick.sender.id, String(e?.message ?? err));
      await activity(userId, "email_guard", "hold", `الصندوق ${pick.sender.fromEmail} رفض خادمه الدخول — عطّلته حتى تصحّح كلمة مروره في الإعدادات. الصناديق الأخرى تكمل.`).catch(() => {});
      await handoffDeliveryFailure(userId, "mailbox", { sender: pick.sender.fromEmail });
      return true;
    }
    await db.update(emailMessagesTable).set({ status: "failed", error: String(e?.message ?? err).slice(0, 400), senderId: pick.sender?.id ?? null }).where(eq(emailMessagesTable.id, m.id));
    if (m.campaignId) await db.update(emailCampaignsTable).set({ failedCount: sql`${emailCampaignsTable.failedCount} + 1` }).where(eq(emailCampaignsTable.id, m.campaignId));
    await recordEvent(userId, m.id, "failed", { meta: { error: String(e?.message ?? err).slice(0, 200) } });
    // رفضُ **العنوان** وحده ارتدادٌ في كل شيء إلا الاسم. ورفضُ المزوّد
    // لرسالتنا ليس عن الجهة في شيء: هي تبقى نشطة، ونحن الذين نتوقف.
    if (e?.kind === "address" && contact) await recordEvent(userId, m.id, "bounce", { meta: { synthetic: true } });
    // راشد يطابق السجل ومارك يفحص، مرةً في اليوم لكل نوع.
    if (e?.kind === "address" || e?.kind === "policy") await handoffDeliveryFailure(userId, e.kind, { messageId: m.id, error: String(e?.message ?? "").slice(0, 200) });
    if (e?.kind === "policy") {
      // المزوّد يقول إن ما نرسله يشبه الإزعاج. الاستمرار بعدها هو ما يحوّل
      // تحذيراً إلى حجب، فيُحجز الإرسال ست ساعات ويُقال لصاحب العمل مرةً.
      const until = new Date(now + 6 * 3_600_000);
      heldUntil.set(userId, until.getTime());
      await db.update(emailSettingsTable).set({ guardHeldAt: new Date(now), guardHoldUntil: until }).where(eq(emailSettingsTable.userId, userId)).catch(() => {});
      await recordEvent(userId, m.id, "failed", { meta: { policy: true, error: String(e?.message ?? "").slice(0, 200) } }).catch(() => {});
      await policyAlert(userId, String(e?.message ?? ""), m.campaignId).catch(() => {});
    }
    // المزوّد يرفضنا لحظةً (مصادقة، معدّل) — لا نطرق الباب.
    if (e?.kind === "transient" || (!e?.kind && !e?.permanent)) heldUntil.set(userId, now + 10 * 60_000);
    logger.warn({ userId, messageId: m.id, err: String(e?.message ?? err) }, "email send failed");
    receipt({ userId, node: "sender", graph: "email", action: "send.email", status: "failed", subject: m.toEmail, inputRef: m.campaignId ? `campaign:${m.campaignId}` : null, outputRef: `email-message:${m.id}`, why: String(e?.message ?? err).slice(0, 300) });
    if ((heldUntil.get(userId) ?? 0) > now) stall(userId, holdNote(heldUntil.get(userId)!));
  }
  return true;
}

/** شرط SQL: لا زميلَ على نطاق شركة هذه الجهة راسلناه خلال `COMPANY_GAP_DAYS`؛ البريد الحر معفى. */
export const COMPANY_GAP_DAYS = 5;
const FREE_MAIL_SQL = sql.join([...FREE_MAIL].map((d) => sql`${d}`), sql`, `);
export const companyGapClause = (contactId: any) => sql`not exists (
  select 1 from email_contacts c join email_contacts c2 on c2.user_id = c.user_id and c2.id <> c.id
    and lower(split_part(c2.email, '@', 2)) = lower(split_part(c.email, '@', 2))
  where c.id = ${contactId} and lower(split_part(c.email, '@', 2)) not in (${FREE_MAIL_SQL})
    and c2.last_sent_at > now() - make_interval(days => ${COMPANY_GAP_DAYS}))`;

/** فهارس 070 عند الإقلاع: النشر لا يشغّل ملفات SQL، وبلا الفهرس يقرأ شرط الشركة الجدول كله في كل مرور. */
export const DOMAIN_INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_email_contacts_domain ON email_contacts (user_id, lower(split_part(email, '@', 2)))`,
  `CREATE INDEX IF NOT EXISTS idx_email_contacts_last_sent ON email_contacts (user_id, last_sent_at)`,
];
async function ensureDomainIndexes() {
  for (const q of DOMAIN_INDEX_SQL) await db.execute(sql.raw(q)).catch((e) => logger.warn({ err: String(e?.message ?? e) }, "تعذّر إنشاء فهرس البريد"));
}

/** مرةً في اليوم، لا مع كل رسالة مرفوضة. */
const policyAlerted = new Map<number, number>();
async function policyAlert(userId: number, error: string, campaignId: number | null) {
  if (Date.now() - (policyAlerted.get(userId) ?? 0) < 20 * 3_600_000) return;
  policyAlerted.set(userId, Date.now());
  const { notify, esc } = await import("../telegram");
  const { activity } = await import("./team");
  const text = `مزوّد البريد رفض رسالتنا لا عنوان العميل: «${error.slice(0, 120)}». حجزتُ الإرسال ست ساعات — الجهات لم تُمسّ.`;
  await activity(userId, "email_guard", "hold", text, { campaignId, policy: true });
  await notify(userId, [
    "<b>⚠️ مزوّد البريد رفض رسائلنا كإزعاج</b>",
    esc(error.slice(0, 200)),
    "",
    "هذا رفضٌ لنصّنا أو لإيقاعنا، لا لعناوين العملاء — فلم تُعلَّم جهةٌ مرتدّة.",
    "حُجز الإرسال ست ساعات. السبب الغالب: نصٌّ واحد يتكرّر مئات المرات. غيّر الزاوية والعنوان قبل الاستئناف.",
  ].join("\n")).catch(() => {});
}

async function completeFinishedCampaigns(userId: number) {
  const sending = await db.select({ id: emailCampaignsTable.id }).from(emailCampaignsTable)
    .where(and(eq(emailCampaignsTable.userId, userId), eq(emailCampaignsTable.status, "sending")));
  for (const c of sending) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.campaignId, c.id), inArray(emailMessagesTable.status, ["queued", "ab_hold"])));
    if (Number(n) === 0) {
      await db.update(emailCampaignsTable).set({ status: "completed", completedAt: new Date() }).where(eq(emailCampaignsTable.id, c.id));
      logger.info({ userId, campaignId: c.id }, "حملة بريد اكتملت");
    }
  }
}

/** Scheduled campaigns whose time has come. */
export async function startScheduled(now = new Date()) {
  const due = await db.select().from(emailCampaignsTable)
    .where(and(eq(emailCampaignsTable.status, "scheduled"), lt(emailCampaignsTable.scheduledAt, now)));
  for (const c of due) {
    if (await accountHalted(c.userId, "email.scheduled")) continue;
    await startCampaign(c.userId, c.id).catch((err) =>
      logger.warn({ campaignId: c.id, err: String(err?.message ?? err) }, "تعذّر بدء حملة مجدولة"));
  }
}

// ── Dashboard ─────────────────────────────────────────────────────
export async function overview(userId: number) {
  const day = new Date(Date.now() - 24 * 3_600_000), week = new Date(Date.now() - 7 * 24 * 3_600_000);
  const [[totals], [c], [w], recent, [queued], [lists], [seq], v, s] = await Promise.all([
    db.select({
      contacts: sql<number>`count(*)`,
      active: sql<number>`count(*) filter (where ${emailContactsTable.status} = 'active')`,
      unsub: sql<number>`count(*) filter (where ${emailContactsTable.status} = 'unsubscribed')`,
      bounced: sql<number>`count(*) filter (where ${emailContactsTable.status} in ('bounced','complained'))`,
    }).from(emailContactsTable).where(eq(emailContactsTable.userId, userId)),
    db.select({
      sent: sql<number>`count(*) filter (where ${emailMessagesTable.status} in ('sent','bounced'))`,
      opened: sql<number>`count(*) filter (where ${emailMessagesTable.openedAt} is not null)`,
      clicked: sql<number>`count(*) filter (where ${emailMessagesTable.clickedAt} is not null)`,
      replied: sql<number>`count(*) filter (where ${emailMessagesTable.repliedAt} is not null)`,
      bounced: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'bounced')`,
      failed: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'failed')`,
    }).from(emailMessagesTable).where(and(eq(emailMessagesTable.userId, userId), gte(emailMessagesTable.createdAt, day))),
    db.select({
      sent: sql<number>`count(*) filter (where ${emailMessagesTable.status} in ('sent','bounced'))`,
      opened: sql<number>`count(*) filter (where ${emailMessagesTable.openedAt} is not null)`,
      clicked: sql<number>`count(*) filter (where ${emailMessagesTable.clickedAt} is not null)`,
      replied: sql<number>`count(*) filter (where ${emailMessagesTable.repliedAt} is not null)`,
      bounced: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'bounced')`,
    }).from(emailMessagesTable).where(and(eq(emailMessagesTable.userId, userId), gte(emailMessagesTable.createdAt, week))),
    db.select({ e: emailEventsTable, to: emailMessagesTable.toEmail, subject: emailMessagesTable.subject })
      .from(emailEventsTable).leftJoin(emailMessagesTable, eq(emailMessagesTable.id, emailEventsTable.messageId))
      .where(eq(emailEventsTable.userId, userId)).orderBy(desc(emailEventsTable.createdAt)).limit(40),
    db.select({ n: sql<number>`count(*)` }).from(emailMessagesTable).where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.status, "queued"))),
    db.select({ n: sql<number>`count(*)` }).from(emailListsTable).where(eq(emailListsTable.userId, userId)),
    db.select({ n: sql<number>`count(*)` }).from(emailSequenceJobsTable).where(and(eq(emailSequenceJobsTable.userId, userId), eq(emailSequenceJobsTable.status, "pending"))),
    verdictFor(userId),
    getSettings(userId),
  ]);
  const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
  return {
    configured: isConfigured(s),
    sender: s ? { provider: s.provider, fromName: s.fromName, fromEmail: s.fromEmail, hourlyCap: s.hourlyCap, dailyCap: s.dailyCap,
      dailyCapToday: (await capacityToday(userId, warmupCap(s.dailyCap, (await signals(userId)).senderAgeDays, s.warmup))).total, warmup: s.warmup,
      mailboxes: (await capacityToday(userId, 0)).senders,
      tracking: s.tracking, imap: !!s.imapHost, autoReply: s.autoReply } : null,
    trackingBase: (await publicBase(userId)) || null,
    contacts: { total: Number(totals?.contacts ?? 0), active: Number(totals?.active ?? 0), unsubscribed: Number(totals?.unsub ?? 0), bounced: Number(totals?.bounced ?? 0), lists: Number(lists?.n ?? 0) },
    today: { sent: Number(c?.sent ?? 0), opened: Number(c?.opened ?? 0), clicked: Number(c?.clicked ?? 0), replied: Number(c?.replied ?? 0), bounced: Number(c?.bounced ?? 0), failed: Number(c?.failed ?? 0),
      openRate: rate(Number(c?.opened ?? 0), Number(c?.sent ?? 0)), replyRate: rate(Number(c?.replied ?? 0), Number(c?.sent ?? 0)) },
    week: { sent: Number(w?.sent ?? 0), opened: Number(w?.opened ?? 0), clicked: Number(w?.clicked ?? 0), replied: Number(w?.replied ?? 0), bounced: Number(w?.bounced ?? 0),
      openRate: rate(Number(w?.opened ?? 0), Number(w?.sent ?? 0)), clickRate: rate(Number(w?.clicked ?? 0), Number(w?.sent ?? 0)), replyRate: rate(Number(w?.replied ?? 0), Number(w?.sent ?? 0)), bounceRate: rate(Number(w?.bounced ?? 0), Number(w?.sent ?? 0)) },
    queue: { queued: Number(queued?.n ?? 0), pendingRungs: Number(seq?.n ?? 0), heldUntil: heldUntil.get(userId) && heldUntil.get(userId)! > Date.now() ? new Date(heldUntil.get(userId)!) : null },
    stall: stallReason(userId),
    window: emailWindowNote(),
    health: v,
    events: recent.map((r: any) => ({ id: r.e.id, type: r.e.type, at: r.e.createdAt, to: r.to, subject: r.subject, url: r.e.url, meta: r.e.meta })),
  };
}

// ── Subject tests ─────────────────────────────────────────────────
/**
 * Decide the tests whose slice has been sent and has had time to be read,
 * and release the held rest under the winning subject.
 */
/** Below this open rate in a test slice of at least this size, the rest waits (the open-rate checkpoint). */
export const LOW_OPEN_RATE = 0.15;
export const LOW_OPEN_MIN_SAMPLE = 50;

/** Opens can only be measured when the pixel can reach us: a public address and tracking on. */
export async function trackingActive(userId: number): Promise<boolean> {
  if (!(await publicBase(userId))) return false;
  const s = await getSettings(userId);
  return !!s?.tracking;
}

/**
 * New subjects on a fresh slice of the held: a fifth of them (at least 20),
 * split between the two, the rest still held until this round is read.
 */
export async function retestHeld(campaignId: number, subjectA: string, subjectB: string): Promise<{ slice: number; held: number }> {
  const held = await db.select({ id: emailMessagesTable.id }).from(emailMessagesTable)
    .where(and(eq(emailMessagesTable.campaignId, campaignId), eq(emailMessagesTable.status, "ab_hold")));
  const ids = held.map((h) => h.id).sort(() => Math.random() - 0.5);
  const slice = Math.min(ids.length, Math.max(20, Math.round(ids.length * 0.2)));
  const a = ids.slice(0, Math.ceil(slice / 2)), b = ids.slice(Math.ceil(slice / 2), slice);
  if (a.length) await db.update(emailMessagesTable).set({ status: "queued", subject: subjectA, variant: "A" }).where(inArray(emailMessagesTable.id, a));
  if (b.length) await db.update(emailMessagesTable).set({ status: "queued", subject: subjectB, variant: "B" }).where(inArray(emailMessagesTable.id, b));
  await db.update(emailCampaignsTable).set({
    subject: subjectA, subjectB, status: "sending", pauseReason: null, lowOpenAt: null, abWinner: null, abDecidedAt: null,
    abRound: sql`${emailCampaignsTable.abRound} + 1`,
  }).where(eq(emailCampaignsTable.id, campaignId));
  return { slice, held: ids.length };
}

export async function decideAbTests(now = new Date(), opts: { tracking?: (userId: number) => Promise<boolean>; onlyCampaignIds?: number[] } = {}): Promise<number> {
  const open = await db.select().from(emailCampaignsTable)
    .where(and(eq(emailCampaignsTable.status, "sending"), sql`${emailCampaignsTable.abPct} > 0`, isNull(emailCampaignsTable.abWinner),
      opts.onlyCampaignIds ? inArray(emailCampaignsTable.id, opts.onlyCampaignIds) : sql`true`));
  let decided = 0;
  for (const c of open) {
    if (await accountHalted(c.userId, "email.ab")) continue;
    const [st] = await db.select({
      pending: sql<number>`count(*) filter (where ${emailMessagesTable.variant} is not null and ${emailMessagesTable.status} = 'queued')`,
      held:    sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'ab_hold')`,
      lastAt:  sql<Date | null>`max(${emailMessagesTable.sentAt}) filter (where ${emailMessagesTable.variant} is not null)`,
      aSent:   sql<number>`count(*) filter (where ${emailMessagesTable.variant} = 'A' and ${emailMessagesTable.sentAt} is not null)`,
      aOpen:   sql<number>`count(*) filter (where ${emailMessagesTable.variant} = 'A' and ${emailMessagesTable.openedAt} is not null)`,
      aReply:  sql<number>`count(*) filter (where ${emailMessagesTable.variant} = 'A' and ${emailMessagesTable.repliedAt} is not null)`,
      bSent:   sql<number>`count(*) filter (where ${emailMessagesTable.variant} = 'B' and ${emailMessagesTable.sentAt} is not null)`,
      bOpen:   sql<number>`count(*) filter (where ${emailMessagesTable.variant} = 'B' and ${emailMessagesTable.openedAt} is not null)`,
      bReply:  sql<number>`count(*) filter (where ${emailMessagesTable.variant} = 'B' and ${emailMessagesTable.repliedAt} is not null)`,
    }).from(emailMessagesTable).where(eq(emailMessagesTable.campaignId, c.id));
    if (!st || Number(st.pending) > 0 || !st.lastAt) continue;
    if (now.getTime() - new Date(st.lastAt).getTime() < c.abWaitHours * 3_600_000) continue;

    // The checkpoint: with opens measured and a slice large enough to mean
    // something, a test almost nobody opened does not decide anything — the
    // rest stays held while the subject is rewritten (missions.rescueSubjects).
    // Sending a thousand an email that the first two hundred ignored only
    // teaches the inbox providers to file the next one as spam.
    const testSent = Number(st.aSent) + Number(st.bSent);
    const best = Math.max(Number(st.aSent) ? Number(st.aOpen) / Number(st.aSent) : 0, Number(st.bSent) ? Number(st.bOpen) / Number(st.bSent) : 0);
    if (testSent >= LOW_OPEN_MIN_SAMPLE && best < LOW_OPEN_RATE && (await (opts.tracking ?? trackingActive)(c.userId))) {
      const pct = Math.round(best * 100);
      await db.update(emailCampaignsTable).set({ status: "paused", lowOpenAt: now, pauseReason: `نسبة الفتح ${pct}% في عينة ${testSent} — أوقفنا الباقي (${Number(st.held)}) ويُعاد كتابة العنوان` })
        .where(eq(emailCampaignsTable.id, c.id));
      await notify(c.userId, `<b>📧 فتح منخفض — ${esc(c.name)}</b>\nفتح ${pct}% فقط من ${testSent} في العينة. أوقفنا إرسال الباقي (${Number(st.held)}) وتكتب نورة عنوانين جديدين لعينة جديدة.`).catch(() => {});
      logger.warn({ campaignId: c.id, best, testSent }, "فتح منخفض — أُوقف الباقي");
      continue;
    }

    const winner = pickWinner(
      { sent: Number(st.aSent), opened: Number(st.aOpen), replied: Number(st.aReply) },
      { sent: Number(st.bSent), opened: Number(st.bOpen), replied: Number(st.bReply) });
    const subject = winner === "B" ? c.subjectB! : c.subject;
    await db.update(emailMessagesTable).set({ status: "queued", subject, variant: winner })
      .where(and(eq(emailMessagesTable.campaignId, c.id), eq(emailMessagesTable.status, "ab_hold")));
    await db.update(emailCampaignsTable).set({ abWinner: winner, abDecidedAt: now }).where(eq(emailCampaignsTable.id, c.id));
    const pctOf = (o: unknown, s: unknown) => (Number(s) ? `${Math.round((Number(o) / Number(s)) * 100)}%` : "—");
    await notify(c.userId, [
      `<b>📧 اختبار العنوان حُسم — ${esc(c.name)}</b>`,
      `A: ${esc(c.subject)} — فتح ${pctOf(st.aOpen, st.aSent)}`,
      `B: ${esc(c.subjectB ?? "")} — فتح ${pctOf(st.bOpen, st.bSent)}`,
      `الفائز ${winner}. يُرسل الآن إلى ${Number(st.held)} الباقين.`,
    ].join("\n")).catch(() => {});
    logger.info({ campaignId: c.id, winner, held: Number(st.held) }, "اختبار العنوان حُسم");
    decided++;
  }
  return decided;
}

// ── The evening report ────────────────────────────────────────────
export async function dailyEmailReport(userId: number): Promise<boolean> {
  const o = await overview(userId);
  if (!o.today.sent && !o.today.replied && !o.queue.queued) return false;
  const [top] = await Promise.all([
    db.select({ name: emailCampaignsTable.name, sent: emailCampaignsTable.sentCount, open: emailCampaignsTable.openCount, reply: emailCampaignsTable.replyCount, status: emailCampaignsTable.status })
      .from(emailCampaignsTable).where(and(eq(emailCampaignsTable.userId, userId), inArray(emailCampaignsTable.status, ["sending", "paused", "completed"])))
      .orderBy(desc(emailCampaignsTable.startedAt)).limit(3),
  ]);
  return notify(userId, [
    "<b>📧 البريد اليوم</b>",
    `أُرسل ${o.today.sent} · فُتح ${o.today.opened} (${o.today.openRate ?? "—"}%) · نقر ${o.today.clicked} · ردّ ${o.today.replied} · ارتدّ ${o.today.bounced}`,
    `الأسبوع: فتح ${o.week.openRate ?? "—"}% · رد ${o.week.replyRate ?? "—"}% · ارتداد ${o.week.bounceRate ?? "—"}%`,
    `في الطابور ${o.queue.queued} · متابعات مجدولة ${o.queue.pendingRungs}`,
    ...top.map((c) => `• ${esc(c.name)} — ${c.sent} أُرسل، ${c.open} فتح، ${c.reply} رد (${c.status})`),
    o.health.reasons.length ? `\n⚠️ ${esc(o.health.reasons.join(" "))}` : "",
  ].filter(Boolean).join("\n"));
}

export function startEmailWorkers(): void {
  let lastReportDay = "";
  void ensureDomainIndexes();
  setTimeout(() => {
    everyMs("email.queue_drain", 20_000, drainQueues);
    everyMs("email.sequence_steps", 60_000, enqueueDueSequenceSteps);
    everyMs("email.scheduled_campaigns", 60_000, startScheduled);
    everyMs("email.ab_tests", 5 * 60_000, decideAbTests);
    // 20:30 Gulf time, once a day, to every account that sent something.
    everyMs("email.daily_report", 5 * 60_000, async () => {
      const gulf = new Date(Date.now() + 4 * 3_600_000);
      const day = gulf.toISOString().slice(0, 10);
      if (gulf.getUTCHours() !== 20 || gulf.getUTCMinutes() < 30 || day === lastReportDay) return;
      lastReportDay = day;
      const users = await db.selectDistinct({ userId: emailSettingsTable.userId }).from(emailSettingsTable);
      for (const { userId } of users) await dailyEmailReport(userId).catch(() => {});
    });
  }, 40_000);
  logger.info("عامل البريد بدأ");
}
