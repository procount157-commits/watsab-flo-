// ── Telegram ──────────────────────────────────────────────────────
// Reports reach the owner where they already are, rather than waiting on a
// dashboard nobody has open at 7am.
//
// The linking is the awkward part, and it is Telegram's rule rather than a
// design choice: a bot cannot open a conversation with a person. The owner has
// to message it first, and only then does its chat id exist. So `link` polls
// getUpdates for a recent message and takes the chat from it.

import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db, telegramSettingsTable, notifyOutboxTable, type TelegramSettings } from "@workspace/db";
import { logger } from "./logger";

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

async function call<T = any>(token: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(API(token, method), {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const d = await res.json() as any;
  if (!d?.ok) throw new Error(d?.description ?? `telegram ${method} ${res.status}`);
  return d.result as T;
}

/** Confirms a token before it is stored, and names the bot for the UI. */
export async function verifyToken(token: string): Promise<{ username: string; name: string }> {
  const me = await call<any>(token, "getMe");
  return { username: me.username, name: me.first_name };
}

export async function getSettings(userId: number): Promise<TelegramSettings | null> {
  const [row] = await db.select().from(telegramSettingsTable)
    .where(eq(telegramSettingsTable.userId, userId)).limit(1);
  return row ?? null;
}

export async function saveToken(userId: number, botToken: string): Promise<void> {
  await db.insert(telegramSettingsTable)
    .values({ userId, botToken, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: telegramSettingsTable.userId,
      // A new token means a new bot, so the old chat id no longer applies.
      set: { botToken, chatId: null, chatTitle: null, linkedAt: null, lastError: null, updatedAt: new Date() },
    });
}

/**
 * Look for a message the owner has sent the bot, and remember where it came
 * from.
 *
 * Takes the most recent update rather than the first: if the owner tried twice,
 * the second attempt is the one they are watching.
 */
export async function link(userId: number): Promise<{ linked: boolean; chatTitle?: string }> {
  const s = await getSettings(userId);
  if (!s) throw new Error("لم يُضف توكن بعد");

  const updates = await call<any[]>(s.botToken, "getUpdates");
  const withChat = updates
    .map((u) => u.message ?? u.edited_message ?? u.channel_post)
    .filter((m) => m?.chat?.id);
  const last = withChat[withChat.length - 1];
  if (!last) return { linked: false };

  const chat = last.chat;
  const title = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ") ?? String(chat.id);
  await db.update(telegramSettingsTable)
    .set({ chatId: String(chat.id), chatTitle: title.slice(0, 120), linkedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(telegramSettingsTable.userId, userId));

  logger.info({ userId, chatTitle: title }, "تليجرام مربوط");
  return { linked: true, chatTitle: title };
}

/**
 * Send, and never throw.
 *
 * Every caller is an agent finishing a job. A Telegram outage must not fail
 * the report that was being delivered, and a failure here is a delivery
 * problem, not a reason to discard the work.
 */
/** One attempt. The queue decides what a failure means. */
async function deliver(s: TelegramSettings, text: string): Promise<void> {
  await call(s.botToken, "sendMessage", {
    chat_id: s.chatId,
    text: text.slice(0, 4_000),
    parse_mode: "HTML",
    // A report is for reading, not for chasing a link preview.
    disable_web_page_preview: true,
  });
}

/**
 * Send, and keep the message if it cannot go now.
 *
 * This used to catch a failure, log it, return false, and that was the end of
 * the report. The owner's complaint that nothing ever reached Telegram was
 * exactly right, and the cause was not here: the laptop sleeps after a minute
 * on battery and the log holds 1,734 network failures. Treating each as final
 * meant every report sent while it slept was lost.
 *
 * Writing it down first turns a dropped report into a late one. The return
 * value still says whether it went immediately, for callers that care.
 */
export async function notify(userId: number, text: string, kind = "general"): Promise<boolean> {
  const s = await getSettings(userId);
  // Not configured is not a failure to retry — there is nowhere to send it.
  if (!s?.chatId || !s.enabled) return false;

  try {
    await deliver(s, text);
    return true;
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 300);
    await db.insert(notifyOutboxTable).values({
      userId, body: text.slice(0, 4_000), kind,
      attempts: 1, lastError: msg,
      nextTryAt: new Date(Date.now() + 60_000),
    }).catch(() => {});
    await db.update(telegramSettingsTable).set({ lastError: msg })
      .where(eq(telegramSettingsTable.userId, userId)).catch(() => {});
    logger.warn({ userId, err: msg }, "تعذّر الإرسال إلى تليجرام — حُفظت للإعادة");
    return false;
  }
}

/** Minutes before the next attempt. Long enough that a sleeping laptop is given time to wake. */
const BACKOFF_MIN = [1, 3, 10, 30, 60, 180];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

/**
 * Retry what is waiting.
 *
 * Oldest first, so a report arrives in the order it happened — a campaign's
 * "finished" landing before its "started" would be worse than either being
 * late.
 */
export async function flushOutbox(limit = 20): Promise<{ sent: number; failed: number; dead: number }> {
  const due = await db.select().from(notifyOutboxTable)
    .where(and(eq(notifyOutboxTable.status, "pending"), lte(notifyOutboxTable.nextTryAt, new Date())))
    .orderBy(asc(notifyOutboxTable.createdAt))
    .limit(limit);

  let sent = 0, failed = 0, dead = 0;
  const settings = new Map<number, TelegramSettings | null>();

  for (const row of due) {
    if (!settings.has(row.userId)) settings.set(row.userId, await getSettings(row.userId));
    const s = settings.get(row.userId);
    if (!s?.chatId || !s.enabled) {
      await db.update(notifyOutboxTable).set({ status: "dead", lastError: "تليجرام غير مربوط" })
        .where(eq(notifyOutboxTable.id, row.id));
      dead++;
      continue;
    }
    try {
      await deliver(s, row.body);
      await db.update(notifyOutboxTable).set({ status: "sent", sentAt: new Date() })
        .where(eq(notifyOutboxTable.id, row.id));
      sent++;
    } catch (err: any) {
      const attempts = row.attempts + 1;
      const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]!;
      // Given up on after three hours of trying, rather than retried for ever
      // — a report about this morning is not worth sending tomorrow.
      const status = attempts >= MAX_ATTEMPTS ? "dead" : "pending";
      await db.update(notifyOutboxTable).set({
        attempts, status,
        lastError: String(err?.message ?? err).slice(0, 300),
        nextTryAt: new Date(Date.now() + wait * 60_000),
      }).where(eq(notifyOutboxTable.id, row.id));
      if (status === "dead") dead++; else failed++;
    }
  }
  if (sent || dead) logger.info({ sent, failed, dead }, "صندوق التقارير المؤجلة");
  return { sent, failed, dead };
}

/** How many reports are waiting, for the diagnostics page. */
export async function outboxState(userId: number) {
  const [row] = await db.select({
    pending: sql<number>`count(*) filter (where ${notifyOutboxTable.status} = 'pending')`,
    dead:    sql<number>`count(*) filter (where ${notifyOutboxTable.status} = 'dead')`,
    sent:    sql<number>`count(*) filter (where ${notifyOutboxTable.status} = 'sent')`,
    oldest:  sql<Date | null>`min(${notifyOutboxTable.createdAt}) filter (where ${notifyOutboxTable.status} = 'pending')`,
  }).from(notifyOutboxTable).where(eq(notifyOutboxTable.userId, userId));
  return {
    pending: Number(row?.pending ?? 0),
    dead: Number(row?.dead ?? 0),
    sent: Number(row?.sent ?? 0),
    oldest: row?.oldest ?? null,
  };
}

/**
 * Drain the queue every minute.
 *
 * A minute rather than ten: the window between this laptop waking and sleeping
 * again is short, and a queue that checks rarely will keep missing it.
 */
export function startOutboxWorker(): void {
  setInterval(() => void flushOutbox().catch((err) =>
    logger.error({ err: String(err?.message ?? err) }, "فشل تفريغ صندوق التقارير")), 60_000);
  logger.info("عامل صندوق التقارير بدأ");
}

/** Accounts that can actually receive something. */
export async function linkedUsers(): Promise<number[]> {
  const rows = await db.select({ userId: telegramSettingsTable.userId })
    .from(telegramSettingsTable)
    .where(and(isNotNull(telegramSettingsTable.chatId), eq(telegramSettingsTable.enabled, true)));
  return rows.map((r) => r.userId);
}

/** Telegram's HTML subset is small; anything unescaped breaks the whole message. */
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
