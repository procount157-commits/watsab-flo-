// ── Meetings with customers ───────────────────────────────────────
// The owner says when he takes calls; the rest follows from that: the free
// times are worked out from his hours minus what is already booked; the
// agents offer them, in so many words, when someone asks for a call; a
// customer can pick one on the booking page; and half an hour before, the
// owner gets everything the customer said on every channel, in one message.
//
// All times are Gulf time (UTC+4, no daylight saving), which is what the
// owner and his customers keep.

import crypto from "node:crypto";
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import { db, meetingSettingsTable, clientMeetingsTable, dealsTable, type MeetingSettings, type Slot, type ClientMeeting } from "@workspace/db";
import { notify, esc } from "../telegram";
import { logger } from "../logger";
import { advance, dealBrief, openDeal } from "./deals";

const GULF = 4 * 3_600_000;
export const DOW_AR = ["", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"];

export async function settingsFor(userId: number): Promise<MeetingSettings> {
  const [s] = await db.select().from(meetingSettingsTable).where(eq(meetingSettingsTable.userId, userId)).limit(1);
  if (s) return s;
  const [made] = await db.insert(meetingSettingsTable).values({ userId, bookingToken: crypto.randomBytes(18).toString("hex"),
    slots: [1, 2, 3, 4].map((dow) => ({ dow, from: "10:00", to: "13:00" })) }).onConflictDoNothing().returning();
  return made ?? (await db.select().from(meetingSettingsTable).where(eq(meetingSettingsTable.userId, userId)).limit(1))[0]!;
}

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

/**
 * Free start times from `from`, for `days` days: inside the owner's hours,
 * at least `noticeHours` ahead, not overlapping a booked meeting (with the
 * buffer either side). Pure, so it can be checked without a database.
 */
export function freeSlots(s: Pick<MeetingSettings, "slots" | "durationMin" | "bufferMin" | "noticeHours">, booked: Array<{ startsAt: Date; durationMin: number }>, from: Date, days = 10, max = 40): Date[] {
  const out: Date[] = [];
  const earliest = from.getTime() + s.noticeHours * 3_600_000;
  const step = s.durationMin + s.bufferMin;
  for (let d = 0; d < days && out.length < max; d++) {
    // The Gulf calendar day d days from now, as UTC midnight of that Gulf date.
    const gulfMidnight = new Date(Math.floor((from.getTime() + GULF) / 86_400_000) * 86_400_000 + d * 86_400_000);
    const dow = ((gulfMidnight.getUTCDay() + 6) % 7) + 1; // Mon=1 … Sun=7
    for (const slot of (s.slots as Slot[]).filter((x) => x.dow === dow)) {
      for (let m = minutes(slot.from); m + s.durationMin <= minutes(slot.to); m += step) {
        const start = gulfMidnight.getTime() + m * 60_000 - GULF;
        if (start < earliest) continue;
        const end = start + s.durationMin * 60_000;
        const clash = booked.some((b) => {
          const bs = b.startsAt.getTime() - s.bufferMin * 60_000, be = b.startsAt.getTime() + (b.durationMin + s.bufferMin) * 60_000;
          return start < be && end > bs;
        });
        if (!clash) out.push(new Date(start));
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

export async function availableSlots(userId: number, days = 10, max = 40) {
  const s = await settingsFor(userId);
  const now = new Date();
  const booked = await db.select({ startsAt: clientMeetingsTable.startsAt, durationMin: clientMeetingsTable.durationMin }).from(clientMeetingsTable)
    .where(and(eq(clientMeetingsTable.userId, userId), eq(clientMeetingsTable.status, "booked"), gte(clientMeetingsTable.startsAt, new Date(now.getTime() - 86_400_000))));
  return freeSlots(s, booked, now, days, max);
}

/** A time as the customer reads it: «الثلاثاء ٧ أكتوبر، ١٠:٣٠ صباحاً» or "Tue 7 Oct, 10:30 AM". */
export function slotLabel(d: Date, lang: "ar" | "en" = "ar") {
  return d.toLocaleString(lang === "ar" ? "ar-AE" : "en-GB", { timeZone: "Asia/Dubai", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true });
}

/** Spread out: not three times in one morning, so a customer has a real choice. */
export function spread(slots: Date[], n: number) {
  const out: Date[] = [];
  for (const s of slots) {
    if (out.some((o) => Math.abs(o.getTime() - s.getTime()) < 20 * 3_600_000)) continue;
    out.push(s);
    if (out.length >= n) break;
  }
  return out.length >= n ? out : slots.slice(0, n);
}

/**
 * The line an agent's prompt gets: when someone asks for a call, offer these
 * exact times — never a time the owner does not take. Empty when the owner
 * switched it off or has no free time.
 */
export async function offerLine(userId: number, lang: "ar" | "en" = "ar") {
  const s = await settingsFor(userId);
  if (!s.offerInReplies) return "";
  const slots = spread(await availableSlots(userId, 7, 30), 3);
  if (!slots.length) return "";
  const base = process.env["SITE_URL"]?.replace(/\/+$/, "");
  return [
    "إن طلب العميل مكالمة أو اجتماعاً أو سأل متى يمكن التحدث: اقترح هذه الأوقات بالضبط ولا غيرها (بتوقيت الخليج):",
    ...slots.map((d) => `- ${slotLabel(d, lang)}`),
    base ? `أو رابط الحجز: ${base}/book/${s.bookingToken}` : "",
    "لا تقترح وقتاً من عندك، ولا تؤكد موعداً — صاحب العمل يؤكده.",
  ].filter(Boolean).join("\n");
}

export type BookInput = { name: string; company?: string | null; email?: string | null; phone?: string | null; startsAt: Date; topic?: string | null; dealId?: number | null; source: "link" | "manual" };

/** A meeting, if the time is still free; its deal moves to «اجتماع». */
export async function book(userId: number, b: BookInput): Promise<ClientMeeting> {
  const s = await settingsFor(userId);
  if (b.source === "link") {
    const free = await availableSlots(userId, 30, 2_000);
    if (!free.some((f) => f.getTime() === b.startsAt.getTime())) throw new Error("هذا الوقت لم يعد متاحاً — اختر وقتاً آخر");
  }
  let dealId = b.dealId ?? null;
  if (!dealId) {
    const { deal } = await openDeal(userId, { channel: b.email ? "email" : b.phone ? "whatsapp" : "manual", ref: b.email ?? b.phone ?? null, company: b.company, contactName: b.name, email: b.email, phone: b.phone, notes: b.topic ?? null });
    dealId = deal.id;
  }
  const [m] = await db.insert(clientMeetingsTable).values({ userId, dealId, name: b.name.slice(0, 160), company: b.company?.slice(0, 200) ?? null, email: b.email ?? null, phone: b.phone ?? null,
    startsAt: b.startsAt, durationMin: s.durationMin, source: b.source, topic: b.topic ?? null }).returning();
  await advance(userId, dealId, "meeting");
  await db.update(dealsTable).set({ nextStep: `اجتماع ${slotLabel(b.startsAt)}`, nextAt: b.startsAt, updatedAt: new Date() }).where(eq(dealsTable.id, dealId));
  await notify(userId, `<b>📅 موعد جديد${b.source === "link" ? " — حجزه العميل بنفسه" : ""}</b>\n${esc(b.name)}${b.company ? ` — ${esc(b.company)}` : ""}\n${esc(slotLabel(b.startsAt))}${b.topic ? `\n${esc(b.topic.slice(0, 200))}` : ""}`, "deals").catch(() => {});
  return m!;
}

/** Before each meeting, the customer's whole story — once. */
export async function remindMeetings(now = new Date(), userId?: number) {
  const due = await db.select({ m: clientMeetingsTable, reminderMin: meetingSettingsTable.reminderMin }).from(clientMeetingsTable)
    .innerJoin(meetingSettingsTable, eq(meetingSettingsTable.userId, clientMeetingsTable.userId))
    .where(and(eq(clientMeetingsTable.status, "booked"), isNull(clientMeetingsTable.remindedAt), gte(clientMeetingsTable.startsAt, now),
      sql`${clientMeetingsTable.startsAt} <= ${now.toISOString()}::timestamptz + make_interval(mins => ${meetingSettingsTable.reminderMin})`, userId ? eq(clientMeetingsTable.userId, userId) : sql`true`));
  for (const { m } of due) {
    const [deal] = m.dealId ? await db.select().from(dealsTable).where(eq(dealsTable.id, m.dealId)).limit(1) : [];
    const brief = deal ? await dealBrief(m.userId, deal, 10).catch(() => "") : "";
    await notify(m.userId, [`<b>⏰ اجتماع بعد قليل — ${esc(slotLabel(m.startsAt))}</b>`, `${esc(m.name)}${m.company ? ` — ${esc(m.company)}` : ""}${m.phone ? ` · ${esc(m.phone)}` : ""}${m.email ? ` · ${esc(m.email)}` : ""}`, m.topic ? `الموضوع: ${esc(m.topic)}` : "", brief ? `\n${esc(brief.slice(0, 2_500))}` : ""].filter(Boolean).join("\n"), "deals").catch(() => {});
    await db.update(clientMeetingsTable).set({ remindedAt: new Date() }).where(eq(clientMeetingsTable.id, m.id));
  }
  return due.length;
}

export function startMeetingReminders() {
  setInterval(() => void remindMeetings().catch((err) => logger.warn({ err: String(err) }, "meeting reminders failed")), 5 * 60_000);
}

/** The meeting as a calendar file, for the owner's own calendar. */
export function ics(m: ClientMeeting, organizer: string) {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(m.startsAt.getTime() + m.durationMin * 60_000);
  const esc2 = (s: string) => s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FlowHub//Meetings//AR", "BEGIN:VEVENT", `UID:meeting-${m.id}@flowhub`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(m.startsAt)}`, `DTEND:${f(end)}`,
    `SUMMARY:${esc2(`${m.name}${m.company ? ` — ${m.company}` : ""}`)}`, `DESCRIPTION:${esc2([m.topic, m.phone, m.email].filter(Boolean).join("\n"))}`, `ORGANIZER:${esc2(organizer)}`,
    "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Meeting", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

export async function upcoming(userId: number) {
  return db.select().from(clientMeetingsTable).where(and(eq(clientMeetingsTable.userId, userId), gte(clientMeetingsTable.startsAt, new Date(Date.now() - 7 * 86_400_000))))
    .orderBy(asc(clientMeetingsTable.startsAt)).limit(200);
}

