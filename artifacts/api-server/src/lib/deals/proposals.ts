// ── عمّار: the proposal writer ────────────────────────────────────
// A proposal written from what the customer actually said, on every channel,
// and from the firm's own knowledge of its services. The one thing he never
// writes on his own is a price that is not in that knowledge: he leaves a
// blank — [[السعر]] — and a proposal with a blank cannot be sent. The owner
// approves (and edits) every one before it leaves, the edit is what he learns
// from, and an unanswered proposal gets at most two short follow-ups, each
// approved too.

import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db, dealsTable, proposalsTable, botEmployeesTable, emailMessagesTable, type Proposal } from "@workspace/db";
import { complete } from "../llm";
import { asAgent } from "../agent-context";
import { lessonsFor, recordFeedback } from "../feedback";
import { retrieve } from "../knowledge";
import { passages } from "../email/knowledge-docs";
import { guardCheck, EMAIL_DOCTRINE } from "../email/team";
import { getSettings } from "../email/service";
import { newToken, renderEmail } from "../email/tracking";
import { sendEmail, isConfigured, messageIdFor } from "../email/provider";
import { brandOf } from "../email/layout";
import { notify, esc } from "../telegram";
import { logger } from "../logger";
import { advance, dealBrief, setStage } from "./deals";

export const ROLE = "proposals";
const BLANK = /\[\[[^\]]+\]\]/;
const FOLLOWUP_DAYS = [3, 5];

export async function ensureWriter(userId: number) {
  const [e] = await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, ROLE))).limit(1);
  if (e) return e;
  const [made] = await db.insert(botEmployeesTable).values({ userId, name: "عمّار", role: ROLE, kind: "internal", title: "مُعِدّ عروض الأسعار", avatar: "📄", specialties: [], priority: 993, handoffTo: null,
    persona: "يكتب عروض أسعار وخطابات تكليف لشركة خدمات محاسبية وضريبية وامتثال في الإمارات. يبني كل عرض على ما قاله العميل فعلاً — نشاطه، مشكلته، ما طلبه — لا على قالب. واضح في النطاق: ما يشمله العرض وما لا يشمله. لا يكتب سعراً ليس في معرفة الشركة: يترك خانة [[السعر]] لصاحب العمل. لا يعد بنتيجة تنظيمية ولا يخترع مهلة أو غرامة." } as any).returning();
  return made!;
}

async function knowledgeFor(userId: number, q: string) {
  const [facts, docs] = await Promise.all([retrieve(userId, q, 5).catch(() => []), passages(userId, q, { limit: 4 }).catch(() => [])]);
  return { text: [...facts.map((f) => `${f.entry.title}\n${f.entry.content}`), ...docs.map((d) => `${d.title}\n${d.text}`)].join("\n\n"), facts, docs };
}

/** A draft proposal for the deal. Numbers not in the firm's knowledge come back as issues to fix before it can be approved. */
export async function writeProposal(userId: number, dealId: number, input: { service?: string | null; notes?: string | null } = {}) {
  const [deal] = await db.select().from(dealsTable).where(and(eq(dealsTable.id, dealId), eq(dealsTable.userId, userId))).limit(1);
  if (!deal) throw new Error("الصفقة غير موجودة");
  const me = await ensureWriter(userId);
  const s = await getSettings(userId);
  const lang = (s?.defaultLanguage ?? "en") === "ar" ? "ar" : "en";
  const service = input.service || deal.service || "";
  const [brief, kb, lessons] = await Promise.all([dealBrief(userId, deal, 18), knowledgeFor(userId, `${service} ${deal.notes ?? ""} عرض سعر أسعار رسوم`), lessonsFor(userId, ROLE, `${service} ${deal.company ?? ""}`).catch(() => "")]);
  const out = await asAgent(userId, ROLE, () => complete([
    { role: "system", content: [
      `اسمك ${me.name}، ${me.title}.`, me.persona ?? "", "", EMAIL_DOCTRINE, lessons,
      kb.text ? `معرفة الشركة عن خدماتها وأسعارها (المصدر الوحيد لأي رقم):\n${kb.text.slice(0, 7_000)}` : "لا توجد معرفة مسجّلة عن الأسعار — اترك كل سعر خانة [[السعر]].",
      "",
      `اكتب عرض سعر رسمياً موجّهاً لهذا العميل ${lang === "ar" ? "بالعربية المهنية الواضحة" : "in clear professional English"}، بصيغة HTML بسيطة (h3, p, ul/li, و table للرسوم فقط).`,
      "البنية: تحية باسمه ← فهمنا لوضعه واحتياجه (من كلامه هو) ← نطاق العمل (ما يشمله العرض وما لا يشمله) ← طريقة العمل والجدول الزمني ← الرسوم ← الخطوة التالية ← التوقيع باسم الشركة.",
      "الرسوم: اكتب السعر فقط إن وجدته في معرفة الشركة نصاً لهذه الخدمة؛ وإلا اكتب [[السعر]] حرفياً في مكانه. لا تقدّر ولا تقرّب.",
      "لا تخترع مهلة قانونية أو غرامة أو نسبة. لا تعد بنتيجة. لا تكتب مدة صلاحية أو شروط دفع ليست في المعرفة — اترك [[شروط الدفع]] إن احتجت.",
      "اكتب HTML وحده، بلا ``` وبلا شرح.",
    ].filter(Boolean).join("\n") },
    { role: "user", content: `العميل والصفقة:\n${brief}\n\nالخدمة المطلوبة: ${service || "(حدّدها من المحادثة)"}${input.notes ? `\nتعليمات صاحب العمل لهذا العرض: ${input.notes}` : ""}` },
  ], 60_000));
  const html = (out?.text ?? "").replace(/^```(?:html)?\s*|\s*```$/g, "").trim();
  if (html.length < 80) throw new Error("لم يكتب الموظف عرضاً — حاول بعد قليل");
  const title = `${lang === "ar" ? "عرض سعر" : "Proposal"} — ${deal.company ?? deal.title}${service ? ` — ${service}` : ""}`.slice(0, 200);
  const [p] = await db.insert(proposalsTable).values({ userId, dealId, title, html, originalHtml: html }).returning();
  await advance(userId, dealId, "proposal");
  if (service && !deal.service) await db.update(dealsTable).set({ service: service.slice(0, 160) }).where(eq(dealsTable.id, dealId));
  return { proposal: p!, issues: issuesOf(html, kb.text) };
}

/** What stops a proposal from going out: a blank left to fill, or a number the firm never wrote down. */
export function issuesOf(html: string, knowledge: string) {
  const issues = guardCheck([html], knowledge);
  const blanks = [...new Set(html.match(/\[\[[^\]]+\]\]/g) ?? [])];
  if (blanks.length) issues.unshift(`خانات تنتظر أن تملأها: ${blanks.join("، ")}`);
  return issues;
}

/** The owner's yes: sent by email, as edited. */
export async function sendProposal(userId: number, id: number, opts: { html?: string; to?: string; subject?: string } = {}) {
  const [p] = await db.select().from(proposalsTable).where(and(eq(proposalsTable.id, id), eq(proposalsTable.userId, userId))).limit(1);
  if (!p) throw new Error("العرض غير موجود");
  if (p.status === "sent") throw new Error("أُرسل هذا العرض من قبل");
  const [deal] = await db.select().from(dealsTable).where(eq(dealsTable.id, p.dealId)).limit(1);
  const html = (opts.html ?? p.html).trim();
  if (BLANK.test(html)) throw new Error("في العرض خانات لم تُملأ بعد (مثل [[السعر]]) — املأها ثم أرسل");
  const to = (opts.to ?? deal?.email ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error("لا بريد صالح للعميل — اكتب بريده");
  const s = await getSettings(userId);
  if (!isConfigured(s)) throw new Error("إعدادات البريد غير مكتملة");
  const subject = (opts.subject ?? p.title).slice(0, 300);
  await deliver(userId, s!, { to, toName: deal?.contactName ?? null, subject, html });
  await db.update(proposalsTable).set({ html, status: "sent", sentTo: to, sentAt: new Date(), nextFollowupAt: new Date(Date.now() + FOLLOWUP_DAYS[0]! * 86_400_000), updatedAt: new Date() }).where(eq(proposalsTable.id, id));
  if (deal && !deal.email) await db.update(dealsTable).set({ email: to.toLowerCase() }).where(eq(dealsTable.id, deal.id));
  await recordFeedback({ userId, role: ROLE, channel: "email", kind: "proposal", refId: id, context: deal?.title ?? null, original: p.originalHtml ?? p.html, final: html, verdict: opts.html && opts.html.trim() !== (p.originalHtml ?? p.html).trim() ? "edited" : "approved" });
  if (deal) await db.update(dealsTable).set({ nextStep: "متابعة عرض السعر", nextAt: new Date(Date.now() + FOLLOWUP_DAYS[0]! * 86_400_000), updatedAt: new Date() }).where(eq(dealsTable.id, deal.id));
}

async function deliver(userId: number, s: NonNullable<Awaited<ReturnType<typeof getSettings>>>, m: { to: string; toName: string | null; subject: string; html: string }) {
  const token = newToken();
  const r = renderEmail(m.html + (s.signature ? `<div style="margin-top:20px">${s.signature}</div>` : ""), {}, { base: "", token, secret: "x", pixel: false, links: false } as any,
    { base: "", token, fromName: s.fromName ?? s.fromEmail!, fromEmail: s.fromEmail! }, brandOf(s));
  const messageId = messageIdFor(token, s.fromEmail!);
  const [row] = await db.insert(emailMessagesTable).values({ userId, toEmail: m.to, subject: m.subject, token, status: "queued", messageIdHdr: messageId }).returning();
  try {
    const sent = await sendEmail(s, { to: m.to, toName: m.toName, subject: m.subject, html: r.html, text: r.text, messageId, unsubscribeUrl: null });
    await db.update(emailMessagesTable).set({ status: "sent", sentAt: new Date(), providerId: sent.providerId }).where(eq(emailMessagesTable.id, row!.id));
  } catch (err: any) {
    await db.update(emailMessagesTable).set({ status: "failed", error: String(err?.message ?? err).slice(0, 400) }).where(eq(emailMessagesTable.id, row!.id));
    throw err;
  }
}

export async function setOutcome(userId: number, id: number, outcome: "accepted" | "declined", reason?: string | null) {
  const [p] = await db.update(proposalsTable).set({ status: outcome, nextFollowupAt: null, followupDraft: null, updatedAt: new Date() }).where(and(eq(proposalsTable.id, id), eq(proposalsTable.userId, userId))).returning();
  if (p) await setStage(userId, p.dealId, outcome === "accepted" ? "won" : "lost", { lostReason: reason ?? "رفض عرض السعر" });
  return p ?? null;
}

/** Proposals sent and unanswered past their date get a short follow-up drafted — at most two, each waiting for approval. */
export async function draftDueFollowups(now = new Date(), userId?: number) {
  const due = await db.select({ p: proposalsTable, d: dealsTable }).from(proposalsTable).innerJoin(dealsTable, eq(dealsTable.id, proposalsTable.dealId))
    .where(and(eq(proposalsTable.status, "sent"), lt(proposalsTable.nextFollowupAt, now), isNull(proposalsTable.followupDraft), lt(proposalsTable.followups, FOLLOWUP_DAYS.length),
      sql`${dealsTable.stage} not in ('won','lost')`, userId ? eq(proposalsTable.userId, userId) : sql`true`));
  for (const { p, d } of due) {
    const brief = await dealBrief(p.userId, d, 6).catch(() => "");
    const out = await asAgent(p.userId, ROLE, () => complete([
      { role: "system", content: `أنت مُعِدّ العروض. اكتب متابعة قصيرة جداً (٣ أسطر) لعرض سعر أُرسل ولم يُرد عليه، بلغة العرض نفسها. سؤال واحد سهل: هل وصل العرض، هل من سؤال، هل نحدد مكالمة قصيرة. بلا ضغط وبلا لوم وبلا «آخر فرصة». نص عادي لا HTML.` },
      { role: "user", content: `العرض: ${p.title}\nأُرسل: ${p.sentAt?.toISOString().slice(0, 10)}\n${brief}` },
    ], 25_000)).catch(() => null);
    const text = out?.text?.trim();
    if (!text) continue;
    await db.update(proposalsTable).set({ followupDraft: text.slice(0, 1_500), updatedAt: new Date() }).where(eq(proposalsTable.id, p.id));
    await notify(p.userId, `<b>📄 عرض سعر بلا رد</b>\n${esc(p.title)}\nكتب عمّار متابعة تنتظر موافقتك في صفحة الصفقات.`, "deals").catch(() => {});
  }
  return due.length;
}

export async function sendFollowup(userId: number, id: number, text?: string) {
  const [p] = await db.select().from(proposalsTable).where(and(eq(proposalsTable.id, id), eq(proposalsTable.userId, userId))).limit(1);
  if (!p?.followupDraft || !p.sentTo) throw new Error("لا متابعة تنتظر");
  const body = (text ?? p.followupDraft).trim();
  const s = await getSettings(userId);
  if (!isConfigured(s)) throw new Error("إعدادات البريد غير مكتملة");
  await deliver(userId, s!, { to: p.sentTo, toName: null, subject: `Re: ${p.title}`, html: `<div dir="auto" style="white-space:pre-wrap">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>` });
  const n = p.followups + 1;
  await db.update(proposalsTable).set({ followups: n, followupDraft: null, nextFollowupAt: FOLLOWUP_DAYS[n] ? new Date(Date.now() + FOLLOWUP_DAYS[n]! * 86_400_000) : null, updatedAt: new Date() }).where(eq(proposalsTable.id, id));
  await recordFeedback({ userId, role: ROLE, channel: "email", kind: "proposal_fu", refId: id, context: p.title, original: p.followupDraft, final: body, verdict: text && text.trim() !== p.followupDraft.trim() ? "edited" : "approved" });
}

export function startProposalFollowups() {
  setInterval(() => void draftDueFollowups().catch((err) => logger.warn({ err: String(err) }, "proposal follow-ups failed")), 60 * 60_000);
}

export async function proposalsFor(userId: number, dealId: number): Promise<Proposal[]> {
  return db.select().from(proposalsTable).where(and(eq(proposalsTable.userId, userId), eq(proposalsTable.dealId, dealId))).orderBy(sql`${proposalsTable.createdAt} desc`);
}

