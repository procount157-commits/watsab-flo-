// ── The check before a reply leaves ──────────────────────────────
// The writing skill tells the model the rules; this makes sure it followed
// them. Every rule here is one the owner has already complained about or a
// mistake that costs a sale: a reply that runs to seven lines, asks three
// questions, opens with «يسعدني», asks for the licence type the card already
// holds, or quotes a price that is nowhere in the company's own knowledge.
//
// Rules, not a model: they run on every reply for free, and a rewrite — the
// one extra call — happens only when something is actually wrong.

import { normalizeArabic } from "./intent";
import { CORPORATE, ENDEARMENT, FORBIDDEN_OFFERS } from "./voice-doctrine";

export interface CheckContext {
  /** What the customer just wrote. */
  customer: string;
  /** The employee's previous reply in this thread, if any. */
  previous?: string | null;
  /** What the card already knows. */
  known?: { licence?: string | null; activity?: string | null; size?: string | null; staff?: string | null };
  /** 1..7 */
  stage?: number;
  /** Everything the reply may state as fact — the knowledge entries used. */
  facts?: string;
  /** What the message was read as (reply-brain): what this reply must do and must not. */
  reading?: { situation: string; mayAsk: boolean; forbid: string[] } | null;
  /** The names the employee may call themselves. */
  names?: string[];
  /** A shop: a number not in the facts is never sent — not even after a rewrite. */
  strictNumbers?: boolean;
  /** A shop's warm register: hospitality is not a template; only corporate phrases are, and a hand-written message may run five lines. */
  warm?: boolean;
  /** The pieces that exist. A piece named that is not among them stops the reply. */
  catalogNames?: string[];
  /** A discount may be offered in this message. Otherwise any discount stops it. */
  discountAllowed?: boolean;
  /**
   * A gold shop's rule (the owner, 2026-10-19): no price, no weight, no
   * today's gold rate — not even one the facts give. A question about them is
   * answered with the piece's link on the shop's site. Any of them stops it.
   */
  noPrices?: boolean;
}

const PIECE_KINDS = "طقم|اطقم|إسواره|اسواره|أسواره|اسوره|سواره|خاتم|خواتم|دبله|مريه|حيول|مرتعشه|سلسله|سلسال|حلق|تعليقه|خلخال|انسيال|إنسيال|ميداليه|بروش|عقد";
/** The pieces a text names, as «kind + up to three words». Pure. */
export function piecesNamed(text: string): string[] {
  const n = normalizeArabic(text);
  const out: string[] = [];
  for (const m of n.matchAll(new RegExp(`(?:^|\\s)(${PIECE_KINDS})\\s+([^\\s,،.؟!]+(?:\\s+[^\\s,،.؟!]+){0,2})`, "g"))) {
    // A product is «kind + a definite noun» (طقم الكلوفر); «أطقم كثيرة» names nothing.
    const words = m[2]!.split(/\s+/).filter((w) => !/^(عيار|وزن|سعر|اليوم|من|في|على|لك|لچ|له|بس|اللي|هذا|هذه|ذهب|الذهب)$/.test(w));
    if (words.length && /^ال/.test(words[0]!)) out.push(`${m[1]} ${words.join(" ")}`);
  }
  return out;
}
/** Is a named piece in the catalogue? Two of its words in one catalogue name is a match. Pure. */
export function pieceKnown(named: string, catalogNames: string[]): boolean {
  const words = normalizeArabic(named).split(/\s+/).filter((w) => w.length > 2);
  if (words.length < 2) return true; // a kind alone («طقم») names nothing
  return catalogNames.some((c) => { const cn = normalizeArabic(c); const hits = words.filter((w) => cn.includes(w)).length; return hits >= Math.min(2, words.length); });
}
/** A price, a weight or the gold rate, in Arabic or English, in a text. Pure. */
export function priceOrWeight(text: string): string | null {
  const t = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const n = normalizeArabic(t);
  const tests: Array<[RegExp, string]> = [
    [/\d[\d,.٬]*\s*(درهم|دراهم|aed|dhs?|ريال|sar|usd|\$)/i, "سعر بالعملة"],
    [/(درهم|aed|dhs)\s*\d/i, "سعر بالعملة"],
    [/\d[\d,.٬]*\s*(جم|جرام|غرام|غم|gm|grams?|g\b)/i, "وزن"],
    [/(سعر|السعر|اسعار|الاسعار|وزن|الوزن|وزنه|وزنها|بوزن)[^\n\d]{0,20}\d/, "رقم مع السعر أو الوزن"],
    [/سعر (الذهب|الجرام|الغرام|العيار|اليوم)|gold (rate|price)|price per gram/i, "سعر الذهب"],
    [/(مصنعيه|المصنعيه|making charge)[^\n]{0,20}\d/i, "مصنعية بالرقم"],
  ];
  for (const [re, what] of tests) if (re.test(n) || re.test(t)) return what;
  return null;
}

const DISCOUNT = /(خصم|تخفيض|تنزيل|عرض خاص|offer|discount|off\b|\d+\s*(%|٪))/i;

export interface Issue { code: string; note: string; fix: string }
export interface CheckResult { score: number; issues: Issue[] }

// The phrases the writing skill forbids, normalised. They are what makes a
// reply read as a template, and a customer who has seen one bot has seen
// them all.
const ROBOTIC = [
  "يسعدني", "يسرني", "لا تتردد", "نحن هنا لخدمتك", "سأكون سعيدا", "شكرا لتواصلك", "نتشرف",
  "في انتظار ردكم", "اتمني ان يكون ذلك واضحا", "دعني اوضح لك", "بناء علي ما ذكرت", "هل هناك اي شيء اخر",
  "لا تتردد في التواصل", "بكل سرور", "عزيزي العميل",
  "just checking in", "i hope this finds you well", "hope you are doing well", "feel free to", "touching base", "thanks for reaching out",
];
const SELF_REVEAL = /(ذكاء اصطناعي|نموذج لغوي|كبوت|انا بوت|as an ai|language model|chatgpt|openai)/i;

const lines = (t: string) => t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
const firstWord = (t: string) => normalizeArabic(t).split(/\s+/)[0] ?? "";
const arabicShare = (t: string) => {
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  return letters ? (t.match(/[؀-ۿ]/g) ?? []).length / letters : 0;
};

/** Money, percentages and durations in a text, as bare numbers. */
export function claims(t: string): string[] {
  // Thousands separators first: the normaliser turns punctuation into spaces
  // and "2,000" would come out as "2" and "000".
  t = t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/(\d)[,٬](\d{3})/g, "$1$2");
  const n = normalizeArabic(t);
  const out = new Set<string>();
  // «٣٠٠ ألف درهم», «2 million AED»: a multiplier between the number and the
  // unit hid the claim — a campaign promised fines «up to 300 thousand» that
  // no fact ever gave.
  const re = /(\d[\d,.]*)\s*(?:(?:الف|آلاف|الاف|مليون|ملايين|thousand|million|k|m|bn)\s*)?(درهم|ريال|aed|sar|usd|\$|%|٪|بالمئه|بالمائه|يوم|ايام|اسبوع|اسابيع|شهر|اشهر|ساعه|ساعات|جم|جرام|غرام|غم|g\b|gm|gram|grams|قيراط|k\b)/giu;
  // A karat is a claim too: «عيار 21» said of a piece the facts do not describe.
  for (const m of n.matchAll(/عيار\s*(\d{2})/g)) out.add(m[1]!);
  for (const m of n.matchAll(re)) out.add(m[1]!.replace(/[,.]0+$/, "").replace(/,/g, ""));
  for (const m of t.matchAll(/(\d[\d,.]*)\s*%/g)) out.add(m[1]!.replace(/,/g, ""));
  return [...out];
}

export function checkReply(reply: string, ctx: CheckContext): CheckResult {
  const issues: Issue[] = [];
  const text = reply.trim();
  const n = normalizeArabic(text);

  const ls = lines(text);
  if (ctx.warm ? (ls.length > 6 || text.length > 700) : (ls.length > 4 || text.length > 480)) {
    issues.push({ code: "long", note: `طويل (${ls.length} أسطر، ${text.length} حرفاً)`, fix: "اختصره إلى سطرين أو ثلاثة، وقل المقصود فقط." });
  }
  const questions = (text.match(/[؟?]/g) ?? []).length;
  if (questions > 1) {
    issues.push({ code: "questions", note: `${questions} أسئلة في رسالة واحدة`, fix: "اترك سؤالاً واحداً فقط — الأهم للمرحلة." });
  }
  if (ls.some((l) => /^(\d+[.)]|[-•*▪])\s+/.test(l)) || /^#+\s/m.test(text)) {
    issues.push({ code: "list", note: "ترقيم أو نقاط أو عناوين", fix: "اكتبها جملاً متصلة كرسالة واتساب، بلا ترقيم." });
  }
  const robotic = (ctx.warm ? CORPORATE : ROBOTIC).filter((p) => n.includes(normalizeArabic(p)));
  if (robotic.length) {
    issues.push({ code: "robotic", note: `عبارات آلية: ${robotic.join("، ")}`, fix: `احذف: ${robotic.join("، ")}. ابدأ من شيء قاله العميل.` });
  }
  if (SELF_REVEAL.test(text)) {
    issues.push({ code: "reveal", note: "يشير إلى أنه آلة", fix: "لا تذكر أنك برنامج أو ذكاء اصطناعي." });
  }

  // Asking for what the card already holds.
  const k = ctx.known ?? {};
  const asks = (re: RegExp) => ls.some((l) => /[؟?]/.test(l) && re.test(normalizeArabic(l)));
  if (k.licence && asks(/(مين ?لاند|فري ?زون|رخصت|نوع الرخصه)/)) {
    issues.push({ code: "reask", note: "يسأل عن الرخصة وهي معروفة", fix: `الرخصة معروفة (${k.licence}) — لا تسأل عنها، ابنِ عليها.` });
  }
  if (k.activity && asks(/(نشاط|وش تشتغل|شو شغلكم|مجال)/)) {
    issues.push({ code: "reask", note: "يسأل عن النشاط وهو معروف", fix: `النشاط معروف (${k.activity}) — لا تسأل عنه.` });
  }
  if (k.size && asks(/(كم فاتوره|عدد الفواتير|حجم الشغل|ايراد)/)) {
    issues.push({ code: "reask", note: "يسأل عن الحجم وهو معروف", fix: `الحجم معروف (${k.size}) — لا تسأل عنه.` });
  }

  // A template's blank that was never filled: "Hi, this is [Name] from the
  // sales team" went to a customer on this number.
  const blank = /\[[^\]\n]{1,30}\]|\{[^}\n]{1,30}\}|<[^>\n]{1,20}>|\bX{3,}\b|_{3,}/.exec(text);
  if (blank) {
    issues.push({ code: "placeholder", note: `خانة قالب لم تُملأ: ${blank[0]}`, fix: `احذف «${blank[0]}» واكتب الكلام نفسه — اسمك الحقيقي أو اترك الجملة بدونها.` });
  }

  // The reading said what this reply is for; hold it to that.
  const r = ctx.reading;
  if (r) {
    const licenceAsked = asks(/(مين ?لاند|فري ?زون|mainland|free ?zone|نوع الرخصه|licen[cs]e type)/i);
    if (licenceAsked && r.forbid.some((f) => f.includes("الرخصة"))) {
      issues.push({ code: "licence", note: "يسأل عن الرخصة والموقف لا يسمح", fix: "احذف سؤال الرخصة. افعل ما طلبته القراءة فقط." });
    }
    if (!r.mayAsk && /[?؟]/.test(text)) {
      issues.push({ code: "asked", note: "يسأل بعد أن رفض العميل", fix: "احذف السؤال: اشكره واترك الباب مفتوحاً بجملة، وانتهِ." });
    }
    if ((r.situation === "who" || r.situation === "confused" || r.situation === "language") && !/(pro ?count|بروكاونت|برو كاونت)/i.test(text)) {
      issues.push({ code: "unanswered", note: "لم يقل من نحن ولماذا راسلناه، والعميل سأل أو لم يفهم", fix: "ابدأ بمن نحن (الاسم وبروكاونت للمحاسبة) ولماذا راسلناه في نصف سطر." });
    }
    if (r.situation === "counter_pitch" && /(how can (we|i) (help|assist)|your .* needs|كيف نقدر نساعدك في)/i.test(text)) {
      issues.push({ code: "role", note: "يتصرف كأنه عميل للشركة التي تعرض خدماتها", fix: "قل بلطف إننا لا نحتاج خدمته الآن، ثم سبب رسالتنا." });
    }
  }
  // The name it calls itself must be its own.
  if (ctx.names?.length) {
    const said = /(?:\bI'?m|\bI am|\bthis is|معك|أنا|انا)\s+([A-Za-z\u0600-\u06FF]{2,})/i.exec(text)?.[1];
    if (said && !ctx.names.some((n) => n.toLowerCase() === said.toLowerCase()) && !/^(from|with|the|من|مع|فريق|team|here|هنا)$/i.test(said)) {
      issues.push({ code: "name", note: `سمّى نفسه «${said}»`, fix: `اسمك ${ctx.names[0]} — صحّحه.` });
    }
  }

  // Numbers the company never gave it.
  const allowed = new Set([...claims(ctx.facts ?? ""), ...claims(ctx.customer)]);
  const invented = claims(text).filter((c) => !allowed.has(c));
  if (invented.length) {
    issues.push({ code: ctx.strictNumbers ? "invented-strict" : "invented", note: `رقم غير موجود في معلومات الشركة: ${invented.join("، ")}`, fix: ctx.strictNumbers ? "احذف الرقم تماماً. الوزن والعيار والسعر تُقال فقط كما وردت في المعلومات أو في حساب السعر؛ وإلا قل «أتأكد لك من القطعة وأرد عليك» واسأل عن القطعة." : "احذف الرقم. إن سُئلت عنه فقل إنه يعتمد على وضعه واسأل عمّا يحدّده." });
  }

  // A term of endearment — «حبيبتي» to a customer — is forbidden outright.
  const sweet = ENDEARMENT.filter((p) => new RegExp(`(^|[\\s،,.!؟?🌸✨💛])${normalizeArabic(p)}([\\s،,.!؟?🌸✨💛]|$)`).test(n) || n.includes(` ${normalizeArabic(p)} `));
  if (sweet.length) issues.push({ code: "endearment", note: `كلمة تحبّب ممنوعة: ${sweet.join("، ")}`, fix: `احذفي «${sweet[0]}». خاطبيها بـ«هلا فيچ» أو باسمها — الدفء احترام لا تدليل.` });

  if (ctx.warm) {
    const offer = FORBIDDEN_OFFERS.filter((p) => n.includes(normalizeArabic(p)) || text.toLowerCase().includes(p));
    if (offer.length) issues.push({ code: "offer", note: `عرض ممنوع: ${offer[0]}`, fix: "احذفي عرض الصورة الأخرى. أرسلي رابط القطعة من الموقع، وتكلّمي عن تصميمها ولمن تناسب، ثم سؤال عن المناسبة." });
  }

  // A piece we do not have, and a discount that was not permitted.
  if (ctx.catalogNames?.length) {
    const unknown = piecesNamed(text).filter((p) => !pieceKnown(p, ctx.catalogNames!));
    if (unknown.length) issues.push({ code: "unknown-piece", note: `قطعة ليست في الكتالوج: ${unknown.join("، ")}`, fix: "اذكري فقط قطعة من قائمة القطع الموجودة باسمها كما هو، أو لا تسمّي قطعة." });
  }
  if (ctx.noPrices) {
    const pw = priceOrWeight(text);
    if (pw) issues.push({ code: "price-weight", note: `${pw} — ممنوع في رسائل المحل`, fix: "احذفي أي سعر أو وزن أو سعر ذهب أو خصم. من سألت عن السعر أو الوزن أرسلي لها رابط القطعة من الموقع، ففيه كل التفاصيل، في جملة قصيرة محترمة." });
    if (DISCOUNT.test(text)) issues.push({ code: "discount", note: "خصم أو عرض — ممنوع في رسائل المحل", fix: "احذفي أي خصم أو عرض." });
  }
  if (ctx.strictNumbers && !ctx.discountAllowed && !ctx.noPrices && DISCOUNT.test(text)) {
    issues.push({ code: "discount", note: "خصم غير مسموح في هذه الرسالة", fix: "احذفي أي خصم أو عرض. الخصم الوحيد المسموح هو على المصنعية وفي المتابعة الرابعة فقط." });
  }

  // Same opening word as last time reads as a template.
  if (ctx.previous && firstWord(text) && firstWord(text) === firstWord(ctx.previous)) {
    issues.push({ code: "same-open", note: `يبدأ بنفس كلمة الرد السابق («${text.split(/\s+/)[0]}»)`, fix: "ابدأ بكلمة مختلفة — من شيء قاله العميل الآن." });
  }

  // Answering Arabic in English or the reverse.
  const cAr = arabicShare(ctx.customer), rAr = arabicShare(text);
  if (ctx.customer.trim().length > 6 && ((cAr > 0.6 && rAr < 0.3) || (cAr < 0.2 && rAr > 0.6))) {
    issues.push({ code: "language", note: "بلغة غير لغة العميل", fix: cAr > 0.6 ? "العميل كتب عربياً — رُدّ بالعربية." : "العميل كتب إنجليزياً — رُدّ بالإنجليزية." });
  }

  // Selling again after a yes.
  if (ctx.stage === 7 && /(سعر|خصم|عرض خاص|باقه|باقات)/.test(n)) {
    issues.push({ code: "oversell", note: "يعرض من جديد بعد أن وافق العميل", fix: "العميل وافق — انتقل للتنفيذ: الخطوة التالية وموعدها فقط." });
  }

  const weights: Record<string, number> = { "price-weight": 80, offer: 60, endearment: 60, "invented-strict": 60, "unknown-piece": 60, discount: 60, licence: 35, asked: 35, unanswered: 30, role: 30, name: 40, placeholder: 50, long: 15, questions: 15, list: 10, robotic: 20, reveal: 40, reask: 20, invented: 30, "same-open": 5, language: 30, oversell: 20 };
  const score = Math.max(0, 100 - issues.reduce((a, i) => a + (weights[i.code] ?? 10), 0));
  return { score, issues };
}

/** Must not be sent as it is, rewritten or not. */
export function blocksSend(r: CheckResult): boolean {
  return r.issues.some((i) => ["placeholder", "reveal", "name", "asked", "invented-strict", "unknown-piece", "discount", "endearment", "offer", "price-weight"].includes(i.code));
}

/** Worth a rewrite: anything but a cosmetic same-opening. */
export function needsRewrite(r: CheckResult): boolean {
  return r.issues.some((i) => i.code !== "same-open");
}

/** The instruction the rewrite call gets: the draft, and exactly what is wrong with it. */
export function rewritePrompt(draft: string, r: CheckResult, ctx: CheckContext): string {
  return [
    "أنت تُراجع رد موظف مبيعات على واتساب قبل إرساله. أعد كتابته ليصلح المشكلات أدناه فقط، مع الحفاظ على معناه وهدفه ولهجته.",
    "اكتب الرد المصحّح وحده، بلا مقدمة ولا شرح ولا علامات تنصيص.",
    "",
    `رسالة العميل: ${ctx.customer.slice(0, 600)}`,
    "",
    `الرد المقترح:\n${draft}`,
    "",
    "المشكلات وطريقة إصلاحها:",
    ...r.issues.map((i) => `- ${i.note} ← ${i.fix}`),
  ].join("\n");
}
