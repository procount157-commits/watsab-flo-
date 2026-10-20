// ── The stop button, and «no» for good ───────────────────────────
// Every campaign carries «إيقاف الرسائل». The owner (2026-10-20): «من اختار
// لا، اختار ما ترسل لي، خلاص ما هرسل له تاني». So a tap, a lone «0», a typed
// «إيقاف», or any short message that asks us to stop puts the person on the
// account's blacklist for good — every send path and the firewall's gate
// refuse them afterwards. Nothing lifts it but the owner, by hand.
//
// Offering the way out is also the cheapest protection the number has: a
// recipient who can stop the messages with one tap does not reach for
// "report and block", which is what gets a sender banned.

import { db, unsubscribedPhonesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/** Kept for callers that still read it: a stop is permanent, so no months. */
export const STOP_MONTHS = 0;
export const STOP_ACK = "تم ✅ أوقفنا رسائلنا لك.";

/** The line campaigns used to end with, before the button: «🔕 لإيقاف الرسائل أرسل: 0». */
export const LEGACY_ZERO_LINE = /\n*━+\n🔕 لإيقاف الرسائل أرسل: 0[ \t]*/g;
export const stripZeroLine = (message: string) => message.replace(LEGACY_ZERO_LINE, "").trimEnd();

/** Whether a tapped button's id is the stop button's (`btn:stop:<n>`). */
export const isStopTap = (id: string | null | undefined) => !!id && /^btn:stop:/.test(id);

/** The tapped quick-reply's id, from the native-flow response, if this message is a tap. */
export function tappedButtonId(message: any): string | null {
  const raw = message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (!raw) return null;
  try { const id = JSON.parse(raw)?.id; return typeof id === "string" ? id : null; } catch { return null; }
}

/**
 * Off the list for good. A row that was once temporary becomes permanent too:
 * the person said no, and the owner's rule is that no is final.
 */
export async function stopForGood(userId: number, phone: string, reason = "زر إيقاف الرسائل"): Promise<void> {
  await db.insert(unsubscribedPhonesTable)
    .values({ userId, phone, reason, expiresAt: null })
    .onConflictDoUpdate({
      target: [unsubscribedPhonesTable.userId, unsubscribedPhonesTable.phone],
      set: { expiresAt: null },
    });
}

/** The old name, kept so every caller still compiles; it stops for good now. */
export async function stopForMonths(userId: number, phone: string, reason = "زر إيقاف الرسائل"): Promise<Date> {
  await stopForGood(userId, phone, reason);
  return new Date(8_640_000_000_000_000);
}

/** Rows from before the rule, with a date on them, are made permanent; nothing is lifted. */
export async function sweepExpiredOptOuts(): Promise<number> {
  const made = await db.update(unsubscribedPhonesTable).set({ expiresAt: null })
    .where(sql`${unsubscribedPhonesTable.expiresAt} IS NOT NULL`)
    .returning({ id: unsubscribedPhonesTable.id });
  if (made.length) logger.info({ made: made.length }, "timed stops made permanent — a no is final");
  return made.length;
}

export function startOptOutSweep() {
  const run = () => sweepExpiredOptOuts().catch((err) => logger.warn({ err: String(err) }, "opt-out sweep failed"));
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 60 * 60_000).unref();
}

/**
 * Whether a message, on its own, asks us to stop. Short messages only — a
 * long one that mentions «إلغاء» is about something else — with punctuation
 * and emoji ignored, in Arabic, Gulf Arabic and English. Pure.
 */
export function asksToStop(text: string): boolean {
  const t = String(text ?? "").toLowerCase()
    .replace(/[ً-ْـ]/g, "").replace(/[إأآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 45) return false;
  return /^(0|stop|unsubscribe|remove me|stop messaging|dont message me|do not message me|no more messages|توقف|وقف|اوقف|ايقاف|ايقاف الرسائل|الغاء|الغاء الاشتراك|لا ارسال|لا تراسلني|لا تراسلوني|لا ترسل|لا ترسلوا|لا ترسلو|لا ترسلون|لا ترسل لي|ارفع رقمي|ارفعوا رقمي|شيل رقمي|شيلوا رقمي|احذف رقمي|احذفوا رقمي|امسح رقمي|امسحوا رقمي|ما ابي رسايل|ما ابغي رسايل|ما ابي رسائل|ما ابغي رسائل|لا اريد رسائل|لا اريد رسايل|ما اريد رسائل|بطلوا ترسلوا|خلاص لا ترسلوا|ازعاج|مش عايز رسايل|مش عايز رسائل|ما بدي رسائل|ما بدي رسايل)( (لي|لو سمحت|please|plz|شكرا|من فضلك))?$/.test(t);
}

const STOP_BUTTON = { text: "إيقاف الرسائل", type: "stop" as const, url: "", color: "red" };

/**
 * Every campaign message carries the stop button — whatever its type, and
 * whenever it was made. Text becomes a button message, an image or a video
 * gets the button under it, a message with buttons gets it last. Only a
 * carousel, which is several messages, goes as it is. The old «أرسل: 0»
 * line is taken out, since the button replaces it.
 */
export function withStopButton(message: string, messageType: string | null | undefined, buttons: string | null | undefined): { message: string; messageType: string; buttons: string | null } {
  const type = messageType ?? "text";
  const text = stripZeroLine(message);
  if (type === "carousel") return { message: text, messageType: type, buttons: buttons ?? null };
  let list: any[] = [];
  try { const p = buttons ? JSON.parse(buttons) : []; if (Array.isArray(p)) list = p.filter((b) => b?.text?.trim()); } catch { list = []; }
  if (!list.some((b) => b.type === "stop")) list.push(STOP_BUTTON);
  const sent = type === "image" || type === "image_button" ? "image_button"
    : type === "video" || type === "video_button" ? "video_button"
    : type === "text" || type === "button" ? "button"
    : type;
  return { message: text, messageType: sent, buttons: JSON.stringify(list) };
}
