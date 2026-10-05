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
import { isWithinSendingHours } from "../sending-hours";
import { logger } from "../logger";
import { notify, esc } from "../telegram";
import { sendEmail, SendError, isConfigured, messageIdFor } from "./provider";
import { newToken, renderEmail, firstName, companyName, personalize, unsubscribeUrl } from "./tracking";
import { brandOf } from "./layout";
import { asLanguage, matchesLanguage, wrongLanguage } from "./language";
import { assessEmail, sendGapMs, warmupCap, splitAb, pickWinner, type EmailVerdict } from "./health";
import { byRisk, domainSignals, verifyDomains } from "./hygiene";

const SITE_URL = () => (process.env["SITE_URL"] ?? "").replace(/\/+$/, "");
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
  const unverified = members.map((m) => m.c).filter((x) => x.mxOk == null && !already.has(x.id)).map((x) => x.id);
  if (unverified.length) {
    await verifyDomains(userId, unverified, { maxDomains: 800 }).catch(() => null);
    const fresh = new Map((await db.select({ id: emailContactsTable.id, mxOk: emailContactsTable.mxOk }).from(emailContactsTable).where(inArray(emailContactsTable.id, unverified))).map((r) => [r.id, r.mxOk]));
    for (const m of members) if (fresh.has(m.c.id)) m.c.mxOk = fresh.get(m.c.id) ?? null;
  }
  let queued = 0, skipped = 0;
  const batch: Array<typeof emailMessagesTable.$inferInsert> = [];
  const sendable = members.map((m) => m.c).filter((contact) => {
    const ok = contact.status === "active" && contact.mxOk !== false && !already.has(contact.id);
    if (!ok) skipped++;
    return ok;
  });
  const { kept: eligible, held: risky } = byRisk(sendable, await domainSignals(userId), s!.skipRisky);
  skipped += risky;

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

  await db.update(emailCampaignsTable).set({ status: "sending", startedAt: c.startedAt ?? new Date(), pauseReason: null })
    .where(eq(emailCampaignsTable.id, c.id));
  logger.info({ userId, campaignId: c.id, queued, skipped, risky, ab: testing ? split : null }, "حملة بريد بدأت");
  return { queued, skipped, risky, ab: testing ? split : null } as { queued: number; skipped: number; risky: number; ab?: typeof split | null };
}

export async function pauseCampaign(userId: number, campaignId: number, reason: string | null = null) {
  await db.update(emailCampaignsTable).set({ status: "paused", pauseReason: reason })
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
    if (c.status !== "active" || c.mxOk === false || inFlight.has(c.id)) { skipped++; continue; }
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

export async function cancelSequencesFor(userId: number, contactId: number, reason: string): Promise<number> {
  const r = await db.update(emailSequenceJobsTable).set({ status: "cancelled", error: reason })
    .where(and(eq(emailSequenceJobsTable.userId, userId), eq(emailSequenceJobsTable.contactId, contactId), eq(emailSequenceJobsTable.status, "pending")))
    .returning({ id: emailSequenceJobsTable.id });
  return r.length;
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
  const configured = db.select({ userId: emailSettingsTable.userId }).from(emailSettingsTable)
    .where(sql`${emailSettingsTable.fromEmail} is not null and (${emailSettingsTable.smtpHost} is not null or ${emailSettingsTable.apiKey} is not null)`);
  const due = await db.select().from(emailSequenceJobsTable)
    .where(and(eq(emailSequenceJobsTable.status, "pending"), lt(emailSequenceJobsTable.dueAt, now), inArray(emailSequenceJobsTable.userId, configured),
      onlyUserId ? eq(emailSequenceJobsTable.userId, onlyUserId) : sql`true`))
    .orderBy(asc(emailSequenceJobsTable.dueAt)).limit(200);
  let n = 0;
  for (const job of due) {
    const [seq] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, job.sequenceId)).limit(1);
    const step = ((seq?.steps as EmailStep[]) ?? [])[job.stepIndex];
    const [contact] = await db.select().from(emailContactsTable).where(eq(emailContactsTable.id, job.contactId)).limit(1);
    if (!seq?.isActive || !step || !contact || contact.status !== "active") {
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

export async function signals(userId: number) {
  const day = new Date(Date.now() - 24 * 3_600_000);
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

/** One pass over every account with something queued. Runs every 20 s. */
export async function drainQueues(): Promise<void> {
  if (!isWithinSendingHours()) return;
  const accounts = await db.selectDistinct({ userId: emailMessagesTable.userId }).from(emailMessagesTable)
    .where(eq(emailMessagesTable.status, "queued"));

  for (const { userId } of accounts) {
    try { await drainOne(userId); }
    catch (err) { logger.warn({ userId, err: String((err as any)?.message ?? err) }, "فشل مرور طابور البريد"); }
  }
}

async function drainOne(userId: number) {
  const s = await getSettings(userId);
  if (!isConfigured(s)) return;

  const now = Date.now();
  if ((heldUntil.get(userId) ?? 0) > now) return;

  const sig = await signals(userId);
  const v = assessEmail(sig);
  if (v.holdMinutes > 0) {
    heldUntil.set(userId, now + v.holdMinutes * 60_000);
    await db.update(emailCampaignsTable).set({ status: "paused", pauseReason: v.reasons.join(" ") })
      .where(and(eq(emailCampaignsTable.userId, userId), eq(emailCampaignsTable.status, "sending")));
    await notify(userId, `<b>📧 أوقفنا إرسال البريد ${v.holdMinutes} دقيقة</b>\n${esc(v.reasons.join("\n"))}`).catch(() => {});
    logger.warn({ userId, reasons: v.reasons }, "email sending held");
    return;
  }

  // Pace: the jittered gap for this account, and the caps.
  const gap = sendGapMs(s!.hourlyCap, v.throttle);
  if (now - (lastSentAt.get(userId) ?? 0) < gap) return;

  const hour = new Date(now - 3_600_000), day = new Date(now - 24 * 3_600_000);
  const [[h], [d]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(emailMessagesTable).where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.status, "sent"), gte(emailMessagesTable.sentAt, hour))),
    db.select({ n: sql<number>`count(*)` }).from(emailMessagesTable).where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.status, "sent"), gte(emailMessagesTable.sentAt, day))),
  ]);
  const dailyCap = warmupCap(s!.dailyCap, sig.senderAgeDays, s!.warmup);
  if (Number(h?.n) >= s!.hourlyCap || Number(d?.n) >= dailyCap) return;

  // Next in line: campaigns that are sending, and any sequence rung.
  const sending = db.select({ id: emailCampaignsTable.id }).from(emailCampaignsTable)
    .where(and(eq(emailCampaignsTable.userId, userId), eq(emailCampaignsTable.status, "sending")));
  // A follow-up waits while its sequence is switched off, and never lands
  // within two days of another email to the same company — a backlog that
  // clears slowly must not deliver step two the day after step one.
  const [m] = await db.select().from(emailMessagesTable)
    .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.status, "queued"),
      sql`(${emailMessagesTable.campaignId} is null or ${emailMessagesTable.campaignId} in (${sending}))`,
      sql`(${emailMessagesTable.sequenceJobId} is null or (
        not exists (select 1 from email_sequence_jobs j join email_sequences q on q.id = j.sequence_id where j.id = ${emailMessagesTable.sequenceJobId} and not q.is_active)
        and not exists (select 1 from email_contacts c where c.id = ${emailMessagesTable.contactId} and c.last_sent_at > now() - interval '48 hours')))`))
    .orderBy(asc(emailMessagesTable.createdAt)).limit(1);
  if (!m) { await completeFinishedCampaigns(userId); return; }

  // A message whose contact was deleted is nobody's to send any more.
  if (!m.contactId) {
    await db.update(emailMessagesTable).set({ status: "cancelled", error: "ألغيت: جهة الاتصال حُذفت" }).where(eq(emailMessagesTable.id, m.id));
    return;
  }
  const [contact] = await db.select().from(emailContactsTable).where(eq(emailContactsTable.id, m.contactId)).limit(1);
  if (contact && contact.status !== "active") {
    await db.update(emailMessagesTable).set({ status: "failed", error: `جهة الاتصال ${contact.status}` }).where(eq(emailMessagesTable.id, m.id));
    return;
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
    await db.update(emailMessagesTable).set({ status: "failed", error: "بلا محتوى" }).where(eq(emailMessagesTable.id, m.id));
    return;
  }

  const vars = varsFor(contact, s);
  const base = SITE_URL();
  const rendered = renderEmail(html + (s!.signature ? `<div style="margin-top:20px">${s!.signature}</div>` : ""), vars,
    { base, token: m.token, secret: SECRET(), pixel: !!s!.tracking, links: !!s!.tracking },
    { base, token: m.token, fromName: s!.fromName ?? s!.fromEmail!, fromEmail: s!.fromEmail! }, brandOf(s));
  const subject = personalize(m.subject, vars);
  const messageId = messageIdFor(m.token, s!.fromEmail!);

  lastSentAt.set(userId, now);
  try {
    const r = await sendEmail(s!, { to: m.toEmail, toName: contact?.name, subject, html: rendered.html, text: rendered.text, messageId, unsubscribeUrl: unsubscribeUrl(base, m.token) });
    await db.update(emailMessagesTable).set({ status: "sent", sentAt: new Date(), providerId: r.providerId, messageIdHdr: messageId, subject }).where(eq(emailMessagesTable.id, m.id));
    if (contact) await db.update(emailContactsTable).set({ lastSentAt: new Date() }).where(eq(emailContactsTable.id, contact.id));
    if (m.campaignId) await db.update(emailCampaignsTable).set({ sentCount: sql`${emailCampaignsTable.sentCount} + 1` }).where(eq(emailCampaignsTable.id, m.campaignId));
    await recordEvent(userId, m.id, "sent");
  } catch (err) {
    const e = err as SendError;
    await db.update(emailMessagesTable).set({ status: "failed", error: String(e?.message ?? err).slice(0, 400) }).where(eq(emailMessagesTable.id, m.id));
    if (m.campaignId) await db.update(emailCampaignsTable).set({ failedCount: sql`${emailCampaignsTable.failedCount} + 1` }).where(eq(emailCampaignsTable.id, m.campaignId));
    await recordEvent(userId, m.id, "failed", { meta: { error: String(e?.message ?? err).slice(0, 200) } });
    // A permanent refusal of the address is a bounce in all but name.
    if (e?.permanent && contact) await recordEvent(userId, m.id, "bounce", { meta: { synthetic: true } });
    // The provider itself refusing us (auth, rate) — stop hammering.
    if (!e?.permanent) heldUntil.set(userId, now + 10 * 60_000);
    logger.warn({ userId, messageId: m.id, err: String(e?.message ?? err) }, "email send failed");
  }
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
  for (const c of due) await startCampaign(c.userId, c.id).catch((err) =>
    logger.warn({ campaignId: c.id, err: String(err?.message ?? err) }, "تعذّر بدء حملة مجدولة"));
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
      dailyCapToday: warmupCap(s.dailyCap, (await signals(userId)).senderAgeDays, s.warmup), warmup: s.warmup,
      tracking: s.tracking, imap: !!s.imapHost, autoReply: s.autoReply } : null,
    trackingBase: SITE_URL() || null,
    contacts: { total: Number(totals?.contacts ?? 0), active: Number(totals?.active ?? 0), unsubscribed: Number(totals?.unsub ?? 0), bounced: Number(totals?.bounced ?? 0), lists: Number(lists?.n ?? 0) },
    today: { sent: Number(c?.sent ?? 0), opened: Number(c?.opened ?? 0), clicked: Number(c?.clicked ?? 0), replied: Number(c?.replied ?? 0), bounced: Number(c?.bounced ?? 0), failed: Number(c?.failed ?? 0),
      openRate: rate(Number(c?.opened ?? 0), Number(c?.sent ?? 0)), replyRate: rate(Number(c?.replied ?? 0), Number(c?.sent ?? 0)) },
    week: { sent: Number(w?.sent ?? 0), opened: Number(w?.opened ?? 0), clicked: Number(w?.clicked ?? 0), replied: Number(w?.replied ?? 0), bounced: Number(w?.bounced ?? 0),
      openRate: rate(Number(w?.opened ?? 0), Number(w?.sent ?? 0)), clickRate: rate(Number(w?.clicked ?? 0), Number(w?.sent ?? 0)), replyRate: rate(Number(w?.replied ?? 0), Number(w?.sent ?? 0)), bounceRate: rate(Number(w?.bounced ?? 0), Number(w?.sent ?? 0)) },
    queue: { queued: Number(queued?.n ?? 0), pendingRungs: Number(seq?.n ?? 0), heldUntil: heldUntil.get(userId) && heldUntil.get(userId)! > Date.now() ? new Date(heldUntil.get(userId)!) : null },
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
  if (!(process.env["SITE_URL"] ?? "").trim()) return false;
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
  setTimeout(() => {
    setInterval(() => void drainQueues().catch((e) => logger.warn({ err: String(e?.message ?? e) }, "email drain failed")), 20_000);
    setInterval(() => void enqueueDueSequenceSteps().catch(() => {}), 60_000);
    setInterval(() => void startScheduled().catch(() => {}), 60_000);
    setInterval(() => void decideAbTests().catch(() => {}), 5 * 60_000);
    // 20:30 Gulf time, once a day, to every account that sent something.
    setInterval(async () => {
      const gulf = new Date(Date.now() + 4 * 3_600_000);
      const day = gulf.toISOString().slice(0, 10);
      if (gulf.getUTCHours() !== 20 || gulf.getUTCMinutes() < 30 || day === lastReportDay) return;
      lastReportDay = day;
      const users = await db.selectDistinct({ userId: emailSettingsTable.userId }).from(emailSettingsTable);
      for (const { userId } of users) await dailyEmailReport(userId).catch(() => {});
    }, 5 * 60_000);
  }, 40_000);
  logger.info("عامل البريد بدأ");
}
