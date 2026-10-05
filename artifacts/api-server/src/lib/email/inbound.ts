// ── What comes back ───────────────────────────────────────────────
// A reply is the whole point of the outreach, and it arrives in a mailbox,
// not in this system. Two ways in: an IMAP poll of the sending mailbox
// every two minutes (works with any provider), and a webhook for providers
// that push inbound mail. Either way the reply is matched to the message
// it answers by In-Reply-To, or failing that by the sender's address; it is
// classified, summarised, and handed to the sales agent who drafts the
// answer — which waits for a person unless the owner switches auto-reply
// on for email.

import { recordFeedback, lessonsFor } from "../feedback";
import { asAgent } from "../agent-context";
import { dealFromHotLead } from "../deals/deals";
import { offerLine } from "../deals/meetings";
import { companyKnowledge, knowledgeLines } from "../company-knowledge";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db, emailSettingsTable, emailContactsTable, emailMessagesTable, emailInboundTable,
  botEmployeesTable, businessProfileTable, type EmailSettings,
} from "@workspace/db";
import { classify } from "../intent";
import { retrieve } from "../knowledge";
import { passages } from "./knowledge-docs";
import { activity, temperature, TEMP_AR } from "./team";
import { complete } from "../llm";
import { skillsFor, skillsPreamble } from "../agent-skills";
import { memoryPreamble } from "../agent-memory";
import { say } from "../agent-comms";
import { notify, esc } from "../telegram";
import { logger } from "../logger";
import { recordEvent, getSettings } from "./service";
import { sendEmail, messageIdFor, isConfigured } from "./provider";
import { newToken, htmlToText } from "./tracking";
import { updateCard } from "../lead-card";
import { replyVoice } from "./agent";
import { lt, isNotNull } from "drizzle-orm";

/** Intents an automatic reply may answer. A complaint or a refusal waits for a person. */
export const AUTO_INTENTS = new Set(["interested", "question", "greeting", "unclear"]);

export interface InboundMail {
  from: string;
  fromName?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

const AUTO_RE = /^(auto(matic)?[- ]?reply|out of office|automatic reply|delivery status notification|undeliver|mail delivery|رد تلقائي|خارج المكتب|إشعار تسليم)/i;
const BOUNCE_FROM = /^(mailer-daemon|postmaster|noreply|no-reply)@/i;

/** Strip the quoted original so the classifier reads what they wrote, not what we wrote. */
export function replyOnly(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^(On .+ wrote:|في .+ كتب|-----Original Message-----|From: .+|De : .+|________________________________)/i.test(l.trim())) break;
    if (l.trim().startsWith(">")) continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

/** File one inbound mail: match, classify, draft, tell the owner. */
export async function handleInbound(userId: number, mail: InboundMail): Promise<{ id: number; bounce: boolean } | null> {
  const from = (mail.from ?? "").toLowerCase().trim();
  if (!from) return null;
  const text = replyOnly(mail.text || (mail.html ? htmlToText(mail.html) : "") || "");

  // A bounce or an auto-reply is information about the address, not a reply.
  const bounce = BOUNCE_FROM.test(from) || /^delivery status notification|^undeliverable|^mail delivery failed/i.test(mail.subject ?? "");
  const auto = AUTO_RE.test(mail.subject ?? "") || /^(this is an automatic reply|هذا رد تلقائي)/i.test(text);

  // Which message they answered: the header first, the address second.
  let matched: { id: number; contactId: number | null } | null = null;
  const refs = [mail.inReplyTo, ...(mail.references ?? "").split(/\s+/)].filter(Boolean) as string[];
  if (refs.length) {
    const [m] = await db.select({ id: emailMessagesTable.id, contactId: emailMessagesTable.contactId }).from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.userId, userId), inArray(emailMessagesTable.messageIdHdr, refs))).limit(1);
    if (m) matched = m;
  }
  if (bounce && !matched) {
    // Bounces come from the daemon; the failed address is inside the body.
    const addr = /([a-z0-9._%+\-']+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(text)?.[1]?.toLowerCase();
    if (addr) {
      const [m] = await db.select({ id: emailMessagesTable.id, contactId: emailMessagesTable.contactId }).from(emailMessagesTable)
        .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.toEmail, addr))).orderBy(desc(emailMessagesTable.createdAt)).limit(1);
      if (m) matched = m;
    }
  }
  if (!matched) {
    const [m] = await db.select({ id: emailMessagesTable.id, contactId: emailMessagesTable.contactId }).from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.toEmail, from))).orderBy(desc(emailMessagesTable.createdAt)).limit(1);
    if (m) matched = m;
  }

  if (bounce) {
    if (matched) await recordEvent(userId, matched.id, "bounce", { meta: { subject: mail.subject } });
    return matched ? { id: matched.id, bounce: true } : null;
  }
  if (auto) return null;

  // The contact, by address — created if they wrote to us first.
  let [contact] = await db.select().from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), eq(emailContactsTable.email, from))).limit(1);
  if (!contact) {
    [contact] = await db.insert(emailContactsTable).values({ userId, email: from, name: mail.fromName ?? null, source: "inbound" }).returning();
  }

  const verdict = await classify(text.slice(0, 2000), false);
  const [row] = await db.insert(emailInboundTable).values({
    userId, contactId: contact!.id, messageId: matched?.id ?? null,
    fromEmail: from, fromName: mail.fromName ?? contact!.name ?? null,
    subject: (mail.subject ?? "").slice(0, 300), text: text.slice(0, 20_000),
    messageIdHdr: mail.messageId ?? null, inReplyTo: mail.inReplyTo ?? null,
    intent: verdict.intent,
  }).returning();

  if (matched) await recordEvent(userId, matched.id, "reply", { meta: { intent: verdict.intent } });
  else if (contact) await db.update(emailContactsTable).set({ lastRepliedAt: new Date() }).where(eq(emailContactsTable.id, contact.id));

  if (verdict.intent === "opt_out") {
    await db.update(emailContactsTable).set({ status: "unsubscribed" }).where(eq(emailContactsTable.id, contact!.id));
    if (matched) await recordEvent(userId, matched.id, "unsubscribe", { meta: { via: "reply" } });
  }

  // ليلى rates the reply — hot, warm, cold — on the contact, where the
  // dashboard's hot list and the follow-up lists read it.
  const temp = temperature(text, verdict.intent);
  if (temp === "hot") dealFromHotLead(userId, { channel: "email", ref: from, email: from, phone: contact?.phone ?? null, company: contact?.company ?? null, contactName: mail.fromName ?? contact?.name ?? null, notes: `ردّ: ${text.slice(0, 200)}` });
  if (contact) {
    const tags = ((contact.tags as string[] | null) ?? []).filter((t) => !["hot", "warm", "cold"].includes(t));
    await db.update(emailContactsTable).set({ tags: temp ? [...tags, temp] : tags }).where(eq(emailContactsTable.id, contact.id));
  }
  await activity(userId, "email_replies", "reply", `${temp ? TEMP_AR[temp] : "رد"} — ${contact?.company ?? mail.fromName ?? from}: «${text.slice(0, 140)}»`, { inboundId: row!.id, contactId: contact?.id ?? null, intent: verdict.intent, temperature: temp });

  // The same card the WhatsApp side keeps, when the contact has a phone: a
  // company that writes by email and then by WhatsApp is one lead, and what
  // it said in the email should be in front of whoever answers next.
  if (contact?.phone) {
    await updateCard(userId, contact.phone, text.slice(0, 2000), verdict.intent).catch(() => {});
  }

  // The draft, in the background: the owner sees the reply at once and the
  // salesman's answer a few seconds later. With auto-reply on, and for an
  // intent where a wrong answer costs little, it is scheduled to go out on
  // its own after the delay a person would take — the owner can still edit
  // or stop it until then.
  void draftReply(userId, row!.id).then(async (d) => {
    if (!d) return;
    const s = await getSettings(userId);
    if (!s?.autoReply || !AUTO_INTENTS.has(verdict.intent) || contact?.status !== "active") return;
    const base = Math.max(2, s.autoReplyDelayMin) * 60_000;
    const at = new Date(Date.now() + Math.round(base * (0.6 + Math.random() * 0.8)));
    await db.update(emailInboundTable).set({ autoSendAt: at }).where(eq(emailInboundTable.id, row!.id));
    logger.info({ userId, inboundId: row!.id, at }, "رد البريد سيُرسل تلقائياً");
  }).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "تعذّرت مسودة الرد على البريد"));

  await notify(userId, [
    `<b>${temp === "hot" ? "🔥 عميل حار ردّ على البريد" : "📧 ردّ على البريد"}</b> — ${esc(mail.fromName ?? from)} &lt;${esc(from)}&gt;`,
    contact?.company ? esc(contact.company) : "",
    `النية: ${esc(verdict.intent)}${temp ? ` · ليلى: ${TEMP_AR[temp]}` : ""}${temp === "hot" && contact?.phone ? ` · واتساب: +${esc(contact.phone.replace(/\D/g, ""))}` : ""}`,
    `«${esc(text.slice(0, 300))}»`,
    "", "المسودة تنتظرك في قسم البريد → الوارد.",
  ].filter(Boolean).join("\n")).catch(() => {});
  await say({ userId, fromRole: "sales", toRole: "chief", kind: "report", body: `ردّ بريد من ${contact?.company ?? from}: ${verdict.intent}` }).catch(() => {});

  logger.info({ userId, from, intent: verdict.intent, matched: !!matched }, "بريد وارد");
  return { id: row!.id, bounce: false };
}

// ── The salesman answers ──────────────────────────────────────────
export async function draftReply(userId: number, inboundId: number): Promise<{ subject: string; body: string; summary: string } | null> {
  const [inb] = await db.select().from(emailInboundTable).where(and(eq(emailInboundTable.id, inboundId), eq(emailInboundTable.userId, userId))).limit(1);
  if (!inb) return null;
  const [contact] = inb.contactId ? await db.select().from(emailContactsTable).where(eq(emailContactsTable.id, inb.contactId)).limit(1) : [null];
  // نورة answers email when she is on the team — with what she was taught
  // about this contact's sector — and the salesman when she is not.
  const [nora] = await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, "email"), eq(botEmployeesTable.isActive, true))).limit(1);
  const [sales] = nora ? [nora] : await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, "sales"))).limit(1);
  const noraVoice = nora ? await replyVoice(userId, contact?.sector ?? null).catch(() => "") : "";
  const [profile] = await db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  const [ours] = inb.messageId ? await db.select({ subject: emailMessagesTable.subject }).from(emailMessagesTable).where(eq(emailMessagesTable.id, inb.messageId)).limit(1) : [null];
  const s = await getSettings(userId);

  const [facts, skills, replySkills, memory, docs] = await Promise.all([
    retrieve(userId, `${inb.subject ?? ""} ${inb.text ?? ""}`.slice(0, 500), 4).catch(() => []),
    skillsFor(userId, "sales", inb.intent as any || "question").catch(() => []),
    // ليلى's craft — reading the reply and writing English B2B — whoever answers.
    skillsFor(userId, "email_replies", "internal").catch(() => []),
    memoryPreamble(userId, "sales").catch(() => ""),
    // What the owner uploaded about the company and the field, the passages that bear on this message.
    passages(userId, `${inb.subject ?? ""} ${inb.text ?? ""}`.slice(0, 500), { sectors: contact?.sector ? [contact.sector] : [], limit: 3 }).catch(() => []),
  ]);

  const lessons = await lessonsFor(userId, "email", `${inb.subject ?? ""} ${inb.text ?? ""}`.slice(0, 600)).catch(() => "");
  // When the reply asks for a call: the owner's free times, not ones the model makes up.
  const offer = await offerLine(userId, (s?.defaultLanguage ?? "en") === "ar" ? "ar" : "en").catch(() => "");
  const more = await companyKnowledge(userId, `${inb.subject ?? ""} ${inb.text ?? ""}`.slice(0, 500), { limit: 3, exclude: ["kb", "docs"] }).catch(() => []);
  const out = await asAgent(userId, nora ? "email" : "sales", () => complete([
    { role: "system", content: [
      noraVoice || (sales ? `اسمك ${sales.name}${sales.title ? `، ${sales.title}` : ""}.` : "أنت مندوب مبيعات."),
      noraVoice ? "" : sales?.persona ?? "",
      profile?.name ? `تعمل لدى ${profile.name}${profile.industry ? ` — ${profile.industry}` : ""}.` : "",
      profile?.description ? `عن الشركة: ${profile.description}` : "",
      "",
      "تكتب ردّ بريد إلكتروني على شركة راسلتها. البريد ليس واتساب: فقرتان إلى ثلاث، تحية باسم الشخص أو الشركة، توقيع باسمك، بلا رموز تعبيرية.",
      // The owner's rule: every email in English.
      // English by default — the owner's rule — unless he set the account's email language to another.
      s?.defaultLanguage === "ar" ? "اللغة: العربية المهنية الواضحة." : s?.defaultLanguage === "both" ? "اللغة: لغة رسالته — عربية إن كتب عربياً، إنجليزية إن كتب إنجليزياً." : "اللغة: الإنجليزية — رد مهني واضح بالإنجليزية حتى لو كتب العميل بالعربية (الإنجليزية هي لغة البريد ما لم يغيّرها صاحب العمل).",
      "هدف الرد واحد: أن يتقدّم خطوة — سؤال تأهيل واحد، أو موعد مكالمة، أو ما يحتاجه ليقرر. لا تُعد شرح كل شيء.",
      "لا رقماً أو نسبة أو مهلة أو سعراً ليس في المعلومات أدناه. إن سُئلت عن سعر غير موجود فاطلب ما يحدّده.",
      "لا تذكر أنك ذكاء اصطناعي.",
      skillsPreamble([
        ...replySkills.filter((x) => /تصنيف الردود|تشريح رسالة/.test(x.name)),
        ...skills.filter((x) => /التفاوض|تشخيص|احتواء|قراءة نية/.test(x.name)),
      ]),
      memory,
      lessons,
      offer,
      knowledgeLines(more, "ومن مصادر المعرفة الأخرى:"),
      profile?.guardrails ? `تعليمات صاحب العمل: ${profile.guardrails}` : "",
      facts.length || docs.length ? `معلومات مفيدة:\n${[...facts.map((f) => `${f.entry.title}\n${f.entry.content}`), ...docs.map((d) => `${d.title}\n${d.text}`)].map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}` : "لا توجد معلومة محددة — اسأل عمّا تحتاجه لتُجيب بدقة.",
      "",
      "اكتب بهذا الشكل بالضبط:",
      "الخلاصة: <سطر واحد: ماذا يريد هو بالضبط>",
      "العنوان: <عنوان الرد>",
      "الرد:",
      "<نص الرد>",
    ].filter(Boolean).join("\n") },
    { role: "user", content: [
      contact?.company ? `الشركة: ${contact.company}` : "",
      inb.fromName ? `الاسم: ${inb.fromName}` : "",
      ours?.subject ? `رسالتنا التي ردّ عليها: ${ours.subject}` : "",
      `عنوان رده: ${inb.subject ?? ""}`,
      `رده:\n${inb.text ?? ""}`,
    ].filter(Boolean).join("\n") },
  ], 45_000));
  if (!out?.text) return null;

  const summary = /الخلاصة\s*[:：]\s*(.+)/.exec(out.text)?.[1]?.trim() ?? "";
  const subject = /العنوان\s*[:：]\s*(.+)/.exec(out.text)?.[1]?.trim() ?? `Re: ${ours?.subject ?? inb.subject ?? ""}`;
  const body = /الرد\s*[:：]\s*\n?([\s\S]+)$/.exec(out.text)?.[1]?.trim() ?? out.text.trim();
  const signed = s?.signature ? `${body}\n\n${htmlToText(s.signature)}` : body;

  await db.update(emailInboundTable).set({ summary, draftSubject: subject.slice(0, 300), draftReply: signed, state: "drafted" }).where(eq(emailInboundTable.id, inboundId));
  return { subject, body: signed, summary };
}

/** Send the draft (edited or not) as a proper reply in the same thread. */
export async function sendReply(userId: number, inboundId: number, subject?: string, body?: string): Promise<{ messageId: number }> {
  const [inb] = await db.select().from(emailInboundTable).where(and(eq(emailInboundTable.id, inboundId), eq(emailInboundTable.userId, userId))).limit(1);
  if (!inb) throw new Error("الرسالة غير موجودة");
  const s = await getSettings(userId);
  if (!isConfigured(s)) throw new Error("إعدادات البريد غير مكتملة");
  const subj = (subject ?? inb.draftSubject ?? `Re: ${inb.subject ?? ""}`).slice(0, 300);
  const text = body ?? inb.draftReply ?? "";
  if (!text.trim()) throw new Error("الرد فارغ");

  const token = newToken();
  const html = `<div dir="auto" style="font:15px/1.8 Arial,sans-serif;color:#111827;white-space:pre-wrap">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`;
  const messageId = messageIdFor(token, s!.fromEmail!);
  const [m] = await db.insert(emailMessagesTable).values({
    userId, contactId: inb.contactId, toEmail: inb.fromEmail, subject: subj, token, status: "queued", messageIdHdr: messageId,
  }).returning();
  try {
    const r = await sendEmail(s!, { to: inb.fromEmail, toName: inb.fromName, subject: subj, html, text, messageId, unsubscribeUrl: null, inReplyTo: inb.messageIdHdr });
    await db.update(emailMessagesTable).set({ status: "sent", sentAt: new Date(), providerId: r.providerId }).where(eq(emailMessagesTable.id, m!.id));
    await db.update(emailInboundTable).set({ state: "sent", draftSubject: subj, draftReply: text, autoSendAt: null }).where(eq(emailInboundTable.id, inboundId));
    if (inb.draftReply) await recordFeedback({ userId, role: "email", channel: "email", kind: "email_reply", refId: inboundId, context: (inb.text ?? "").slice(0, 1_500), original: inb.draftReply, final: text, verdict: body != null ? "edited" : "approved" });
    await recordEvent(userId, m!.id, "sent", { meta: { reply: true } });
  } catch (err: any) {
    await db.update(emailMessagesTable).set({ status: "failed", error: String(err?.message ?? err).slice(0, 400) }).where(eq(emailMessagesTable.id, m!.id));
    throw err;
  }
  return { messageId: m!.id };
}

// ── IMAP ──────────────────────────────────────────────────────────
export async function pollMailbox(s: EmailSettings): Promise<number> {
  // The replies arrive in the mailbox that sends, almost always: an empty
  // IMAP username or password means the sender's own.
  const user = s.imapUser?.trim() || s.smtpUser, pass = s.imapPass || s.smtpPass;
  if (!s.imapHost || !user || !pass) return 0;
  const client = new ImapFlow({
    host: s.imapHost, port: s.imapPort ?? 993, secure: (s.imapPort ?? 993) === 993,
    auth: { user, pass }, logger: false,
  });
  let handled = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox as any;
      // First run: start from the newest message rather than the whole mailbox.
      if (s.imapLastUid === 0) {
        const uidNext = Number(mailbox?.uidNext ?? 1);
        await db.update(emailSettingsTable).set({ imapLastUid: Math.max(0, uidNext - 1) }).where(eq(emailSettingsTable.userId, s.userId));
        return 0;
      }
      let maxUid = s.imapLastUid;
      for await (const msg of client.fetch({ uid: `${s.imapLastUid + 1}:*` }, { uid: true, source: true })) {
        if (msg.uid <= s.imapLastUid) continue;
        maxUid = Math.max(maxUid, msg.uid);
        try {
          const parsed = await simpleParser(msg.source as Buffer);
          const fromAddr = parsed.from?.value?.[0];
          if (!fromAddr?.address || fromAddr.address.toLowerCase() === (s.fromEmail ?? "").toLowerCase()) continue;
          const r = await handleInbound(s.userId, {
            from: fromAddr.address, fromName: fromAddr.name || null,
            subject: parsed.subject ?? null, text: parsed.text ?? null, html: typeof parsed.html === "string" ? parsed.html : null,
            messageId: parsed.messageId ?? null, inReplyTo: parsed.inReplyTo ?? null,
            references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references ?? null),
          });
          if (r) handled++;
        } catch (err) {
          logger.warn({ userId: s.userId, uid: msg.uid, err: String((err as any)?.message ?? err) }, "تعذّر قراءة رسالة واردة");
        }
      }
      if (maxUid !== s.imapLastUid) {
        await db.update(emailSettingsTable).set({ imapLastUid: maxUid, imapLastError: null }).where(eq(emailSettingsTable.userId, s.userId));
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 300);
    await db.update(emailSettingsTable).set({ imapLastError: msg }).where(eq(emailSettingsTable.userId, s.userId)).catch(() => {});
    logger.warn({ userId: s.userId, err: msg }, "IMAP poll failed");
    try { await client.logout(); } catch {}
  }
  return handled;
}

export async function pollAllMailboxes(): Promise<void> {
  const rows = await db.select().from(emailSettingsTable).where(sql`${emailSettingsTable.imapHost} is not null and coalesce(nullif(${emailSettingsTable.imapUser}, ''), ${emailSettingsTable.smtpUser}) is not null`);
  for (const s of rows) await pollMailbox(s).catch(() => {});
}

/** Drafts whose moment has come. A person who edited or sent one first has already moved it out of "drafted". */
export async function sendDueAutoReplies(now = new Date()): Promise<number> {
  const due = await db.select({ id: emailInboundTable.id, userId: emailInboundTable.userId }).from(emailInboundTable)
    .where(and(eq(emailInboundTable.state, "drafted"), isNotNull(emailInboundTable.autoSendAt), lt(emailInboundTable.autoSendAt, now))).limit(20);
  let n = 0;
  for (const d of due) {
    try { await sendReply(d.userId, d.id); n++; logger.info({ userId: d.userId, inboundId: d.id }, "أُرسل رد البريد تلقائياً"); }
    catch (err: any) {
      await db.update(emailInboundTable).set({ autoSendAt: null }).where(eq(emailInboundTable.id, d.id));
      logger.warn({ inboundId: d.id, err: String(err?.message ?? err) }, "تعذّر الرد التلقائي — ينتظر شخصاً");
    }
  }
  return n;
}

export function startInboundPolling(): void {
  setTimeout(() => {
    void pollAllMailboxes();
    setInterval(() => void pollAllMailboxes(), 2 * 60_000);
    setInterval(() => void sendDueAutoReplies().catch(() => {}), 60_000);
  }, 50_000);
  logger.info("قارئ البريد الوارد بدأ");
}

/** Normalise what the push providers post. Best effort; unknown shapes fall back to the generic fields. */
export function normalizeWebhook(body: any): InboundMail[] {
  const out: InboundMail[] = [];
  const items = Array.isArray(body) ? body : body?.items && Array.isArray(body.items) ? body.items : [body];
  for (const b of items) {
    if (!b || typeof b !== "object") continue;
    // Brevo inbound parsing
    if (b.From?.Address || b.Sender?.Address) {
      out.push({ from: b.From?.Address ?? b.Sender?.Address, fromName: b.From?.Name ?? null, subject: b.Subject ?? null, text: b.RawTextBody ?? b.ExtractedMarkdownMessage ?? null, html: b.RawHtmlBody ?? null,
        messageId: b.MessageId ?? null, inReplyTo: b.InReplyTo ?? null, references: Array.isArray(b.References) ? b.References.join(" ") : null });
      continue;
    }
    // Mailgun / SendGrid inbound parse (form-ish fields)
    if (b.sender || b["from"]) {
      const from = String(b.sender ?? b.from ?? "");
      const m = /<([^>]+)>/.exec(from);
      out.push({ from: (m?.[1] ?? from).trim(), fromName: m ? from.replace(/<[^>]+>/, "").replace(/"/g, "").trim() : null,
        subject: b.subject ?? null, text: b["stripped-text"] ?? b.text ?? b["body-plain"] ?? null, html: b.html ?? b["body-html"] ?? null,
        messageId: b["Message-Id"] ?? b["message-id"] ?? null, inReplyTo: b["In-Reply-To"] ?? b["in-reply-to"] ?? null, references: b.References ?? b.references ?? null });
      continue;
    }
    // Resend inbound (email.received) or a generic {from, subject, text}
    const d = b.data ?? b;
    const from = d.from?.email ?? d.from?.address ?? d.from;
    if (typeof from === "string") {
      out.push({ from: /<([^>]+)>/.exec(from)?.[1] ?? from, fromName: d.from?.name ?? null, subject: d.subject ?? null, text: d.text ?? null, html: d.html ?? null,
        messageId: d.message_id ?? d.messageId ?? null, inReplyTo: d.in_reply_to ?? d.inReplyTo ?? null, references: d.references ?? null });
    }
  }
  return out;
}
