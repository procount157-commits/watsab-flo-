// ── What we sent them, before they wrote ─────────────────────────
// Nearly every conversation on this number starts with us: a campaign landed,
// and the customer is answering it. The employee who reads the reply has to
// know what it is a reply to. Without that, «مهتم» got "رخصتك مين لاند ولا
// فري زون؟" and a company's greeting got "what does your business do?" — the
// replies of someone who had not seen their own company's message.
//
// The thread now records our words as they go (whatsapp.ts recordOutbound),
// but campaigns sent before that left an empty row, and the thread holds only
// the last few turns. So the latest campaign this number received is read
// from the campaign itself and handed to the employee in plain words.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, messageLogs, campaignsTable, contactsTable } from "@workspace/db";
import { fillRecipient } from "./recipient-name";

/** A campaign template as one reader would have seen it: company filled, first choice of each {a|b}, pools dropped. */
export function readableTemplate(template: string, contactName?: string | null): string {
  return fillRecipient(template, contactName)
    .replace(/\{([^{}|]*)\|[^{}]*\}/g, "$1")
    .replace(/\{[^{}]*\}/g, "")
    .replace(/\n*━+\n🔕[^\n]*/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type Outreach = { campaign: string; text: string; buttons: string[]; daysAgo: number; read: boolean };

/** The name this number is saved under in the account's lists — usually its company. */
export async function savedName(userId: number, phone: string): Promise<string | null> {
  const [c] = await db.select({ name: contactsTable.name }).from(contactsTable)
    .where(and(eq(contactsTable.phone, phone), sql`${contactsTable.groupId} IN (SELECT id FROM contact_groups WHERE user_id = ${userId})`, sql`${contactsTable.name} IS NOT NULL AND ${contactsTable.name} <> ''`))
    .limit(1);
  return c?.name ?? null;
}

export async function lastOutreach(userId: number, phone: string, contactName?: string | null): Promise<Outreach | null> {
  const [row] = await db
    .select({
      name: campaignsTable.name, message: campaignsTable.message, buttons: campaignsTable.buttons,
      sentAt: messageLogs.sentAt, readAt: messageLogs.readAt,
    })
    .from(messageLogs)
    .innerJoin(campaignsTable, eq(messageLogs.campaignId, campaignsTable.id))
    .where(and(
      eq(messageLogs.phone, phone),
      eq(campaignsTable.userId, userId),
      eq(messageLogs.status, "sent"),
      gte(messageLogs.sentAt, new Date(Date.now() - 45 * 86_400_000)),
    ))
    .orderBy(desc(messageLogs.sentAt))
    .limit(1);
  if (!row?.message) return null;
  let buttons: string[] = [];
  try { buttons = (JSON.parse(row.buttons ?? "[]") as Array<{ text?: string; type?: string }>).filter((b) => b.type !== "stop").map((b) => b.text ?? "").filter(Boolean); } catch { /* none */ }
  return {
    campaign: row.name,
    text: readableTemplate(row.message, contactName).slice(0, 900),
    buttons,
    daysAgo: row.sentAt ? Math.floor((Date.now() - new Date(row.sentAt).getTime()) / 86_400_000) : 0,
    read: !!row.readAt,
  };
}

/** The block for the employee's instructions. */
export function outreachPreamble(o: Outreach | null, company?: string | null): string {
  if (!o) return company ? `═══ من هو ═══\nرقمه محفوظ عندنا باسم: ${company}` : "";
  const when = o.daysAgo === 0 ? "اليوم" : o.daysAgo === 1 ? "أمس" : `قبل ${o.daysAgo} أيام`;
  return [
    `═══ ما أرسلناه له قبل أن يكتب (${when}، حملة «${o.campaign}») ═══`,
    `«${o.text}»`,
    company ? `رقمه محفوظ عندنا باسم: ${company}` : "",
    o.buttons.length ? `وكان تحتها أزرار: ${o.buttons.join(" · ")}` : "",
    "رسالته على الأغلب ردّ على هذه. أكمل موضوعها هي: لا تعرّف بالشركة من جديد، ولا تسأله «وش نشاطك» قبل أن تربط كلامه بما أرسلناه.",
  ].filter(Boolean).join("\n");
}
