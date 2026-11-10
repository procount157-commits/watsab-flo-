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
  db, emailSettingsTable, emailContactsTable, emailMessagesTable, emailInboundTable, emailSequenceJobsTable,
  botEmployeesTable, businessProfileTable, type EmailSettings, emailSendersTable, type EmailSender,
} from "@workspace/db";
import { senderFor, asSettings } from "./senders";
import { classifyMail, classifyWithModel, bounceSeverity, mayBecomeLead, KIND_AR, INTENT_AR, toSharedIntent, type MailKind, type EmailIntent } from "./classify";
import { thread, threadBrief, openingsUsed, sentBody } from "./thread";
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
import { recordEvent, getSettings, cancelSequencesFor, stopCompany } from "./service";
import { EmailHalted, sendEmail, messageIdFor, isConfigured } from "./provider";
import { accountHalted } from "../org/controls";
import { runAs } from "../org/runtime";
import { handoffDeliveryFailure, recordReplyOutcome } from "../org/handoffs";
import { newToken, htmlToText } from "./tracking";
import { updateCard } from "../lead-card";
import { replyVoice } from "./agent";
import { lt, gt, isNotNull } from "drizzle-orm";
import { dryRun, personaFor, simPersona } from "../org/simulation";

/**
 * النيّات التي يجوز أن يجيبها ردٌّ آلي. الشكوى والرفض ينتظران شخصاً،
 * ومثلهما «ليس الشخص المناسب» و«حوّلنا لغيره»: كلاهما يحتاج قراراً من
 * إنسان — أي عنوانٍ يُراسَل بعده — لا رسالةً تُرسَل من تلقاء نفسها.
 */
export const AUTO_INTENTS = new Set(["interested", "question", "greeting", "considering", "later"]);
/**
 * ودون هذه الثقة في النيّة لا يخرج ردٌّ آلي مهما كانت النيّة: ردٌّ خاطئ
 * أسوأ من لا ردّ. «غير واضح» ليست في القائمة أصلاً، وهذا الحد يمسك ما
 * دخلها بثقةٍ واهية — علامة استفهامٍ وحدها (٠٫٥٥)، أو نصٌّ قصير حُسب تحية.
 */
export const AUTO_MIN_CONFIDENCE = 0.6;
/** كم يعيش المسوّدة قبل أن تُعدّ قديمةً فلا تُرسَل من تلقاء نفسها. */
const DRAFT_MAX_AGE_MS = 48 * 3_600_000;
/** ردٌّ حار مسوّدته تنتظر هذه المدة بلا أحد: يُصعَّد. */
const HOT_STALE_MS = 2 * 3_600_000;

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
/**
 * علامات بداية المقتبس التي تمتدّ على سطرٍ أو سطرين — تُفحص على النص كله
 * لا سطراً سطراً: ترويسة Outlook «From: …\nSent: …» سطران، وجيميل على
 * الهاتف يكسر «On … wrote:» أحياناً. وما سبق أول علامةٍ هو ما كتبه هو.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^On .+ wrote:$/m, /^On .+\n.*wrote:$/m,
  /^Le .+ a écrit/m,
  /^-----\s*Original Message\s*-----/im,
  /^From:\s.+\nSent:\s/m, /^From:\s.+\n(To|Date):\s/m,
  /^De : .+$/m,
  /^في .+ كتب/m, /^بتاريخ .+ كتب/m,
  /^---+ ?(الرسالة الأصلية|Forwarded message)/m,
  /^________________________________/m,
];

export function replyOnly(text: string): string {
  let t = text.replace(/\r/g, "");
  let cut = -1;
  for (const re of QUOTE_MARKERS) {
    const i = t.search(re);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  if (cut >= 0) t = t.slice(0, cut);
  const out: string[] = [];
  for (const l of t.split("\n")) {
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
  const v0 = await classifyMail(userId, {
    from, subject: mail.subject, text, raw,
    headers: mail.headers ?? null, inReplyTo: mail.inReplyTo, references: mail.references,
    ourEmail: s0?.fromEmail ?? null,
  });
  // القواعد تردّدت في نيّة ردٍّ حقيقي: النموذج يُسأل كلمةً واحدة. وأي
  // فشلٍ يُبقي حكم القواعد.
  const v = await classifyWithModel(v0, { subject: mail.subject, text }, userId).catch(() => v0);
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
      // الرسالة التي **خرجت** إلى هذا العنوان، لا آخر صفٍّ له: ثماني عشرة
      // إشعار ارتدادٍ نُسبت إلى متابعاتٍ ما زالت في الطابور، فظهرت رسائل
      // «مرتدّة» لم تُرسَل قط، واختلّ كل عدٍّ يقسم الارتداد على ما خرج.
      const [m] = await db.select({ id: emailMessagesTable.id, contactId: emailMessagesTable.contactId }).from(emailMessagesTable)
        .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.toEmail, addr), isNotNull(emailMessagesTable.sentAt)))
        .orderBy(desc(emailMessagesTable.sentAt)).limit(1);
      if (m) matched = m;
    }
  }
  if (!matched && v.sentCount > 0) {
    const [m] = await db.select({ id: emailMessagesTable.id, contactId: emailMessagesTable.contactId }).from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.toEmail, from))).orderBy(desc(emailMessagesTable.createdAt)).limit(1);
    if (m) matched = m;
  }

  if (v.kind === "bounce") {
    // الشدّة قبل الحكم: العنوان الميت وحده يُخرج الجهة (classify.ts).
    const severity = bounceSeverity(`${mail.subject ?? ""}\n${raw}`);
    if (matched && severity === "hard") {
      await recordEvent(userId, matched.id, "bounce", { meta: { subject: mail.subject } });
      await handoffDeliveryFailure(userId, "address", { messageId: matched.id, via: "inbound_bounce" });
    }
    else if (matched && severity !== "delay" && severity !== "report") {
      await recordEvent(userId, matched.id, "failed", { meta: { subject: mail.subject, severity } });
      // صندوقٌ ممتلئ يُعطى ثلاثة أيام ثم يُراسَل؛ ورفض السياسة لا يمسّ الجهة.
      if (severity === "soft" && matched.contactId) await db.update(emailContactsTable)
        .set({ quietUntil: new Date(Date.now() + 3 * 86_400_000), quietReason: "صندوقه ممتلئ أو خادمه مؤقتاً لا يستقبل" })
        .where(eq(emailContactsTable.id, matched.contactId));
      if (severity === "policy") await activity(userId, "email_guard", "policy", `مزوّد ${mail.from} رفض رسالتنا لسياسته (لا عنوانٌ ميت) — الجهة باقية، والنص يُراجَع.`).catch(() => {});
    }
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
    // خارج المكتب: ليس رداً، لكنه يقول متى يعود. كان يُهمَل فتصله
    // المتابعة الثانية وهو غائب، ويقرأ الثلاث معاً حين يرجع.
    if (v.kind === "auto_reply" && contact) {
      await outOfOffice(userId, contact, text, from, s0?.fromEmail ?? null, row.id).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "تعذّر تسجيل الغياب"));
    }
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
  // One person at a company answered: their colleagues stop getting the
  // same ladder (Instantly, Smartlead: a reply stops the whole company).
  const colleagues = await stopCompany(userId, from).catch(() => 0);
  if (colleagues) logger.info({ userId, from, colleagues }, "ردّ من شركة — أُوقفت متابعات زملائه");

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
  // نتيجة الرد لجاسم، معلّقةً بمهمتها وزاويتها.
  await recordReplyOutcome(userId, { messageId: matched?.id ?? null, inboundId: row.id, contactId: contact?.id ?? null, intent: v.intent, temperature: temp }).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "نتيجة رد لم تُسجَّل"));
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
    // البوابة: نيّةٌ يجوز الرد عليها آلياً، وبثقةٍ كافية، وجهةٌ نشطة.
    // «غير واضح» ليست في القائمة، وما دونه ثقةً يُترك لإنسان.
    const sure = (v.intentConfidence ?? v.confidence) >= AUTO_MIN_CONFIDENCE;
    if (!s?.autoReply || !AUTO_INTENTS.has(v.intent!) || !sure || contact?.status !== "active") return;
    const base = Math.max(2, s.autoReplyDelayMin) * 60_000;
    const at = new Date(Date.now() + Math.round(base * (0.6 + Math.random() * 0.8)));
    await db.update(emailInboundTable).set({ autoSendAt: at }).where(eq(emailInboundTable.id, row.id));
    logger.info({ userId, inboundId: row.id, at }, "رد البريد سيُرسل تلقائياً");
  }).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "تعذّرت مسودة الرد على البريد"));

  const told = await notify(userId, [
    `<b>${temp === "hot" ? "🔥 عميل حار ردّ على البريد" : "📧 ردّ على البريد"}</b> — ${esc(mail.fromName ?? from)} &lt;${esc(from)}&gt;`,
    contact?.company ? esc(contact.company) : "",
    `النية: ${esc(INTENT_AR[v.intent!].label)}${temp ? ` · ليلى: ${TEMP_AR[temp]}` : ""}${temp === "hot" && contact?.phone ? ` · واتساب: +${esc(contact.phone.replace(/\D/g, ""))}` : ""}`,
    `الخطوة: ${esc(INTENT_AR[v.intent!].next)}`,
    v.solicited ? "" : "⚠️ لا سجلَّ إرسالٍ لهذا العنوان عندنا — يرجَّح أن العرض أُرسل بيدك من خارج النظام.",
    `«${esc(text.slice(0, 300))}»`,
    "", "المسودة تنتظرك في قسم البريد → الوارد.",
  ].filter(Boolean).join("\n")).catch(() => false);
  await say({ userId, fromRole: "sales", toRole: "chief", kind: "report", body: `ردّ بريد من ${contact?.company ?? from}: ${INTENT_AR[v.intent!].label}` }).catch(() => {});
  // عميلٌ حار ولا تليجرام يصله الخبر: لا يُترك في سجلٍ لا يقرؤه أحد.
  if (temp === "hot" && !told) {
    await escalate(userId, { inboundId: row.id, from, company: contact?.company ?? mail.fromName ?? null, text, why: "تليجرام غير مضبوط — الإشعار لم يصل" }).catch(() => {});
  }

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

// ── خارج المكتب: متى يعود ─────────────────────────────────────────
// الرد الآلي يقول تاريخ العودة بصيغٍ كثيرة: «back on 12 November»،
// «until 15 Nov»، «return on 12/11»، «من ١ إلى ١٠ نوفمبر»، أو ISO. تُجمع كل
// التواريخ في النص، ويُفضَّل ما سبقته كلمةُ عودة، وإلا أبعدُها — في
// «من … إلى …» تاريخ العودة هو الثاني. نقيّة لتُختبر بلا قاعدة.
const RETURN_WORDS = /(back|return(ing)?|until|till|through|resume|reach(able)?|to|اعود|العوده|عوده|ساعود|حتي|الي|لغايه)(?:\s*(?:on|in|from|the|of|office|by|:))*\s*$/i;
const WEEKDAYS: Array<[RegExp, number]> = [
  [/\b(sun(day)?|الاحد)\b/i, 0], [/\b(mon(day)?|الاثنين|الإثنين)\b/i, 1], [/\b(tue(s|sday)?|الثلاثاء)\b/i, 2],
  [/\b(wed(nesday)?|الاربعاء)\b/i, 3], [/\b(thu(rs|rsday)?|الخميس)\b/i, 4], [/\b(fri(day)?|الجمعه)\b/i, 5], [/\b(sat(urday)?|السبت)\b/i, 6],
];
const MONTH_NAMES = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|يناير|فبراير|مارس|ابريل|مايو|يونيو|يوليو|اغسطس|سبتمبر|اكتوبر|نوفمبر|ديسمبر";
// بلا `\b`: حدود الكلمة في JS لاتينية، فلا تقف عند حرفٍ عربي أبداً.
const MONTH_RES = MONTHS.map(([re]) => new RegExp(`^(?:${re.source.replace(/\\b/g, "")})$`, "i"));
const monthIndex = (word: string): number => MONTH_RES.findIndex((re) => re.test(word));

export function oooReturnDate(text: string, now: Date = new Date()): Date | null {
  // التطبيع العربي نفسه الذي يستعمله المصنّف: همزات، وأرقام مشرقية.
  const t = text.replace(/[آأإا]/g, "ا").replace(/ة/g, "ه").replace(/[ى]/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\r/g, "");
  const DAY = 86_400_000, y0 = now.getFullYear();
  const found: Array<{ at: Date; idx: number }> = [];
  const push = (y: number, m: number, d: number, idx: number) => {
    if (m < 0 || m > 11 || d < 1 || d > 31) return;
    const at = new Date(y, m, d, 9);
    if (at.getMonth() !== m) return;
    found.push({ at, idx });
  };
  let m: RegExpExecArray | null;
  // ISO: 2026-11-12
  const iso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g;
  while ((m = iso.exec(t))) push(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m.index);
  // يوم/شهر(/سنة) — ترتيب الإمارات: اليوم أولاً.
  const num = /(?<![\d\/.\-])(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](20\d{2}|\d{2}))?(?![\d\/\-]|\.\d)/g;
  while ((m = num.exec(t))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : y0;
    push(y, Number(m[2]) - 1, Number(m[1]), m.index);
  }
  // 12 November / 12th Nov 2026 / ١٢ نوفمبر
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})(?![a-z])(?:,?\\s*(20\\d{2}))?`, "gi");
  while ((m = dm.exec(t))) push(m[3] ? Number(m[3]) : y0, monthIndex(m[2]!), Number(m[1]), m.index);
  // November 12 / Nov 12th, 2026
  const md = new RegExp(`(?<![a-z])(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(20\\d{2}))?`, "gi");
  while ((m = md.exec(t))) push(m[3] ? Number(m[3]) : y0, monthIndex(m[1]!), Number(m[2]), m.index);
  // يوم الأسبوع بعد كلمة عودة: «back on Monday» — أقرب اثنين قادم.
  if (!found.length) {
    for (const [re, wd] of WEEKDAYS) {
      const w = new RegExp(`(?:back|return(?:ing)?|until|till|on|اعود|حتي|يوم)\\s+(?:on\\s+)?(?:next\\s+)?${re.source}`, "i").exec(t);
      if (!w) continue;
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9);
      let diff = (wd - d.getDay() + 7) % 7; if (diff === 0) diff = 7;
      d.setDate(d.getDate() + diff);
      found.push({ at: d, idx: w.index });
      break;
    }
    if (/\btomorrow\b|غدا/i.test(t)) found.push({ at: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9), idx: 0 });
  }
  // سنةٌ لم تُذكر وتاريخٌ قد مضى: السنة القادمة. وما بعد ثلاثة أشهر ليس عودةً من إجازة.
  const ok = found.map((f) => {
    if (f.at.getTime() < now.getTime() - DAY && !/20\d{2}/.test(t.slice(f.idx, f.idx + 24))) f.at.setFullYear(f.at.getFullYear() + 1);
    return f;
  }).filter((f) => f.at.getTime() >= now.getTime() - DAY && f.at.getTime() <= now.getTime() + 120 * DAY);
  if (!ok.length) return null;
  const after = ok.filter((f) => RETURN_WORDS.test(t.slice(Math.max(0, f.idx - 24), f.idx)));
  const pool = after.length ? after : ok;
  return pool.reduce((a, b) => (b.at > a.at ? b : a)).at;
}

/** أطول غيابٍ نصدّقه، وافتراضُنا حين لا يُذكر تاريخ. */
const OOO_MAX_DAYS = 45, OOO_DEFAULT_DAYS = 7;

/**
 * رُدّ آلياً بأنه غائب: تُمهَل الجهة إلى ما بعد عودته بيوم، وما ينتظر من
 * متابعاتها يُؤجَّل لا يُلغى، ومن سُمّي بديلاً يُكتب في السجل — ولا يُضاف
 * لقائمةٍ من تلقاء نفسه: كتابته بديلاً أثناء الغياب ليست إذناً بمراسلته.
 */
export async function outOfOffice(userId: number, contact: { id: number; email: string; company?: string | null; quietUntil?: Date | null }, text: string, from: string, ourEmail: string | null, inboundId: number): Promise<Date> {
  const DAY = 86_400_000, now = Date.now();
  const ret = oooReturnDate(text, new Date(now));
  let until = ret ? new Date(ret.getTime() + DAY) : new Date(now + OOO_DEFAULT_DAYS * DAY);
  if (until.getTime() > now + OOO_MAX_DAYS * DAY) until = new Date(now + OOO_MAX_DAYS * DAY);
  // هدنةٌ أطول قائمةٌ أصلاً («بعد التدقيق») لا تُقصَّر بسبب إجازة.
  if (contact.quietUntil && new Date(contact.quietUntil).getTime() > until.getTime()) until = new Date(contact.quietUntil);
  await db.update(emailContactsTable).set({ quietUntil: until, quietReason: "خارج المكتب" }).where(eq(emailContactsTable.id, contact.id));
  // المتابعات المعلّقة تُدفَع إلى ما بعد العودة — `inTruce` في المصرف يحترم
  // quietUntil أيضاً، لكن تأجيل الموعد نفسه يُبقي ترتيب السلّم صحيحاً.
  const resume = new Date(until.getTime() + DAY);
  await db.update(emailSequenceJobsTable).set({ dueAt: resume })
    .where(and(eq(emailSequenceJobsTable.userId, userId), eq(emailSequenceJobsTable.contactId, contact.id), eq(emailSequenceJobsTable.status, "pending"), lt(emailSequenceJobsTable.dueAt, resume)));
  const ours = (ourEmail ?? "").toLowerCase();
  const alt = [...new Set((text.match(/[a-z0-9._%+\-']+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))]
    .filter((e) => e !== from && e !== ours && !/^(no-?reply|noreply|mailer-daemon|postmaster)@/.test(e));
  await activity(userId, "email_replies", "ooo",
    `خارج المكتب — ${contact.company ?? from}: ${ret ? `يعود ${ret.toLocaleDateString("en-GB")}` : "بلا تاريخ عودة"} — أُمهل حتى ${until.toLocaleDateString("en-GB")}${alt.length ? ` · بديل أثناء الغياب: ${alt.slice(0, 3).join("، ")}` : ""}`,
    { inboundId, contactId: contact.id, until: until.toISOString(), alternates: alt.slice(0, 3) }).catch(() => {});
  logger.info({ userId, contactId: contact.id, until, alt }, "خارج المكتب — أُمهلت الجهة");
  return until;
}

// ── التصعيد: ردٌّ حار لا يراه أحد ────────────────────────────────
/**
 * ردٌّ حار لم يصل خبره (لا تليجرام)، أو مسودته تنتظر ساعتين بلا أحد:
 * سطرٌ في لوحة الفريق، ورسالةٌ للرئيس، وبريدٌ إلى صندوق صاحب العمل
 * نفسه إن كان الإرسال مضبوطاً — الصندوق الذي يقرؤه على كل حال.
 */
export async function escalate(userId: number, x: { inboundId: number; from: string; company: string | null; text: string; why: string }): Promise<void> {
  const head = `ردٌّ حار ينتظر — ${x.company ?? x.from}`;
  await activity(userId, "email_replies", "escalate", `${head}: ${x.why}. «${x.text.slice(0, 160)}» — افتح البريد → الوارد.`, { inboundId: x.inboundId, from: x.from }).catch(() => {});
  await say({ userId, fromRole: "email_replies", toRole: "chief", kind: "alert", body: `${head} (${x.why}). النص: «${x.text.slice(0, 200)}»` }).catch(() => {});
  try {
    const s = await getSettings(userId);
    if (!s || !isConfigured(s) || !s.fromEmail) return;
    const body = `${head}\n${x.why}\n\nمن: ${x.from}\n\n${x.text.slice(0, 1500)}\n\nالمسودة في قسم البريد → الوارد.`;
    await sendEmail(s, {
      to: s.fromEmail, toName: null, subject: `🔥 ${head}`.slice(0, 200),
      html: `<div dir="auto" style="font:15px/1.8 Arial,sans-serif;white-space:pre-wrap">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`,
      text: body, messageId: messageIdFor(newToken(), s.fromEmail), unsubscribeUrl: null, inReplyTo: null, kind: "owner_notice",
    });
  } catch (err: any) {
    logger.warn({ userId, inboundId: x.inboundId, err: String(err?.message ?? err) }, "تعذّر بريد التصعيد");
  }
}

/**
 * المسح كل ربع ساعة: مسودات ردودٍ حارة بقيت «مسودة» بلا إرسالٍ آلي
 * ولا إنسان لساعتين — تُصعَّد مرةً واحدة (السجل يشهد). الحرارة على
 * وسم الجهة، حيث وضعتها ليلى.
 */
export async function escalateStaleHotDrafts(now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - HOT_STALE_MS), floor = new Date(now.getTime() - 7 * 86_400_000);
  const rows = (await db.execute<{ id: number; user_id: number; from_email: string; text: string | null; company: string | null }>(sql`
    SELECT i.id, i.user_id, i.from_email, i.text, c.company
    FROM email_inbound i JOIN email_contacts c ON c.id = i.contact_id
    WHERE i.state = 'drafted' AND i.auto_send_at IS NULL AND i.kind = 'reply'
      AND i.received_at < ${since} AND i.received_at > ${floor}
      AND c.tags @> '["hot"]'::jsonb
      -- وسم «حار» على الجهة قد يكون من ردٍّ قديم؛ الرسالة نفسها يجب أن تحمل نيّة.
      -- أول تشغيل نبّه على إقرارٍ آلي من خدمة عملاء (unclear) كأنه عميل ينتظر.
      AND i.intent IN ('interested', 'question', 'considering', 'later', 'referral')
      -- تنبيهٌ واحد للشخص في ثلاثة أيام، لا واحدٌ لكل رسالةٍ منه.
      AND NOT EXISTS (SELECT 1 FROM email_agent_activity a WHERE a.user_id = i.user_id AND a.action = 'escalate'
        AND ((a.ref->>'inboundId')::int = i.id OR (lower(a.ref->>'from') = lower(i.from_email) AND a.created_at > ${new Date(now.getTime() - 3 * 86_400_000)})))
    ORDER BY i.received_at DESC LIMIT 20`)).rows;
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.from_email.toLowerCase())) continue;
    seen.add(r.from_email.toLowerCase());
    await escalate(Number(r.user_id), { inboundId: Number(r.id), from: r.from_email, company: r.company, text: r.text ?? "", why: "مسودة الرد تنتظر أكثر من ساعتين بلا إرسال" }).catch(() => {});
  }
  return rows.length;
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
  // الرسالة التي ردّ عليها بنصّها الكامل (حتى ١٥٠٠ حرف)، لا ٢٦٠ حرفاً من
  // الموجز: ما وعدنا به وما سألناه هو ما يردّ عليه، والمسودة تُبنى عليه.
  const original = inb.messageId ? await sentBody(inb.messageId, 1500).catch(() => "") : "";

  const [facts, skills, replySkills, memory, docs] = await Promise.all([
    retrieve(userId, `${inb.subject ?? ""} ${inb.text ?? ""}`.slice(0, 500), 4).catch(() => []),
    skillsFor(userId, "sales", inb.intent as any || "question").catch(() => []),
    // ليلى's craft — reading the reply and writing English B2B — whoever answers.
    skillsFor(userId, "email_replies", "internal").catch(() => []),
    // ذاكرة من يردّ على البريد — لا ذاكرة مندوب الواتساب.
    memoryPreamble(userId, "email_replies").catch(() => ""),
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
      noraVoice ? "" : personaFor("sales", sales?.persona) ?? "",
      // الظل: تعليمات ليلى المقترحة تدخل الصوت؛ خارج المحاكاة لا شيء هنا.
      simPersona("email_replies") ?? "",
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
      original ? `نص رسالتنا تلك:\n${original}\n— انتهت رسالتنا —` : "",
      `عنوان رده: ${inb.subject ?? ""}`,
      `رده:\n${inb.text ?? ""}`,
    ].filter(Boolean).join("\n") },
  ], 45_000));
  if (!out?.text) return null;

  const summary = /الخلاصة\s*[:：]\s*(.+)/.exec(out.text)?.[1]?.trim() ?? "";
  const subject = /العنوان\s*[:：]\s*(.+)/.exec(out.text)?.[1]?.trim() ?? `Re: ${ours?.subject ?? inb.subject ?? ""}`;
  const body = /الرد\s*[:：]\s*\n?([\s\S]+)$/.exec(out.text)?.[1]?.trim() ?? out.text.trim();
  const signed = s?.signature ? `${body}\n\n${htmlToText(s.signature)}` : body;

  if (!dryRun()) await db.update(emailInboundTable).set({ summary, draftSubject: subject.slice(0, 300), draftReply: signed, state: "drafted" }).where(eq(emailInboundTable.id, inboundId));
  return { subject, body: signed, summary };
}

/** Send the draft (edited or not) as a proper reply in the same thread. */
export async function sendReply(userId: number, inboundId: number, subject?: string, body?: string): Promise<{ messageId: number }> {
  const [inb] = await db.select().from(emailInboundTable).where(and(eq(emailInboundTable.id, inboundId), eq(emailInboundTable.userId, userId))).limit(1);
  if (!inb) throw new Error("الرسالة غير موجودة");
  const base = await getSettings(userId);
  if (!isConfigured(base)) throw new Error("إعدادات البريد غير مكتملة");
  // The reply leaves from the mailbox the customer wrote back to.
  const via = await senderFor(userId, inb.fromEmail).catch(() => null);
  const s = via ? asSettings(base!, via) : base;
  const subj = (subject ?? inb.draftSubject ?? `Re: ${inb.subject ?? ""}`).slice(0, 300);
  const text = body ?? inb.draftReply ?? "";
  if (!text.trim()) throw new Error("الرد فارغ");

  const token = newToken();
  const html = `<div dir="auto" style="font:15px/1.8 Arial,sans-serif;color:#111827;white-space:pre-wrap">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`;
  const messageId = messageIdFor(token, s!.fromEmail!);
  const [m] = await db.insert(emailMessagesTable).values({
    userId, contactId: inb.contactId, toEmail: inb.fromEmail, subject: subj, token, status: "queued", messageIdHdr: messageId, senderId: via?.id ?? null,
  }).returning();
  try {
    const r = await sendEmail(s!, { to: inb.fromEmail, toName: inb.fromName, subject: subj, html, text, messageId, unsubscribeUrl: null, inReplyTo: inb.messageIdHdr, kind: "reply" });
    await db.update(emailMessagesTable).set({ status: "sent", sentAt: new Date(), providerId: r.providerId }).where(eq(emailMessagesTable.id, m!.id));
    await db.update(emailInboundTable).set({ state: "sent", draftSubject: subj, draftReply: text, autoSendAt: null }).where(eq(emailInboundTable.id, inboundId));
    if (inb.draftReply) await recordFeedback({ userId, role: "email", channel: "email", kind: "email_reply", refId: inboundId, context: (inb.text ?? "").slice(0, 1_500), original: inb.draftReply, final: text, verdict: body != null ? "edited" : "approved" });
    await recordEvent(userId, m!.id, "sent", { meta: { reply: true } });
  } catch (err: any) {
    // المفتاح مُطفأ: المحاولة لم تخرج ولا سطر لها، والمسودة في مكانها تنتظر.
    if (err instanceof EmailHalted) { await db.delete(emailMessagesTable).where(eq(emailMessagesTable.id, m!.id)); throw err; }
    await db.update(emailMessagesTable).set({ status: "failed", error: String(err?.message ?? err).slice(0, 400) }).where(eq(emailMessagesTable.id, m!.id));
    throw err;
  }
  return { messageId: m!.id };
}

// ── IMAP ──────────────────────────────────────────────────────────
/** One inbox to read: where it is, where the last read stopped, and where to write the next stop. */
export interface Inbox {
  userId: number; host: string; port: number; user: string; pass: string; own: string[]; lastUid: number;
  /** An extra mailbox may be a person's working inbox: only replies to our campaigns and bounces are taken from it. */
  onlyOurs?: boolean;
  save: (patch: { lastUid?: number; error?: string | null }) => Promise<unknown>;
}

export async function pollMailbox(s: EmailSettings): Promise<number> {
  // The replies arrive in the mailbox that sends, almost always: an empty
  // IMAP username or password means the sender's own.
  const user = s.imapUser?.trim() || s.smtpUser, pass = s.imapPass || s.smtpPass;
  if (!s.imapHost || !user || !pass) return 0;
  return pollInbox({
    userId: s.userId, host: s.imapHost, port: s.imapPort ?? 993, user, pass, own: [s.fromEmail ?? ""], lastUid: s.imapLastUid,
    save: (p) => db.update(emailSettingsTable).set({ ...(p.lastUid != null ? { imapLastUid: p.lastUid } : {}), ...(p.error !== undefined ? { imapLastError: p.error } : {}) }).where(eq(emailSettingsTable.userId, s.userId)),
  });
}

/** Each extra sending mailbox's inbox: its replies and its bounces come back there, not to the first. */
export async function pollSenderInbox(x: EmailSender): Promise<number> {
  if (!x.imapHost) return 0;
  return pollInbox({
    userId: x.userId, host: x.imapHost, port: x.imapPort ?? 993, user: x.smtpUser, pass: x.smtpPass, own: [x.fromEmail], lastUid: x.imapLastUid, onlyOurs: true,
    save: (p) => db.update(emailSendersTable).set({ ...(p.lastUid != null ? { imapLastUid: p.lastUid } : {}), ...(p.error !== undefined ? { imapLastError: p.error } : {}) }).where(eq(emailSendersTable.id, x.id)),
  });
}

/** Is this mail about our campaigns: a bounce, a reply in our thread, or from someone we wrote to? */
async function isOurs(userId: number, from: string, inReplyTo: string | null, references: string | string[] | null, subject: string): Promise<boolean> {
  if (/^(mailer-daemon|postmaster|mail-daemon)@/i.test(from) || /undeliver|delivery status|returned mail|failure notice|delivery failure/i.test(subject)) return true;
  const ids = [inReplyTo, ...(Array.isArray(references) ? references : String(references ?? "").split(/\s+/))].filter((x): x is string => !!x && x.length > 3);
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM email_messages WHERE user_id = ${userId} AND status IN ('sent','bounced')
    AND (lower(to_email) = lower(${from}) ${ids.length ? sql`OR message_id_hdr IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))` : sql``})`);
  return Number((r.rows[0] as any)?.n ?? 0) > 0;
}

async function pollInbox(ib: Inbox): Promise<number> {
  const s = { userId: ib.userId, imapHost: ib.host, imapPort: ib.port, imapLastUid: ib.lastUid };
  const user = ib.user, pass = ib.pass;
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
        await ib.save({ lastUid: Math.max(0, uidNext - 1) });
        return 0;
      }
      let maxUid = s.imapLastUid;
      for await (const msg of client.fetch({ uid: `${s.imapLastUid + 1}:*` }, { uid: true, source: true })) {
        if (msg.uid <= s.imapLastUid) continue;
        maxUid = Math.max(maxUid, msg.uid);
        try {
          const parsed = await simpleParser(msg.source as Buffer);
          const fromAddr = parsed.from?.value?.[0];
          if (!fromAddr?.address || ib.own.some((o) => o && o.toLowerCase() === fromAddr.address!.toLowerCase())) continue;
          // الترويسات التي يحتاجها المصنّف ليعرف الآلة من الإنسان.
          // RFC 3834 يُلزم كل مجيبٍ آليٍّ مؤدّب بـ Auto-Submitted، وهي
          // أصدق من أي نمطٍ في العنوان أو النص.
          const hdrs: Record<string, string> = {};
          for (const k of ["auto-submitted", "x-autoreply", "x-autorespond", "x-autoresponder", "x-auto-response-suppress", "x-mailer-autoreply", "precedence", "list-id", "list-unsubscribe", "list-post", "x-campaign-id", "x-mailchimp-id", "feedback-id", "x-failed-recipients", "content-type"]) {
            const val = (parsed.headers as Map<string, unknown> | undefined)?.get(k);
            if (val != null) hdrs[k] = typeof val === "string" ? val : String((val as any)?.value ?? val);
          }
          // A person's own mail in a shared mailbox is theirs, not the campaign's:
          // it is not read into the system, nor answered by an agent.
          if (ib.onlyOurs && !(await isOurs(s.userId, fromAddr.address, parsed.inReplyTo ?? null, parsed.references ?? null, parsed.subject ?? ""))) continue;
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
        await ib.save({ lastUid: maxUid, error: null });
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 300);
    await ib.save({ error: msg })?.catch?.(() => {});
    logger.warn({ userId: s.userId, err: msg }, "IMAP poll failed");
    try { await client.logout(); } catch {}
  }
  return handled;
}

export async function pollAllMailboxes(): Promise<void> {
  const rows = await db.select().from(emailSettingsTable).where(sql`${emailSettingsTable.imapHost} is not null and coalesce(nullif(${emailSettingsTable.imapUser}, ''), ${emailSettingsTable.smtpUser}) is not null`);
  // الموقوف لا يُقرأ بريده الآن، فلا يُصنَّف بلا نموذج ولا يضيع: lastUid يكمل حين يعود.
  // كل دقيقتين: نبضٌ مجمَّع، وسطر تنفيذ كل ربع ساعة على الأكثر.
  for (const s of rows) { if (await accountHalted(s.userId, "email.poll")) continue; await runAs(s.userId, "email_replies", { kind: "inbound_poll", respect: "none", sampleMin: 15 }, () => pollMailbox(s)).catch(() => {}); }
  const extra = await db.select().from(emailSendersTable).where(and(isNotNull(emailSendersTable.imapHost), sql`${emailSendersTable.status} <> 'paused'`)).catch(() => []);
  for (const x of extra) { if (await accountHalted(x.userId, "email.poll")) continue; await runAs(x.userId, "email_replies", { kind: "inbound_poll", respect: "none", sampleMin: 15 }, () => pollSenderInbox(x)).catch(() => {}); }
}

/** Drafts whose moment has come. A person who edited or sent one first has already moved it out of "drafted". */
/**
 * لماذا لا تُرسَل مسودةٌ حان وقتها — إن كان ثمة سبب. تُسأل لحظة الإرسال
 * لا لحظة الجدولة: بين الاثنتين قد يُلغي الشخص اشتراكه، أو يكتب رسالةً
 * ثانية تنسخ الأولى («تجاهلوا بريدي السابق»)، أو يُمهَل، أو تُنسى المسودة
 * يومين فتخرج على سياقٍ مات. ردٌّ خاطئ أسوأ من لا ردّ.
 */
export async function autoSendBlocker(inb: { id: number; userId: number; contactId: number | null; fromEmail: string; receivedAt: Date }, now = new Date()): Promise<string | null> {
  if (now.getTime() - new Date(inb.receivedAt).getTime() > DRAFT_MAX_AGE_MS) return "المسودة أقدم من ٤٨ ساعة";
  if (inb.contactId) {
    const [c] = await db.select({ status: emailContactsTable.status, quietUntil: emailContactsTable.quietUntil, quietReason: emailContactsTable.quietReason })
      .from(emailContactsTable).where(eq(emailContactsTable.id, inb.contactId)).limit(1);
    if (!c) return "الجهة لم تعد موجودة";
    if (c.status !== "active") return `الجهة لم تعد نشطة (${c.status})`;
    if (c.quietUntil && new Date(c.quietUntil).getTime() > now.getTime()) return `الجهة في هدنة حتى ${new Date(c.quietUntil).toLocaleDateString("en-GB")}${c.quietReason ? ` — ${c.quietReason}` : ""}`;
  }
  const [newer] = await db.select({ id: emailInboundTable.id }).from(emailInboundTable)
    .where(and(eq(emailInboundTable.userId, inb.userId), sql`${emailInboundTable.id} <> ${inb.id}`, gt(emailInboundTable.receivedAt, new Date(inb.receivedAt)),
      inb.contactId ? sql`(${emailInboundTable.contactId} = ${inb.contactId} or lower(${emailInboundTable.fromEmail}) = ${inb.fromEmail.toLowerCase()})` : sql`lower(${emailInboundTable.fromEmail}) = ${inb.fromEmail.toLowerCase()}`))
    .limit(1);
  if (newer) return "وصلت منه رسالةٌ أحدث بعد هذه — الرد عليها هو الذي يُكتب";
  return null;
}

/** Drafts whose moment has come. A person who edited or sent one first has already moved it out of "drafted". */
export async function sendDueAutoReplies(now = new Date()): Promise<number> {
  const due = await db.select({ id: emailInboundTable.id, userId: emailInboundTable.userId, contactId: emailInboundTable.contactId, fromEmail: emailInboundTable.fromEmail, receivedAt: emailInboundTable.receivedAt }).from(emailInboundTable)
    .where(and(eq(emailInboundTable.state, "drafted"), isNotNull(emailInboundTable.autoSendAt), lt(emailInboundTable.autoSendAt, now))).limit(20);
  let n = 0;
  for (const d of due) {
    // حسابٌ موقوف: موعد الإرسال يبقى، ويُعاد السؤال كله حين يعود.
    if (await accountHalted(d.userId, "email.auto_reply")) continue;
    try {
      // يُعاد السؤال لحظة الإرسال، لا لحظة الجدولة.
      const why = await autoSendBlocker(d, now);
      if (why) {
        await db.update(emailInboundTable).set({ state: "held", autoSendAt: null }).where(eq(emailInboundTable.id, d.id));
        await activity(d.userId, "email_replies", "hold", `أُمسك الرد الآلي على ${d.fromEmail}: ${why}. المسودة تنتظر شخصاً.`, { inboundId: d.id, why }).catch(() => {});
        logger.info({ userId: d.userId, inboundId: d.id, why }, "أُمسك الرد الآلي");
        continue;
      }
      await sendReply(d.userId, d.id); n++; logger.info({ userId: d.userId, inboundId: d.id }, "أُرسل رد البريد تلقائياً");
    } catch (err: any) {
      if (err instanceof EmailHalted) continue;
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
    // ردٌّ حار مسودته تنتظر ساعتين بلا أحد: يُصعَّد.
    setInterval(() => void escalateStaleHotDrafts().catch(() => {}), 15 * 60_000);
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
