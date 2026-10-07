// ── The lead card ─────────────────────────────────────────────────
// The conversation map tells an employee to know which stage of the sale it
// is in, what it has already learnt, and what the one goal of this message
// is. Until now it had to work all three out from the transcript on every
// reply, and a ten-message history rarely says "licence: free zone" in so
// many words — so it asked again, which is the single most reliable way to
// sound like a machine.
//
// So the facts are extracted by rules from the customer's own messages, the
// stage is computed from them, and both are written into the prompt as a
// card. Rules rather than a model call: extraction runs on every inbound
// message, the free tier cannot afford a second call per message, and the
// vocabulary — licence types, activities, "كم فاتورة" — is small and stable.
// What the rules miss the model still sees in the history; what they catch
// it no longer has to guess.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, leadCardsTable, waThreadMessagesTable, type LeadCard } from "@workspace/db";
import { normalizeArabic, type Intent } from "./intent";
import { logger } from "./logger";

// ── Facts ─────────────────────────────────────────────────────────

export interface LeadFacts {
  licence?: "mainland" | "freezone";
  activity?: string;
  size?: string;
  staff?: string;
  taxStatus?: string;
  accountant?: string;
  pain?: string;
  /** The objection raised in this message, if any. Transient. */
  objection?: string;
  /** This message is an agreement to go ahead. */
  agreed?: boolean;
}

// Patterns run on normalised text (see normalizeArabic): hamza forms folded
// to ا, ة to ه, ى/ئ to ي, digits Latin, punctuation gone, lower-case. They
// are written in that spelling. `\b` cannot be used — it only knows ASCII
// word characters, so it never finds the edge of an Arabic word — hence the
// lookarounds on letters and digits.
const B = "\\p{L}\\p{N}";
// A conjunction is written attached — «وعندي محاسب», «فغالي» — so one is
// allowed on the front of every match.
const W = (src: string) => new RegExp(`(?<![${B}])[وف]?(?:${src})(?![${B}])`, "iu");

// Activities a UAE company owner names. The stored value is the canonical
// form on the right.
const ACTIVITIES: Array<[RegExp, string]> = [
  [W("مقاول(ات|ه)?|مقاولين"), "مقاولات"],
  [W("مطعم|مطاعم|كافيه|كوفي|مقهي"), "مطاعم"],
  [W("تجاره|تجاري|بيع وشراء|جمله|تجزيه"), "تجارة"],
  [W("عقار(ات|ي)?"), "عقارات"],
  [W("نقل|شحن|لوجستي(ات|ه)?"), "نقل وشحن"],
  [W("صيانه|تكييف|كهرباء|سباكه"), "صيانة"],
  [W("نظافه|تنظيف"), "نظافة"],
  [W("تسويق|اعلان(ات)?|دعايه"), "تسويق"],
  [W("برمج(ه|يات)|تقنيه|سوفت|تطبيق(ات)?"), "تقنية"],
  [W("استشار(ات|ي|يه)"), "استشارات"],
  [W("صالون|حلاق(ه|ين)?|تجميل|بيوتي"), "صالونات"],
  [W("عياد(ه|ات)|طبي|مركز طبي"), "طبي"],
  [W("صيدلي(ه|ات)"), "صيدلية"],
  [W("ذهب|مجوهرات"), "ذهب ومجوهرات"],
  [W("سيارات|معرض سيارات|ورشه"), "سيارات"],
  [W("تعليم|معهد|مدرسه|تدريب"), "تعليم"],
  [W("سياح(ه|ي|يه)|سفر|فندق"), "سياحة"],
  [W("ديكور|اثاث|تصميم داخلي"), "ديكور وأثاث"],
  [W("مواد بناء|حديد|اسمنت"), "مواد بناء"],
  [W("الكتروني(ات|ه)?|جوالات|اجهزه"), "إلكترونيات"],
  [W("ملابس|ازياء|عبايات"), "ملابس"],
  [W("اغذيه|مواد غذائيه|مواد غذاييه|سوبرماركت|بقاله"), "أغذية"],
  [W("توصيل|دليفري"), "توصيل"],
  [W("تاجير|ايجار"), "تأجير"],
];

const PAINS: Array<[RegExp, string]> = [
  [W("غرام(ه|ات)|مخالف(ه|ات)"), "غرامات"],
  [W("متاخر(ه|ات|ين)?|متراكم(ه|ات)?|من شهور"), "متأخرات متراكمة"],
  [W("تدقيق|مدقق|اوديت"), "تدقيق قادم"],
  [W("تجديد (ال)?رخص(ه|تنا|تي)?"), "تجديد الرخصة"],
  [W("البنك|قرض|تمويل|شريك"), "بنك أو شريك يطلب أرقاماً"],
  [W("محاسب(ي|نا)? (ترك|استقال|مشي|راح)|ما عندي محاسب|بدون محاسب"), "بلا محاسب"],
  [W("ما اعرف (ربح|ارباح)|ما ادري (وين|كم) (الربح|الفلوس)|الفلوس (وين|فين)"), "لا يعرف ربحه"],
  [W("فوضي|مو مرتب|مش مرتب|مبعثر"), "دفاتر غير مرتبة"],
  [W("اشعار|خطاب رسمي|رساله من الهييه"), "إشعار رسمي"],
];

const OBJECTIONS: Array<[RegExp, string]> = [
  [W("غالي|مرتفع|كثير (علي|عليه)|expensive"), "غالي"],
  [W("عندي محاسب|محاسب عندي|عندنا محاسب|مكتب محاسبه"), "عنده محاسب"],
  [W("ارسل(ي|وا)? (لي )?(ال)?تفاصيل|ابغي تفاصيل|عطني تفاصيل"), "يطلب التفاصيل"],
  [W("بعدين|مشغول|مو الحين|مش دلوقتي|لاحقا"), "يؤجّل"],
  [W("شركت(نا|ي) صغيره|احنا صغار|لسه بدايه"), "يرى شركته صغيرة"],
  [W("مع مكتب (ثاني|اخر)|متعاقد(ين)? مع"), "مع مكتب آخر"],
  [W("من انتم|مين انتم|ما اعرفكم|منين (جبتوا|جبت) رقمي"), "لا يعرفنا"],
];

// Agreement comes in two strengths. «موافق» and «أرسل العقد» are a yes
// wherever they appear. «نبدأ» is a yes only as a statement — «كيف نبدأ؟» and
// «متى نبدأ» are an interested customer asking a question, and reading them
// as agreement closed the sale before the offer had been made.
const AGREED_STRONG = W("موافق(ين)?|اتفقنا|ارسل (لي )?العقد|علي بركه الله|deal");
const AGREED_SOFT   = W("نبدا|خلاص ابدا|تمام ابدا|يلا نبدا|ابشر نبدا|let s start");
const ASKING        = W("كيف|متي|وش|شو|شلون|هل|ايش|ليش|كم|how|when|what");

const LICENCE_MAINLAND = W("مين ?لاند|مينلاند|mainland|رخصه (محليه|اقتصاديه|رييسيه)|دايره (الاقتصاد|التنميه)");
const LICENCE_FREEZONE = W("فري ?زون|فريزون|free ?zone|منطقه حره");
const INVOICES = /(\d{1,6})\s*(?:الي|او)?\s*(\d{1,6})?\s*(فاتوره|فواتير)/;
const REVENUE  = /(\d{1,4}(?:[.,]\d+)?)\s*(مليون|الف|k|m)(?![\p{L}])/iu;
const STAFF    = /(\d{1,5})\s*(موظف(ين)?|عامل|عمال|شخص|انفار)/;
const TAX_NO   = W("(مو|مش|غير|ما) مسجل(ين)?|ما سجلنا|لسه ما سجلت");
const TAX_YES  = W("مسجل(ين)? (في|ب)?(ال)?ضريب(ه|ة)?");
const ACC_HAS  = W("عندي محاسب|محاسب عندي|عندنا محاسب");
const ACC_FIRM = W("مكتب محاسبه|متعاقد(ين)? مع مكتب");
const ACC_NONE = W("ما عندي محاسب|بدون محاسب|لسه ما عندنا محاسب");

/** What this one message says about the lead. Pure. */
export function extractFacts(text: string): LeadFacts {
  const n = normalizeArabic(text ?? "");
  const f: LeadFacts = {};

  if (LICENCE_MAINLAND.test(n)) f.licence = "mainland";
  else if (LICENCE_FREEZONE.test(n)) f.licence = "freezone";

  for (const [re, name] of ACTIVITIES) if (re.test(n)) { f.activity = name; break; }

  const invoices = INVOICES.exec(n);
  if (invoices) f.size = `${invoices[1]}${invoices[2] ? `–${invoices[2]}` : ""} فاتورة بالشهر`;
  else {
    const revenue = REVENUE.exec(n);
    if (revenue) f.size = `إيراد نحو ${revenue[1]} ${revenue[2]}`;
  }

  const staff = STAFF.exec(n);
  if (staff) f.staff = `${staff[1]} موظف`;

  if (TAX_NO.test(n)) f.taxStatus = "غير مسجل في الضريبة";
  else if (TAX_YES.test(n)) f.taxStatus = "مسجل في الضريبة";

  if (ACC_NONE.test(n)) f.accountant = "بلا محاسب";
  else if (ACC_HAS.test(n)) f.accountant = "عنده محاسب";
  else if (ACC_FIRM.test(n)) f.accountant = "مع مكتب محاسبة";

  for (const [re, name] of PAINS) if (re.test(n)) { f.pain = name; break; }
  for (const [re, name] of OBJECTIONS) if (re.test(n)) { f.objection = name; break; }
  if (AGREED_STRONG.test(n) || (AGREED_SOFT.test(n) && !/[؟?]/.test(text ?? "") && !ASKING.test(n))) f.agreed = true;

  return f;
}

// ── Stages ────────────────────────────────────────────────────────

export const STAGES = [
  { n: 1, name: "فتح",     goal: "أن يرد. جملة تخصّه وسؤال سهل، لا عرض." },
  { n: 2, name: "استكشاف", goal: "أن تعرف وضعه في موضوع الحملة الذي رد عليه — سؤال واحد فقط، عن هذا الموضوع لا عن كل شيء." },
  { n: 3, name: "تشخيص",   goal: "أن يسمّي هو المشكلة بلسانه." },
  { n: 4, name: "قيمة",    goal: "أن يفهم تكلفة بقاء الوضع كما هو. لا سعر بعد." },
  { n: 5, name: "عرض",     goal: "عرض واحد يناسب ما قاله، ثم السعر إن طلبه، ثم اصمت." },
  { n: 6, name: "اعتراض",  goal: "افهم سبب اعتراضه، ردّ واحد وسؤال. لا تدافع ولا تخفّض." },
  { n: 7, name: "إغلاق",   goal: "وافق. لا تبِع من جديد — خطوة محددة بزمن وسلّم لبشري باسم وموعد." },
] as const;

export type Known = Pick<LeadCard, "licence" | "activity" | "size" | "pain" | "agreedAt">;

/**
 * Where the sale is after this message. Pure.
 *
 * Mostly monotonic — a customer does not un-learn that they have a problem —
 * with one exception: an objection is a moment, not a level. Stage 6 lasts
 * for the message that raised it and the reply to it, then the sale is back
 * where it was.
 */
export function nextStage(prev: number, known: Known, intent: Intent, turns: number, now: LeadFacts): number {
  if (known.agreedAt || now.agreed) return 7;
  if (intent === "opt_out" || intent === "complaint") return prev || 1;

  let s = prev || 1;
  if (s === 6) s = 5;                                   // the objection has passed
  if (now.objection && s >= 4) return 6;

  const facts = [known.licence, known.activity, known.size].filter(Boolean).length;
  if (intent === "interested") s = Math.max(s, 5);
  else if (known.pain)         s = Math.max(s, 4);
  else if (facts >= 2)         s = Math.max(s, 3);
  else if (turns >= 2 || facts >= 1) s = Math.max(s, 2);
  return Math.max(1, s);
}

// ── The card in the prompt ────────────────────────────────────────

const LICENCE_AR = { mainland: "مِين لاند", freezone: "فري زون" } as const;

/** The card as the employee reads it. Pure. */
export function cardText(c: LeadCard): string {
  const known: string[] = [];
  if (c.licence)    known.push(`الرخصة: ${LICENCE_AR[c.licence as keyof typeof LICENCE_AR] ?? c.licence}`);
  if (c.activity)   known.push(`النشاط: ${c.activity}`);
  if (c.size)       known.push(`الحجم: ${c.size}`);
  if (c.staff)      known.push(`الموظفون: ${c.staff}`);
  if (c.taxStatus)  known.push(`الضريبة: ${c.taxStatus}`);
  if (c.accountant) known.push(`المحاسب: ${c.accountant}`);
  if (c.pain)       known.push(`وجعه: ${c.pain}`);

  const missing: string[] = [];
  if (!c.licence)  missing.push("الرخصة");
  if (!c.activity) missing.push("النشاط");
  if (!c.size)     missing.push("الحجم");
  if (!c.pain)     missing.push("ما يقلقه");

  const stage = STAGES[Math.min(7, Math.max(1, c.stage)) - 1]!;
  const lines = [
    "بطاقة العميل — من كلامه هو، لا تسأل عمّا فيها:",
    known.length ? `- ${known.join(" · ")}` : "- لا تعرف عنه شيئاً بعد.",
  ];
  if (missing.length && c.stage < 5) lines.push(`- لم تعرف بعد: ${missing.join("، ")} — اسأل عن واحدة فقط إن ناسبت الرسالة.`);
  lines.push(`المرحلة الآن: ${stage.n} — ${stage.name}. هدف هذه الرسالة: ${stage.goal}`);
  if (c.stage === 6 && c.objection) lines.push(`اعترض للتو: «${c.objection}».`);
  return lines.join("\n");
}

// ── Persistence ───────────────────────────────────────────────────

export interface CardUpdate {
  card: LeadCard;
  /** Facts this message added that the card did not have. */
  learnt: string[];
  /** The stage crossed a line the owner should hear about: 5 (hot) or 7 (agreed). */
  reached: 5 | 7 | null;
}

export async function getCard(userId: number, phone: string): Promise<LeadCard | null> {
  const [row] = await db.select().from(leadCardsTable)
    .where(and(eq(leadCardsTable.userId, userId), eq(leadCardsTable.phone, phone))).limit(1);
  return row ?? null;
}

/**
 * Fold one inbound message into the card. Called before the reply to it is
 * composed, so the prompt sees what the customer just said as fact rather
 * than as history.
 */
export async function updateCard(userId: number, phone: string, text: string, intent: Intent): Promise<CardUpdate> {
  const now = extractFacts(text);
  const prev = await getCard(userId, phone);
  const turns = (prev?.turns ?? 0) + 1;

  const merged = {
    licence:    prev?.licence    ?? now.licence    ?? null,
    activity:   prev?.activity   ?? now.activity   ?? null,
    size:       now.size         ?? prev?.size     ?? null,   // the latest figure wins
    staff:      now.staff        ?? prev?.staff    ?? null,
    taxStatus:  now.taxStatus    ?? prev?.taxStatus ?? null,
    accountant: now.accountant   ?? prev?.accountant ?? null,
    pain:       prev?.pain       ?? now.pain       ?? null,
    objection:  now.objection    ?? null,
    agreedAt:   prev?.agreedAt   ?? (now.agreed ? new Date() : null),
  };

  const learnt: string[] = [];
  for (const k of ["licence", "activity", "size", "staff", "taxStatus", "accountant", "pain"] as const) {
    if (merged[k] && merged[k] !== (prev?.[k] ?? null)) learnt.push(k);
  }

  const stage = nextStage(prev?.stage ?? 1, merged, intent, turns, now);
  const notified = prev?.notifiedStage ?? 0;
  const reached: 5 | 7 | null = stage >= 7 && notified < 7 ? 7 : stage >= 5 && notified < 5 ? 5 : null;

  const [card] = await db.insert(leadCardsTable).values({
    userId, phone, stage, ...merged, lastIntent: intent, turns,
    notifiedStage: reached ? reached : notified,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [leadCardsTable.userId, leadCardsTable.phone],
    set: { stage, ...merged, lastIntent: intent, turns, notifiedStage: reached ? reached : notified, updatedAt: new Date() },
  }).returning();

  if (learnt.length || reached) {
    logger.info({ userId, phone, stage, learnt, reached }, "بطاقة العميل حُدِّثت");
  }
  return { card: card!, learnt, reached };
}

/** The prompt block, or "" for a customer with no card yet. */
export async function cardPreamble(userId: number, phone: string): Promise<string> {
  const card = await getCard(userId, phone);
  return card ? cardText(card) : "";
}

// ── A person on the thread ────────────────────────────────────────

export const TAKEOVER_MINUTES = 24 * 60;

/** True while a person holds this thread; the bot and the follow-ups stay quiet. */
export async function isHumanHeld(userId: number, phone: string): Promise<boolean> {
  const card = await getCard(userId, phone);
  return !!card?.humanUntil && new Date(card.humanUntil).getTime() > Date.now();
}

export async function takeover(userId: number, phone: string, by: "phone" | "app" | "owner", minutes = TAKEOVER_MINUTES): Promise<Date> {
  const until = new Date(Date.now() + minutes * 60_000);
  await db.insert(leadCardsTable).values({ userId, phone, humanUntil: until, humanBy: by, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [leadCardsTable.userId, leadCardsTable.phone],
      set: { humanUntil: until, humanBy: by, updatedAt: new Date() },
    });
  logger.info({ userId, phone, by, until }, "بشري تولّى المحادثة — البوت والمتابعات صامتان");
  return until;
}

export async function release(userId: number, phone: string): Promise<void> {
  await db.update(leadCardsTable).set({ humanUntil: null, humanBy: null, updatedAt: new Date() })
    .where(and(eq(leadCardsTable.userId, userId), eq(leadCardsTable.phone, phone)));
}

// ── For the dashboard ─────────────────────────────────────────────

export async function funnel(userId: number, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000);
  const rows = await db.select({ stage: leadCardsTable.stage, n: sql<number>`count(*)` })
    .from(leadCardsTable)
    .where(and(eq(leadCardsTable.userId, userId), gte(leadCardsTable.updatedAt, since)))
    .groupBy(leadCardsTable.stage);
  const byStage = STAGES.map((s) => ({ stage: s.n, name: s.name, n: Number(rows.find((r) => r.stage === s.n)?.n ?? 0) }));

  const hot = await db.select().from(leadCardsTable)
    .where(and(eq(leadCardsTable.userId, userId), gte(leadCardsTable.stage, 5), gte(leadCardsTable.updatedAt, since)))
    .orderBy(desc(leadCardsTable.stage), desc(leadCardsTable.updatedAt)).limit(20);

  const held = await db.select().from(leadCardsTable)
    .where(and(eq(leadCardsTable.userId, userId), gte(leadCardsTable.humanUntil, new Date())));

  return { byStage, hot, held };
}

/** The last thing the customer said, for an alert. */
export async function lastCustomerLine(userId: number, phone: string): Promise<string> {
  const [row] = await db.select({ text: waThreadMessagesTable.text }).from(waThreadMessagesTable)
    .where(and(eq(waThreadMessagesTable.userId, userId), eq(waThreadMessagesTable.phone, phone), eq(waThreadMessagesTable.fromMe, false)))
    .orderBy(desc(waThreadMessagesTable.createdAt)).limit(1);
  return (row?.text ?? "").slice(0, 160);
}
