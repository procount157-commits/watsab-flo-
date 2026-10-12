// ── Read the message first, then write one reply for it ──────────
// What the replies showed, on the owner's own number, the day after the
// prompt was rebuilt a fourth time:
//
//   «What ?»               → "Just checking in… are you on mainland or free zone?"
//   «Who is this?»         → "Hi, I'm Hala from Pro Count… mainland or free zone?"
//   «No»                   → "Is there anything specific you need help with…?"
//   «We have in house team»→ "Are you looking for help with VAT filings…?"
//
// and the pre-send check scored every one of them 100. The prompt the model
// read was 11,400 characters — twenty blocks of rules for a 76-character
// answer — and the lead card ended every one of them with «you do not know
// the licence yet: ask». A mid-size model does the last clear thing it was
// told, so it asked about the licence.
//
// So the reply is made in two steps. First, code reads the message: what
// kind of message it is (confused, asking who we are, declining, interested,
// asking a price, promoting their own services, switching language…), what
// it means given what we sent, the single thing this reply must achieve,
// and what it must not do. Then a short prompt — who you are, what we sent,
// that reading, the move, two examples for this exact situation, the facts
// that apply — and nothing else. The reading goes into the receipt, so the
// owner sees why each reply was written the way it was.

import { normalizeArabic } from "./intent";
import { HUMAN_VOICE } from "./voice-doctrine";

export type Situation =
  | "confused" | "who" | "declined" | "language" | "interested" | "price"
  | "counter_pitch" | "thanks" | "question" | "other"
  // A shop's customers: a photo, a weight to price, an ad click, a piece asked by name, an order.
  | "photo" | "weight_price" | "ad_lead" | "piece" | "order";

export type Vertical = "accounting" | "jewelry";
export type Dialect = "gulf" | "yemeni" | "egyptian" | "levant" | "maghreb" | "msa" | "en";

// ── Which Arabic the customer writes ─────────────────────────────
// A lookup, not a talent: the words that belong to one dialect and almost
// never to another. Counted, the winner is the register the reply mirrors —
// unless the account fixes one (the gold house writes Emirati to everyone
// who writes Gulf or standard Arabic).
const DIALECT_WORDS: Record<Exclude<Dialect, "msa" | "en">, string[]> = {
  gulf: ["شلون", "شلونك", "شحال", "وايد", "الحين", "ابغى", "ابي", "ودي", "زين", "يبا", "يبه", "هلا", "ترى", "جذي", "جيه", "وش", "ليش", "مو", "عيل", "يا طويل العمر", "ابشر", "يزاك", "جان", "شو", "هاي", "ويه"],
  yemeni: ["بش", "ايش", "عندش", "معش", "حقك", "حقي", "حقنا", "حقه", "قدي", "كذيه", "هوه", "هيه", "تمام عاد", "والله عاد", "شي", "ماشي عاد", "اشتي", "اشتيه", "تشتي", "يا خال", "يا ولد", "اثبت", "جنبيه", "قد", "دحين"],
  egyptian: ["ازيك", "ازاي", "عايز", "عاوز", "دلوقتي", "ايه", "ليه", "كده", "كدا", "مش", "فين", "اوي", "خالص", "بتاع", "بتاعت", "حضرتك", "يعني ايه", "طب", "ماشي", "تمام يا", "انا عايز"],
  levant: ["كيفك", "شلونك", "بدي", "بدك", "هلأ", "هلق", "ليش", "شو", "هيك", "كتير", "منيح", "تكرم", "عنجد", "مو", "لسا", "لسه", "يلا", "بس", "هاد", "هاي"],
  maghreb: ["واش", "بزاف", "كيداير", "لاباس", "شحال", "دابا", "علاش", "بغيت", "خويا", "صافي", "واخا"],
};
const SHARED = new Set(["شلونك", "ليش", "شو", "مو", "بس", "هاي", "شحال", "لسا", "لسه", "ايش", "شي", "قد"]);

/** The dialect of a text, by its words; the account's own dialect for Gulf/standard Arabic when it fixes one. Pure. */
export function dialectOf(text: string, accountDialect?: string | null): Dialect {
  const t = normalizeArabic((text ?? "").toLowerCase());
  const ar = (t.match(/[\u0600-\u06FF]/g) ?? []).length, en = (t.match(/[a-z]/g) ?? []).length;
  if (!ar && en) return "en";
  const score: Record<string, number> = { gulf: 0, yemeni: 0, egyptian: 0, levant: 0, maghreb: 0 };
  for (const [d, words] of Object.entries(DIALECT_WORDS)) for (const w of words) {
    if (new RegExp(`(^|\\s)${normalizeArabic(w)}(\\s|$)`).test(t)) score[d]! += SHARED.has(w) ? 0.5 : 1;
  }
  const [best, n] = Object.entries(score).sort((a, b) => b[1] - a[1])[0]!;
  const found = n >= 1 ? (best as Dialect) : "msa";
  if (accountDialect === "gulf" && (found === "msa" || found === "gulf")) return "gulf";
  return found;
}

const DIALECT_NAME: Record<Dialect, string> = { gulf: "خليجية إماراتية", yemeni: "يمنية", egyptian: "مصرية", levant: "شامية", maghreb: "مغاربية", msa: "عربية بسيطة واضحة", en: "English" };

/** The line in the prompt that fixes the register. Pure. */
export function dialectLine(d: Dialect): string {
  if (d === "en") return "اكتب بالإنجليزية، قصيرة وطبيعية.";
  if (d === "gulf") return DIALECT_LINE;
  if (d === "yemeni") return "اللهجة: يمنية بسيطة قريبة كما يكتبها العميل (اشتي، بش، حقك، عاد، قدي) مع عربية واضحة؛ لا تخلطها بمصري أو شامي، ولا تبالغ في المحاكاة — كلمتان في محلهما خير من عشر مصطنعة.";
  return `اللهجة: ${DIALECT_NAME[d]} طبيعية كما يكتبها العميل نفسه — لا تخلطها بلهجة أخرى ولا تنتقل للفصحى الثقيلة.`;
}

export type Lang = "ar" | "en";

export type Reading = {
  situation: Situation;
  lang: Lang;
  /** What the customer means, in a line — for the model and the receipt. */
  meaning: string;
  /** The one thing this reply must achieve. */
  goal: string;
  /** What this reply must not do. */
  forbid: string[];
  /** May the reply end with a question? */
  mayAsk: boolean;
  /** This reply closes the conversation — no follow-up after it. */
  closes: boolean;
  /** The Arabic the customer writes, mirrored in the reply. */
  dialect?: Dialect;
};

const has = (t: string, words: string[]) => words.some((w) => t.includes(w));
const norm = (s: string) => normalizeArabic(s.toLowerCase()).replace(/[^\p{L}\p{N}?؟\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Arabic or English, by the message — or by what we sent when the message has no letters. Pure. */
export function langOf(text: string, fallback: Lang = "ar"): Lang {
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length, en = (text.match(/[A-Za-z]/g) ?? []).length;
  if (!ar && !en) return fallback;
  return ar >= en ? "ar" : "en";
}

/** What kind of message this is. Pure; ordered from the most specific to the least. */
export function situationOf(text: string, vertical: Vertical = "accounting"): Situation {
  const raw = (text ?? "").trim();
  const t = norm(raw);
  const words = t.split(" ").filter(Boolean);
  if (/\[صورة أرسلها العميل/.test(raw)) return "photo";
  if (vertical === "jewelry") {
    if (/(\d+(?:[.,]\d+)?)\s*(جم|جرام|غرام|غم|g\b|gm|gram)/i.test(raw.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))))) return "weight_price";
    if (has(t, ["ابغى اطلب", "ابي اطلب", "اطلبه", "اطلبها", "احجزه", "احجزها", "اشتريه", "اشتريها", "ارسلوه", "التوصيل", "توصلون", "الدفع", "كيف ادفع", "اشتري", "i want to order", "order", "delivery", "how to pay", "buy it"])) return "order";
  }
  if (!t || /^[?؟❓❔!.\s]+$/.test(raw)) return "confused";
  if (has(t, ["english please", "english plz", "in english", "english pls", "speak english", "بالانجليزي", "انجليزي", "بالعربي", "arabic please"])) return "language";
  if ((has(t, ["who is this", "who are you", "who r u", "whos this", "who s this", "مين معي", "مين انت", "من انت", "منو انت", "منو معي", "مين حضرتك", "من حضرتك", "مين معاي"]) && words.length <= 6)
    || (words.length <= 2 && ["مين", "منو", "who", "من"].includes(words[0]!) && !has(t, ["لاند", "land"]))) return "who";
  if (has(t, ["what is this", "what s this", "whats this", "i don t understand", "dont understand", "didn t understand", "ما فهمت", "مافهمت", "شو هذا", "ايش هذا", "وش هذا", "شنو هذا", "what do you mean", "huh"]) || (words.length <= 2 && ["what", "wat", "wht", "ايش", "شو", "وش", "شنو"].includes(words[0]!))) return "confused";
  if (has(t, ["not interested", "no thanks", "no thank you", "no need", "in house", "inhouse", "we have an accountant", "we have accountant", "we already have", "already have", "we are good", "stop", "غير مهتم", "مو مهتم", "مش مهتم", "لا شكرا", "ما نحتاج", "مو محتاجين", "مش محتاجين", "عندنا محاسب", "عندنا فريق", "لدينا محاسب", "لا نحتاج"]) || (words.length <= 3 && ["no", "nope", "nah", "لا", "لاء", "لأ"].includes(words[0]!))) return "declined";
  if (has(t, ["how much", "price", "cost", "fees", "charges", "quotation", "quote", "كم السعر", "كم سعر", "بكم", "الاسعار", "السعر", "التكلفه", "الرسوم", "تكلفه", "عرض سعر"])) return "price";
  if (has(t, ["interested", "yes please", "send details", "send me details", "more details", "call me", "مهتم", "ارسل التفاصيل", "ابغى التفاصيل", "ابي التفاصيل", "كلمني", "اتصل", "نعم", "ايوه", "ايوا", "تمام ارسل"]) || (words.length <= 3 && ["yes", "yeah", "yep", "sure", "ok", "okay"].includes(words[0]!) && words.length > 1 && has(t, ["send", "please", "details", "ارسل"]))) return "interested";
  // Their own offer: services, prices, a free visit — a business promoting itself to us.
  if (raw.length > 70 && has(t, ["our services", "we provide", "we offer", "we do", "free visit", "contact us", "call us", "زياره مجانيه", "خدماتنا", "نقدم", "نوفر", "للتواصل", "اتصل بنا", "عروض", "تصاميم", "صيانه", "تصليح", "repair", "maintenance", "installation", "supply"])) return "counter_pitch";
  if (/[?؟]/.test(raw)) return "question";
  if (words.length <= 4 && has(t, ["thanks", "thank you", "thx", "ok", "okay", "شكرا", "تسلم", "مشكور", "تمام", "اوكي", "حسنا"])) return "thanks";
  return "other";
}

/** Whether the customer, or the campaign, is about tax or licences — the only time the licence is worth asking. Pure. */
export const taxTopic = (s: string) => /(ضريب|vat|corporate tax|\bct\b|tax|رخص|licen[cs]e|mainland|free ?zone|مين لاند|فري زون)/i.test(s);

/** The reading of one message. Pure. */
export function read(text: string, ctx: Parameters<typeof readInner>[1]): Reading {
  const r = readInner(text, ctx);
  return { ...r, dialect: dialectOf(`${text} ${ctx.ourLast ?? ""}`.slice(0, 2000), ctx.accountDialect) };
}

function readInner(text: string, ctx: { campaignTopic?: string | null; ourLast?: string | null; known?: { licence?: string | null; activity?: string | null }; vertical?: Vertical; ad?: { title?: string | null } | null; piece?: string | null; accountDialect?: string | null }): Reading {
  const vertical = ctx.vertical ?? "accounting";
  let situation = situationOf(text, vertical);
  // A piece named in the message outranks a generic question; an ad click outranks a greeting.
  if (vertical === "jewelry" && ctx.piece && ["question", "other", "thanks", "price"].includes(situation)) situation = "piece";
  if (vertical === "jewelry" && ctx.ad && ["other", "thanks", "confused", "question"].includes(situation)) situation = "ad_lead";
  const topic = (ctx.campaignTopic ?? "").trim();
  const lang = langOf(text, langOf(ctx.ourLast ?? topic, "ar"));
  const ask = topic ? `whether ${topic.slice(0, 60)} is relevant to him` : "one easy yes/no question";
  const noLicence = !(taxTopic(text) || taxTopic(topic)) || !!ctx.known?.licence;
  const base: Omit<Reading, "situation" | "lang"> = {
    meaning: "", goal: "", forbid: ["رقم أو سعر غير موجود في المعلومات", "عبارات القوالب: just checking in، I hope this finds you well، يسعدنا، لا تتردد"],
    mayAsk: true, closes: false,
  };
  if (noLicence) base.forbid.push("السؤال عن الرخصة (مين لاند/فري زون)");
  if (vertical === "jewelry") {
    base.forbid = ["سعر أو وزن أو عيار غير موجود في المعلومات المرفقة أو في حساب السعر", "ادعاء توفر قطعة غير مذكورة", "لغة الشركات: عزيزي العميل، يسعدنا إبلاغكم، لا تترددوا، هل وصلتك رسالتي", "السؤال عن الرخصة أو النشاط"];
    const ad = ctx.ad?.title ? `إعلان «${ctx.ad.title}»` : "إعلاننا";
    switch (situation) {
      case "photo": return { ...base, situation, lang, meaning: "أرسل صورة قطعة (مذكور وصفها في رسالته).", goal: "علّق على القطعة بما تراه في الوصف، وقل إن كانت من مجموعتنا أو قريبة منها (سمِّ القطعة المشابهة من المعلومات إن وُجدت)، ثم سؤال واحد: الوزن أو المناسبة أو هل تبغى سعرها." };
      case "weight_price": return { ...base, situation, lang, meaning: "يسأل عن سعر وزن محدد.", goal: "أعطه الرقم المحسوب في المعلومات المرفقة كما هو (سعر الجرام + المصنعية + الضريبة)، وقل إنه شامل الضريبة، ثم سؤال واحد عن القطعة التي يفكر فيها.", mayAsk: true };
      case "ad_lead": return { ...base, situation, lang, meaning: `جاء من ${ad} على فيسبوك/إنستجرام — يعرف القطعة التي رآها وهو ساخن.`, goal: "رحّب به باسم المحل، اذكر القطعة أو المجموعة التي رآها في الإعلان، أعطه معلومة واحدة عنها (الوزن أو السعر من المعلومات)، واسأل سؤالاً واحداً يقرّبه من الطلب: المقاس، أو اللون، أو هل يبغى صورة أوضح." };
      case "piece": return { ...base, situation, lang, meaning: `يسأل عن قطعة بعينها${ctx.piece ? ` (${ctx.piece})` : ""}.`, goal: "أجب عن القطعة نفسها من المعلومات: الوزن والعيار والسعر شامل الضريبة والتوفر، في سطرين، ثم سؤال واحد: المقاس أو المناسبة أو هل يبغى صورة إضافية." };
      case "order": return { ...base, situation, lang, meaning: "يريد أن يطلب أو يسأل عن التوصيل والدفع.", goal: "اشكره، وقل ما يلزم لإتمام الطلب كما في المعلومات (الاسم، الإمارة، طريقة الدفع والتوصيل)، واطلب أول معلومة ناقصة فقط. إن لم تكن تفاصيل التوصيل في المعلومات فقل إن مختصاً سيرتبها معه." };
      case "price": return { ...base, situation, lang, meaning: "يسأل عن السعر.", goal: "السعر يعتمد على الوزن والعيار: اذكر سعر الجرام اليوم للعيار الافتراضي وقاعدة الحساب من المعلومات، واسأل عن القطعة أو الوزن الذي يفكر فيه." };
      case "interested": return { ...base, situation, lang, meaning: "أبدى اهتماماً.", goal: "اشكره وقدّم خطوة واحدة: صورة أوضح، أو السعر الدقيق بعد الوزن، أو زيارة المعرض في العين — واسأل أيها يفضّل.", forbid: base.forbid };
      case "declined": return { ...base, situation, lang, meaning: "رفض أو لا يريد الآن.", goal: "اشكره في سطر واترك الباب مفتوحاً (المعرض في العين موجود متى شاء). انتهت المحادثة.", mayAsk: false, closes: true, forbid: [...base.forbid, "أي سؤال", "محاولة إقناعه"] };
      case "who": return { ...base, situation, lang, meaning: "يسأل من نحن.", goal: "عرّف نفسك في سطر (اسمك، فلوريت للذهب والمجوهرات في العين)، وقل لماذا راسلناه في نصف سطر، ثم سؤال واحد سهل." };
      case "confused": return { ...base, situation, lang, meaning: "لم يفهم رسالتنا أو لا يعرف من نحن.", goal: "في سطرين: من نحن (فلوريت للذهب في العين) ولماذا راسلناه، ثم سؤال نعم/لا واحد.", forbid: [...base.forbid, "أي سؤال غير سؤال نعم/لا"] };
      default: break; // the generic readings below fit
    }
  }
  switch (situation) {
    case "confused": return { ...base, situation, lang, meaning: "لم يفهم رسالتنا أو لا يعرف من نحن.", goal: "يفهم في سطرين: من نحن ولماذا راسلناه — ثم سؤال نعم/لا واحد إن كان الموضوع يهمه.", forbid: [...base.forbid, "السؤال عن الرخصة أو النشاط", "أي سؤال غير سؤال نعم/لا"] };
    case "who": return { ...base, situation, lang, meaning: "يسأل من نحن.", goal: `عرّف نفسك في سطر (اسمك، بروكاونت للمحاسبة في أبوظبي)، وقل لماذا راسلناه في نصف سطر، ثم ${ask}.`, forbid: [...base.forbid, "السؤال عن الرخصة أو النشاط"] };
    case "declined": return { ...base, situation, lang, meaning: "رفض أو لديه من يقوم بالعمل.", goal: "اشكره في سطر واحد واترك الباب مفتوحاً بجملة قصيرة. انتهت المحادثة.", forbid: [...base.forbid, "أي سؤال", "محاولة إقناعه", "مهاجمة محاسبه أو فريقه"], mayAsk: false, closes: true };
    case "language": return { ...base, situation, lang: /english|انجليزي/i.test(text) ? "en" : "ar", meaning: "طلب لغة أخرى.", goal: "أعد جوهر رسالتنا الأخيرة باللغة التي طلبها، في سطرين، ثم سؤال نعم/لا واحد.", forbid: [...base.forbid, "السؤال عن الرخصة أو النشاط"] };
    case "interested": return { ...base, situation, lang, meaning: "أبدى اهتماماً.", goal: "اشكره بكلمة، وقل إن مختصاً من الفريق سيكلمه مكالمة قصيرة، واطلب شيئاً واحداً: الوقت المناسب له.", forbid: [...base.forbid, "أسئلة استكشاف عن الرخصة أو النشاط أو الحجم"] };
    case "price": return { ...base, situation, lang, meaning: "يسأل عن السعر.", goal: "قل إن السعر يُحدد بعد معرفة نطاق العمل، اذكر ما يحدده من المعلومات إن وُجد، واسأل عن أهم معلومة واحدة — وقل إنك تجهّز له عرضاً مكتوباً." };
    case "counter_pitch": return { ...base, situation, lang, meaning: "يعرض خدماته هو علينا (إعلان لشركته).", goal: "سطر لطيف أن خدمته ليست ما نحتاجه الآن، ثم سطر عن سبب رسالتنا له وسؤال نعم/لا واحد إن كان يهمه.", forbid: [...base.forbid, "السؤال عن تفاصيل خدمته هو", "التظاهر بأننا عميل له"] };
    case "thanks": return { ...base, situation, lang, meaning: "رد مقتضب (شكراً/تمام) دون أن يقول شيئاً.", goal: `أعطه معلومة واحدة مفيدة من موضوع رسالتنا تخص شركته، ثم ${ask}.` };
    case "question": return { ...base, situation, lang, meaning: "يسأل سؤالاً.", goal: "أجب عن سؤاله نفسه في أول جملة من المعلومات المرفقة (أو قل بصراحة إنك ستتأكد)، ثم سؤال واحد على الأكثر يقدّم الموضوع." };
    default: return { ...base, situation, lang, meaning: "رد على رسالتنا.", goal: `اربط كلامه بموضوع رسالتنا في جملة، ثم ${ask}.` };
  }
}

/** Two examples for a shop's situations, in the shop's own voice. */
const JEWELRY_EXAMPLES: Partial<Record<Situation, Record<Lang, string[]>>> = {
  photo: { ar: ["العميل: [صورة: طقم ذهب أصفر بنقش كلوفر، سلسلة وحلق وخاتم]\nجيد: «ما شاء الله ذوقك حلو — هذا قريب وايد من طقم الكلوفر عندنا، عيار ٢١ ووزنه ١٢.٨٧ جم. تبين سعره اليوم ولا صورة أوضح؟»", "سيئ: «شكراً على الصورة! كيف أقدر أساعدك؟» — ما قال شي عن القطعة."], en: ["Customer: [photo: yellow-gold clover set]\nGood: «Lovely choice — that's very close to our Clover set, 21k at 12.87 g. Want today's price or a closer photo?»", "Bad: «Thanks for the photo! How can I help?»"] },
  weight_price: { ar: ["العميل: «كم سعر ١٥ جرام عيار ٢١؟»\nجيد: «١٥ جم عيار ٢١ اليوم: سعر الجرام ٤٣٣ + مصنعية ٤٥ = ٧٬١٧٠، وبالضريبة ٧٬٥٢٩ درهم شامل. أي قطعة في بالك؟»", "سيئ: «الأسعار تختلف حسب القطعة، تواصل معنا.» — ما حسب."], en: ["Customer: «Price for 15 g 21k?»\nGood: «15 g of 21k today: 433/g + 45 making = 7,170, with VAT 7,529 AED all-in. Which piece did you have in mind?»", "Bad: «Prices vary, please contact us.»"] },
  ad_lead: { ar: ["العميل (من إعلان «طقم الكلوفر»): «السلام عليكم»\nجيد: «وعليكم السلام وهلا فيك في فلوريت 🌸 شفتي طقم الكلوفر بالإعلان — عيار ٢١، ١٢.٨٧ جم، وسعره اليوم ٦٬٤٦٠ درهم شامل. تبين صورة أوضح ولا أقولك المقاسات؟»", "سيئ: «أهلاً! كيف أقدر أساعدك؟» — تجاهل إنها جاية من إعلان قطعة محددة."], en: ["Customer (from the Clover set ad): «Hi»\nGood: «Welcome to Floret 🌸 You saw the Clover set — 21k, 12.87 g, 6,460 AED today all-in. Want a closer photo or the sizes?»", "Bad: «Hello! How can I help you?»"] },
  piece: { ar: ["العميل: «طقم الكلوفر متوفر؟»\nجيد: «إيه متوفر — عيار ٢١، ١٢.٨٧ جم، وسعره اليوم ٦٬٤٦٠ درهم شامل الضريبة. لمناسبة ولا هدية؟»", "سيئ: «نعم عندنا تشكيلة واسعة من الأطقم!» — ما جاوب عن القطعة."], en: ["Customer: «Is the Clover set available?»\nGood: «Yes — 21k, 12.87 g, 6,460 AED today all-in. For an occasion or a gift?»", "Bad: «Yes, we have a wide range of sets!»"] },
  order: { ar: ["العميل: «أبغى أطلبه»\nجيد: «أبشري. عطيني اسمك والإمارة، وأرتب لك التوصيل أو تستلمينه من المعرض في العين — أيهم أسهل لك؟»", "سيئ: «تمام، سنتواصل معك قريباً.» — ما أخذ أي معلومة."], en: ["Customer: «I want to order it»\nGood: «Great. Your name and emirate, and I'll arrange delivery — or pickup from the Al Ain showroom, whichever is easier?»", "Bad: «Okay, we'll contact you soon.»"] },
  price: { ar: ["العميل: «كم السعر؟»\nجيد: «السعر على الوزن: اليوم جرام عيار ٢١ بـ ٤٣٣ درهم + ٤٥ مصنعية + الضريبة. أي قطعة تبين أحسب لك سعرها؟»", "سيئ: «الأسعار تبدأ من ٥٠٠ درهم.» — رقم مخترع."], en: ["Customer: «How much?»\nGood: «It's by weight: 21k today is 433/g + 45 making + VAT. Which piece shall I price for you?»", "Bad: «Prices start from 500 AED.»"] },
  interested: { ar: ["العميل: «مهتمة»\nجيد: «يسرّني 🌸 أرسل لك صورة أوضح، ولا أحسب لك السعر النهائي بعد الوزن، ولا تحبين تشوفينه في المعرض بالعين؟»", "سيئ: «ممتاز! وش ميزانيتك وكم قطعة تبين؟» — استجواب."], en: ["Customer: «Interested»\nGood: «Lovely. Shall I send a closer photo, the exact price by weight, or would you like to see it at the Al Ain showroom?»", "Bad: «Great! What's your budget?»"] },
  declined: { ar: ["العميل: «لا شكراً»\nجيد: «تم، شكراً لك. المعرض في العين موجود متى حبيتي 🌸»", "سيئ: «طيب وش اللي ما عجبك؟» — يلاحق."], en: ["Customer: «No thanks»\nGood: «Understood, thank you. The Al Ain showroom is there whenever you like.»", "Bad: «What didn't you like?»"] },
  who: { ar: ["العميل: «مين معي؟»\nجيد: «معك نورة من فلوريت للذهب والمجوهرات في العين — راسلناك بخصوص تشكيلة الأطقم الجديدة. تبين أرسل لك صورها؟»", "سيئ: «أنا من فريق المبيعات.»"], en: ["Customer: «Who is this?»\nGood: «Noura from Floret Jewelry in Al Ain — we wrote about the new sets. Want me to send photos?»", "Bad: «Sales team.»"] },
  confused: { ar: ["العميل: «؟»\nجيد: «عذراً على اللبس — معك نورة من فلوريت للذهب في العين، راسلناك عن تشكيلة الأطقم عيار ٢١. يهمك الموضوع؟»", "سيئ: «هلا، كيف أقدر أساعدك؟»"], en: ["Customer: «?»\nGood: «Sorry for the confusion — Noura from Floret Jewelry, Al Ain; we wrote about our 21k sets. Is that of interest?»", "Bad: «Hi, how can I help?»"] },
};

/** Two examples for the situation — the thing a mid-size model learns from most. */
const EXAMPLES: Record<Situation, Record<Lang, string[]>> = {
  photo: { ar: ["جيد: علّق على ما في الصورة، ثم سؤال واحد.", "سيئ: «شكراً على الصورة» بلا تعليق عليها."], en: ["Good: comment on what the photo shows, then one question.", "Bad: «Thanks for the photo» and nothing about it."] },
  weight_price: { ar: ["جيد: الرقم المحسوب من المعلومات كما هو.", "سيئ: رقم من عندك."], en: ["Good: the computed number as given.", "Bad: a number of your own."] },
  ad_lead: { ar: ["جيد: اذكر ما رآه في الإعلان.", "سيئ: ترحيب عام."], en: ["Good: name what the ad showed.", "Bad: a generic welcome."] },
  piece: { ar: ["جيد: الوزن والعيار والسعر والتوفر من المعلومات.", "سيئ: «عندنا تشكيلة واسعة»."], en: ["Good: weight, karat, price and availability from the facts.", "Bad: «we have a wide range»."] },
  order: { ar: ["جيد: اطلب أول معلومة ناقصة لإتمام الطلب.", "سيئ: «سنتواصل معك»."], en: ["Good: ask for the first missing detail to complete the order.", "Bad: «we'll contact you»."] },
  confused: {
    en: ["Customer: «What ?»\nGood: «Sorry for the confusion — this is Hal from Pro Count, an accounting firm in Abu Dhabi. We wrote about AML compliance for real estate agencies; is that something you handle?»", "Bad: «Just checking in about your business setup. Are you on mainland or free zone?» — ignores that he did not understand."],
    ar: ["العميل: «؟؟»\nجيد: «عذراً على اللبس — معك هال من بروكاونت للمحاسبة في أبوظبي. راسلناكم بخصوص الامتثال لمكافحة غسل الأموال للوسطاء العقاريين، يهمكم الموضوع؟»", "سيئ: «هلا، رخصتك مين لاند ولا فري زون؟» — لم يفهم أصلاً من نحن."],
  },
  who: {
    en: ["Customer: «Who is this?»\nGood: «Hal from Pro Count, an accounting firm in Abu Dhabi — we wrote to you about corporate tax filing. Is that handled for your company already?»", "Bad: «Hi, I'm Hala… Could you let me know if your company is mainland or free zone?» — wrong name, and a question he did not ask for."],
    ar: ["العميل: «مين معي؟»\nجيد: «هال من بروكاونت للمحاسبة في أبوظبي — راسلناكم بخصوص إقرار ضريبة الشركات. عندكم أحد يتابعه؟»", "سيئ: «أنا من فريق المبيعات، وش نشاط شركتك؟» — لم يجب عن سؤاله."],
  },
  declined: {
    en: ["Customer: «We have in house team»\nGood: «Understood, thanks for letting me know. If you ever want a second pair of eyes before a filing, we're here.»", "Bad: «Are you looking for help with VAT filings or corporate-tax compliance?» — he just said no."],
    ar: ["العميل: «لا شكراً، عندنا محاسب»\nجيد: «تمام، شكراً على وقتك. إذا احتجتم مراجعة ثانية قبل أي إقرار، نحن موجودين.»", "سيئ: «طيب وش الخدمات اللي يغطيها محاسبكم؟» — يلاحق من رفض."],
  },
  language: {
    en: ["Customer: «English plz»\nGood: «Of course — we're Pro Count, an accounting firm in Abu Dhabi, and we wrote about AML compliance for real estate agencies. Is that relevant to you?»", "Bad: «Great, thanks for reaching out. Is your company registered in a Mainland or a Free Zone?» — he asked for the message in English, not a new question."],
    ar: ["العميل: «عربي لو سمحت»\nجيد: «أكيد — نحن بروكاونت للمحاسبة في أبوظبي، وراسلناكم بخصوص ضريبة الشركات. يهمكم الموضوع؟»", "سيئ: «هلا، وش نشاطكم؟» — لم يُعِد ما أرسلناه بلغته."],
  },
  interested: {
    en: ["Customer: «Interested»\nGood: «Thanks! One of our specialists will give you a short call to understand your setup — what time suits you today or tomorrow?»", "Bad: «Great! Are you mainland or free zone, and how many invoices a month?» — interrogating someone who said yes."],
    ar: ["العميل: «مهتم»\nجيد: «ممتاز، شكراً! مختص من الفريق بيكلمك مكالمة قصيرة يفهم وضعكم — أي وقت يناسبك اليوم أو بكرة؟»", "سيئ: «رخصتكم مين لاند ولا فري زون؟ وكم فاتورة بالشهر؟» — يستجوب من قال نعم."],
  },
  price: {
    en: ["Customer: «How much?»\nGood: «It depends on the scope — mainly how many transactions you have a month. Roughly how many is that? I'll send you a written quote.»", "Bad: «Our packages start from AED 500.» — a price that is not in the information."],
    ar: ["العميل: «كم السعر؟»\nجيد: «يعتمد على حجم الشغل — بالأساس كم معاملة عندكم بالشهر تقريباً؟ وأجهز لك عرض سعر مكتوب.»", "سيئ: «الأسعار تبدأ من ٥٠٠ درهم.» — سعر غير موجود في المعلومات."],
  },
  counter_pitch: {
    en: ["Customer: «Free visit! AC repair, fridge repair, call us…»\nGood: «Thanks — we're not looking for that right now. We're Pro Count, an accounting firm; we wrote about VAT filing for service companies like yours. Is that relevant?»", "Bad: «Hi Sajid, how can we assist you with your AC repair needs?» — we are not his customer."],
    ar: ["العميل: «زيارة مجانية! صيانة مكيفات…»\nجيد: «شكراً، ما نحتاجها حالياً. نحن بروكاونت للمحاسبة، وراسلناكم بخصوص إقرارات القيمة المضافة لشركات الخدمات. يهمكم؟»", "سيئ: «هل تحتاج مساعدة في محاسبة شركتك؟» بعد أن عرض خدماته — تجاهل ما قاله."],
  },
  thanks: {
    en: ["Customer: «Thanks»\nGood: «Most agencies we speak to registered on goAML and stopped there — the inspection asks for what sits behind it. Do you have that file ready?»", "Bad: «Great, thanks! Could you tell me what the main activity of your company is?» — says nothing useful."],
    ar: ["العميل: «شكراً»\nجيد: «أغلب الوسطاء اللي نكلمهم سجلوا في goAML ووقفوا — التفتيش يطلب ملف الامتثال اللي وراه. ملفكم جاهز؟»", "سيئ: «العفو! وش نشاط شركتك؟» — لا يضيف شيئاً."],
  },
  question: {
    en: ["Customer: «Do you do payroll?»\nGood: «Yes — payroll and WPS are part of what we handle. How many staff are on your payroll?»", "Bad: «Thanks for your question! We offer many services. Are you mainland?» — did not answer."],
    ar: ["العميل: «تسوون رواتب؟»\nجيد: «إيه، الرواتب ونظام حماية الأجور من خدماتنا. كم موظف عندكم تقريباً؟»", "سيئ: «شكراً على سؤالك! عندنا خدمات كثيرة.» — لم يجب."],
  },
  other: {
    en: ["Good: one line that ties what he said to what we wrote about, then one easy question about that topic.", "Bad: a generic question about his business that could be sent to anyone."],
    ar: ["جيد: سطر يربط كلامه بموضوع رسالتنا، ثم سؤال سهل واحد عن هذا الموضوع.", "سيئ: سؤال عام عن نشاطه يصلح لأي أحد."],
  },
};

/** Emirati register, as substitutions a mid-size model can apply rather than a talent it lacks. */
export const DIALECT_LINE = [
  "اللهجة: إماراتية طبيعية، لا مصرية ولا شامية ولا فصحى ثقيلة. بدّل: عايز/بدي ← أبغى · دلوقتي/هلأ ← الحين · إزيك ← شحالك/شلونك · إيه ← شو/وش · ليه ← ليش · كده ← جذي/كذا · مش ← مو/ما · كتير/أوي ← وايد · كويس ← زين · ماشي ← تم/أبشر.",
  "مع المرأة: خاطبها بصيغة المؤنث (تبين، حبيتي، شفتي). مع الرجل: المذكر. إن لم تعرف فاستخدم صيغة محايدة (تحب/تبي).",
].join("\n");

/** An English name for the employee, for English replies. */
const EN: Record<string, string> = { "هال": "Hal", "سام": "Sam", "خالد": "Khalid", "شمّة": "Shamma", "شمة": "Shamma", "نورة": "Noura", "ليلى": "Layla", "ريم": "Reem", "مريم": "Mariam", "سارة": "Sara", "فاطمة": "Fatima", "علياء": "Alia", "شيخة": "Shaikha" };
export const englishName = (name: string) => EN[name.trim()] ?? "the Pro Count team";

/** The whole prompt for one reply — short on purpose. */
export function replyPrompt(i: {
  name: string; title?: string | null; firm: string; firmLine?: string | null;
  outreach?: string | null; known?: string[]; facts?: string; reading: Reading; guardrails?: string | null;
  vertical?: Vertical; dialect?: string | null;
}): string {
  const r = i.reading;
  const examples = (i.vertical === "jewelry" && JEWELRY_EXAMPLES[r.situation]?.[r.lang]) || EXAMPLES[r.situation][r.lang];
  // The customer's dialect wins; standard Arabic takes the account's own register when it fixes one.
  const chosen = r.dialect && r.dialect !== "msa" && r.dialect !== "en" ? r.dialect : (i.dialect === "gulf" ? "gulf" : "msa");
  const never = i.vertical === "jewelry" ? "\nممنوع منعاً باتاً كلمات التحبّب: حبيبتي، حبيبي، قلبي، عيوني، حياتي، يا قمر — خاطبيها بـ«هلا فيچ» أو باسمها.\nممنوع منعاً باتاً: أي وزن أو عيار أو سعر أو توفر أو مدة توصيل لا يوجد نصاً في المعلومات أو في حساب السعر المرفق. إن لم تكن متأكداً قل «أتأكد لك من القطعة وأرد عليك خلال دقائق» واسأل عن القطعة أو الصورة — الرقم المخترع يُوقف ردك ولا يُرسل." : "";
  const dialect = r.lang === "ar" ? dialectLine(chosen) : "";
  const nameLine = r.lang === "en" ? `Your name is ${englishName(i.name)} (${i.name}). Never use another name.` : `اسمك ${i.name}. لا تستخدم اسماً غيره.`;
  return [
    `أنت ${i.name}${i.title ? `، ${i.title}` : ""} لدى ${i.firm}${i.firmLine ? ` — ${i.firmLine}` : ""}. تكتب على واتساب لعميل محتمل.`,
    nameLine,
    "",
    i.outreach ? `ما أرسلناه له قبل أن يكتب:\n${i.outreach.slice(0, 700)}` : "لم نرسل له حملة؛ هو من بدأ.",
    i.known?.length ? `ما نعرفه عنه: ${i.known.join(" · ")}` : "",
    "",
    "═══ قراءة رسالته الأخيرة ═══",
    `نوعها: ${r.meaning}`,
    `هدف ردك الوحيد: ${r.goal}`,
    `ممنوع في هذا الرد: ${r.forbid.join("؛ ")}.`,
    r.mayAsk ? "سؤال واحد على الأكثر." : "لا تسأل أي سؤال.",
    "",
    i.vertical === "jewelry" ? HUMAN_VOICE : "",
    `أمثلة لهذا النوع بالضبط:\n${examples.join("\n")}`,
    dialect,
    "",
    i.facts ? `معلومات الشركة التي يجوز ذكرها (لا تذكر غيرها):\n${i.facts.slice(0, 1600)}` : "لا معلومات محددة لهذا الموضوع — لا تذكر أرقاماً ولا أسعاراً.",
    i.guardrails ? `تعليمات صاحب العمل: ${i.guardrails}` : "",
    never,
    "",
    i.vertical === "jewelry"
      ? `اكتبي الرد وحده ${r.lang === "en" ? "in English" : "بلهجة العميلة"}: رسالة كما تكتبها يد — سطران إلى خمسة، دافئة وشخصية، بلا قوائم ولا علامات تنصيص. لا تقولي إنك برنامج.`
      : `اكتب الرد وحده ${r.lang === "en" ? "in English" : "بالعربية وبلهجة العميل"}: سطر إلى ثلاثة، بلا مقدمات ولا علامات تنصيص ولا قوائم. لا تقل إنك ذكاء اصطناعي.`,
  ].filter((x) => x !== "").join("\n");
}
