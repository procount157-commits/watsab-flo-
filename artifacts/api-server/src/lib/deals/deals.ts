// ── Deals: from a hot conversation to a paying client ─────────────
// Every channel used to end at "hot" — a Telegram message and a tag. A deal
// carries it on: lead → meeting → proposal → negotiation → won or lost.
// One opens by itself when a lead turns hot on any channel (WhatsApp, email,
// Instagram, TikTok), or by the owner's hand; and whatever the customer said
// on any channel is read back as one history, so whoever picks it up next —
// the owner before a call, the proposal writer before a quote — has all of it.

import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db, dealsTable, autoReplyLogTable, emailInboundTable, emailMessagesTable, socialThreadsTable, socialMessagesTable, leadCardsTable,
  type Deal, type DealStage,
} from "@workspace/db";
import { notify, esc } from "../telegram";
import { logger } from "../logger";

export const STAGE_AR: Record<DealStage, string> = { lead: "عميل محتمل", meeting: "اجتماع", proposal: "عرض سعر", negotiation: "تفاوض", won: "تم التعاقد", lost: "خسرناه" };
export const CHANNEL_AR: Record<string, string> = { whatsapp: "واتساب", email: "البريد", instagram: "إنستجرام", tiktok: "تيك توك", linkedin: "لينكدإن", groups: "القروبات", manual: "يدوي" };

export type DealInput = {
  channel: string; ref?: string | null; title?: string | null; company?: string | null; contactName?: string | null;
  email?: string | null; phone?: string | null; service?: string | null; notes?: string | null; stage?: DealStage;
};

/**
 * One deal per company, whichever channel it came from: an existing open
 * deal with the same email, phone or channel handle is returned rather than a
 * second one opened. `created` says which happened.
 */
export async function openDeal(userId: number, d: DealInput, opts: { announce?: boolean } = {}): Promise<{ deal: Deal; created: boolean }> {
  const ref = d.ref?.trim().toLowerCase().slice(0, 200) || null;
  const email = d.email?.trim().toLowerCase() || null, phone = d.phone?.replace(/\D/g, "") || null;
  const match = [ref ? and(eq(dealsTable.channel, d.channel), eq(dealsTable.ref, ref)) : null, email ? eq(dealsTable.email, email) : null, phone ? eq(dealsTable.phone, phone) : null].filter(Boolean) as any[];
  if (match.length) {
    const [found] = await db.select().from(dealsTable).where(and(eq(dealsTable.userId, userId), or(...match), sql`${dealsTable.stage} not in ('won','lost')`)).orderBy(desc(dealsTable.updatedAt)).limit(1);
    if (found) {
      // What the new channel adds, without overwriting what the owner wrote.
      const fill: Record<string, unknown> = {};
      if (!found.email && email) fill["email"] = email;
      if (!found.phone && phone) fill["phone"] = phone;
      if (!found.company && d.company) fill["company"] = d.company.slice(0, 200);
      if (!found.contactName && d.contactName) fill["contactName"] = d.contactName.slice(0, 160);
      if (Object.keys(fill).length) await db.update(dealsTable).set({ ...fill, updatedAt: new Date() }).where(eq(dealsTable.id, found.id));
      return { deal: { ...found, ...fill } as Deal, created: false };
    }
  }
  const title = (d.title || d.company || d.contactName || ref || "صفقة جديدة").slice(0, 200);
  const [deal] = await db.insert(dealsTable).values({
    userId, title, company: d.company?.slice(0, 200) ?? null, contactName: d.contactName?.slice(0, 160) ?? null, channel: d.channel, ref,
    email, phone, service: d.service?.slice(0, 160) ?? null, notes: d.notes ?? null, stage: d.stage ?? "lead", nextStep: "تواصل لتحديد الاحتياج وموعد مكالمة",
  }).onConflictDoNothing().returning();
  if (!deal) {
    const [again] = await db.select().from(dealsTable).where(and(eq(dealsTable.userId, userId), eq(dealsTable.channel, d.channel), eq(dealsTable.ref, ref!))).limit(1);
    return { deal: again!, created: false };
  }
  if (opts.announce) await notify(userId, `<b>💼 صفقة جديدة من ${esc(CHANNEL_AR[d.channel] ?? d.channel)}</b>\n${esc(title)}${d.notes ? `\n${esc(d.notes.slice(0, 200))}` : ""}`, "deals").catch(() => {});
  logger.info({ userId, dealId: deal.id, channel: d.channel }, "صفقة جديدة");
  return { deal, created: true };
}

/** Opened in the background where a lead turns hot; never in the way of the reply that found it. */
export function dealFromHotLead(userId: number, d: DealInput) {
  void openDeal(userId, { ...d, stage: "lead" }, { announce: false }).catch((err) => logger.warn({ err: String(err) }, "deal from hot lead failed"));
}

export async function setStage(userId: number, id: number, stage: DealStage, opts: { lostReason?: string | null } = {}) {
  const set: Record<string, unknown> = { stage, updatedAt: new Date() };
  if (stage === "won") set["wonAt"] = new Date();
  if (stage === "lost") set["lostReason"] = opts.lostReason?.slice(0, 300) ?? null;
  const [row] = await db.update(dealsTable).set(set).where(and(eq(dealsTable.id, id), eq(dealsTable.userId, userId))).returning();
  return row ?? null;
}

/** Only ever forwards: a deal at proposal is not dragged back to meeting because a call got booked. */
const ORDER: DealStage[] = ["lead", "meeting", "proposal", "negotiation", "won"];
export async function advance(userId: number, id: number, to: DealStage) {
  const [d] = await db.select().from(dealsTable).where(and(eq(dealsTable.id, id), eq(dealsTable.userId, userId))).limit(1);
  if (!d || d.stage === "won" || d.stage === "lost") return d ?? null;
  if (ORDER.indexOf(to) <= ORDER.indexOf(d.stage)) return d;
  return setStage(userId, id, to);
}

export type TimelineItem = { at: Date; channel: string; fromUs: boolean; text: string };

/** Everything the customer and we said, on every channel the deal knows about, oldest first. */
export async function timeline(userId: number, deal: Deal, limit = 60): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];
  const phone = deal.phone ?? (deal.channel === "whatsapp" ? deal.ref : null);
  const email = deal.email ?? (deal.channel === "email" ? deal.ref : null);
  if (phone) {
    const rows = await db.select().from(autoReplyLogTable).where(and(eq(autoReplyLogTable.userId, userId), eq(autoReplyLogTable.phone, phone))).orderBy(desc(autoReplyLogTable.createdAt)).limit(30);
    for (const r of rows) {
      if (r.incoming) items.push({ at: r.createdAt, channel: "whatsapp", fromUs: false, text: r.incoming });
      if (r.reply && !r.skipped) items.push({ at: new Date(r.createdAt.getTime() + 1), channel: "whatsapp", fromUs: true, text: r.reply });
    }
  }
  if (email) {
    const [ins, outs] = await Promise.all([
      db.select().from(emailInboundTable).where(and(eq(emailInboundTable.userId, userId), ilike(emailInboundTable.fromEmail, email))).orderBy(desc(emailInboundTable.receivedAt)).limit(20),
      db.select().from(emailMessagesTable).where(and(eq(emailMessagesTable.userId, userId), ilike(emailMessagesTable.toEmail, email), inArray(emailMessagesTable.status, ["sent"]))).orderBy(desc(emailMessagesTable.createdAt)).limit(20),
    ]);
    for (const r of ins) items.push({ at: r.receivedAt, channel: "email", fromUs: false, text: `${r.subject ? `${r.subject}: ` : ""}${r.text ?? ""}` });
    for (const r of outs) items.push({ at: r.sentAt ?? r.createdAt, channel: "email", fromUs: true, text: r.subject });
  }
  if (deal.ref && ["instagram", "tiktok", "linkedin"].includes(deal.channel)) {
    const [t] = await db.select().from(socialThreadsTable).where(and(eq(socialThreadsTable.userId, userId), eq(socialThreadsTable.platform, deal.channel), eq(socialThreadsTable.handle, deal.ref))).limit(1);
    if (t) {
      const msgs = await db.select().from(socialMessagesTable).where(and(eq(socialMessagesTable.threadId, t.id), inArray(socialMessagesTable.status, ["received", "sent"]))).orderBy(desc(socialMessagesTable.createdAt)).limit(30);
      for (const m of msgs) items.push({ at: m.sentAt ?? m.createdAt, channel: deal.channel, fromUs: m.fromMe, text: m.text });
    }
  }
  return items.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-limit);
}

/** What the WhatsApp side already learned about the lead — its stage, activity, pain — when the deal has a phone. */
export async function cardFacts(userId: number, deal: Deal) {
  const phone = deal.phone ?? (deal.channel === "whatsapp" ? deal.ref : null);
  if (!phone) return null;
  const [c] = await db.select().from(leadCardsTable).where(and(eq(leadCardsTable.userId, userId), eq(leadCardsTable.phone, phone))).limit(1);
  if (!c) return null;
  return [c.activity && `النشاط: ${c.activity}`, c.size && `الحجم: ${c.size}`, c.taxStatus && `الوضع الضريبي: ${c.taxStatus}`, c.accountant && `المحاسب الحالي: ${c.accountant}`, c.pain && `المشكلة: ${c.pain}`, c.objection && `الاعتراض: ${c.objection}`].filter(Boolean).join("\n") || null;
}

/** A deal's whole story in a few lines, for a prompt or a reminder. */
export async function dealBrief(userId: number, deal: Deal, maxItems = 14) {
  const [t, card] = await Promise.all([timeline(userId, deal, maxItems), cardFacts(userId, deal)]);
  return [
    `${deal.title}${deal.company && deal.company !== deal.title ? ` — ${deal.company}` : ""}${deal.contactName ? ` (${deal.contactName})` : ""} · ${CHANNEL_AR[deal.channel] ?? deal.channel} · ${STAGE_AR[deal.stage]}`,
    deal.service ? `الخدمة: ${deal.service}` : "",
    deal.notes ? `ملاحظات: ${deal.notes}` : "",
    card ?? "",
    t.length ? `آخر ما قيل:\n${t.map((x) => `${x.fromUs ? "نحن" : "العميل"} (${CHANNEL_AR[x.channel] ?? x.channel}): ${x.text.replace(/\s+/g, " ").slice(0, 220)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

export async function pipeline(userId: number) {
  const rows = await db.select().from(dealsTable).where(eq(dealsTable.userId, userId)).orderBy(desc(dealsTable.updatedAt)).limit(500);
  const won30 = rows.filter((d) => d.stage === "won" && d.wonAt && Date.now() - d.wonAt.getTime() < 30 * 86_400_000);
  return {
    deals: rows,
    totals: Object.fromEntries((Object.keys(STAGE_AR) as DealStage[]).map((s) => [s, { n: rows.filter((d) => d.stage === s).length, value: rows.filter((d) => d.stage === s).reduce((a, d) => a + Number(d.valueAed ?? 0), 0) }])),
    won30: { n: won30.length, value: won30.reduce((a, d) => a + Number(d.valueAed ?? 0), 0) },
  };
}
