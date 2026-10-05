// ── Each client's deadlines ───────────────────────────────────────
// The owner enters them — VAT returns, corporate tax, licence renewals, AML
// reviews — and the system only ever reminds about a date it was given: a
// wrong date here is a fine for the client, so nothing is inferred.
//
// When one comes within its reminder window, سارة drafts the reminder for the
// client's group as a suggestion (she never sends — the owner copies it), and
// the owner hears about it on Telegram. A recurring one moves to its next
// date once this one has passed.

import { and, asc, eq, sql } from "drizzle-orm";
import { db, clientObligationsTable, waGroupSuggestionsTable, type ClientObligation } from "@workspace/db";
import { notify, esc } from "../telegram";
import { logger } from "../logger";

export const KIND_AR: Record<string, string> = { vat: "ضريبة القيمة المضافة", ct: "ضريبة الشركات", license: "تجديد الرخصة", aml: "مراجعة AML", payroll: "الرواتب", audit: "التدقيق", other: "التزام" };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const gulfToday = (now = new Date()) => iso(new Date(now.getTime() + 4 * 3_600_000));

/** The next date of a recurring obligation, after `from`. */
export function nextDue(due: string, recurrence: string): string | null {
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[recurrence];
  if (!months) return null;
  const [y, m, d] = due.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  // The 31st of a month without one is that month's last day, not the 1st of the next.
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return iso(target);
}

/** The reminder text: the date and the documents, as the owner entered them — no figure of its own. */
export function reminderText(o: Pick<ClientObligation, "title" | "dueDate" | "documents" | "clientName">) {
  const date = new Date(`${o.dueDate}T00:00:00Z`).toLocaleDateString("ar-AE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return [
    `تذكير ودي: موعد ${o.title} في ${date}.`,
    o.documents ? `حتى نجهّزه في وقته، نرجو تزويدنا بـ: ${o.documents}.` : "حتى نجهّزه في وقته، نرجو تزويدنا بالمستندات المطلوبة في أقرب وقت.",
    "وإذا كان عندكم أي سؤال نحن جاهزون.",
  ].join("\n");
}

export async function listObligations(userId: number) {
  return db.select().from(clientObligationsTable).where(eq(clientObligationsTable.userId, userId)).orderBy(asc(clientObligationsTable.dueDate));
}

/** Reminders due today, rolled-over recurring dates, and the owner told. Safe to run as often as wanted. */
export async function sweepObligations(now = new Date(), userId?: number) {
  const today = gulfToday(now);
  const rows = await db.select().from(clientObligationsTable).where(and(eq(clientObligationsTable.active, true), userId ? eq(clientObligationsTable.userId, userId) : sql`true`));
  const told = new Map<number, ClientObligation[]>();
  let reminded = 0, rolled = 0, closed = 0;
  for (const o of rows) {
    // A date gone by: the next one for a recurring obligation, the end for a one-off.
    if (o.dueDate < today) {
      const next = nextDue(o.dueDate, o.recurrence);
      if (next) { await db.update(clientObligationsTable).set({ dueDate: next }).where(eq(clientObligationsTable.id, o.id)); rolled++; o.dueDate = next; }
      else { await db.update(clientObligationsTable).set({ active: false }).where(eq(clientObligationsTable.id, o.id)); closed++; continue; }
    }
    const windowStart = iso(new Date(new Date(`${o.dueDate}T00:00:00Z`).getTime() - o.remindDays * 86_400_000));
    if (today < windowStart || o.lastRemindedDue === o.dueDate) continue;
    if (o.groupJid) {
      await db.insert(waGroupSuggestionsTable).values({
        userId: o.userId, groupJid: o.groupJid, triggerMessageId: `obl-${o.id}-${o.dueDate}`, triggerText: `تذكير التزام: ${o.title} — ${o.dueDate}`,
        suggestion: reminderText(o), reason: `${KIND_AR[o.kind] ?? "التزام"} لـ ${o.clientName} يحين ${o.dueDate} — تذكير قبل ${o.remindDays} أيام`, status: "pending", provider: "calendar",
      });
    }
    await db.update(clientObligationsTable).set({ lastRemindedDue: o.dueDate }).where(eq(clientObligationsTable.id, o.id));
    told.set(o.userId, [...(told.get(o.userId) ?? []), o]);
    reminded++;
  }
  for (const [uid, list] of told) {
    await notify(uid, [`<b>📅 مواعيد عملاء تقترب (${list.length})</b>`, ...list.map((o) => `• <b>${esc(o.clientName)}</b> — ${esc(o.title)}: ${o.dueDate}${o.groupJid ? " (التذكير جاهز في القروب)" : ""}`)].join("\n"), "groups").catch(() => {});
  }
  return { reminded, rolled, closed };
}

export function startObligationReminders() {
  setTimeout(() => {
    void sweepObligations().catch(() => {});
    setInterval(() => void sweepObligations().catch((err) => logger.warn({ err: String(err) }, "obligation sweep failed")), 60 * 60_000);
  }, 3 * 60_000);
}

