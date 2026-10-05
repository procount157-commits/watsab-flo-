// ── What the social team writes ───────────────────────────────────
// Every judgement and every draft goes through here, each in the voice of the
// employee whose job it is — with that employee's standing orders and skills,
// the firm's knowledge, and what was said before, so nothing is repeated.

import { complete } from "../llm";
import { retrieve } from "../knowledge";
import { guardCheck } from "../email/team";
import { PLATFORM, type SocialPlatform } from "./platforms";
import { voiceFor, roleOf, type Job } from "./team";
import { asAgent } from "../agent-context";
import { lessonsFor } from "../feedback";

export const INTENTS = ["question", "interested", "praise", "complaint", "spam", "stop", "other"] as const;
export type Intent = typeof INTENTS[number];

async function facts(userId: number, text: string) {
  const f = await retrieve(userId, text.slice(0, 400), 3).catch(() => []);
  return f.length ? `من معرفة الشركة (لا تذكر غيرها من أرقام):\n${f.map((x) => `- ${x.entry.title}: ${x.entry.content.slice(0, 350)}`).join("\n")}` : "";
}

async function ask(userId: number, p: SocialPlatform, job: Job, rules: string[], user: string, ms = 25_000) {
  const role = roleOf(p, job);
  return asAgent(userId, role, async () => {
    const [voice, lessons] = await Promise.all([voiceFor(userId, p, job), lessonsFor(userId, role, user).catch(() => "")]);
    const out = await complete([
      { role: "system", content: [voice, "", ...rules, lessons].filter(Boolean).join("\n") },
      { role: "user", content: user },
    ], ms);
    return out?.text?.trim() ?? "";
  });
}

const clean = (t: string, max: number) => t.replace(/^[«"'`]+|[»"'`]+$/g, "").replace(/^(الرد|الرسالة|المنشور|التعليق)\s*[:：]\s*/i, "").trim().slice(0, max);

/** The triage job: what is this, is it worth anything, and did they ask us to stop. */
export async function triage(userId: number, p: SocialPlatform, text: string, author: string) {
  const t = await ask(userId, p, "triage", [
    "صنّف الرسالة أو التعليق التالي. أجب بهذا الشكل بالضبط ولا شيء غيره:",
    "النوع: question | interested | praise | complaint | spam | stop | other",
    "فرصة: نعم | لا",
    "الحرارة: حار | دافئ | بارد",
    "السبب: <سطر واحد>",
    "",
    "«ما شاء الله» و«جميل» و«❤️» = praise وليست فرصة. السؤال عن سعر أو خدمة أو موعد = interested وفرصة.",
    "«لا شكراً»، «لا تراسلني»، «not interested»، «stop» = stop. الترويج لحساب آخر أو رابط مشبوه = spam.",
  ], `@${author}: ${text}`, 15_000);
  const intent = (INTENTS.find((i) => new RegExp(`النوع\\s*[:：]\\s*${i}`, "i").test(t)) ?? "other") as Intent;
  const temp = /الحرارة\s*[:：]\s*حار/.test(t) ? "hot" : /الحرارة\s*[:：]\s*دافئ/.test(t) ? "warm" : "cold";
  return { intent, isLead: /فرصة\s*[:：]\s*نعم/.test(t), temperature: temp as "hot" | "warm" | "cold", why: /السبب\s*[:：]\s*(.+)/.exec(t)?.[1]?.trim() ?? "" };
}

/** The writer: the public reply, or nothing. */
export async function draftCommentReply(userId: number, p: SocialPlatform, c: { author: string; text: string; intent: Intent }, recent: string[]) {
  if (c.intent === "spam" || c.intent === "stop") return null;
  const t = await ask(userId, p, "writer", [
    "اكتب الرد العلني على التعليق. سطر أو سطران كحد أقصى، بلهجة صاحب التعليق.",
    "لا سعر ولا تفاصيل في العلن — ادعه للخاص إن احتاج سؤاله ذلك. لا تبدأ بـ«شكراً لتواصلك» ولا «يسعدنا».",
    recent.length ? `ردود استعملتها مؤخراً — لا تكررها ولا تقاربها:\n${recent.slice(0, 6).map((r) => `- ${r}`).join("\n")}` : "",
    await facts(userId, c.text),
    "اكتب الرد وحده بلا مقدمات ولا علامات اقتباس.",
  ], `@${c.author}: ${c.text}`);
  const r = clean(t, 400);
  return r.length > 1 ? r : null;
}

/** The DM desk: the next reply in a conversation. */
export async function draftDmReply(userId: number, p: SocialPlatform, who: string, history: Array<{ fromMe: boolean; text: string }>) {
  const last = history.filter((m) => !m.fromMe).slice(-3).map((m) => m.text).join("\n");
  const t = await ask(userId, p, "dm", [
    "اكتب الرد التالي في هذه المحادثة الخاصة، كما يكتبه موظف من الشركة.",
    `${PLATFORM[p].voice} سؤال تأهيل واحد كحد أقصى. لا تخترع سعراً — اطلب ما يحدد نطاق العمل.`,
    "إن طلب التوقف أو رفض بوضوح: اكتب «(لا رد)» فقط.",
    await facts(userId, last),
    "اكتب الرد وحده.",
  ], `المحادثة مع ${who} (الأقدم أولاً):\n${history.slice(-14).map((m) => `${m.fromMe ? "نحن" : who}: ${m.text}`).join("\n")}`);
  const r = clean(t, 1_000);
  return !r || /\(لا رد\)/.test(r) ? null : r;
}

export type TargetBrief = { handle: string; name?: string | null; headline?: string | null; company?: string | null; sector?: string | null; city?: string | null; note?: string | null };

/** The prospector: the first message to someone on the owner's list. */
export async function draftFirstMessage(userId: number, p: SocialPlatform, t: TargetBrief, recent: string[]) {
  const P = PLATFORM[p];
  const about = [t.name && `الاسم: ${t.name}`, t.headline && `الوصف: ${t.headline}`, t.company && `الشركة: ${t.company}`, t.sector && `القطاع: ${t.sector}`, t.city && `المدينة: ${t.city}`, t.note && `ملاحظة صاحب العمل: ${t.note}`].filter(Boolean).join("\n");
  const text = await ask(userId, p, "prospector", [
    `اكتب أول رسالة خاصة لهذا الشخص في ${P.labelAr}. لا يعرفنا، ونحن من يبدأ.`,
    `أقصى طول ${P.firstContactMax} حرف. سطر يبيّن لماذا هو بالذات، قيمة واحدة، وسؤال واحد سهل يُجاب بسطر.`,
    "لا رابط، ولا سعر، ولا «عرض خاص»، ولا مدح مبالغ فيه. لا تبدأ بـ«أتمنى أن تكون بخير» ولا بـ«اسمي…».",
    "إن لم تعرف لغته فاكتب بلغة وصفه؛ وإن لم يوجد وصف فبالإنجليزية لحسابات الشركات وبالعربية الخليجية للأسماء العربية.",
    recent.length ? `رسائل أولى استعملتها مؤخراً — لا تكرر صياغتها:\n${recent.slice(0, 5).map((r) => `- ${r.slice(0, 160)}`).join("\n")}` : "",
    await facts(userId, `${t.sector ?? ""} ${t.headline ?? ""}`),
    "اكتب الرسالة وحدها.",
  ], about || `@${t.handle}`);
  const r = clean(text, P.firstContactMax);
  return r.length > 10 ? r : null;
}

/** The follow-up: once, shorter, a new angle. */
export async function draftFollowup(userId: number, p: SocialPlatform, t: TargetBrief, first: string) {
  const text = await ask(userId, p, "followup", [
    "اكتب متابعة واحدة لمن لم يرد على رسالتنا الأولى. هي الأخيرة: بعدها نتوقف.",
    "أقصر من الأولى بنصفها، بزاوية جديدة لا تكرار، بلا لوم ولا «لم ترد». مخرج كريم: إن لم يكن الوقت مناسباً فلا بأس.",
    "اكتب الرسالة وحدها.",
  ], `رسالتنا الأولى:\n${first}\n\nعنه: ${[t.name, t.headline, t.company].filter(Boolean).join(" — ") || `@${t.handle}`}`);
  const r = clean(text, PLATFORM[p].firstContactMax);
  return r.length > 8 ? r : null;
}

/** The creator: a post on a topic the owner gave. */
export async function draftPost(userId: number, p: SocialPlatform, topic: string) {
  const text = await ask(userId, p, "creator", [
    `اكتب منشوراً واحداً لحساب الشركة في ${PLATFORM[p].labelAr} عن الموضوع المطلوب.`,
    p === "linkedin"
      ? "لينكدإن: سطر أول يوقف القارئ، ثم ٤–٧ أسطر قصيرة تعلّم فكرة واحدة عملية، ثم سؤال واحد للقراء. ٣ وسوم كحد أقصى في النهاية. بالإنجليزية ما لم يُطلب غيرها."
      : "وصف قصير لصورة أو فيديو: سطر أول جاذب، ٢–٤ أسطر فائدة، دعوة واحدة للتواصل بالخاص، ٣–٥ وسوم.",
    "لا أرقام أو غرامات أو مهل ليست في معرفة الشركة. لا وعود.",
    await facts(userId, topic),
    "اكتب المنشور وحده.",
  ], `الموضوع: ${topic}`, 40_000);
  const r = clean(text, 2_900);
  return r.length > 20 ? r : null;
}

/** The creator: a comment on someone else's post that adds something. */
export async function draftEngage(userId: number, p: SocialPlatform, postText: string) {
  const text = await ask(userId, p, "creator", [
    "اكتب تعليقاً واحداً على منشور شخص آخر في قطاعنا. يضيف رأياً أو معلومة أو سؤالاً ذكياً — لا «منشور رائع» ولا ترويج لنا ولا رابط.",
    "سطران كحد أقصى، بلغة المنشور.",
    "اكتب التعليق وحده.",
  ], `المنشور:\n${postText.slice(0, 1_500)}`);
  const r = clean(text, 600);
  return r.length > 5 ? r : null;
}

/** The guard's check before anything leaves on its own: the email desk's rules, and no repeats. */
export function guardText(text: string, knowledge: string, recentSent: string[]): string[] {
  const issues = guardCheck([text], knowledge);
  const n = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (recentSent.some((r) => n(r) === n(text))) issues.push("نفس الرسالة أُرسلت حرفياً لشخص آخر — المنصات تقيّد الحساب على التكرار");
  return issues;
}
