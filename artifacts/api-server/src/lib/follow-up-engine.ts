// ── Follow-up engine ──────────────────────────────────────────────
// Follows up with a lead on a fixed cadence after first contact, and stops the
// moment they answer. A sequence that keeps firing at someone who has already
// replied is not a follow-up, it is the thing that gets numbers reported, so
// stopOnReply is the default and cancellation is checked at send time too.
//
// Ad leads identify themselves: a click-to-WhatsApp ad stamps the first
// incoming message with referral data, which is what sourceFilter="ad" keys on.

import { asAgent } from "./agent-context";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  db, leadSourcesTable, followUpSequencesTable, followUpJobsTable,
  unsubscribedPhonesTable, incomingMessagesTable, contactsTable, contactGroupsTable, autoReplyLogTable,
  waThreadMessagesTable,
  type FollowUpStep,
} from "@workspace/db";
import { logger } from "./logger";
import { isWithinSendingHours } from "./sending-hours";
import { getDailyRemaining } from "./daily-limit";
import { classify, INTENT_LABELS_AR, type Intent } from "./intent";
import { answerFromKnowledge, shouldAutoReply, logAutoReply } from "./knowledge";
import { detectAutoresponder } from "./autoresponder";
import { route, personaPreamble, agentJob } from "./agent-router";
import { memoryPreamble, learnFromOutcome } from "./agent-memory";
import { skillsFor, skillsPreamble, finalCheckPreamble } from "./agent-skills";
import { inboxPreamble } from "./agent-comms";
import { thinkTime } from "./reply-timing";
import { sendMessage, getStatus, registerInboundHook, registerOnConnectHook, registerHumanReplyHook, markRead } from "./whatsapp";
import { updateCard, cardPreamble, isHumanHeld, takeover, lastCustomerLine, getCard } from "./lead-card";
import { notify, esc } from "./telegram";
import { say } from "./agent-comms";
import { assertCanSend } from "./plans";
import { provisionOnConnect } from "./provision";

// How often the worker looks for due jobs.
const TICK_MS = 60_000;
// Sends per tick per user. A hundred leads can reach their one-hour mark
// together; releasing them in a burst is exactly the pattern to avoid.
const MAX_PER_TICK_PER_USER = 5;
// A job this far past due is stale — after a long outage, a "one hour later"
// message arriving a week late reads as a mistake.
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

// ── Referral extraction ───────────────────────────────────────────

export interface Referral {
  isAd:        boolean;
  adSourceId:  string | null;
  adSourceUrl: string | null;
  adTitle:     string | null;
  ctwaClid:    string | null;
  entryPoint:  string | null;
  raw:         Record<string, unknown> | null;
}

const EMPTY_REFERRAL: Referral = {
  isAd: false, adSourceId: null, adSourceUrl: null,
  adTitle: null, ctwaClid: null, entryPoint: null, raw: null,
};

/**
 * Pull ad-referral data out of a Baileys message.
 *
 * contextInfo hangs off whichever message variant was sent (extendedText,
 * image, video…), so rather than enumerate them this walks one level down
 * looking for the first contextInfo that carries referral fields.
 */
export function extractReferral(message: unknown): Referral {
  const root = (message as any)?.message ?? message;
  if (!root || typeof root !== "object") return EMPTY_REFERRAL;

  let ctx: any = null;
  for (const value of Object.values(root as Record<string, any>)) {
    const candidate = value?.contextInfo;
    if (candidate && (candidate.externalAdReply || candidate.entryPointConversionSource)) {
      ctx = candidate;
      break;
    }
  }
  if (!ctx) return EMPTY_REFERRAL;

  const ad = ctx.externalAdReply ?? {};
  const entryPoint = ctx.entryPointConversionSource ?? null;

  // Any of these three is enough: a click id, an ad id, or an entry point that
  // names an ad surface.
  const isAd = Boolean(
    ad.ctwaClid || ad.sourceId || (entryPoint && /ctwa|ad/i.test(String(entryPoint))),
  );

  return {
    isAd,
    adSourceId:  ad.sourceId  ?? null,
    adSourceUrl: ad.sourceUrl ?? null,
    adTitle:     ad.title     ?? null,
    ctwaClid:    ad.ctwaClid  ?? null,
    entryPoint,
    // Kept whole so a lead that was not recognised can still be inspected —
    // which matters before the first ad has ever run.
    raw: {
      entryPointConversionSource: entryPoint,
      entryPointConversionApp:    ctx.entryPointConversionApp ?? null,
      externalAdReply: ad.sourceId || ad.ctwaClid || ad.title ? {
        title: ad.title ?? null, body: ad.body ?? null,
        sourceType: ad.sourceType ?? null, sourceId: ad.sourceId ?? null,
        sourceUrl: ad.sourceUrl ?? null, sourceApp: ad.sourceApp ?? null,
        ctwaClid: ad.ctwaClid ?? null, ref: ad.ref ?? null,
      } : null,
    },
  };
}

// ── Lead recording and enrolment ──────────────────────────────────

/** Record where a lead came from. First contact wins; later messages do not overwrite. */
export async function recordLead(userId: number, phone: string, ref: Referral): Promise<"ad" | "organic"> {
  const source = ref.isAd ? "ad" : "organic";
  await db.insert(leadSourcesTable)
    .values({
      userId, phone, source,
      adSourceId: ref.adSourceId, adSourceUrl: ref.adSourceUrl, adTitle: ref.adTitle,
      ctwaClid: ref.ctwaClid, entryPoint: ref.entryPoint,
      rawReferral: ref.raw as any,
    })
    .onConflictDoUpdate({
      target: [leadSourcesTable.userId, leadSourcesTable.phone],
      set: {
        // Only ever upgrade organic -> ad. A lead who first arrived from an ad
        // stays an ad lead even if they message again from elsewhere.
        source:      sql`CASE WHEN ${leadSourcesTable.source} = 'ad' THEN 'ad' ELSE excluded.source END`,
        adSourceId:  sql`COALESCE(${leadSourcesTable.adSourceId},  excluded.ad_source_id)`,
        adSourceUrl: sql`COALESCE(${leadSourcesTable.adSourceUrl}, excluded.ad_source_url)`,
        adTitle:     sql`COALESCE(${leadSourcesTable.adTitle},     excluded.ad_title)`,
        ctwaClid:    sql`COALESCE(${leadSourcesTable.ctwaClid},    excluded.ctwa_clid)`,
        entryPoint:  sql`COALESCE(${leadSourcesTable.entryPoint},  excluded.entry_point)`,
        rawReferral: sql`COALESCE(${leadSourcesTable.rawReferral}, excluded.raw_referral)`,
      },
    });
  return source;
}

/**
 * Schedule every step of each matching active sequence.
 *
 * Offsets run from now — the moment of first contact. Idempotent: the unique
 * index on (sequence, phone, step) means re-running on a later message adds
 * nothing, which matters because this is called for every inbound message.
 */
export async function enrolLead(userId: number, phone: string, source: "ad" | "organic"): Promise<number> {
  const sequences = await db.select().from(followUpSequencesTable)
    .where(and(eq(followUpSequencesTable.userId, userId), eq(followUpSequencesTable.isActive, true)));

  const matching = sequences.filter((s) => s.sourceFilter === "all" || s.sourceFilter === source);
  if (matching.length === 0) return 0;

  const now = Date.now();
  const rows = matching.flatMap((seq) =>
    ((seq.steps as FollowUpStep[]) ?? []).map((step, i) => ({
      userId, sequenceId: seq.id, phone, stepIndex: i,
      dueAt: new Date(now + step.offsetMinutes * 60_000),
    })),
  );
  if (rows.length === 0) return 0;

  const inserted = await db.insert(followUpJobsTable)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: followUpJobsTable.id });

  if (inserted.length > 0) {
    logger.info({ userId, phone, source, scheduled: inserted.length }, "lead enrolled in follow-up");
  }
  return inserted.length;
}

/** Drop the rest of a lead's sequence. */
export async function cancelPendingFollowUps(userId: number, phone: string, reason: string): Promise<number> {
  const cancelled = await db.update(followUpJobsTable)
    .set({ status: "cancelled", error: reason })
    .where(and(
      eq(followUpJobsTable.userId, userId),
      eq(followUpJobsTable.phone, phone),
      eq(followUpJobsTable.status, "pending"),
    ))
    .returning({ id: followUpJobsTable.id });

  if (cancelled.length > 0) {
    logger.info({ userId, phone, reason, cancelled: cancelled.length }, "follow-up cancelled");
  }
  return cancelled.length;
}

// ── Enrolling an imported list ────────────────────────────────────
// Leads from an ad lead form arrive as a spreadsheet, not as a WhatsApp
// message, so they never reach handleInbound and would otherwise be the one
// group of ad leads that never gets followed up.
//
// Worth being clear about what this is: these people have not opened a
// conversation. Whether following up with them is contact they asked for or
// unsolicited messaging depends entirely on where the list came from, which
// the file cannot tell us — hence `source` being declared by the caller. The
// worker's guards (allowance, warm-up, sending hours, opt-out) apply either
// way, and are what keeps a large import from behaving like a blast.

export interface GroupEnrolResult {
  total: number; enrolled: number; skippedOptedOut: number; skippedExisting: number;
  estimatedDays: number;
}

export async function enrolGroup(
  userId: number,
  sequenceId: number,
  groupId: number,
  source: "ad" | "organic" = "ad",
): Promise<GroupEnrolResult> {
  const [seq] = await db.select().from(followUpSequencesTable)
    .where(and(eq(followUpSequencesTable.id, sequenceId), eq(followUpSequencesTable.userId, userId)));
  if (!seq) throw new Error("SEQUENCE_NOT_FOUND: التسلسل غير موجود");
  if (!seq.isActive) throw new Error("SEQUENCE_INACTIVE: فعّل التسلسل أولاً");

  const [group] = await db.select().from(contactGroupsTable)
    .where(and(eq(contactGroupsTable.id, groupId), eq(contactGroupsTable.userId, userId)));
  if (!group) throw new Error("GROUP_NOT_FOUND: القائمة غير موجودة");

  const contacts = await db.select({ phone: contactsTable.phone })
    .from(contactsTable)
    .where(and(eq(contactsTable.groupId, groupId), eq(contactsTable.status, "active")));

  const optedOut = new Set(
    (await db.select({ phone: unsubscribedPhonesTable.phone })
      .from(unsubscribedPhonesTable)
      .where(eq(unsubscribedPhonesTable.userId, userId))).map((r) => r.phone),
  );

  const phones = [...new Set(contacts.map((c) => c.phone))].filter((p) => !optedOut.has(p));
  const skippedOptedOut = contacts.length - phones.length;

  const steps = (seq.steps as FollowUpStep[]) ?? [];
  if (phones.length === 0 || steps.length === 0) {
    return { total: contacts.length, enrolled: 0, skippedOptedOut, skippedExisting: 0, estimatedDays: 0 };
  }

  // Record where they came from, so reporting can tell an imported ad lead
  // from someone who messaged in.
  for (let i = 0; i < phones.length; i += 500) {
    await db.insert(leadSourcesTable)
      .values(phones.slice(i, i + 500).map((phone) => ({ userId, phone, source })))
      .onConflictDoNothing();
  }

  // Spread the base time across an hour so a large import does not produce one
  // instant where every step-0 falls due together.
  const now = Date.now();
  const spreadMs = Math.min(60 * 60_000, phones.length * 5_000);

  let enrolled = 0;
  for (let i = 0; i < phones.length; i += 500) {
    const batch = phones.slice(i, i + 500);
    const rows = batch.flatMap((phone, k) => {
      const offset = ((i + k) / phones.length) * spreadMs;
      return steps.map((step, stepIndex) => ({
        userId, sequenceId, phone, stepIndex,
        dueAt: new Date(now + offset + step.offsetMinutes * 60_000),
      }));
    });
    const done = await db.insert(followUpJobsTable).values(rows)
      .onConflictDoNothing()
      .returning({ id: followUpJobsTable.id });
    enrolled += done.length;
  }

  const skippedExisting = phones.length * steps.length - enrolled;
  const remaining = await getDailyRemaining(userId);
  const perDay = Math.max(1, remaining || 1);

  logger.info(
    { userId, sequenceId, groupId, total: contacts.length, enrolled, skippedOptedOut, source },
    "contact group enrolled in follow-up",
  );

  return {
    total: contacts.length,
    enrolled: Math.round(enrolled / steps.length),   // leads, not individual messages
    skippedOptedOut,
    skippedExisting: Math.round(skippedExisting / steps.length),
    // Rough: the allowance is shared with campaigns, so this is a ceiling.
    estimatedDays: Math.ceil(phones.length / perDay),
  };
}

// ── Inbound handling ──────────────────────────────────────────────

/**
 * Whether this is the lead's first message.
 *
 * A first message enrols; any later one is a reply and stops the sequence.
 * Counted from incoming_messages, which the caller has already written to.
 */
async function isFirstContact(userId: number, phone: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(incomingMessagesTable)
    .where(and(eq(incomingMessagesTable.userId, userId), eq(incomingMessagesTable.phone, phone)));
  return Number(row?.n ?? 0) <= 1;
}

// ── Auto-reply ────────────────────────────────────────────────────
// Capped per contact per hour. The cap is not about cost — it is about the
// other end possibly being a bot too, in which case two auto-repliers will
// talk to each other until someone notices.
const AUTO_REPLY_MAX_PER_HOUR = 8;

// A quarter of model calls were failing on the free tier, and each failure
// was a customer who got nothing. The call is retried on a widening delay,
// three times, and the customer is only given up on after the third.
const REPLY_RETRIES = 3;
const REPLY_RETRY_MS = 75_000;

async function autoReplyIfAppropriate(
  userId: number, phone: string, text: string, intent: Intent,
  /** The inbound message's key, for the read receipt. */
  key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null },
  attempt = 1,
) {
  // Other companies answer campaigns with their own bots. Replying to those
  // spends the daily allowance on nobody, produces bot-to-bot threads that
  // read as automation, and occasionally says something absurd — this account
  // congratulated a cleaning company's autoresponder on its business.
  const [lastOutbound] = await db
    .select({ at: waThreadMessagesTable.createdAt })
    .from(waThreadMessagesTable)
    .where(and(
      eq(waThreadMessagesTable.userId, userId),
      eq(waThreadMessagesTable.phone, phone),
      eq(waThreadMessagesTable.fromMe, true),
    ))
    .orderBy(desc(waThreadMessagesTable.createdAt))
    .limit(1);

  const [inboundCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(incomingMessagesTable)
    .where(and(eq(incomingMessagesTable.userId, userId), eq(incomingMessagesTable.phone, phone)));

  const auto = detectAutoresponder(text, {
    secondsSinceOurMessage: lastOutbound?.at
      ? (Date.now() - new Date(lastOutbound.at).getTime()) / 1000
      : undefined,
    isFirstFromThem: Number(inboundCount?.n ?? 0) <= 1,
  });

  if (auto.isAuto) {
    logger.info({ userId, phone, confidence: auto.confidence, signals: auto.signals }, "inbound looks automated — not replying");
    await logAutoReply({ userId, phone, incoming: text, intent, skipped: `رد آلي من الطرف الآخر (${auto.confidence})` });
    return;
  }

  // A person on the thread outranks every employee. The owner who answered
  // from their phone an hour ago does not want the bot answering over them.
  if (await isHumanHeld(userId, phone)) {
    await logAutoReply({ userId, phone, incoming: text, intent, skipped: "يتولاها بشري" });
    return;
  }

  // Which of the owner's employees this message belongs to. Decided before
  // the gate, because whether a complaint may be answered at all depends on
  // whether anyone was hired to handle one.
  const routing = await route(userId, phone, intent);
  const mine = routing?.agent.specialties.includes(intent) ?? false;

  const gate = await shouldAutoReply(userId, intent, mine);
  if (!gate.ok) {
    if (gate.reason && !/غير مفعّل/.test(gate.reason)) {
      await logAutoReply({ userId, phone, incoming: text, intent, skipped: gate.reason, agentRole: routing?.agent.role });
    }
    return;
  }

  const [recent] = await db
    .select({ n: sql<number>`count(*)` })
    .from(autoReplyLogTable)
    .where(and(
      eq(autoReplyLogTable.userId, userId),
      eq(autoReplyLogTable.phone, phone),
      isNotNull(autoReplyLogTable.reply),
      gte(autoReplyLogTable.createdAt, new Date(Date.now() - 60 * 60_000)),
    ));
  if (Number(recent?.n ?? 0) >= AUTO_REPLY_MAX_PER_HOUR) {
    await logAutoReply({ userId, phone, incoming: text, intent, skipped: "تجاوز حد الردود في الساعة", agentRole: routing?.agent.role });
    return;
  }

  // Everything the employee brings to this reply: who they are, what they were
  // told, what they have learnt, and the skills they hold. Fetched together
  // because none of it depends on the others.
  let voice: string | undefined;
  let finalCheck: string | undefined;
  if (routing) {
    const [memory, skills, inbox] = await Promise.all([
      memoryPreamble(userId, routing.agent.role),
      skillsFor(userId, routing.agent.role, intent),
      inboxPreamble(userId, routing.agent.role, phone),
    ]);
    voice = [personaPreamble(routing), skillsPreamble(skills), memory, inbox]
      .filter(Boolean).join("\n\n");
    finalCheck = finalCheckPreamble(skills);
  }
  // What the team knows about this lead and where the sale is — told to the
  // employee outright, so it is not inferred from the transcript and asked
  // about again.
  const card = await cardPreamble(userId, phone).catch(() => "");

  // Pass the phone so the reply sees the conversation, not just this line.
  const leadCard = await getCard(userId, phone).catch(() => null);
  const answer = await asAgent(userId, routing?.agent.role ?? "sales", () => answerFromKnowledge(
    userId, text, phone, voice,
    routing ? agentJob(routing) : undefined,
    finalCheck,
    card || undefined,
    { card: leadCard },
  ));
  if (!answer.reply) {
    if (answer.retryable && attempt < REPLY_RETRIES) {
      const delay = REPLY_RETRY_MS * attempt;
      logger.warn({ userId, phone, attempt, delayMs: delay }, "النموذج تعذّر — سيُعاد الرد على العميل بعد قليل");
      setTimeout(() => {
        autoReplyIfAppropriate(userId, phone, text, intent, key, attempt + 1)
          .catch((err) => logger.warn({ userId, phone, err: String(err?.message ?? err) }, "فشلت إعادة محاولة الرد"));
      }, delay).unref();
      return;
    }
    await logAutoReply({ userId, phone, incoming: text, intent,
      skipped: attempt > 1 ? `تعذّر النموذج ${attempt} مرات` : (answer.reason ?? "لا رد"), agentRole: routing?.agent.role });
    return;
  }

  try {
    // Wait before the typing indicator even appears. The indicator itself was
    // already running for a plausible length of time; what gave it away was
    // starting the instant the customer's message landed. Nobody notices a
    // message, opens it and begins typing inside half a second.
    //
    // The gap is measured from their previous message, not this one: it says
    // how live the conversation is, which is what decides how fast a person
    // would come back.
    const [prior] = await db
      .select({ at: waThreadMessagesTable.createdAt })
      .from(waThreadMessagesTable)
      .where(and(
        eq(waThreadMessagesTable.userId, userId),
        eq(waThreadMessagesTable.phone, phone),
        eq(waThreadMessagesTable.fromMe, false),
      ))
      .orderBy(desc(waThreadMessagesTable.createdAt))
      .offset(1)
      .limit(1);

    const gulfHour = (new Date().getUTCHours() + 4) % 24;
    const wait = thinkTime({
      minutesSinceTheirLast: prior?.at
        ? (Date.now() - new Date(prior.at).getTime()) / 60_000
        : null,
      incomingLength: text.length,
      outsideHours: gulfHour < 8 || gulfHour >= 22,
    });
    logger.info({ userId, phone, pace: wait.pace, seconds: Math.round(wait.ms / 1000) },
      "ينتظر قبل أن يبدأ الكتابة");

    // The pause has two parts a person would recognise: noticing the message
    // and opening it (the ticks turn blue), then reading and thinking before
    // "typing…" appears. The read receipt goes out between them. Without it
    // every reply from this number arrives from someone who never opened the
    // message, which no phone user has ever seen a person do.
    const noticeMs = Math.round(wait.ms * (0.3 + Math.random() * 0.3));
    await new Promise((r) => setTimeout(r, noticeMs));
    if (key) await markRead(userId, key).catch(() => {});
    await new Promise((r) => setTimeout(r, wait.ms - noticeMs));

    await sendMessage(userId, phone, answer.reply);
    await logAutoReply({ userId, phone, incoming: text, reply: answer.reply, provider: answer.provider, kbIds: answer.kbIds, intent, agentRole: routing?.agent.role, quality: answer.quality });
    logger.info({ userId, phone, provider: answer.provider, kb: answer.kbIds }, "auto-reply sent");
  } catch (err: any) {
    await logAutoReply({ userId, phone, incoming: text, intent, skipped: `فشل الإرسال: ${String(err?.message).slice(0, 40)}`, agentRole: routing?.agent.role });
  }
}

/**
 * Tell the owner when a lead gets hot, and when one agrees.
 *
 * Once each, per lead. A person who wants to close the sale themselves
 * needs to hear about it at the moment it becomes closable, not in the
 * evening report — and the alert says how to take the thread over.
 */
async function announceStage(userId: number, phone: string, reached: 5 | 7, text: string) {
  const c = (await cardPreamble(userId, phone).catch(() => "")).split("\n")[1] ?? "";
  const last = text.slice(0, 160) || await lastCustomerLine(userId, phone).catch(() => "");
  const head = reached === 7 ? "🤝 <b>عميل وافق</b>" : "🔥 <b>عميل مهتم</b>";
  await notify(userId, [
    `${head} — <code>${esc(phone)}</code>`,
    c ? esc(c.replace(/^- /, "")) : "",
    last ? `آخر ما قال: «${esc(last)}»` : "",
    "",
    reached === 7
      ? "البوت لن يبيع من جديد. ردّ من هاتفك أو من التطبيق ويصمت 24 ساعة."
      : "إن أردت أن تتولاه بنفسك: ردّ من هاتفك ويصمت البوت 24 ساعة.",
  ].filter(Boolean).join("\n")).catch(() => {});
  await say({ userId, fromRole: "sales", toRole: "chief", kind: "report", phone,
    body: reached === 7 ? `${phone} وافق — ينتظر تسليماً لبشري.` : `${phone} أبدى اهتماماً — وصل مرحلة العرض.` }).catch(() => {});
}

export async function handleInbound(ev: { userId: number; phone: string; text: string; message: unknown }) {
  const { userId, phone, text } = ev;
  const ref = extractReferral(ev.message);
  const source = await recordLead(userId, phone, ref);
  const first = await isFirstContact(userId, phone);

  const sequences = await db.select().from(followUpSequencesTable)
    .where(and(eq(followUpSequencesTable.userId, userId), eq(followUpSequencesTable.isActive, true)));

  // ── Classify every message, first contact included ────────────
  // The opening message is usually the most informative one — "ابغى اطلب"
  // straight off an ad click, or "كم السعر" — and it used to be the one
  // message that was never read, because first contact enrolled and returned.
  const useAi = sequences.some((s) => s.useAi);
  const verdict = await classify(text, useAi);

  await db.update(leadSourcesTable)
    .set({
      lastIntent:       verdict.intent,
      lastIntentAt:     new Date(),
      intentConfidence: String(verdict.confidence) as any,
      lastMessage:      text.slice(0, 1_000),
    })
    .where(and(eq(leadSourcesTable.userId, userId), eq(leadSourcesTable.phone, phone)));

  logger.info(
    { userId, phone, first, intent: verdict.intent, confidence: verdict.confidence, via: verdict.source, matched: verdict.matched },
    first ? "first message classified" : "reply classified",
  );

  // An explicit stop is honoured before anything else, on any message.
  if (verdict.intent === "opt_out") {
    await db.insert(unsubscribedPhonesTable)
      .values({ userId, phone, reason: "طلب الإيقاف" })
      .onConflictDoNothing();
    await cancelPendingFollowUps(userId, phone, "طلب الإيقاف");
    return;
  }

  // Answer them, if the account has auto-reply on and the knowledge base has
  // something relevant. Deliberately after the opt-out branch above.
  // Judge the previous reply before composing the next one: what the customer
  // just said is the only outcome signal a WhatsApp thread offers, and it is
  // about the message before this one, not this one.
  // Fold what they just said into the card first: the reply is composed
  // against the card, and the outcome of the previous reply is judged partly
  // by whether this message taught us something.
  const cardUpdate = await updateCard(userId, phone, text, verdict.intent).catch((err) => {
    logger.warn({ userId, phone, err: String(err?.message ?? err) }, "تعذّر تحديث بطاقة العميل");
    return null;
  });

  await learnFromOutcome(userId, phone, verdict.intent, { qualified: (cardUpdate?.learnt.length ?? 0) > 0 }).catch((err) => {
    // A lesson not learnt must never cost a reply.
    logger.warn({ userId, phone, err: String(err?.message ?? err) }, "تعذّر تسجيل نتيجة الرد السابق");
  });

  if (cardUpdate?.reached) void announceStage(userId, phone, cardUpdate.reached, text);

  await autoReplyIfAppropriate(userId, phone, text, verdict.intent, (ev.message as any)?.key);

  if (first) {
    // Someone whose opening line is a refusal or a complaint should not be
    // enrolled in a seven-step sequence at all.
    if (verdict.intent === "not_interested" || verdict.intent === "complaint") {
      logger.info({ userId, phone, intent: verdict.intent }, "not enrolling — opening message is not a lead");
      return;
    }
    await enrolLead(userId, phone, source);
    return;
  }

  // ── They answered ─────────────────────────────────────────────
  // Whether that ends the sequence depends on what they said. A bare "مرحبا"
  // is not engagement and the follow-ups should carry on; anything with real
  // content means a person should take over, so the queue is dropped.

  // Per-sequence, because two sequences may disagree about what counts.
  for (const seq of sequences) {
    if (!seq.stopOnReply) continue;
    const carryOn = (seq.continueOnIntents as Intent[] | null) ?? ["greeting", "unclear"];
    if (carryOn.includes(verdict.intent)) continue;

    await db.update(followUpJobsTable)
      .set({ status: "cancelled", error: `رد العميل: ${INTENT_LABELS_AR[verdict.intent]}` })
      .where(and(
        eq(followUpJobsTable.userId, userId),
        eq(followUpJobsTable.phone, phone),
        eq(followUpJobsTable.sequenceId, seq.id),
        eq(followUpJobsTable.status, "pending"),
      ));
  }
}

// ── Worker ────────────────────────────────────────────────────────

/**
 * Send whatever is due.
 *
 * Deliberately conservative: outside sending hours nothing goes out and jobs
 * simply stay pending until the window opens, which turns a 3am follow-up into
 * a 9am one rather than dropping it.
 */
export async function runDueFollowUps(now = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
  const result = { sent: 0, skipped: 0, failed: 0 };

  if (!isWithinSendingHours(now)) return result;

  const due = await db.select().from(followUpJobsTable)
    .where(and(eq(followUpJobsTable.status, "pending"), lte(followUpJobsTable.dueAt, now)))
    .orderBy(asc(followUpJobsTable.dueAt))
    .limit(200);
  if (due.length === 0) return result;

  // Expire anything long overdue rather than sending it late.
  const stale = due.filter((j) => now.getTime() - new Date(j.dueAt).getTime() > STALE_AFTER_MS);
  if (stale.length > 0) {
    await db.update(followUpJobsTable)
      .set({ status: "skipped", error: "تأخر أكثر من اللازم — أُلغي" })
      .where(inArray(followUpJobsTable.id, stale.map((j) => j.id)));
    result.skipped += stale.length;
  }

  const fresh = due.filter((j) => !stale.includes(j));
  const perUser = new Map<number, number>();
  const planOkByUser = new Map<number, boolean>();
  // Cached per tick: the allowance is shared with campaigns, so it has to be
  // read rather than assumed, but re-reading it per job would be wasteful.
  const remainingByUser = new Map<number, number>();

  for (const job of fresh) {
    const used = perUser.get(job.userId) ?? 0;
    if (used >= MAX_PER_TICK_PER_USER) continue;   // next tick
    if (!getStatus(job.userId).connected) continue; // stays pending
    // A lapsed subscription sends nothing. Stays pending for the renewal.
    if (!planOkByUser.has(job.userId)) {
      planOkByUser.set(job.userId, await assertCanSend(job.userId).then(() => true).catch(() => false));
    }
    if (!planOkByUser.get(job.userId)) continue;

    // Follow-ups come off the same number as campaigns and count toward the
    // same warm-up ramp and daily ceiling. Without this a sequence enrolled
    // with an imported list would push hundreds a day straight past both.
    if (!remainingByUser.has(job.userId)) {
      remainingByUser.set(job.userId, await getDailyRemaining(job.userId));
    }
    const left = remainingByUser.get(job.userId)!;
    if (left <= 0) continue;                        // stays pending for tomorrow

    // A person on the thread wins over the ladder: a follow-up landing in
    // the middle of the owner's own conversation reads as a second, dumber
    // salesman. Stays pending; the rung goes out when the person steps back.
    if (await isHumanHeld(job.userId, job.phone)) continue;

    // Opt-out wins over any schedule.
    const [optedOut] = await db.select({ phone: unsubscribedPhonesTable.phone })
      .from(unsubscribedPhonesTable)
      .where(and(eq(unsubscribedPhonesTable.userId, job.userId), eq(unsubscribedPhonesTable.phone, job.phone)))
      .limit(1);
    if (optedOut) {
      await db.update(followUpJobsTable)
        .set({ status: "cancelled", error: "ألغى الاشتراك" })
        .where(eq(followUpJobsTable.id, job.id));
      result.skipped++;
      continue;
    }

    const [seq] = await db.select().from(followUpSequencesTable)
      .where(eq(followUpSequencesTable.id, job.sequenceId));
    const step = ((seq?.steps as FollowUpStep[]) ?? [])[job.stepIndex];

    if (!seq?.isActive || !step) {
      await db.update(followUpJobsTable)
        .set({ status: "cancelled", error: seq?.isActive ? "الخطوة لم تعد موجودة" : "التسلسل متوقف" })
        .where(eq(followUpJobsTable.id, job.id));
      result.skipped++;
      continue;
    }

    try {
      await sendMessage(job.userId, job.phone, step.message);
      await db.update(followUpJobsTable)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(followUpJobsTable.id, job.id));
      result.sent++;
      perUser.set(job.userId, used + 1);
      remainingByUser.set(job.userId, left - 1);
      logger.info({ userId: job.userId, phone: job.phone, step: job.stepIndex, sequenceId: seq.id }, "follow-up sent");
    } catch (err: any) {
      await db.update(followUpJobsTable)
        .set({ status: "failed", error: String(err?.message ?? err).slice(0, 500) })
        .where(eq(followUpJobsTable.id, job.id));
      result.failed++;
      logger.warn({ userId: job.userId, phone: job.phone, err: err?.message }, "follow-up send failed");
    }

    // Space the sends inside a tick.
    await new Promise((r) => setTimeout(r, 2_000 + Math.random() * 3_000));
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;

// The owner answered from their phone. The bot has nothing to add for a day.
registerHumanReplyHook(async ({ userId, phone }) => {
  await takeover(userId, phone, "phone");
});

export function startFollowUpEngine() {
  registerInboundHook(handleInbound);
  // Every account that links WhatsApp gets the bot's scaffolding, so the only
  // remaining step is turning it on.
  registerOnConnectHook((userId) => { void provisionOnConnect(userId); });

  if (timer) return;
  timer = setInterval(() => {
    runDueFollowUps().catch((err) => logger.error({ err }, "follow-up worker tick failed"));
  }, TICK_MS);
  logger.info({ tickSeconds: TICK_MS / 1000 }, "follow-up engine started");
}

export function stopFollowUpEngine() {
  if (timer) { clearInterval(timer); timer = null; }
}
