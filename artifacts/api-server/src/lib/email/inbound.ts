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
import { classifyMail, mayBecomeLead, KIND_AR, INTENT_AR, toSharedIntent, type MailKind, type EmailIntent } from "./classify";
import { thread, threadBrief, openingsUsed } from "./thread";
import { replyInstructions, OUTPUT_SHAPE } from "./prompts";
import { retrieve } from "../knowledge";
import { passages } from "./knowledge-docs";
import { activity, temperature, TEMP_AR } from "./team";
import { complete } from "../llm";
import { skillsFor, skillsPreamble } from "../agent-skills";
import { memoryPreamble } from "../agent-memory";
import { say } from "../agent-comms";
import { notify, esc } from "../telegram";
import { logger } from "../logger";
import { recordEvent, getSettings, cancelSequencesFor } from "./service";
import { sendEmail, messageIdFor, isConfigured } from "./provider";
import { newToken, htmlToText } from "./tracking";
import { updateCard } from "../lead-card";
import { replyVoice } from "./agent";
import { lt, isNotNull } from "drizzle-orm";

/**
 * النيّات التي يجوز أن يجيبها ردٌّ آلي. الشكوى والرفض ينتظران شخصاً،
 * ومثلهما «ليس الشخص المناسب» و«حوّلنا لغيره»: كلاهما يحتاج قراراً من
 * إنسان — أي عنوانٍ يُراسَل بعده — لا رسالةً تُرسَل من تلقاء نفسها.
 */
export const AUTO_INTENTS = new Set(["interested", "question", "greeting", "considering", "later"]);

export interface InboundMail {
  from: string;
  /** ترويسات الرسالة بالاسم الصغير — أصدق ما يقوله الرد الآلي عن نفسه. */
  headers?: Record<string, string> | null;
  fromName?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

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

/**
 * تُسجّل رسالةً واردة: تُطابَق، ويُحسم نوعها، ثم — للرد الحقيقي وحده —
 * تُصنَّف نيّتها وتُكتب مسودتها ويُخبر صاحب العمل.
 *
 * كانت تُرجع null للردّ الآلي وللارتداد، فتُهدَر معلومةٌ وصلت فعلاً. الآن
 * يُسجَّل كل ما يصل، ويقول المُرجَع نوعه: `isReply` يميّز ما يستحق إنساناً
 * عمّا يُحفظ ويُعدّ ولا يُوقظ أحداً.
 */
export async function handleInbound(userId: number, mail: InboundMail): Promise<{ id: number; bounce: boolean; kind: MailKind; isReply: boolean } | null> {
  const from = (mail.from ?? "").toLowerCase().trim();
  if (!from) return null;
  const raw = mail.text || (mail.html ? htmlToText(mail.html) : "") || "";
  const text = replyOnly(raw);
  const s0 = await getSettings(userId);

  // ── ماذا وصل، قبل أي سؤال عن نيّة كاتبه ─────────────────────────
  // هذا السطر كان `classify(text)` — مصنّف الواتساب — فصار الإعلان
  // المُرسَل إلينا «عميلاً حاراً»، وصُنعت منه صفقة، وأُرسل به إشعار بنار.
  // الآن النوع يُحسم أولاً، ولا شيء غير الرد الحقيقي يعبر هذه النقطة
  // إلى العميل والصفقة والإشعار.
  const v = await classifyMail(userId, {
    from, subject: mail.subject, text, raw,
    headers: mail.headers ?? null, inReplyTo: mail.inReplyTo, references: mail.references,
    ourEmail: s0?.fromEmail ?? null,
  });
  const isReply = mayBecomeLead(v.kind);

  // الرسالة التي ردّ عليها: الترويسة أولاً، ثم العنوان.
  let matched: { id: number; contactId: number | null } | null = null;
  if (v.matchedId) {
    const [m] = await db.select({ id: emailMessagesTable.id, contactId: emailMessagesTable.contactId }).from(emailMessagesTable)
      .where(eq(emailMessagesTable.id, v.matchedId)).limit(1);
    if (m) matched = m;
  }
  if (!matched && v.kind === "bounce") {
    // الارتداد يأتي من الخادم، والعنوان الفاشل داخل النص.
    const addr = /([a-z0-9._%+\-']+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(text)?.[1]?.toLowerCase();
    if (addr) {
      const [m] = await db.select({ id: emailMessagesTable.id, contactId: emailMessagesTable.contactId }).from(emailMessagesTable)
        .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.toEmail, addr))).orderBy(desc(emailMessagesTable.createdAt)).limit(1);
      if (m) matched = m;
    }
  }
  if (!matched && v.sentCount > 0) {
    const [m] = await db.select({ id: emailMessagesTable.id, contactId: emailMessagesTable.contactId }).from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.toEmail, from))).orderBy(desc(emailMessagesTable.createdAt)).limit(1);
    if (m) matched = m;
  }

  if (v.kind === "bounce") {
    if (matched) await recordEvent(userId, matched.id, "bounce", { meta: { subject: mail.subject } });
    const b = await record(userId, null, matched?.id ?? null, mail, text, v);
    return { id: b.id, bounce: true, kind: "bounce", isReply: false };
  }

  // ── جهة الاتصال: لمن ردّ علينا فقط ──────────────────────────────
  // كانت تُنشأ لكل مُرسِل بحالة «نشط»، فكان بائع السيو يدخل قوائمنا
  // ويستقبل حملاتنا بعد أسبوع. ومن راسلنا مُعلِناً لا يُسجَّل جهةً أصلاً.
  let contact: typeof emailContactsTable.$inferSelect | null = null;
  if (isReply) {
    [contact] = await db.select().from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), eq(emailContactsTable.email, from))).limit(1);
    if (!contact) {
      [contact] = await db.insert(emailContactsTable).values({ userId, email: from, name: mail.fromName ?? null, source: "inbound" }).returning();
    }
  } else {
    // جهةٌ قائمة أصلاً — أُضيفت من ملفٍ مرفوع — تبقى، ولا نُنشئ جديدة.
    [contact] = await db.select().from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), eq(emailContactsTable.email, from))).limit(1);
    contact = contact ?? null;
  }

  const row = await record(userId, contact?.id ?? null, matched?.id ?? null, mail, text, v);

  // ── طلب الإيقاف: يُطاع قبل أي سؤالٍ عن النوع ────────────────────
  // «إلغاء الاشتراك» كلمةٌ ذات وجهين — علامةُ تذييلٍ في نشرة، وطلبُ
  // إنسانٍ في رسالةٍ من سطر. فصُنّف طلبٌ حقيقي «نشرةً» ولم يُنفَّذ. ولا
  // يجوز أن يتوقف احترامُ طلبٍ كهذا على أن نكون قد سجّلنا كيف وصل.
  if (v.asksToStop) {
    const email = from;
    const [c] = contact ? [contact] : await db.select().from(emailContactsTable)
      .where(and(eq(emailContactsTable.userId, userId), eq(emailContactsTable.email, email))).limit(1);
    if (c) {
      await db.update(emailContactsTable).set({ status: "unsubscribed" }).where(eq(emailContactsTable.id, c.id));
      await cancelSequencesFor(userId, c.id, "طلب إلغاء الاشتراك").catch(() => {});
    }
    if (matched) await recordEvent(userId, matched.id, "unsubscribe", { meta: { via: "reply" } });
    await activity(userId, "email_replies", "opt_out", `طلب إيقاف — ${c?.company ?? mail.fromName ?? email}`, { inboundId: row.id, kind: v.kind }).catch(() => {});
    logger.info({ userId, from: email, kind: v.kind }, "نُفّذ طلب إلغاء الاشتراك");
  }

  // ── ما ليس رداً: يُسجَّل ويُرى، ولا يُوقظ أحداً ─────────────────
  if (!isReply) {
    await activity(userId, "email_replies", "noise", `${KIND_AR[v.kind]} — ${mail.fromName ?? from}: «${(mail.subject ?? text).slice(0, 90)}»`,
      { inboundId: row.id, kind: v.kind, reasons: v.reasons }).catch(() => {});
    logger.info({ userId, from, kind: v.kind, reasons: v.reasons }, "بريد وارد ليس رداً");
    return { id: row.id, bounce: false, kind: v.kind, isReply: false };
  }

  if (matched) await recordEvent(userId, matched.id, "reply", { meta: { intent: v.intent } });
  if (contact) await db.update(emailContactsTable).set({ lastRepliedAt: new Date() }).where(eq(emailContactsTable.id, contact.id));

  // ── سلّم المتابعة يتوقف لأن الشخص تكلّم ─────────────────────────
  // كان الإيقاف معلّقاً على `recordEvent(reply)`، وتلك لا تُستدعى إلا
  // حين تُطابَق رسالةٌ أرسلناها. فردٌّ حقيقي بلا سجل إرسالٍ عندنا — كما
  // في ردّ شركةٍ على عرضٍ أُرسل بيد صاحب العمل — كان يترك السلّم يعمل،
  // فتُلاحَق شركةٌ تقول إنها تدرس عرضنا. وهذا أسرع طريق لخسارتها.
  if (contact && !matched) {
    await cancelSequencesFor(userId, contact.id, "ردّ على البريد").catch(() => {});
  }

  // ── الهدنة: من طلب أن نمهله يُمهَل ──────────────────────────────
  // «سنراجع داخلياً ونعود إليكم» قرارٌ يُتّخذ في غرفةٍ لسنا فيها، ومن
  // يُلحّ عليها يخرج منها. و«بعد التدقيق» موعدٌ ذكره هو، فهو عقد.
  const truce = truceFor(v.intent!, text);
  if (contact && truce) {
    await db.update(emailContactsTable)
      .set({ quietUntil: truce.until, quietReason: truce.why })
      .where(eq(emailContactsTable.id, contact.id));
    logger.info({ userId, contactId: contact.id, until: truce.until, why: truce.why }, "هدنة بعد ردّ");
  }

  // ليلى تُقيّم الرد — حار، دافئ، بارد — على جهة الاتصال، حيث تقرؤها
  // قائمة الحارّين في اللوحة وقوائم المتابعة.
  const shared = toSharedIntent(v.intent!);
  const temp = temperature(text, shared);
  if (temp === "hot") dealFromHotLead(userId, { channel: "email", ref: from, email: from, phone: contact?.phone ?? null, company: contact?.company ?? null, contactName: mail.fromName ?? contact?.name ?? null, notes: `ردّ: ${text.slice(0, 200)}` });
  if (contact) {
    const tags = ((contact.tags as string[] | null) ?? []).filter((t) => !["hot", "warm", "cold"].includes(t));
    await db.update(emailContactsTable).set({ tags: temp ? [...tags, temp] : tags }).where(eq(emailContactsTable.id, contact.id));
  }
  await activity(userId, "email_replies", "reply", `${temp ? TEMP_AR[temp] : "رد"} — ${contact?.company ?? mail.fromName ?? from}: «${text.slice(0, 140)}»`, { inboundId: row.id, contactId: contact?.id ?? null, intent: v.intent, temperature: temp });

  // البطاقة نفسها التي يحفظها جانب الواتساب، حين يكون للجهة رقم: شركةٌ
  // تكتب بالبريد ثم بالواتساب عميلٌ واحد، وما قالته في البريد يجب أن
  // يكون أمام من يجيبها بعد ذلك.
  if (contact?.phone) {
    await updateCard(userId, contact.phone, text.slice(0, 2000), shared).catch(() => {});
  }

  // المسودة في الخلفية: صاحب العمل يرى الرد فوراً، وجواب المندوب بعده
  // بثوانٍ. ومع تشغيل الرد التلقائي، ولنيّةٍ يكلّف الخطأ فيها قليلاً،
  // يُجدوَل ليخرج وحده بعد المدة التي يأخذها شخص — ولصاحب العمل أن
  // يعدّله أو يوقفه حتى تلك اللحظة.
  void draftReply(userId, row.id).then(async (d) => {
    if (!d) return;
    const s = await getSettings(userId);
    if (!s?.autoReply || !AUTO_INTENTS.has(v.intent!) || contact?.status !== "active") return;
    const base = Math.max(2, s.autoReplyDelayMin) * 60_000;
    const at = new Date(Date.now() + Math.round(base * (0.6 + Math.random() * 0.8)));
    await db.update(emailInboundTable).set({ autoSendAt: at }).where(eq(emailInboundTable.id, row.id));
    logger.info({ userId, inboundId: row.id, at }, "رد البريد سيُرسل تلقائياً");
  }).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "تعذّرت مسودة الرد على البريد"));

  await notify(userId, [
    `<b>${temp === "hot" ? "🔥 عميل حار ردّ على البريد" : "📧 ردّ على البريد"}</b> — ${esc(mail.fromName ?? from)} &lt;${esc(from)}&gt;`,
    contact?.company ? esc(contact.company) : "",
    `النية: ${esc(INTENT_AR[v.intent!].label)}${temp ? ` · ليلى: ${TEMP_AR[temp]}` : ""}${temp === "hot" && contact?.phone ? ` · واتساب: +${esc(contact.phone.replace(/\D/g, ""))}` : ""}`,
    `الخطوة: ${esc(INTENT_AR[v.intent!].next)}`,
    v.solicited ? "" : "⚠️ لا سجلَّ إرسالٍ لهذا العنوان عندنا — يرجَّح أن العرض أُرسل بيدك من خارج النظام.",
    `«${esc(text.slice(0, 300))}»`,
    "", "المسودة تنتظرك في قسم البريد → الوارد.",
  ].filter(Boolean).join("\n")).catch(() => {});
  await say({ userId, fromRole: "sales", toRole: "chief", kind: "report", body: `ردّ بريد من ${contact?.company ?? from}: ${INTENT_AR[v.intent!].label}` }).catch(() => {});

  logger.info({ userId, from, kind: v.kind, intent: v.intent, matched: !!matched }, "ردّ بريد");
  return { id: row.id, bounce: false, kind: v.kind, isReply: true };
}

/** صفُّ الوارد مع حكم المصنّف كاملاً — سببه معه، ليُقرأ بعد شهر. */
async function record(
  userId: number, contactId: number | null, messageId: number | null,
  mail: InboundMail, text: string,
  v: { kind: MailKind; solicited: boolean; intent: string | null; confidence: number; reasons: string[]; classifier: string },
) {
  const [row] = await db.insert(emailInboundTable).values({
    userId, contactId, messageId,
    fromEmail: (mail.from ?? "").toLowerCase().trim(), fromName: mail.fromName ?? null,
    subject: (mail.subject ?? "").slice(0, 300), text: text.slice(0, 20_000),
    messageIdHdr: mail.messageId ?? null, inReplyTo: mail.inReplyTo ?? null,
    intent: v.intent, kind: v.kind, solicited: v.solicited,
    confidence: v.confidence, reasons: v.reasons, classifier: v.classifier,
    // ما ليس رداً لا ينتظر قراراً من أحد.
    state: v.kind === "reply" ? "new" : "ignored",
  }).returning();
  return row!;
}

/**
 * كم نُمهله، وبأي حقٍّ. المدة ليست اختراعاً: هي ما يطلبه ردُّه نفسه.
 * ومن ذكر شهراً بالاسم يُراسَل في أوله، لا قبله بأسبوع «للتأكد».
 */
const MONTHS: Array<[RegExp, number]> = [
  [/\b(jan(uary)?|يناير)\b/i, 0], [/\b(feb(ruary)?|فبراير)\b/i, 1], [/\b(mar(ch)?|مارس)\b/i, 2],
  [/\b(apr(il)?|أبريل|ابريل)\b/i, 3], [/\b(may|مايو)\b/i, 4], [/\b(jun(e)?|يونيو)\b/i, 5],
  [/\b(jul(y)?|يوليو)\b/i, 6], [/\b(aug(ust)?|أغسطس|اغسطس)\b/i, 7], [/\b(sep(t|tember)?|سبتمبر)\b/i, 8],
  [/\b(oct(ober)?|أكتوبر|اكتوبر)\b/i, 9], [/\b(nov(ember)?|نوفمبر)\b/i, 10], [/\b(dec(ember)?|ديسمبر)\b/i, 11],
];

export function truceFor(intent: EmailIntent, text: string): { until: Date; why: string } | null {
  const DAY = 86_400_000;
  const add = (d: number) => new Date(Date.now() + d * DAY);
  if (intent === "considering") return { until: add(6), why: "قال إنه يراجع داخلياً ويعود — الإلحاح يُخرجنا من المراجعة" };
  if (intent !== "later") return null;

  // شهرٌ بالاسم: أول ذاك الشهر، فإن كان قد مضى فالسنة القادمة.
  for (const [re, m] of MONTHS) {
    if (!re.test(text)) continue;
    const now = new Date();
    const d = new Date(now.getFullYear(), m, 1, 9);
    if (d.getTime() < now.getTime() + 7 * DAY) d.setFullYear(now.getFullYear() + 1);
    return { until: d, why: `ذكر موعداً: ${re.source.replace(/[\\b()?|]/g, "").split("i")[0].slice(0, 20)}` };
  }
  if (/\bnext (year|السنة القادمة)/i.test(text) || /السنة (القادمة|المقبلة)/.test(text)) return { until: add(120), why: "قال السنة القادمة" };
  if (/\bnext quarter\b|الربع (القادم|المقبل)/i.test(text)) return { until: add(75), why: "قال الربع القادم" };
  if (/\bnext month\b|الشهر (القادم|المقبل)/i.test(text)) return { until: add(28), why: "قال الشهر القادم" };
  if (/\baudit|التدقيق|المراجعة السنوية/i.test(text)) return { until: add(45), why: "قال بعد التدقيق" };
  if (/\bramadan|رمضان/i.test(text)) return { until: add(40), why: "قال بعد رمضان" };
  if (/\byear[- ]end|نهاية (السنة|العام)/i.test(text)) return { until: add(60), why: "قال بعد نهاية السنة" };
  if (/\bnext week\b|الأسبوع (القادم|المقبل)/i.test(text)) return { until: add(7), why: "قال الأسبوع القادم" };
  return { until: add(30), why: "قال ليس الآن بلا موعد محدّد — شهرٌ هو أقل ما يُحترم به ذلك" };
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

  // ── ما سبق مع هذه الشركة ────────────────────────────────────────
  // هذا ما كان ناقصاً: المسودة كانت تُكتب على عنوان رسالةٍ واحدة منّا
  // ونصِّ ما وصل الآن، فتُعيد تقديم الشركة لمن راسلها أربع مرات وتُلحّ
  // على من قال «سنراجع ونعود». الآن تُقرأ اللمسات كلها أولاً.
  const hist = contact ? await thread(userId, contact.id, 20).catch(() => null) : null;
  const brief = hist ? threadBrief(hist, { turns: 6, chars: 260 }) : "";
  const openings = hist ? openingsUsed(hist.turns).slice(-3) : [];

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
      "تكتب ردّ بريد إلكتروني على شركة. البريد ليس واتساب: فقرتان إلى ثلاث، تحية باسم الشخص أو الشركة، توقيع باسمك.",
      // اللغة قاعدةُ صاحب العمل: الإنجليزية أساساً.
      s?.defaultLanguage === "ar" ? "اللغة: العربية المهنية الواضحة." : s?.defaultLanguage === "both" ? "اللغة: لغة رسالته — عربية إن كتب عربياً، إنجليزية إن كتب إنجليزياً." : "اللغة: الإنجليزية — رد مهني واضح بالإنجليزية حتى لو كتب العميل بالعربية (الإنجليزية هي لغة البريد ما لم يغيّرها صاحب العمل).",
      "",
      // الصنعة وخطةُ نيّته وحدها — لا الإحدى عشرة خطة.
      replyInstructions(inb.intent as EmailIntent | null, {
        hasHistory: (hist?.stats.sent ?? 0) > 0,
        silent: !!hist?.stats.silent,
      }),
      openings.length ? `افتتاحياتٌ استُعملت معه فعلاً — لا تُعِد أيّاً منها:\n${openings.map((o) => `• ${o}`).join("\n")}` : "",
      "",
      skillsPreamble([
        ...replySkills.filter((x) => /تصنيف الردود|تشريح رسالة/.test(x.name)),
        ...skills.filter((x) => /التفاوض|تشخيص|احتواء|قراءة نية/.test(x.name)),
      ]),
      memory,
      lessons,
      offer,
      knowledgeLines(more, "ومن مصادر المعرفة الأخرى:"),
      profile?.guardrails ? `تعليمات صاحب العمل: ${profile.guardrails}` : "",
      brief,
      facts.length || docs.length ? `معلومات مفيدة:\n${[...facts.map((f) => `${f.entry.title}\n${f.entry.content}`), ...docs.map((d) => `${d.title}\n${d.text}`)].map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}` : "لا توجد معلومة محددة — اسأل عمّا تحتاجه لتُجيب بدقة.",
      "",
      OUTPUT_SHAPE,
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
          // الترويسات التي يحتاجها المصنّف ليعرف الآلة من الإنسان.
          // RFC 3834 يُلزم كل مجيبٍ آليٍّ مؤدّب بـ Auto-Submitted، وهي
          // أصدق من أي نمطٍ في العنوان أو النص.
          const hdrs: Record<string, string> = {};
          for (const k of ["auto-submitted", "x-autoreply", "x-autorespond", "x-autoresponder", "x-auto-response-suppress", "x-mailer-autoreply", "precedence", "list-id", "list-unsubscribe", "list-post", "x-campaign-id", "x-mailchimp-id", "feedback-id", "x-failed-recipients", "content-type"]) {
            const val = (parsed.headers as Map<string, unknown> | undefined)?.get(k);
            if (val != null) hdrs[k] = typeof val === "string" ? val : String((val as any)?.value ?? val);
          }
          const r = await handleInbound(s.userId, {
            from: fromAddr.address, fromName: fromAddr.name || null, headers: hdrs,
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
