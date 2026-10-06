// ── The stop button ───────────────────────────────────────────────
// Every campaign can carry «إيقاف الرسائل». A tap puts the number on the
// account's unsubscribed list for five months — every send path already
// skips that list — and the sweep below takes it off again when the time is
// up. A customer who typed «إيقاف» themselves stays off for good, and a tap
// never shortens that.
//
// Offering the way out is also the cheapest protection the number has: a
// recipient who can stop the messages with one tap does not reach for
// "report and block", which is what gets a sender banned.

import { db, unsubscribedPhonesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

export const STOP_MONTHS = 5;
export const STOP_ACK = "تم ✅ أوقفنا رسائلنا لك.";

/** The day the block lifts: the same date, five months on. */
export function stopUntil(from = new Date()): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + STOP_MONTHS);
  return d;
}

/** Whether a tapped button's id is the stop button's (`btn:stop:<n>`). */
export const isStopTap = (id: string | null | undefined) => !!id && /^btn:stop:/.test(id);

/** The tapped quick-reply's id, from the native-flow response, if this message is a tap. */
export function tappedButtonId(message: any): string | null {
  const raw = message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (!raw) return null;
  try { const id = JSON.parse(raw)?.id; return typeof id === "string" ? id : null; } catch { return null; }
}

/**
 * Off the list for five months. If the number is already off for good, it
 * stays that way; if it is off until an earlier date, the later date wins.
 */
export async function stopForMonths(userId: number, phone: string, reason = "زر إيقاف الرسائل"): Promise<Date> {
  const until = stopUntil();
  await db.insert(unsubscribedPhonesTable)
    .values({ userId, phone, reason, expiresAt: until })
    .onConflictDoUpdate({
      target: [unsubscribedPhonesTable.userId, unsubscribedPhonesTable.phone],
      set: {
        expiresAt: sql`CASE WHEN ${unsubscribedPhonesTable.expiresAt} IS NULL THEN NULL
                            ELSE GREATEST(${unsubscribedPhonesTable.expiresAt}, excluded.expires_at) END`,
      },
    });
  return until;
}

/** Lift the blocks whose five months are up. */
export async function sweepExpiredOptOuts(): Promise<number> {
  const gone = await db.delete(unsubscribedPhonesTable)
    .where(sql`${unsubscribedPhonesTable.expiresAt} IS NOT NULL AND ${unsubscribedPhonesTable.expiresAt} <= now()`)
    .returning({ id: unsubscribedPhonesTable.id });
  if (gone.length) logger.info({ lifted: gone.length }, "stop-button blocks ended — those numbers may be messaged again");
  return gone.length;
}

export function startOptOutSweep() {
  const run = () => sweepExpiredOptOuts().catch((err) => logger.warn({ err: String(err) }, "opt-out sweep failed"));
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}
