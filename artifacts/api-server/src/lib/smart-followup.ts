// ── The follow-up, rebuilt ───────────────────────────────────────
// Two follow-up systems existed and neither worked. The ladder sent the same
// seven templates to everyone — «شكراً لتواصلك معنا 🌿 هل وصلتك المعلومات»,
// the exact phrases the writing rules forbid — and was switched off. The
// officer argued each step and drafted a message, but its sending was never
// wired, and the draft was written by the manager from six lines of thread,
// without the campaign, the knowledge or what earlier follow-ups had said.
//
// This one follows up the people worth following up and no one else:
//
//   WHO   someone who spoke to us (a person, not their autoresponder), got
//         an answer, and went quiet. Never a campaign recipient who never
//         replied — chasing those is what gets a number reported.
//   WHEN  a ladder measured from our last message: 1, 3, 7, 14 days — or 4h,
//         1, 3, 7 days for a lead who was already warm. Four at most; a reply
//         from them resets it.
//   WHAT  خالد writes each one for the person: what was said, what we sent,
//         what the card knows, what the firm knows on the subject, and what
//         the earlier follow-ups already tried. Each rung has its own angle,
//         and has no say in whether to write: who is followed is the code's
//         decision (opt-outs, refusals, complaints and machines are out
//         before he is asked). Left the choice, he declined half the time
//         with «لا جديد» — on the silences that are the whole point.
//   CHECK the same pre-send check as every reply, one rewrite at most; a
//         blank or a near-copy of an earlier follow-up is dropped.
//
// Operations keeps its veto over the whole round, and the number's daily
// allowance, sending hours and every opt-out apply. It starts in dry mode:
// every draft and decision is recorded for the owner to read, and nothing is
// sent until they switch it to live.

import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { FOLLOWUP_CRAFT, FOLLOWUP_CHECK, followupIssues } from "./followup-doctrine";
import {
  db, waThreadMessagesTable, botEmployeesTable, businessProfileTable, followupDeliberationsTable,
  unsubscribedPhonesTable, leadSourcesTable,
} from "@workspace/db";
import { complete } from "./llm";
import { asAgent } from "./agent-context";
import { corePrompt } from "./prompt-core";
import { detectAutoresponder } from "./autoresponder";
import { getCard, cardText, isHumanHeld } from "./lead-card";
import { lastOutreach, outreachPreamble, savedName } from "./outreach-context";
import { retrieve } from "./knowledge";
import { checkReply, needsRewrite, rewritePrompt, blocksSend } from "./reply-check";
import { opsVerdict, FOLLOWUP_ROLE } from "./followup-officer";
import { isWithinSendingHours, timeNote, fixGreeting } from "./sending-hours";
import { getDailyRemaining } from "./daily-limit";
import { assertCanSend } from "./plans";
import { sendMessage, getStatus } from "./whatsapp";
import { logger } from "./logger";
import { receipt } from "./graph/receipts";
import { dialectOf, dialectLine } from "./reply-brain";
import { shopContext } from "./catalog/shop-context";
import { HUMAN_VOICE } from "./voice-doctrine";
import { quote, discounted, discountText } from "./catalog/pricing";
import { normalizeArabic } from "./intent";

const H = 3_600_000;
/** Hours after our last message, per rung. A warm lead is followed sooner. */
export const LADDER = { cold: [24, 72, 168, 336], warm: [4, 24, 72, 168] } as const;
export const MAX_RUNGS = 4;
/** The shop's ladder: 1h · 6h · 1d · 3d · 1w · 2w · 1mo — seven rungs, the owner's own cadence. */
export const SHOP_LADDER = [1, 6, 24, 72, 168, 336, 720] as const;
/** Smart follow-ups are recorded with step 100+rung, apart from the old ladder's 0–6. */
export const STEP_BASE = 100;
const MAX_PER_RUN = 8;
/** Between one follow-up and the next, whoever they go to: a minute or two, like a person (the owner, 2026-10-22). */
export const FOLLOWUP_GAP_MS: [number, number] = [60_000, 120_000];
const followupPause = () => new Promise((r) => setTimeout(r, FOLLOWUP_GAP_MS[0] + Math.random() * (FOLLOWUP_GAP_MS[1] - FOLLOWUP_GAP_MS[0])));

/** What each rung is for — so the four messages are four different messages. */
export const RUNG_ANGLE: string[] = [
  "المتابعة ١ — أكمل من حيث توقفت المحادثة: أجب عن آخر نقطة بقيت مفتوحة، أو أضف معلومة واحدة من المعرفة تخص ما سأل عنه هو. لا تقل «أتابع» ولا «هل وصلتك رسالتي».",
  "المتابعة ٢ — زاوية جديدة لم تُذكر: خطر أو موعد أو فائدة واحدة من المعرفة تخص قطاعه أو وضعه، في جملتين، ثم سؤال يجيب عنه بنعم أو لا.",
  "المتابعة ٣ — خطوة سهلة جداً: اعرض مكالمة قصيرة مع مختص، أو أن ترسل له ملخصاً مكتوباً يخص وضعه — اختر ما يناسب ما قاله.",
  "المتابعة ٤ — خطوة سهلة جداً من زاوية ثانية: صورة أو قطعة مشابهة، أو عرض يناسب مناسبته، في سطرين.",
  "المتابعة ٥ — تذكير قصير بما يخصه هو (ما سأل عنه)، مع معلومة جديدة واحدة، في سطر أو سطرين.",
  "المتابعة ٦ — قبل الختام: اعرض أن ترسل له ما يحتاج (صورة، سعر محدث، تفاصيل) متى شاء، في سطر، بلا ضغط.",
  "المتابعة الأخيرة — ختام لطيف: قل إنك لن تزعجه بعدها وإن الباب مفتوح متى احتاج، في سطر أو سطرين، بلا ضغط ولا سؤال.",
];
/** A shop's rungs: each one a benefit to the customer, never a reminder. */
export const JEWELRY_ANGLE: string[] = [
  // No price, no weight, no gold rate, no discount (the owner, 2026-10-19):
  // the piece's page carries them, and its link is what each rung sends.
  "المتابعة ١ (بعد ساعة) — القطعة التي سألت عنها بالاسم ورابطها من المعلومات (فيه السعر والصور)، وسؤال واحد محترم: لمناسبة أم للبس اليومي.",
  "المتابعة ٢ (بعد ٦ ساعات) — معلومة تفيدها عن القطعة نفسها من وصفها في المعلومات (تصميمها، لمن تناسب، كيف تُلبس)، ورابطها، بلا أي رقم.",
  "المتابعة ٣ (بعد يوم) — خيار بديل: قطعة أو قطعتان من نفس الذوق بالاسم من الكتالوج ورابط كل منهما، ليكون عندها مقارنة لا ضغط.",
  "المتابعة ٤ (بعد ٣ أيام) — تسهيل الطلب: ما يلزم لإتمامه (الاسم والإمارة) والتوصيل أو الاستلام من المعرض في العين، ورابط القطعة — بلا خصم ولا عرض.",
  "المتابعة ٥ (بعد أسبوع) — مناسبة أو هدية: إن اقتربت مناسبة (عيد، زفاف، مولود) فاذكرها وقطعة تناسبها برابطها؛ وإلا نصيحة عناية قصيرة بالذهب تخص نوع قطعتها.",
  "المتابعة ٦ (بعد أسبوعين) — جديد المجموعة: قطعة جديدة بالاسم ورابطها، في سطر أو سطرين، بلا سؤال.",
  "المتابعة الأخيرة (بعد شهر) — ختام كريم: شكر، وأن المعرض في العين والواتساب موجودان متى احتاجت، بلا سؤال ولا ضغط.",
];

/**
 * «Service only» (the owner, 2026-10-21, for Floret): no new information, no
 * piece, no link, no price, no endearment — only a polite «do you need
 * anything? we are at your service», seven different ways, the way a person
 * at the shop would write it. Each rung is a different moment, not a template.
 */
export const SERVICE_ANGLE: string[] = [
  "المتابعة ١ — اطمئنان قصير بعد المحادثة: هل وصلها ما تحتاجه أو بقي عندها سؤال، وأننا في الخدمة.",
  "المتابعة ٢ — سؤال لطيف واحد: هل تحب تساعدها في شيء معيّن، بلا ذكر أي قطعة لم تذكرها هي.",
  "المتابعة ٣ — تذكير دافئ أن المحل في خدمتها متى ما احتاجت، في سطر.",
  "المتابعة ٤ — إن كانت سألت عن شيء بعينه فاذكره بكلماتها هي واسأل إن كانت ما زالت تفكر فيه؛ وإلا فاسأل إن كان هناك ما يمكن مساعدتها فيه.",
  "المتابعة ٥ — سطر قصير جداً: نحن هنا لأي استفسار، بلا سؤال مباشر.",
  "المتابعة ٦ — اسألها بلطف إن كانت تفضّل أن نتواصل لاحقاً أو أن تكتب هي متى ما احتاجت.",
  "المتابعة الأخيرة — ختام كريم: شكر على تواصلها، وأن الواتساب مفتوح لها دائماً، بلا سؤال ولا ضغط.",
];

/** How a person at the shop writes these, and what they never do. */
export const SERVICE_VOICE = [
  "═══ أسلوب المتابعة: خدمة فقط (تعليمات صاحب العمل) ═══",
  "- اكتب كإنسان يعمل في المحل يكتب بيده الآن: سطر أو سطران، طبيعيان وعاديان، بلهجة الزبونة.",
  "- كل ما تقوله: هل تحتاج أي شيء، هل عندها سؤال، ونحن في الخدمة. لا شيء غير ذلك.",
  "- ممنوع منعاً باتاً: أي سعر أو رقم أو وزن أو عيار أو خصم أو عرض؛ أي رابط؛ أي قطعة أو معلومة لم تذكرها هي؛ أي وعد.",
  "- ممنوع منعاً باتاً أي تحبّب: حبيبتي، حبيبي، صاحبتي، قلبي، عمري، روحي، حياتي، يا قمر، يا عسل، غناتي. الاحترام هو الدفء.",
  "- لا تبدأ بـ«أتابع معك» ولا «للتذكير» ولا «هل وصلتك رسالتي». ولا تكرر جملة قيلت لها من قبل.",
  "- إيموجي واحد على الأكثر، أو لا شيء.",
  "- لا تبدأ بـ«وعليكم السلام»: هذه رسالة جديدة منك لا رد على تحية قديمة. ابدأ بتحية الوقت أو بـ«هلا».",
  "- كل زبونة تأخذ رسالة بكلمات مختلفة عن غيرها: نص واحد لعدة أشخاص يقرؤه واتساب رسالةً آلية.",
  "أمثلة:",
  "✓ «مساء الخير، إذا احتجتي أي شي أو عندك سؤال، إحنا موجودين 🌸»",
  "✓ «هلا، حبيت أطمّن إذا كل شي واضح عندك، وإذا تحتاجين مساعدة بأي شي قوليلي»",
  "✗ «هلا حبيبتي، الطقم سعره…» — تحبّب وسعر.",
  "✗ «شوفي هذا الرابط فيه قطع جديدة…» — رابط ومعلومة من عندنا.",
].join("\n");

const ENDEARMENT = /حبيبت|حبيبي|حبيبة|صاحبت|صاحبتي|قلبي|عمري|روحي|حياتي|يا ?قمر|يا ?عسل|غناتي|يا ?بعد|عيوني|يا ?روح/;
const MONEY = /سعر|أسعار|اسعار|درهم|د\.إ|aed|dhs|خصم|تخفيض|عرض|عروض|وزن|جرام|غرام|عيار|مصنعية|قيراط/i;

/** What the service style must never carry. Pure, so it is tested. */
export function serviceIssues(text: string): string[] {
  const t = String(text ?? "");
  const out: string[] = [];
  if (ENDEARMENT.test(t)) out.push("فيها كلمة تحبّب");
  if (MONEY.test(t)) out.push("فيها كلام عن سعر أو وزن أو عرض");
  if (/[0-9٠-٩]/.test(t)) out.push("فيها رقم");
  if (/^\s*(و\s?عليكم|wa\s?alaikum)/i.test(t)) out.push("تبدأ بردّ السلام كأنها ترد على تحية قديمة");
  if (/https?:|www\.|\.(io|com|ae|net)\b/i.test(t)) out.push("فيها رابط");
  if (t.split(/\n+/).filter((l) => l.trim()).length > 3 || t.length > 260) out.push("أطول من سطرين أو ثلاثة");
  return out;
}

/**
 * «Sales» (the owner, 2026-10-21, a few hours after «service»): still a
 * person at the shop, still no price and no endearment, but now an
 * invitation — «we have many pieces on the site, take a look» — with the
 * site's link. The link is the only thing the writer may add.
 */
export const SALES_ANGLE: string[] = [
  "المتابعة ١ — اطمئنان قصير، ثم دعوة واثقة: عندنا قطع كثيرة في الموقع بصورها، تقدر تاخذ فكرة وتختار على راحتها، مع رابط الموقع.",
  "المتابعة ٢ — إن سألت عن شيء بعينه فاذكره بكلماتها هي: «في الموقع تصاميم قريبة من اللي سألتي عنه»، مع الرابط، وادعها ترسل صورة اللي يعجبها عشان ترتب لها الطلب.",
  "المتابعة ٣ — سؤال يقرّبها من الشراء بلا رابط: تدوّر على شي لمناسبة قريبة أو للبس اليومي أو هدية؟ عشان نساعدها تختار الأنسب.",
  "المتابعة ٤ — زاوية الهدية والمناسبات: لو عندها مناسبة أو تبي تهدي أحد، الموقع فيه خيارات كثيرة تناسب كل ذوق، مع الرابط.",
  "المتابعة ٥ — تسهيل الخطوة: إذا شافت شي عجبها ترسل صورته أو اسمه هنا وتكمل الباقي معها خطوة بخطوة، بلا رابط.",
  "المتابعة ٦ — تذكير دافئ بالموقع: التصاميم كلها فيه بصورها وتفاصيلها، تتصفحها متى ما ارتاحت، مع الرابط.",
  "المتابعة الأخيرة — ختام كريم: شكر على تواصلها، وأن الواتساب والموقع موجودين لها دائماً، بلا ضغط ولا سؤال.",
];

export const SALES_VOICE = [
  "═══ أسلوب المتابعة: بيعي وبشري (تعليمات صاحب العمل) ═══",
  "- اكتب كإنسان يعمل في محل ذهب ويعرف زبونته، يكتب بيده الآن: سطران إلى ثلاثة، طبيعيان، دافئان باحترام.",
  "- هدفك أن تشجعها بلطف تتصفح القطع وتختار: «عندنا قطع كثيرة في الموقع، تقدرين تاخذين فكرة»، «الموقع فيه التصاميم كلها بصورها».",
  "- الرابط الوحيد المسموح هو رابط الموقع المعطى لك، كما هو حرفياً. لا تخترع رابط قطعة.",
  "- ممنوع منعاً باتاً: أي سعر أو رقم أو وزن أو عيار أو خصم أو عرض؛ اسم قطعة أو معلومة لم تذكرها هي؛ أي وعد بتوفر أو موعد.",
  "- ممنوع منعاً باتاً أي تحبّب: حبيبتي، حبيبي، صاحبتي، قلبي، عمري، روحي، حياتي، يا قمر، يا عسل، غناتي. الاحترام هو الدفء.",
  "- لا تبدأ بـ«وعليكم السلام» ولا «أتابع معك» ولا «للتذكير» ولا «هل وصلتك رسالتي». ابدأ بتحية الوقت أو بـ«هلا».",
  "- كل زبونة تأخذ رسالة بكلمات مختلفة عن غيرها: نص واحد لعدة أشخاص يقرؤه واتساب رسالةً آلية.",
  "- إيموجي واحد على الأكثر.",
  "أمثلة:",
  "✓ «مساء الخير 🌸 حبيت أقولك إن عندنا قطع كثيرة في الموقع، تقدرين تاخذين فكرة على راحتك: https://floret-royal.io وإذا عجبك شي قوليلي»",
  "✓ «هلا، الخلخال اللي سألتي عنه في الموقع تصاميم قريبة منه تقدرين تشوفينها https://floret-royal.io»",
  "✗ «هلا حبيبتي، الطقم سعره…» — تحبّب وسعر.",
].join("\n");

/** The prefilled text a Meta click-to-WhatsApp ad puts in the customer's mouth, in any of its languages. */
const AD_PREFILL = /^\s*(hello!?\s*can\s+i\s+get\s+more\s+info(rmation)?\s+on\s+this\??|مرحب[اًا]?!?\s*هل\s*يمكنني\s*الحصول\s*على\s*مزيد\s*من\s*ال?\s*معلومات\s*حول\s*هذا\s*[؟?]?|سلام!?\s*می.?\s*توانم[^؟?]*[؟?]?)/i;

/**
 * The language to write in (the owner, 2026-10-21): Arabic always — unless
 * she herself wrote in English, in words of her own and not the ad's
 * prefilled «Hello! Can I get more info on this?». Pure.
 */
export function followupLanguage(customerTexts: string[]): "ar" | "en" {
  for (const raw of customerTexts) {
    const t = String(raw ?? "").replace(AD_PREFILL, "").trim();
    if (!t || /[\u0600-\u06FF]/.test(t)) continue;
    if ((t.match(/[A-Za-z]{2,}/g) ?? []).length >= 1 && !/^(ok|okay|yes|no|thanks|thank you|hi|hello)[.!\s]*$/i.test(t)) return "en";
  }
  return "ar";
}

/** The shop's site, the one link the sales style may carry. */
export const shopSite = () => (process.env["FLORET_SITE_URL"] || "https://floret-royal.io").replace(/\/+$/, "");

/** The sales style: the service style's limits, but the shop's own site may be linked. Pure. */
export function salesIssues(text: string, site = shopSite(), lang: "ar" | "en" = "ar"): string[] {
  const host = site.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const links: string[] = String(text ?? "").match(/https?:\/\/\S+|www\.\S+|\b[\w-]+\.(io|com|ae|net)\S*/gi) ?? [];
  const foreign = links.filter((l) => !l.replace(/^https?:\/\//, "").replace(/^www\./, "").startsWith(host));
  let withoutSite = String(text ?? "");
  for (const l of links) withoutSite = withoutSite.replace(l, " ");
  const out = serviceIssues(withoutSite).filter((x) => x !== "أطول من سطرين أو ثلاثة");
  if (foreign.length) out.push("فيها رابط غير رابط الموقع");
  if (withoutSite.split(/\n+/).filter((l) => l.trim()).length > 4 || withoutSite.length > 320) out.push("أطول من ثلاثة أسطر");
  if (lang === "ar" && /[A-Za-z]{3,}/.test(withoutSite)) out.push("فيها كلام بالإنجليزية والزبونة تُكتب لها بالعربية");
  return out;
}

/** The angle for a rung on any ladder: the last angle is always the farewell. Pure. */
export const angleFor = (rung: number, rungs: number, vertical?: string | null, style?: string | null) => {
  const set = style === "sales" ? SALES_ANGLE : style === "service" ? SERVICE_ANGLE : vertical === "jewelry" ? JEWELRY_ANGLE : RUNG_ANGLE;
  return rung >= rungs - 1 ? set[set.length - 1]! : set[Math.min(rung, set.length - 2)]!;
};

export type Mode = "off" | "dry" | "approve" | "live";

export async function modeOf(userId: number): Promise<Mode> {
  const [p] = await db.select({ m: businessProfileTable.smartFollowup }).from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  const m = (p?.m ?? "dry") as Mode;
  return m === "live" || m === "off" || m === "approve" ? m : "dry";
}

type Turn = { fromMe: boolean; text: string; at: Date };

/** Word overlap of two messages, 0–1 — a near-copy of an earlier follow-up is not a new one. */
export function overlap(a: string, b: string): number {
  const w = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((x) => x.length > 2));
  const A = w(a), B = w(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}

/**
 * Who is due, and at which rung. Pure: the thread, the rungs already taken
 * since their last message, and the time.
 */
export function dueRung(turns: Turn[], taken: Date[], warm: boolean, now = Date.now(), opts: { ladder?: readonly number[]; scope?: "spoke" | "all" } = {}): { rung: number; dueAt: number } | null {
  const lastIn = [...turns].reverse().find((t) => !t.fromMe);
  const lastOut = [...turns].reverse().find((t) => t.fromMe);
  if (!lastOut) return null;
  // Only those who wrote to us — unless the account follows everyone it reached.
  if (!lastIn && opts.scope !== "all") return null;
  if (lastIn && lastOut.at.getTime() < lastIn.at.getTime()) return null; // their turn is unanswered: the reply path's job
  const from = lastIn?.at.getTime() ?? 0;
  const since = taken.filter((d) => d.getTime() > from);
  const rung = since.length;
  const ladder = opts.ladder?.length ? opts.ladder : (warm ? LADDER.warm : LADDER.cold);
  if (rung >= ladder.length) return null;
  const base = Math.max(lastOut.at.getTime(), ...since.map((d) => d.getTime()));
  const dueAt = base + ladder[rung]! * H;
  return dueAt <= now ? { rung, dueAt } : null;
}

/** The account's ladder and scope. */
async function ladderOf(userId: number): Promise<{ ladder: number[] | null; scope: "spoke" | "all"; vertical: string | null; style: string; batch: number }> {
  const [p] = await db.select({ l: businessProfileTable.followupLadder, s: businessProfileTable.followupScope, v: businessProfileTable.vertical, st: businessProfileTable.followupStyle, b: businessProfileTable.followupBatch }).from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  const l = Array.isArray(p?.l) ? p!.l.map(Number).filter((h) => h > 0).slice(0, 10) : null;
  return { ladder: l?.length ? l : null, scope: p?.s === "all" ? "all" : "spoke", vertical: p?.v ?? null, style: p?.st ?? "rich", batch: Math.max(1, Math.min(20, Number(p?.b ?? MAX_PER_RUN))) };
}

async function thread(userId: number, phone: string, limit = 14): Promise<Turn[]> {
  const rows = await db.select({ fromMe: waThreadMessagesTable.fromMe, text: waThreadMessagesTable.text, at: waThreadMessagesTable.createdAt })
    .from(waThreadMessagesTable)
    .where(and(eq(waThreadMessagesTable.userId, userId), eq(waThreadMessagesTable.phone, phone), sql`coalesce(${waThreadMessagesTable.text}, '') <> ''`))
    .orderBy(desc(waThreadMessagesTable.createdAt)).limit(limit);
  return rows.reverse().map((r) => ({ fromMe: !!r.fromMe, text: r.text ?? "", at: new Date(r.at) }));
}

/** Conversations where we spoke last, they had spoken in the last month, and the quiet has lasted at least four hours. */
async function candidates(userId: number, scope: "spoke" | "all", days = 30): Promise<string[]> {
  const r = await db.execute(sql`
    SELECT phone FROM wa_thread_messages
    WHERE user_id = ${userId} AND created_at > now() - make_interval(days => ${days + 5})
    GROUP BY phone
    HAVING ${scope === "all" ? sql`true` : sql`max(created_at) FILTER (WHERE NOT from_me) > now() - make_interval(days => ${days})`}
       AND max(created_at) FILTER (WHERE from_me) > coalesce(max(created_at) FILTER (WHERE NOT from_me), '-infinity')
       AND max(created_at) < now() - interval '1 hour'
    ORDER BY max(created_at) DESC
    LIMIT 300`);
  return (r.rows as Array<{ phone: string }>).map((x) => x.phone);
}

type Draft = { send: boolean; text: string | null; reason: string; retry?: boolean; photo?: { path: string; caption: string } | null };

/** خالد writes the rung, or declines. */
async function compose(userId: number, phone: string, turns: Turn[], rung: number, earlier: string[], rungs = MAX_RUNGS, vertical: string | null = null, style = "rich"): Promise<Draft> {
  if (style === "service" || style === "sales") return composeService(userId, phone, turns, rung, earlier, rungs, style);
  const angle = angleFor(rung, rungs, vertical);
  const [[me], [profile], card, company] = await Promise.all([
    db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, FOLLOWUP_ROLE))).limit(1),
    db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1),
    getCard(userId, phone).catch(() => null),
    savedName(userId, phone).catch(() => null),
  ]);
  const outreach = outreachPreamble(await lastOutreach(userId, phone, company).catch(() => null), company);
  const customerDialect = dialectOf(turns.filter((t) => !t.fromMe).map((t) => t.text).join(" "), profile?.dialect ?? null);
  const topic = turns.filter((t) => !t.fromMe).slice(-3).map((t) => t.text).join(" ");
  const found = await retrieve(userId, topic, 3).catch(() => []);
  const shop = vertical === "jewelry" ? await shopContext(userId, phone, topic).catch(() => null) : null;
  // ريم's reading of this very conversation: who they are, what they wanted, the step she chose.
  const [rv] = (await db.execute<any>(sql`SELECT label, score, piece, summary, next_action FROM conversation_reviews WHERE user_id = ${userId} AND phone = ${phone}`).catch(() => ({ rows: [] }))).rows;
  const reviewFact = rv ? `قراءة ريم لهذه المحادثة: ${rv.summary ?? ""} (${rv.label}، قربه من الشراء ${rv.score}/100${rv.piece ? `، القطعة: ${rv.piece}` : ""}). الخطوة التي اقترحتها: ${rv.next_action ?? "—"}. ابنِ متابعتك عليها.` : "";
  // No discount and no number at all in a shop's follow-up (the owner, 2026-10-19).
  const discountFact = shop ? "ممنوع في هذه المتابعة: أي سعر أو وزن أو سعر ذهب أو مصنعية أو خصم أو عرض. أرسلي رابط القطعة بدلاً منها." : "";
  const facts = [reviewFact, ...(shop?.facts ?? []), discountFact, ...found.map((f) => `${f.entry.title}\n${f.entry.content.slice(0, 700)}`)].filter(Boolean).join("\n\n");

  const system = corePrompt({
    channel: "whatsapp",
    role: FOLLOWUP_ROLE,
    identity: `اسمك ${me?.name ?? "خالد"}، ${me?.title ?? "موظف المتابعة"}${profile?.name ? ` لدى ${profile.name}` : ""}.`,
    persona: me?.persona ?? null,
    firm: profile?.description ?? null,
    rules: [
      vertical === "jewelry" ? HUMAN_VOICE : "",
      // لماذا سكت قبل ماذا أكتب — صنعة المتابعة لكل المنصات.
      FOLLOWUP_CRAFT,
      "",
      `═══ زاوية هذه الدرجة ═══\n${angle}`,
      vertical === "jewelry" ? "اكتب الرسالة نفسها فقط، بلهجة العميلة، كما تكتبها يد: سطران إلى خمسة، دافئة وشخصية، وفيها شيء يخصها هي." : "اكتب الرسالة نفسها فقط، بلغة العميل ولهجته، سطر إلى ثلاثة.",
      dialectLine(customerDialect),
      vertical === "jewelry" ? "ممنوع منعاً باتاً: وزن أو عيار أو سعر أو توفر لا يوجد نصاً في المعلومات المرفقة. إن لم يكن عندك الرقم فلا تذكره، واعرض أن تتأكد وترد." : "",
      "صمته بعد سؤالنا هو سبب المتابعة لا مانعها: لا تعد السؤال نفسه — أحضر الجديد من الزاوية المطلوبة ومن معرفة الشركة (معلومة، صورة، قطعة أو خدمة تناسبه، سعر محدث، خطوة أسهل). من يُستبعد من المتابعة استُبعد قبل أن تصلك، فلا تقرر أنت ذلك.",
      profile?.guardrails ? `تعليمات صاحب العمل: ${profile.guardrails}` : "",
    ],
    context: [
      outreach,
      card ? cardText(card) : "",
      earlier.length ? `═══ ما قلناه له في المتابعات السابقة — لا تكرره ولا تعِد صياغته ═══\n${earlier.map((e, i) => `${i + 1}. ${e}`).join("\n")}` : "",
      facts ? `═══ من معرفة الشركة عن موضوعه ═══\n${facts}` : "",
    ],
    check: [...FOLLOWUP_CHECK, "□ هل تصلح لهذا العميل وحده؟", ...(vertical === "jewelry" ? ["□ هل تُقرأ كأن إنساناً كتبها لها الآن — دافئة، عنها هي، بلا لغة شركات؟"] : [])],
  });
  const transcript = turns.map((t) => `${t.fromMe ? "نحن" : "العميل"}: ${t.text.slice(0, 500)}`).join("\n");
  const out = await complete([
    { role: "system", content: system },
    { role: "user", content: `${timeNote()}\n\nالمحادثة حتى الآن:\n${transcript}\n\nسكت العميل منذ آخر رسالة منا. اكتب ${angle.split(" — ")[0]}.` },
  ], 30_000);
  const raw = out?.text?.trim().replace(/^["«“]+|["»”]+$/g, "").trim();
  if (!raw) return { send: false, text: null, reason: "تعذّر الوصول للنموذج", retry: true };
  // He was told not to decide; if he still writes «لا ترسل», the rung is held for the next round, not lost.
  if (/^«?\s*لا ترسل/.test(raw)) return { send: false, text: null, reason: `خالد امتنع: ${raw.slice(0, 160)}`, retry: true };

  // The check every reply passes, and one rewrite at most.
  const lastCustomer = [...turns].reverse().find((t) => !t.fromMe)?.text ?? "";
  const previous = [...turns].reverse().find((t) => t.fromMe)?.text ?? null;
  const ctx = {
    customer: lastCustomer, previous, stage: card?.stage,
    known: card ? { licence: card.licence, activity: card.activity, size: card.size, staff: card.staff } : undefined,
    facts: [facts, profile?.description ?? ""].join("\n"),
  };
  if (vertical === "jewelry") { (ctx as any).strictNumbers = true; (ctx as any).warm = true; (ctx as any).catalogNames = shop?.names ?? []; (ctx as any).discountAllowed = false; (ctx as any).noPrices = true; }
  let text = raw, q = checkReply(text, ctx);
  if (needsRewrite(q)) {
    const fixed = await complete([
      { role: "system", content: "أنت محرر رسائل واتساب لفريق مبيعات. تُصلح ما يُطلب منك فقط وتعيد الرسالة المصحّحة وحدها." },
      { role: "user", content: rewritePrompt(text, q, ctx) },
    ], 20_000);
    const candidate = fixed?.text?.trim().replace(/^["«“]+|["»”]+$/g, "").trim();
    if (candidate) { const q2 = checkReply(candidate, ctx); if (q2.score > q.score) { text = candidate; q = q2; } }
  }
  if (blocksSend(q)) return { send: false, text, reason: `أُوقفت: ${q.issues[0]?.note ?? "فحص الكتابة"}` };
  // عقيدة المتابعة تُفرَض بالكود لا بوعد النموذج: «أتابع معك» و«للتذكير»
  // تُسقط الرسالة. محاولة إصلاحٍ واحدة، ثم تُحجز للجولة القادمة.
  let fi = followupIssues(text, { last: rung >= rungs - 1, previous });
  if (fi.length) {
    const fixed = await complete([
      { role: "system", content: "أنت محرر رسائل متابعة. تُصلح ما يُطلب فقط وتعيد الرسالة المصحّحة وحدها، بلغتها ولهجتها." },
      { role: "user", content: `الرسالة:\n${text}\n\nأصلح: ${fi.join("؛ ")}.\nلا تُضف معلومةً ولا رقماً. لا تبدأ بتذكير ولا اعتذار.` },
    ], 20_000).catch(() => null);
    const cand = fixed?.text?.trim().replace(/^["«“]+|["»”]+$/g, "").trim();
    if (cand && !followupIssues(cand, { last: rung >= rungs - 1, previous }).length && !blocksSend(checkReply(cand, ctx))) { text = cand; fi = []; }
  }
  if (fi.length) return { send: false, text, reason: `أُوقفت: ${fi[0]}`, retry: true };
  const copy = earlier.find((e) => overlap(e, text) > 0.6);
  if (copy) return { send: false, text, reason: "تكاد تكون نسخة من متابعة سابقة" };
  return { send: true, text, reason: q.issues.length ? `أُرسلت مع ملاحظات: ${q.issues.map((i) => i.note).join("، ")}`.slice(0, 300) : "جاهزة", photo: shop?.photo && shop.piece && normalizeArabic(text).includes(normalizeArabic(shop.piece.name.split(" ").slice(0, 2).join(" "))) ? shop.photo : null };
}

/**
 * خالد in the service style: a person at the shop asking if she needs
 * anything. No knowledge, no catalogue, no link is handed to him — there is
 * nothing to add, so nothing can be invented — and the code check refuses
 * an endearment, a number, a price word or a link even if he writes one.
 */
async function composeService(userId: number, phone: string, turns: Turn[], rung: number, earlier: string[], rungs: number, style = "service"): Promise<Draft> {
  const sales = style === "sales";
  const angle = angleFor(rung, rungs, null, style);
  const lang = followupLanguage(turns.filter((t) => !t.fromMe).map((t) => t.text));
  const site = shopSite();
  const check = (x: string) => sales ? salesIssues(x, site, lang) : [...serviceIssues(x), ...(lang === "ar" && /[A-Za-z]{3,}/.test(x) ? ["فيها كلام بالإنجليزية والزبونة تُكتب لها بالعربية"] : [])];
  const [[me], [profile]] = await Promise.all([
    db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, FOLLOWUP_ROLE))).limit(1),
    db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1),
  ]);
  const customerDialect = dialectOf(turns.filter((t) => !t.fromMe).map((t) => t.text).join(" "), profile?.dialect ?? null);
  // What went, or waits, to other customers in the last two days: this one must not read like them.
  const others = (await db.execute<{ draft: string }>(sql`SELECT draft FROM followup_deliberations WHERE user_id = ${userId} AND phone <> ${phone}
    AND verdict IN ('pending', 'approved', 'send') AND coalesce(draft, '') <> '' AND created_at > now() - interval '48 hours' ORDER BY created_at DESC LIMIT 25`)).rows.map((r) => r.draft);
  const system = [
    `اسمك ${me?.name ?? "خالد"}، تعمل في ${profile?.name ?? "المحل"}. تكتب رسالة متابعة واحدة لزبونة سكتت بعد محادثتها معنا.`,
    others.length ? `═══ رسائل كُتبت لزبونات أخريات — لا تشبهها في الكلمات ولا في البناء ═══\n${others.slice(0, 8).map((e) => `- ${e}`).join("\n")}` : "",
    sales ? SALES_VOICE : SERVICE_VOICE,
    `═══ زاوية هذه الرسالة ═══\n${angle}`,
    sales ? `رابط الموقع (الوحيد المسموح، انسخه كما هو): ${site}` : "",
    lang === "ar"
      ? `اكتب بالعربية فقط، بلهجة خليجية طبيعية — ولا كلمة إنجليزية${sales ? " غير الرابط" : ""}. إن كانت رسالتها الأولى «Hello! Can I get more info on this?» فتلك رسالة الإعلان الجاهزة لا لغتها. ${dialectLine(customerDialect)}`
      : "She writes to us in English herself, so write in natural, warm English.",
    profile?.guardrails ? `تعليمات صاحب العمل: ${profile.guardrails}` : "",
    earlier.length ? `═══ ما قلناه لها في المتابعات السابقة — اكتب شيئاً مختلفاً ═══\n${earlier.map((e, i) => `${i + 1}. ${e}`).join("\n")}` : "",
    "أعد نص الرسالة وحده، بلا علامات اقتباس ولا شرح.",
  ].filter(Boolean).join("\n\n");
  const transcript = turns.slice(-8).map((t) => `${t.fromMe ? "نحن" : "الزبونة"}: ${t.text.slice(0, 300)}`).join("\n");
  const clean = (x?: string | null) => (x ?? "").trim().replace(/^["«“]+|["»”]+$/g, "").trim();
  const out = await complete([{ role: "system", content: system }, { role: "user", content: `${timeNote()}\n\nآخر المحادثة:\n${transcript}\n\nاكتب ${angle.split(" — ")[0]}.` }], 30_000);
  let text = clean(out?.text);
  if (!text) return { send: false, text: null, reason: "تعذّر الوصول للنموذج", retry: true };
  let issues = [...check(text), ...followupIssues(text, { last: rung >= rungs - 1, previous: [...turns].reverse().find((t) => t.fromMe)?.text ?? null })];
  if (issues.length) {
    const fixed = await complete([
      { role: "system", content: sales
        ? `أنت محرر رسائل متابعة لمحل ذهب. تعيد الرسالة مصحّحة وحدها، سطرين أو ثلاثة، ${lang === "ar" ? "بالعربية الخليجية فقط" : "in English"}. لا سعر ولا رقم ولا تحبّب ولا اسم قطعة جديد، والرابط الوحيد المسموح ${site}.`
        : `أنت محرر رسائل متابعة لمحل. تعيد الرسالة مصحّحة وحدها، سطراً أو سطرين، ${lang === "ar" ? "بالعربية الخليجية فقط" : "in English"}. لا سعر ولا رقم ولا رابط ولا تحبّب ولا معلومة جديدة: فقط هل تحتاج شيئاً ونحن في الخدمة.` },
      { role: "user", content: `الرسالة:\n${text}\n\nأصلح: ${issues.join("؛ ")}.` },
    ], 20_000).catch(() => null);
    const cand = clean(fixed?.text);
    if (cand) { const again = [...check(cand), ...followupIssues(cand, { last: rung >= rungs - 1, previous: null })]; if (again.length < issues.length) { text = cand; issues = again; } }
  }
  if (issues.length) return { send: false, text, reason: `أُوقفت: ${issues[0]}`, retry: true };
  if (earlier.find((e) => overlap(e, text) > 0.6)) return { send: false, text, reason: "تكاد تكون نسخة من متابعة سابقة", retry: true };
  if (others.find((e) => overlap(e, text) > 0.75)) return { send: false, text, reason: "تشبه رسالة كُتبت لزبونة أخرى — تُكتب من جديد في الجولة القادمة", retry: true };
  return { send: true, text, reason: sales ? `جاهزة — أسلوب بيعي (${lang === "ar" ? "بالعربية" : "بالإنجليزية لأنها كتبت بها"})` : "جاهزة — أسلوب الخدمة فقط", photo: null };
}

async function record(userId: number, phone: string, rung: number, verdict: "send" | "hold" | "drop" | "pending", reason: string, draft: string | null, executed: boolean, opsView: string) {
  receipt({ userId, node: FOLLOWUP_ROLE, graph: "whatsapp", action: executed ? "followup.sent" : verdict === "send" ? "followup.draft" : "followup.decline",
    status: executed || verdict === "send" ? "ok" : "blocked", subject: phone, evidence: { rung: rung + 1, ops: opsView }, why: reason.slice(0, 600) });
  await db.insert(followupDeliberationsTable).values({
    userId, phone, step: STEP_BASE + rung, verdict, reason: reason.slice(0, 1000),
    managerView: "خالد يكتب ويقرر", opsView, draft, executed,
  });
}

// One round per account at a time. Two rounds that overlap — the worker's
// and an owner's «run now» — both read the same ladder before either has
// written its rung, and the customer gets the same follow-up twice. It
// happened; two customers got two messages a minute apart.
const running = new Set<number>();

/** One round for one account. */
export async function runSmartFollowUps(userId: number, now = Date.now()) {
  const mode = await modeOf(userId);
  const result = { mode, considered: 0, drafted: 0, sent: 0, declined: 0 };
  if (running.has(userId)) return result;
  running.add(userId);
  try { return await runRound(userId, now, mode, result); } finally { running.delete(userId); }
}

async function runRound(userId: number, now: number, mode: Mode, result: { mode: Mode; considered: number; drafted: number; sent: number; declined: number }) {
  if (mode === "off") return result;
  if (!isWithinSendingHours(new Date(now))) return result;
  if (mode === "live" && !getStatus(userId).connected) return result;

  const { ladder, scope, vertical, style, batch } = await ladderOf(userId);
  // A send claimed and never finished (a restart mid-send) goes back to the queue; alreadySent() stops a second copy.
  await db.execute(sql`UPDATE followup_deliberations SET verdict = 'approved' WHERE user_id = ${userId} AND verdict = 'sending' AND created_at < now() - interval '15 minutes'`).catch(() => {});
  // A copy that reached someone twice is taken back first.
  if (getStatus(userId).connected) await recallDuplicateFollowups(userId).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "فحص المكرر تعذّر"));
  // Approved drafts go first, through the firewall like any message.
  if (mode === "approve" || mode === "live") await sendApproved(userId, batch).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "إرسال المعتمد تعذّر"));
  // The shop's styles follow every customer of the last two months, a few at a time (the owner, 2026-10-22).
  const wide = style === "sales" || style === "service";
  // ريم keeps the listing current: up to ten conversations that moved since her last reading, every round.
  if (wide) { const { reviewAll } = await import("./graph/review"); await reviewAll(userId, { onlyStale: true, limit: 10 }).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "قراءة ريم تعذّرت")); }
  const phones = await candidates(userId, scope, wide ? 60 : 30);
  if (!phones.length) return result;

  // Who is not to be followed at all.
  const [outRows, coldRows] = await Promise.all([
    db.select({ phone: unsubscribedPhonesTable.phone }).from(unsubscribedPhonesTable).where(and(eq(unsubscribedPhonesTable.userId, userId), inArray(unsubscribedPhonesTable.phone, phones))),
    db.select({ phone: leadSourcesTable.phone }).from(leadSourcesTable).where(and(eq(leadSourcesTable.userId, userId), inArray(leadSourcesTable.phone, phones), inArray(leadSourcesTable.lastIntent, ["not_interested", "opt_out", "complaint"]))),
  ]);
  const filed = (await db.execute<{ phone: string }>(sql`SELECT phone FROM conversation_reviews WHERE user_id = ${userId} AND label IN ('machine','not_customer','refused')`).catch(() => ({ rows: [] as Array<{ phone: string }> }))).rows;
  const skip = new Set([...outRows, ...coldRows, ...filed].map((r) => r.phone));

  // The rungs already taken, per phone.
  // A draft waiting for the owner (or approved and not yet sent) holds its person: no second draft beside it.
  const waiting = new Set((await db.execute<{ phone: string }>(sql`SELECT DISTINCT phone FROM followup_deliberations WHERE user_id = ${userId} AND verdict IN ('pending', 'approved', 'sending')`)).rows.map((r) => r.phone));
  const takenRows = await db.select({ phone: followupDeliberationsTable.phone, at: followupDeliberationsTable.createdAt, draft: followupDeliberationsTable.draft, verdict: followupDeliberationsTable.verdict })
    .from(followupDeliberationsTable)
    .where(and(eq(followupDeliberationsTable.userId, userId), inArray(followupDeliberationsTable.phone, phones), sql`${followupDeliberationsTable.step} >= ${STEP_BASE}`, gt(followupDeliberationsTable.createdAt, new Date(now - 60 * 86_400_000))));

  let ops: { ok: boolean; view: string } | null = null;
  let left = mode === "live" ? Math.min(batch, await getDailyRemaining(userId).catch(() => 0)) : Infinity;
  if (mode === "live") {
    const planOk = await assertCanSend(userId).then(() => true).catch(() => false);
    if (!planOk) return result;
  }

  for (const phone of phones) {
    if (result.drafted >= batch) break;
    if (skip.has(phone) || waiting.has(phone)) continue;
    const turns = await thread(userId, phone);
    // A thread whose every word from them is a machine's is not a conversation.
    const fromThem = turns.filter((t) => !t.fromMe);
    if (fromThem.length && fromThem.every((t) => detectAutoresponder(t.text).isAuto)) continue;
    if (!fromThem.length && scope !== "all") continue;

    const mine = takenRows.filter((r) => r.phone === phone && (r.verdict === "send" || r.verdict === "drop"));
    const card = await getCard(userId, phone).catch(() => null);
    const due = dueRung(turns, mine.map((r) => new Date(r.at)), (card?.stage ?? 1) >= 5, now, { ladder: ladder ?? undefined, scope });
    if (!due) continue;
    result.considered++;
    if (await isHumanHeld(userId, phone)) continue;

    // Operations decides once a round, and its no stops the round.
    ops ??= await opsVerdict(userId);
    if (!ops.ok) { logger.info({ userId, why: ops.view }, "smart follow-ups held by operations"); break; }
    if (left <= 0) break;

    // Belt and braces: a follow-up already went to this number in the last two hours.
    const recent = mine.find((r) => r.verdict === "send" && now - new Date(r.at).getTime() < 2 * H);
    if (recent) continue;
    const lastIn = [...turns].reverse().find((t) => !t.fromMe)?.at.getTime() ?? 0;
    // ريم reads the conversation first when it moved since she last did; her label can take the person out.
    const reading = await freshReview(userId, phone, vertical, turns);
    if (reading && OUT_LABELS.includes(reading.label)) { await record(userId, phone, due.rung, "drop", `ريم صنّفتها «${reading.label}» — لا متابعة`, null, false, "ريم"); result.declined++; continue; }
    const earlier = mine.filter((r) => new Date(r.at).getTime() > lastIn && r.draft).map((r) => r.draft!);
    const d = await asAgent(userId, FOLLOWUP_ROLE, () => compose(userId, phone, turns, due.rung, earlier, (ladder ?? LADDER.cold).length, vertical, style));
    result.drafted++;
    if (!d.send || !d.text) {
      // A model that did not answer, or refused, costs this round only: «hold»
      // is not a rung taken, so the ladder resumes next round. A draft the
      // check stopped is a real drop.
      await record(userId, phone, due.rung, d.retry ? "hold" : "drop", d.reason, d.text, false, ops.view);
      result.declined++;
      continue;
    }
    if (mode === "dry") {
      await record(userId, phone, due.rung, "send", `${d.reason} (وضع التجربة — لم تُرسل)`, d.text, false, ops.view);
      continue;
    }
    if (mode === "approve") {
      await record(userId, phone, due.rung, "pending", `${d.reason} — بانتظار موافقتك`, d.text, false, ops.view);
      continue;
    }
    if (await alreadySent(userId, phone, d.text)) { await record(userId, phone, due.rung, "drop", "النص نفسه وصلها من قبل", d.text, false, ops.view); result.declined++; continue; }
    try {
      await sendMessage(userId, phone, fixGreeting(d.text), undefined, undefined, undefined, undefined, { kind: "followup" });
      if (d.photo) await sendMessage(userId, phone, d.photo.caption, "image", d.photo.path, undefined, undefined, { kind: "followup" }).catch((err) => logger.warn({ userId, phone, err: String(err?.message ?? err).slice(0, 120) }, "صورة المتابعة لم تُرسل"));
      await record(userId, phone, due.rung, "send", d.reason, d.text, true, ops.view);
      result.sent++; left--;
      logger.info({ userId, phone, rung: due.rung + 1 }, "smart follow-up sent");
      await followupPause();
    } catch (err: any) {
      logger.warn({ userId, phone, err: String(err?.message ?? err).slice(0, 160) }, "smart follow-up send failed — will try next round");
      // The firewall's no is about the number today, not this person: the round ends here.
      if (String(err?.message ?? err).startsWith("FIREWALL:")) break;
    }
  }
  if (result.drafted) logger.info({ userId, ...result }, "smart follow-up round done");
  return result;
}

// ── ريم first ────────────────────────────────────────────────────
const OUT_LABELS = ["machine", "not_customer", "refused"];
async function freshReview(userId: number, phone: string, vertical: string | null, turns: Turn[]): Promise<{ label: string } | null> {
  const [r] = (await db.execute<{ label: string; reviewed_at: Date }>(sql`SELECT label, reviewed_at FROM conversation_reviews WHERE user_id = ${userId} AND phone = ${phone}`)).rows;
  const lastAt = Math.max(0, ...turns.map((t) => t.at.getTime()));
  if (r && new Date(r.reviewed_at).getTime() >= lastAt) return r;
  const { reviewAndSave } = await import("./graph/review");
  const fresh = await reviewAndSave(userId, phone, vertical).catch(() => null);
  return fresh ?? r ?? null;
}

// ── The owner's approval ──────────────────────────────────────────
// approve: a draft waits as «pending». The owner approves it (as written or
// edited), and it becomes «approved»; the next round — or one started at
// once — sends the approved ones, the batch at most, each through the
// firewall's gate, so the pace is the number's and not the owner's click.
// A customer who wrote after the draft was made gets no follow-up: the
// conversation moved, and the draft is dropped.

export async function pendingDrafts(userId: number) {
  return (await db.execute<any>(sql`SELECT d.id, d.phone, d.step - ${STEP_BASE} + 1 AS rung, d.verdict, d.reason, d.draft, d.created_at,
      r.label, r.score, r.summary, r.piece,
      (SELECT text FROM wa_thread_messages t WHERE t.user_id = d.user_id AND t.phone = d.phone AND NOT t.from_me AND coalesce(t.text,'') <> '' ORDER BY created_at DESC LIMIT 1) AS last_customer,
      (SELECT name FROM wa_conversations c WHERE c.user_id = d.user_id AND c.phone = d.phone LIMIT 1) AS name
    FROM followup_deliberations d LEFT JOIN conversation_reviews r ON r.user_id = d.user_id AND r.phone = d.phone
    WHERE d.user_id = ${userId} AND d.verdict IN ('pending', 'approved', 'sending') ORDER BY d.created_at`)).rows;
}

export async function approveDraft(userId: number, id: number, text?: string | null): Promise<{ ok: boolean; why?: string }> {
  const t = text?.trim();
  const r = await db.execute(sql`UPDATE followup_deliberations SET verdict = 'approved', draft = coalesce(${t || null}, draft),
      reason = 'اعتمدها صاحب العمل' || CASE WHEN ${!!t} THEN ' بعد تعديلها' ELSE '' END
    WHERE id = ${id} AND user_id = ${userId} AND verdict = 'pending' RETURNING id`);
  return r.rows.length ? { ok: true } : { ok: false, why: "المسودة لم تعد بانتظار الموافقة" };
}

export async function rejectDraft(userId: number, id: number): Promise<{ ok: boolean }> {
  const r = await db.execute(sql`UPDATE followup_deliberations SET verdict = 'drop', reason = 'رفضها صاحب العمل'
    WHERE id = ${id} AND user_id = ${userId} AND verdict IN ('pending', 'approved') RETURNING id`);
  return { ok: r.rows.length > 0 };
}

/** The approved drafts, oldest first, the batch at most, each through the gate. */
export async function sendApproved(userId: number, batch: number): Promise<{ sent: number; dropped: number; held: number }> {
  const out = { sent: 0, dropped: 0, held: 0 };
  if (!isWithinSendingHours() || !getStatus(userId).connected) return out;
  const rows = (await db.execute<{ id: number; phone: string; draft: string; created_at: Date }>(sql`SELECT id, phone, draft, created_at FROM followup_deliberations
    WHERE user_id = ${userId} AND verdict = 'approved' AND coalesce(draft, '') <> '' ORDER BY created_at LIMIT ${batch}`)).rows;
  for (const r of rows) {
    // Claimed before anything else: the owner's «send now» and the round both
    // read the same approved rows, and on 2026-10-21 both sent two of them.
    const claimed = (await db.execute(sql`UPDATE followup_deliberations SET verdict = 'sending' WHERE id = ${r.id} AND verdict = 'approved' RETURNING id`)).rows.length;
    if (!claimed) continue;
    // The same words already reached this person: never twice.
    if (await alreadySent(userId, r.phone, r.draft)) {
      await db.execute(sql`UPDATE followup_deliberations SET verdict = 'drop', reason = 'النص نفسه وصلها من قبل — لم يُرسل مرة ثانية' WHERE id = ${r.id}`);
      out.dropped++; continue;
    }
    // She wrote after the draft: the conversation moved on, the draft is stale.
    const [moved] = (await db.execute(sql`SELECT 1 FROM wa_thread_messages WHERE user_id = ${userId} AND phone = ${r.phone} AND NOT from_me AND created_at > ${r.created_at} LIMIT 1`)).rows;
    if (moved) { await db.execute(sql`UPDATE followup_deliberations SET verdict = 'drop', reason = 'ردّت الزبونة بعد كتابتها — لم تُرسل' WHERE id = ${r.id}`); out.dropped++; continue; }
    try {
      await sendMessage(userId, r.phone, fixGreeting(r.draft), undefined, undefined, undefined, undefined, { kind: "followup" });
      await db.execute(sql`UPDATE followup_deliberations SET verdict = 'send', executed = true WHERE id = ${r.id}`);
      receipt({ userId, node: FOLLOWUP_ROLE, graph: "whatsapp", action: "followup.sent", status: "ok", subject: r.phone, why: "متابعة اعتمدها صاحب العمل" });
      out.sent++;
      await followupPause();
    } catch (err: any) {
      const m = String(err?.message ?? err);
      // The person said no for good: the draft goes. The number's no: everything waits for the next round.
      if (m.startsWith("FIREWALL-REFUSED:")) { await db.execute(sql`UPDATE followup_deliberations SET verdict = 'drop', reason = ${m.slice(0, 200)} WHERE id = ${r.id}`); out.dropped++; continue; }
      out.held++;
      await db.execute(sql`UPDATE followup_deliberations SET verdict = 'approved' WHERE id = ${r.id} AND verdict = 'sending'`);
      logger.info({ userId, phone: r.phone, why: m.slice(0, 160) }, "متابعة معتمدة تنتظر الجولة القادمة");
      if (m.startsWith("FIREWALL:")) break;
    }
  }
  if (out.sent || out.dropped) logger.info({ userId, ...out }, "أُرسلت المتابعات المعتمدة");
  return out;
}

/**
 * ريم's listing (the owner, 2026-10-22: «يعمل listing للناس اللي في الشات
 * كلهم وشوف اللي المفروض يتابع معاهم»): every conversation of the last two
 * months, her reading of it, and what happens next — the follow-up and when,
 * or why not. Read-only; the round is what acts.
 */
export async function followupPlan(userId: number, now = Date.now()) {
  const { ladder, scope, style } = await ladderOf(userId);
  const rungs = (ladder ?? LADDER.cold).length;
  const rows = (await db.execute<any>(sql`
    SELECT m.phone, max(m.created_at) FILTER (WHERE NOT m.from_me) AS last_in, max(m.created_at) FILTER (WHERE m.from_me) AS last_out,
      r.label, r.score, r.summary, r.piece, r.reviewed_at,
      (SELECT name FROM wa_conversations c WHERE c.user_id = m.user_id AND c.phone = m.phone LIMIT 1) AS name,
      EXISTS (SELECT 1 FROM unsubscribed_phones u WHERE u.user_id = m.user_id AND right(regexp_replace(u.phone, '[^0-9]', '', 'g'), 9) = right(regexp_replace(split_part(m.phone, ':', 1), '[^0-9]', '', 'g'), 9) AND (u.expires_at IS NULL OR u.expires_at > now())) AS stopped,
      (SELECT verdict FROM followup_deliberations d WHERE d.user_id = m.user_id AND d.phone = m.phone AND d.verdict IN ('pending','approved','sending') LIMIT 1) AS waiting
    FROM wa_thread_messages m LEFT JOIN conversation_reviews r ON r.user_id = m.user_id AND r.phone = m.phone
    WHERE m.user_id = ${userId} AND m.created_at > now() - interval '65 days'
    GROUP BY m.phone, m.user_id, r.label, r.score, r.summary, r.piece, r.reviewed_at
    ORDER BY max(m.created_at) DESC LIMIT 400`)).rows;
  const taken = (await db.execute<{ phone: string; at: Date }>(sql`SELECT phone, created_at AS at FROM followup_deliberations
    WHERE user_id = ${userId} AND step >= ${STEP_BASE} AND verdict IN ('send', 'drop') AND created_at > now() - interval '60 days'`)).rows;
  const out = [];
  for (const r of rows) {
    const lastIn = r.last_in ? new Date(r.last_in).getTime() : 0, lastOut = r.last_out ? new Date(r.last_out).getTime() : 0;
    const mine = taken.filter((t) => t.phone === r.phone && new Date(t.at).getTime() > lastIn).map((t) => new Date(t.at).getTime());
    let status: string, next: number | null = null, follow = false;
    if (r.stopped) status = "طلبت إيقاف الرسائل — لا تُتابَع أبداً";
    else if (r.label && OUT_LABELS.includes(r.label)) status = `ريم: ${r.label === "machine" ? "رد آلي" : r.label === "refused" ? "رفضت" : "ليست زبونة"} — لا تُتابَع`;
    else if (!lastIn && scope !== "all") status = "لم تكتب لنا — لا تُتابَع";
    else if (lastIn > lastOut) status = "كتبت لنا آخر شيء — تنتظر رداً من المحل، لا متابعة";
    else if (lastIn < now - 60 * 86_400_000) status = "آخر رسالة منها قبل أكثر من شهرين";
    else if (r.waiting) status = r.waiting === "pending" ? "متابعة مكتوبة بانتظار موافقتك" : "متابعة معتمدة تنتظر دورها";
    else if (mine.length >= rungs) status = `أخذت المتابعات ${rungs} كلها`;
    else {
      const l = ladder ?? LADDER.cold;
      const base = Math.max(lastOut, ...mine);
      next = base + l[mine.length]! * H; follow = true;
      status = `المتابعة ${mine.length + 1} من ${rungs}`;
    }
    out.push({ phone: r.phone, name: r.name ?? null, label: r.label ?? null, score: r.score ?? null, summary: r.summary ?? null, piece: r.piece ?? null,
      reviewed: !!r.reviewed_at, lastIn: r.last_in, lastOut: r.last_out, taken: mine.length, rungs, follow, next: next ? new Date(next).toISOString() : null, status });
  }
  const summary = { total: out.length, follow: out.filter((x) => x.follow).length, dueNow: out.filter((x) => x.follow && x.next && new Date(x.next).getTime() <= now).length, unreviewed: out.filter((x) => !x.reviewed).length, style };
  return { summary, people: out.sort((a, b) => Number(b.follow) - Number(a.follow) || (a.next ?? "z").localeCompare(b.next ?? "z")) };
}

/** Whether these words, or nearly these, already went to this person in the last week. */
async function alreadySent(userId: number, phone: string, text: string): Promise<boolean> {
  const key = String(phone).split(":")[0]!.replace(/\D/g, "").slice(-9);
  const rows = (await db.execute<{ text: string }>(sql`SELECT text FROM wa_thread_messages WHERE user_id = ${userId} AND from_me
    AND right(regexp_replace(split_part(phone, ':', 1), '[^0-9]', '', 'g'), 9) = ${key} AND coalesce(text, '') <> '' AND created_at > now() - interval '7 days'`)).rows;
  return rows.some((r) => r.text.trim() === text.trim() || overlap(r.text, text) > 0.85);
}

/**
 * A follow-up that reached the same person twice (the owner, 2026-10-21:
 * «كرر نفس الرسالة لنفس الرقم — امسح المكرر») is taken back for everyone:
 * the later copy only, and only when it is word for word a follow-up we
 * sent, within an hour of the first and inside WhatsApp's recall window.
 */
export async function recallDuplicateFollowups(userId: number): Promise<number> {
  const dups = (await db.execute<{ phone: string; message_id: string; text: string }>(sql`
    SELECT later.phone, later.message_id, later.text FROM wa_thread_messages later
    WHERE later.user_id = ${userId} AND later.from_me AND later.message_id IS NOT NULL AND coalesce(later.text, '') <> ''
      AND later.created_at > now() - interval '36 hours'
      AND EXISTS (SELECT 1 FROM wa_thread_messages earlier WHERE earlier.user_id = later.user_id AND earlier.phone = later.phone AND earlier.from_me
        AND earlier.text = later.text AND earlier.created_at < later.created_at AND earlier.created_at > later.created_at - interval '1 hour')
      AND EXISTS (SELECT 1 FROM followup_deliberations d WHERE d.user_id = later.user_id AND d.executed AND d.draft = later.text)
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.user_id = later.user_id AND r.action = 'recall.whatsapp' AND r.output_ref = later.message_id)`)).rows;
  if (!dups.length) return 0;
  const { deleteForEveryone } = await import("./whatsapp");
  let n = 0;
  for (const d of dups) {
    try {
      await deleteForEveryone(userId, d.phone, d.message_id);
      await db.execute(sql`UPDATE wa_thread_messages SET text = ${"🚫 حُذفت: نسخة مكررة من متابعة"} WHERE user_id = ${userId} AND message_id = ${d.message_id}`);
      n++;
      logger.info({ userId, phone: d.phone, messageId: d.message_id }, "حُذفت متابعة مكررة عند الطرفين");
      await new Promise((r) => setTimeout(r, 4_000));
    } catch (err: any) { logger.warn({ userId, phone: d.phone, err: String(err?.message ?? err).slice(0, 160) }, "حذف المكرر تعذّر"); }
  }
  return n;
}

/** Sending what the owner just approved, without holding the request open. */
const sendingNow = new Set<number>();
export function sendApprovedSoon(userId: number) {
  if (sendingNow.has(userId)) return;
  sendingNow.add(userId);
  void (async () => {
    try { const { batch } = await ladderOf(userId); await sendApproved(userId, batch); }
    catch (err: any) { logger.warn({ userId, err: String(err?.message ?? err) }, "إرسال المعتمد تعذّر"); }
    finally { sendingNow.delete(userId); }
  })();
}

let timer: NodeJS.Timeout | null = null;
export function startSmartFollowUps() {
  if (timer) return;
  const run = async () => {
    const users = await db.execute(sql`SELECT user_id FROM business_profile WHERE smart_followup <> 'off' AND NOT team_paused`).catch(() => ({ rows: [] }));
    for (const u of users.rows as Array<{ user_id: number }>) {
      await runSmartFollowUps(u.user_id).catch((err) => logger.warn({ userId: u.user_id, err: String(err?.message ?? err) }, "smart follow-up round failed"));
    }
  };
  setTimeout(() => void run(), 3 * 60_000).unref();
  timer = setInterval(() => void run(), 20 * 60_000);
  timer.unref();
}
