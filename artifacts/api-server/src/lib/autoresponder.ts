// ── Autoresponder detection ───────────────────────────────────────
// Campaigns land in the inboxes of other businesses, and a good share of those
// answer with their own bot. Replying to those is worse than pointless: it
// spends the daily allowance, produces bot-to-bot exchanges that read as
// automation to anyone auditing the number, and occasionally says something
// absurd — this account congratulated a cleaning company's autoresponder on
// its business.
//
// Detection is by phrasing and shape rather than by any single rule, because
// no one signal is reliable on its own: a greeting can be genuine, and a fast
// reply can be an eager human.

import { normalizeArabic } from "./intent";

/** Openers that essentially only appear in automated replies. */
const TEMPLATE_OPENERS = [
  "thank you for contacting", "thanks for contacting",
  "thanks for reaching out", "thank you for reaching out",
  "thank you for your message", "thanks for your message",
  "welcome to", "you have reached", "you've reached",
  "شكرا لتواصلك", "شكرا لتواصلكم", "شكرا على تواصلك",
  "مرحبا بك في", "اهلا بك في", "تم استلام رسالتك", "وصلتنا رسالتك",
  "لقد قمت بتوصيلك", "سيتواصل معك احد", "سيتم الرد عليك",
  // Seen on this number and missed: the greeting a business sets once and
  // forgets — "شكرا لك على تواصلك مع منجرة النقش", "Thank you for reaching
  // Drill and Hummer", "مرحبًا بكم في ألماس".
  "شكرا لك على تواصلك", "شكرا لك على التواصل", "شكرا لتواصلك مع", "شكرا على التواصل",
  "مرحبا بكم في", "اهلا بكم في", "اهلا وسهلا بكم في", "حياكم الله في",
  "thank you for reaching", "thanks for reaching", "thank you for choosing", "thanks for choosing",
  "thank you for getting in touch", "welcome to our",
];

/** The question a greeting template ends on — it asks, but no one is there yet. */
const TEMPLATE_QUESTIONS = [
  "how can we help", "how may we help", "how can i help you", "how may i assist", "please let us know how",
  "please let us know", "let us know how we can",
  "كيف يمكننا خدمتك", "كيف نقدر نخدمك", "كيف يمكننا مساعدتك", "كيف نخدمك", "اخبرنا كيف",
  "يسعدنا خدمتكم", "يسرنا خدمتكم", "يسعدنا خدمتك", "يسرنا خدمتك",
];

/** Broadcast-channel promotion: "subscribe to our channel", "follow us". */
const PROMO_HINTS = [
  "subscribe to our channel", "follow our channel", "join our channel", "follow us on",
  "اشترك في قناتنا", "تابعوا قناتنا", "تابعنا على", "انضم لقناتنا",
];

/** Phrases that promise a human will follow — the signature of a holding reply. */
const HOLDING_PHRASES = [
  "we will get back to you", "we'll get back to you", "will contact you shortly",
  "our team will", "as soon as possible", "during business hours",
  "outside our working hours", "office hours",
  "سنعاود التواصل", "سنتواصل معك", "فريقنا سيتواصل", "في اقرب وقت",
  "خارج اوقات العمل", "ساعات العمل", "سيرد عليك",
];

/** Menu-style replies: "press 1 for sales". */
const MENU_HINTS = [
  "press 1", "reply with 1", "choose an option", "select an option",
  "اضغط 1", "ارسل 1", "اختر من القائمة", "للاستفسار ارسل",
];

export interface AutoresponderVerdict {
  isAuto: boolean;
  confidence: number;
  signals: string[];
}

/**
 * Decide whether an inbound message is itself a machine.
 *
 * `secondsSinceOurMessage` matters because a templated greeting arriving two
 * seconds after our campaign message is a different thing from the same words
 * typed by a person an hour later.
 */
export function detectAutoresponder(
  text: string,
  opts: { secondsSinceOurMessage?: number; isFirstFromThem?: boolean } = {},
): AutoresponderVerdict {
  const raw = (text ?? "").trim();
  if (!raw) return { isAuto: false, confidence: 0, signals: [] };

  const lower = raw.toLowerCase();
  const norm  = normalizeArabic(raw);
  const has = (p: string) => lower.includes(p.toLowerCase()) || norm.includes(normalizeArabic(p));

  const signals: string[] = [];
  let score = 0;

  const opener = TEMPLATE_OPENERS.find(has);
  if (opener) { score += 0.55; signals.push(`قالب: «${opener}»`); }

  const holding = HOLDING_PHRASES.find(has);
  if (holding) { score += 0.35; signals.push(`وعد بالرد: «${holding}»`); }

  const asked = TEMPLATE_QUESTIONS.find(has);
  if (asked) { score += opener ? 0.2 : 0.3; signals.push(`سؤال القالب: «${asked}»`); }

  const promo = PROMO_HINTS.find(has);
  if (promo) { score += 0.6; signals.push(`دعوة لقناة: «${promo}»`); }

  const menu = MENU_HINTS.find(has);
  // A numbered menu is conclusive on its own, whenever it arrives — no person
  // opens a conversation by offering you options to press.
  if (menu) { score += 0.65; signals.push(`قائمة خيارات: «${menu}»`); }

  // A reply this fast was not typed. On its own it proves nothing — hence the
  // small weight — but combined with a template opener it is conclusive.
  const secs = opts.secondsSinceOurMessage;
  if (secs !== undefined && secs >= 0 && secs <= 20) {
    score += 0.3;
    signals.push(`ردّ خلال ${Math.round(secs)} ثانية`);
  }

  // Their very first message being a polished template is the classic shape;
  // a person opening a conversation rarely writes "Thank you for contacting".
  if (opts.isFirstFromThem && opener) { score += 0.15; signals.push("أول رسالة منهم وهي قالب"); }

  // An autoresponder states; it does not ask. A question mark is the single
  // strongest sign a human is on the other end, so it pulls the score down
  // rather than merely failing to raise it.
  // The greetings that slipped through on this number asked "how can we
  // help" without a question mark; the person who types one usually means it.
  if (/[?؟]/.test(raw) && !menu) { score -= 0.35; signals.push("يحتوي سؤالاً"); }

  const confidence = Math.max(0, Math.min(1, score));
  return { isAuto: confidence >= 0.6, confidence: Number(confidence.toFixed(2)), signals };
}
