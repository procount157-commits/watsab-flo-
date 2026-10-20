// ── Daily allowance ───────────────────────────────────────────────
// One number, one budget. Campaign sends and follow-up sends both come off the
// same WhatsApp account and both count toward the same ban risk, so they share
// a limit rather than each having their own.
//
// This used to live inside routes/campaigns.ts and counted message_logs alone,
// which made follow-ups invisible to it: a sequence could push hundreds of
// messages a day past a warm-up ramp that campaigns were carefully respecting.

import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db, messageLogs, campaignsTable, waSessionEventsTable, followUpJobsTable,
  incomingMessagesTable, unsubscribedPhonesTable, usersTable,
} from "@workspace/db";
import { asc } from "drizzle-orm";

// New numbers start low and grow, so day one cannot look like a blast.
//   Day 0 → 50   Day 1 → 65   Day 2 → 85   Day 5 → 185
//   Day 7 → 310  Day 10 → 680  Day 14 → 1500 (ceiling)
export const DAILY_LIMIT_MAX   = 1_500;
export const WARMUP_DAY0_LIMIT = 50;
export const WARMUP_DAILY_GROW = 1.30;

/** Days since this number first connected; 0 for one that never has. */
export async function numberAgeDays(userId: number): Promise<number> {
  const [firstConn] = await db
    .select({ createdAt: waSessionEventsTable.createdAt })
    .from(waSessionEventsTable)
    .where(and(
      eq(waSessionEventsTable.userId, userId),
      eq(waSessionEventsTable.event, "connected"),
    ))
    .orderBy(asc(waSessionEventsTable.createdAt))
    .limit(1);
  if (!firstConn) return 0;
  return Math.floor((Date.now() - new Date(firstConn.createdAt).getTime()) / (24 * 60 * 60 * 1_000));
}

// ── Engagement ────────────────────────────────────────────────────
// The ramp used to grow on one input: days since linking. A number that had
// sent 2,000 messages and heard back from nobody earned the same allowance as
// one running real conversations, and the first of those is the one WhatsApp
// flags. So the ramp is scaled by what the number's own recipients did with
// it — whether anyone wrote back, and whether anyone asked it to stop.

export interface Engagement {
  /** Distinct people written to in the window. */
  sent: number;
  /** Distinct people among them who wrote back. */
  repliers: number;
  /** Opt-outs recorded in the window. */
  optOuts: number;
}

/** Below this many recipients the ratios are noise and the ramp runs as it is. */
export const ENGAGEMENT_MIN_SENT = 100;

/**
 * Multiplier on the warm-up allowance from how recipients have responded.
 * Pure. Never raises the allowance — a chatty number earns the full ramp,
 * not more than it.
 */
export function engagementFactor(e: Engagement): number {
  if (e.sent < ENGAGEMENT_MIN_SENT) return 1;
  const optOutRate = e.optOuts / e.sent;
  const replyRate  = e.repliers / e.sent;
  // People asking to stop is the strongest signal there is; it halves the
  // allowance before anything else is considered.
  if (optOutRate >= 0.02) return 0.5;
  if (replyRate < 0.01) return 0.6;   // nobody answers: this is a broadcast, not a business
  if (replyRate < 0.03) return 0.8;
  return 1;
}

/** How this number's recipients responded over the last seven days. */
export async function engagement7d(userId: number): Promise<Engagement> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const mine = db.select({ id: campaignsTable.id }).from(campaignsTable)
    .where(eq(campaignsTable.userId, userId));
  const written = db.selectDistinct({ phone: messageLogs.phone }).from(messageLogs)
    .where(and(inArray(messageLogs.campaignId, mine), eq(messageLogs.status, "sent"), gte(messageLogs.sentAt, since)));

  const [[sentRow], [replyRow], [optRow]] = await Promise.all([
    db.select({ n: sql<number>`count(distinct ${messageLogs.phone})` }).from(messageLogs)
      .where(and(inArray(messageLogs.campaignId, mine), eq(messageLogs.status, "sent"), gte(messageLogs.sentAt, since))),
    db.select({ n: sql<number>`count(distinct ${incomingMessagesTable.phone})` }).from(incomingMessagesTable)
      .where(and(eq(incomingMessagesTable.userId, userId), gte(incomingMessagesTable.receivedAt, since),
                 inArray(incomingMessagesTable.phone, written))),
    db.select({ n: count() }).from(unsubscribedPhonesTable)
      .where(and(eq(unsubscribedPhonesTable.userId, userId), gte(unsubscribedPhonesTable.createdAt, since))),
  ]);
  return { sent: Number(sentRow?.n ?? 0), repliers: Number(replyRow?.n ?? 0), optOuts: Number(optRow?.n ?? 0) };
}

/**
 * Today's allowance for this number: the warm-up ramp, scaled by engagement,
 * and never above the cap an admin set on the account — which existed as a
 * column and a form field and was read by nothing.
 */
export async function getEffectiveDailyLimit(userId: number): Promise<number> {
  try {
    const [days, eng, [user]] = await Promise.all([
      numberAgeDays(userId),
      engagement7d(userId).catch(() => null),
      db.select({ cap: usersTable.dailyMessageLimit }).from(usersTable).where(eq(usersTable.id, userId)).limit(1),
    ]);
    const ramp = Math.min(DAILY_LIMIT_MAX, Math.round(WARMUP_DAY0_LIMIT * Math.pow(WARMUP_DAILY_GROW, days)));
    const factor = eng ? engagementFactor(eng) : 1;
    const allowance = Math.max(WARMUP_DAY0_LIMIT, Math.round(ramp * factor));
    return user?.cap && user.cap > 0 ? Math.min(allowance, user.cap) : allowance;
  } catch {
    return DAILY_LIMIT_MAX; // DB trouble — do not hard-stop sending
  }
}

/** Everything this number sent in the last 24h: campaigns and follow-ups together. */
export async function getDailySentCount(userId: number): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000);

  const [campaigns] = await db
    .select({ total: count() })
    .from(messageLogs)
    .innerJoin(campaignsTable, eq(messageLogs.campaignId, campaignsTable.id))
    .where(and(
      eq(campaignsTable.userId, userId),
      eq(messageLogs.status, "sent"),
      gte(messageLogs.sentAt, cutoff),
    ));

  const [followUps] = await db
    .select({ total: count() })
    .from(followUpJobsTable)
    .where(and(
      eq(followUpJobsTable.userId, userId),
      eq(followUpJobsTable.status, "sent"),
      gte(followUpJobsTable.sentAt, cutoff),
    ));

  // The follow-ups خالد writes and sends — the same number, the same ceiling.
  const smart = await db.execute(sql`SELECT count(*)::int AS n FROM followup_deliberations
    WHERE user_id = ${userId} AND executed AND step >= 100 AND created_at >= ${cutoff}`).catch(() => ({ rows: [{ n: 0 }] }));

  return Number(campaigns?.total ?? 0) + Number(followUps?.total ?? 0) + Number((smart.rows[0] as any)?.n ?? 0);
}

/** Room left today, never negative. */
export async function getDailyRemaining(userId: number): Promise<number> {
  const [limit, used] = await Promise.all([
    getEffectiveDailyLimit(userId),
    getDailySentCount(userId),
  ]);
  return Math.max(0, limit - used);
}
