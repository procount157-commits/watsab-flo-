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

export type Situation =
  | "confused" | "who" | "declined" | "language" | "interested" | "price"
  | "counter_pitch" | "thanks" | "question" | "other";

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
export function situationOf(text: string): Situation {
  const raw = (text ?? "").trim();
  const t = norm(raw);
  const words = t.split(" ").filter(Boolean);
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
export function read(text: string, ctx: { campaignTopic?: string | null; ourLast?: string | null; known?: { licence?: string | null; activity?: string | null } }): Reading {
  const situation = situationOf(text);
  const topic = (ctx.campaignTopic ?? "").trim();
  const lang = langOf(text, langOf(ctx.ourLast ?? topic, "ar"));
  const ask = topic ? `whether ${topic.slice(0, 60)} is relevant to him` : "one easy yes/no question";
  const noLicence = !(taxTopic(text) || taxTopic(topic)) || !!ctx.known?.licence;
  const base: Omit<Reading, "situation" | "lang"> = {
    meaning: "", goal: "", forbid: ["رقم أو سعر غير موجود في المعلومات", "عبارات القوالب: just checking in، I hope this finds you well، يسعدنا، لا تتردد"],
    mayAsk: true, closes: false,
  };
  if (noLicence) base.forbid.push("السؤال عن الرخصة (مين لاند/فري زون)");
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

/** Two examples for the situation — the thing a mid-size model learns from most. */
const EXAMPLES: Record<Situation, Record<Lang, string[]>> = {
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

/** An English name for the employee, for English replies. */
const EN: Record<string, string> = { "هال": "Hal", "سام": "Sam", "خالد": "Khalid", "شمّة": "Shamma", "شمة": "Shamma", "نورة": "Noura", "ليلى": "Layla" };
export const englishName = (name: string) => EN[name.trim()] ?? "the Pro Count team";

/** The whole prompt for one reply — short on purpose. */
export function replyPrompt(i: {
  name: string; title?: string | null; firm: string; firmLine?: string | null;
  outreach?: string | null; known?: string[]; facts?: string; reading: Reading; guardrails?: string | null;
}): string {
  const r = i.reading;
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
    `أمثلة لهذا النوع بالضبط:\n${EXAMPLES[r.situation][r.lang].join("\n")}`,
    "",
    i.facts ? `معلومات الشركة التي يجوز ذكرها (لا تذكر غيرها):\n${i.facts.slice(0, 1600)}` : "لا معلومات محددة لهذا الموضوع — لا تذكر أرقاماً ولا أسعاراً.",
    i.guardrails ? `تعليمات صاحب العمل: ${i.guardrails}` : "",
    "",
    `اكتب الرد وحده ${r.lang === "en" ? "in English" : "بالعربية وبلهجة العميل"}: سطر إلى ثلاثة، بلا مقدمات ولا علامات تنصيص ولا قوائم. لا تقل إنك ذكاء اصطناعي.`,
  ].filter((x) => x !== "").join("\n");
}
