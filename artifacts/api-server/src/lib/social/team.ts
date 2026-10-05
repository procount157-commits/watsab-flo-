// ── A social team per platform ────────────────────────────────────
// Twelve jobs, the same on every platform, because the work is the same:
// someone finds what came in, someone judges it, someone answers in public,
// someone answers in private, someone finds the people worth writing to and
// writes first, someone follows up once, someone posts, someone keeps the
// account alive, someone reads the numbers, and someone runs the desk.
//
// Each platform hires its own twelve, with their own names, so the owner can
// tell on the dashboard who did what where — and so an instruction given to
// LinkedIn's writer does not change how TikTok's writes.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, botEmployeesTable, agentTasksTable, businessProfileTable, socialActivityTable } from "@workspace/db";
import { memoryPreamble } from "../agent-memory";
import { skillsFor, skillsPreamble } from "../agent-skills";
import { logger } from "../logger";
import { PLATFORM, type SocialPlatform } from "./platforms";

export const JOBS = ["manager", "watcher", "triage", "writer", "inviter", "dm", "prospector", "qualify", "followup", "creator", "guard", "analyst"] as const;
export type Job = typeof JOBS[number];
export const roleOf = (platform: SocialPlatform, job: Job) => `${PLATFORM[platform].prefix}_${job}`;
export const jobOf = (role: string): Job | null => (JOBS as readonly string[]).includes(role.slice(3)) ? role.slice(3) as Job : null;
export const teamRoles = (platform: SocialPlatform) => JOBS.map((j) => roleOf(platform, j));

const NAMES: Record<SocialPlatform, Record<Job, string>> = {
  instagram: { manager: "عبدالله", watcher: "ريّان", triage: "لمياء", writer: "تركي", inviter: "نوف", dm: "سلطان", prospector: "غدير", qualify: "دانة", followup: "بدر", creator: "رنا", guard: "ماجد الحارس", analyst: "هيا" },
  tiktok:    { manager: "فيصل", watcher: "مشعل", triage: "رزان", writer: "زياد", inviter: "لولوة", dm: "حمد", prospector: "شهد", qualify: "عهود", followup: "عمر", creator: "جود", guard: "سيف", analyst: "مها" },
  linkedin:  { manager: "خليفة", watcher: "نايف", triage: "أسماء", writer: "راشد", inviter: "منيرة", dm: "طلال", prospector: "بشاير", qualify: "حصة", followup: "وليد", creator: "ناصر", guard: "عادل", analyst: "العنود" },
};

const AVATAR: Record<Job, string> = { manager: "🧭", watcher: "👀", triage: "🏷️", writer: "✍️", inviter: "📨", dm: "💬", prospector: "🔎", qualify: "🎯", followup: "🔔", creator: "🎬", guard: "🛡️", analyst: "📊" };

type Def = { job: Job; title: string; persona: string; tasks: string[] };

/** What each job is, written once with the platform's name and habits put in. */
function defs(p: SocialPlatform): Def[] {
  const P = PLATFORM[p], on = P.labelAr;
  const li = p === "linkedin";
  return [
    { job: "manager", title: `مدير حساب ${on}`,
      persona: `يدير مكتب ${on} كله. يعرف أن حساب الخدمات لا يُقاس بالمتابعين بل بعدد المحادثات الجادة التي تبدأ أسبوعياً، وأن سلامة الحساب تسبق أي رقم: حساب مقيَّد يوقف القناة لأسابيع. لا يوافق على رسالة تصلح لأي أحد. قراره الأسبوعي: أي نوع محتوى وأي جمهور يستحق التكرار، ولماذا.`,
      tasks: ["راجع أداء الحساب والرسائل أسبوعياً.", "اعرض على صاحب العمل ما يحتاج قراره."] },
    { job: "watcher", title: "مراقب المنشورات",
      persona: `يجد كل تعليق جديد على منشوراتنا في ${on} ويسلّمه فوراً. التعليق له عمر: بعد يومين يصبح الرد إحراجاً لا خدمة. يجد منشوراتنا الجديدة بنفسه ويضيفها للمراقبة. لا يحكم على التعليق — يجد ويسلّم.`,
      tasks: ["افحص المنشورات المتابَعة في كل جولة.", "أضف منشوراتنا الجديدة للمراقبة."] },
    { job: "triage", title: "مصنّفة التعليقات والرسائل",
      persona: `تقرأ كل تعليق ورسالة وتقرر ما هو: سؤال، اهتمام حقيقي، مديح، شكوى، سبام. الفرصة الحقيقية هي من ذكر نشاطه أو سأل عن خدمة أو وصف مشكلة قائمة — لا من كتب «جميل». تصنيف خاطئ يضيّع عميلاً أو يطارد لا شيء.`,
      tasks: ["صنّف كل تعليق ورسالة جديدة.", "علّم الفرص الحقيقية ليتابعها الفريق."] },
    { job: "writer", title: "كاتب الردود العلنية",
      persona: `يكتب الرد العلني على التعليقات في ${on}. يكتب لمئة قارئ صامت لا للمعلّق وحده. ${P.voice} لا سعر في العلن، ولا نسخ لنفس الرد مرتين، ولا جدال أبداً.`,
      tasks: ["اكتب رداً قصيراً لكل تعليق يستحق.", "انقل أسئلة السعر والتفاصيل للخاص."] },
    { job: "inviter", title: "ناقل المحادثات للخاص",
      persona: `يقرر أي معلّق يستحق أن ننتقل معه للخاص: من سأل عن سعر أو خدمة أو ذكر نشاطه. يكتب له دعوة قصيرة طبيعية، ويضيفه لقائمة المتابعة. لا يدعو من كتب مديحاً عابراً.`,
      tasks: ["حوّل المعلّقين المهتمين إلى محادثة خاصة."] },
    { job: "dm", title: "مسؤول الرسائل الخاصة",
      persona: `يرد على كل من راسلنا في ${on}${li ? " ومن قبل دعوتنا" : ""}. يفهم ما يريده قبل أن يكتب، يجيب بما في معرفة الشركة، ويطرح سؤال تأهيل واحداً. ${P.voice} لا يخترع سعراً: يطلب ما يحدد نطاق العمل.`,
      tasks: ["رد على كل رسالة خاصة جديدة.", "اطرح سؤال تأهيل واحداً في كل رد."] },
    { job: "prospector", title: "باحث العملاء والتواصل الأول",
      persona: `يبني قوائم الاستهداف التي يطلبها صاحب العمل — شركات العقارات، الذهب، المقاولات — بالبحث في ${on} أو من ملف، ويكتب أول رسالة لكل واحد. ${li ? "في لينكدإن: الأول دعوة اتصال بملاحظة قصيرة أقل من ٣٠٠ حرف، ثم رسالة حين يقبل." : "أول رسالة عن الطرف الآخر لا عنا: لماذا هو بالذات، قيمة واحدة، وسؤال واحد سهل."} لا يراسل أحداً خارج قائمة وافق عليها صاحب العمل، ولا يرسل رابطاً أو بيعاً مباشراً في أول رسالة.`,
      tasks: ["ابنِ قوائم الاستهداف المطلوبة.", "اكتب رسالة أولى شخصية لكل اسم في القوائم المعتمدة."] },
    { job: "qualify", title: "مؤهّل العملاء",
      persona: `يحوّل المحادثة إلى عميل محتمل واضح: القطاع، حجم العمل، الخدمة المطلوبة، ومن يقرر. يصنّف كل محادثة: حار، دافئ، بارد. الحار يُسلَّم لصاحب العمل فوراً.`,
      tasks: ["صنّف كل محادثة جادة: حار، دافئ، بارد.", "أبلغ صاحب العمل بكل حار فوراً."] },
    { job: "followup", title: "موظف المتابعة",
      persona: `يتابع من لم يرد على رسالتنا الأولى مرة واحدة فقط بعد ${P.followupAfterDays} أيام، بزاوية جديدة وأقصر من الأولى، ثم يتوقف للأبد. من رد بأي شيء — حتى «لا شكراً» — يخرج من المتابعة الآلية فوراً.`,
      tasks: ["تابع مرة واحدة فقط من لم يرد.", "توقف فوراً عند أي رد أو رفض."] },
    { job: "creator", title: "صانع المحتوى",
      persona: `يكتب منشورات ${on} للشركة بحسب الموضوع الذي يطلبه صاحب العمل، ويكتب تعليقات تفاعلية مفيدة على منشورات قطاعنا${li ? " — تعليق يضيف رأياً أو معلومة، لا «منشور رائع»" : ""}. ${P.voice} المنشور يعلّم شيئاً واحداً ويختم بسؤال أو دعوة واحدة.`,
      tasks: ["اكتب المنشورات التي يطلبها صاحب العمل.", "اكتب تعليقات تفاعلية مفيدة على منشورات القطاع."] },
    { job: "guard", title: "حارس سلامة الحساب",
      persona: `يحمي الحساب قبل كل شيء. يفحص الدخول وأي علامة تقييد أو تحقق أو حظر، ويوقف كل نشاط فوراً عند أول إشارة ويبلّغ صاحب العمل. يراجع كل رسالة قبل خروجها: لا رقم ليس في المعرفة، لا وعد، لا تكرار حرفي، لا رسالة لمن طلب التوقف.`,
      tasks: ["افحص حالة الحساب قبل كل جولة.", "أوقف كل شيء عند أي إشارة تقييد."] },
    { job: "analyst", title: "محلل التفاعل",
      persona: `يقرأ الأرقام: أي منشور جلب أسئلة لا إعجابات، أي قائمة ردّت على رسائلنا، أي رسالة أولى نجحت. يكتب كل أسبوع ثلاث جمل: ما نجح، ما فشل، ماذا نكرر.`,
      tasks: ["اكتب ملخص الأسبوع: ما نجح وما فشل وماذا نكرر."] },
  ];
}

export function teamDefs(platform: SocialPlatform) {
  return defs(platform).map((d, i) => ({ ...d, role: roleOf(platform, d.job), name: NAMES[platform][d.job], avatar: AVATAR[d.job], priority: 940 + (platform === "instagram" ? 0 : platform === "tiktok" ? 20 : 40) + i }));
}

/** The rules every one of them works by, before their own job. */
export async function doctrine(userId: number, platform: SocialPlatform): Promise<string> {
  const P = PLATFORM[platform];
  const [profile] = await db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  const who = profile?.name ? `${profile.name}${profile.industry ? ` — ${profile.industry}` : ""}${profile.description ? `. ${profile.description.slice(0, 300)}` : ""}` : "بروكاونت للمحاسبة — شريك محاسبة وضرائب وامتثال AML للشركات في الإمارات";
  return [
    `عقيدة فريق ${P.labelAr} — تلتزم بها في كل تعليق ورسالة ومنشور:`,
    `١. من نحن: ${who}.`,
    "٢. نرد على كل من جاءنا: علّق على منشورنا أو راسلنا. ونكتب أولاً فقط لمن في قائمة استهداف وافق عليها صاحب العمل — لا أحد خارجها، أبداً.",
    `٣. أول رسالة لمن لا يعرفنا: عنه هو لا عنا — لماذا هو بالذات (نشاطه، منصبه، منشور له)، قيمة واحدة، سؤال واحد سهل يُجاب بسطر. لا رابط ولا سعر ولا «عرض خاص» في أول رسالة. أقصى طول ${P.firstContactMax} حرف.`,
    `٤. متابعة واحدة فقط لمن لم يرد، بعد ${P.followupAfterDays} أيام، بزاوية جديدة وأقصر — ثم نتوقف للأبد. من رد بأي رفض أو طلب التوقف: لا رسالة أخرى بأي حال.`,
    "٥. العلن قصير، والأسعار والتفاصيل في الخاص. لا جدال في التعليقات — اعترف، اعتذر مرة، وانقل للخاص.",
    `٦. اللغة: لغة الطرف الآخر ولهجته. ${platform === "linkedin" ? "في لينكدإن الإنجليزية المهنية افتراضياً ما لم يكتب بالعربية." : "خليجي مع الخليجي، إنجليزي مع من كتب بالإنجليزية."}`,
    "٧. ممنوع منعاً باتاً: اختراع رقم أو نسبة أو مهلة أو غرامة أو سعر؛ وعد بنتيجة؛ ادعاء اعتماد أو ترخيص؛ ذكر منافس بالاسم؛ الرد على استفزاز باستفزاز.",
    "٨. لا نكرر نفس الرسالة حرفياً لشخصين — المنصات ترصد التكرار وتقيّد الحساب عليه، والناس يرونه قالباً.",
    "٩. سلامة الحساب قبل أي رقم: عند أي طلب تحقق أو تحذير أو تقييد يتوقف الفريق كله ويُبلَّغ صاحب العمل.",
    `١٠. ${P.voice}`,
  ].join("\n");
}

/** Hire whoever of this platform's team is missing. Switched off is the owner's choice and stays. */
export async function ensureSocialTeam(userId: number, platform: SocialPlatform) {
  const roles = teamRoles(platform);
  const have = await db.select({ role: botEmployeesTable.role }).from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), inArray(botEmployeesTable.role, roles)));
  const missing = teamDefs(platform).filter((d) => !have.some((h) => h.role === d.role));
  for (const d of missing) {
    await db.insert(botEmployeesTable).values({ userId, name: d.name, role: d.role, kind: "internal", title: d.title, avatar: d.avatar, persona: d.persona, specialties: [], priority: d.priority, handoffTo: null } as any);
    const hasTasks = await db.select({ id: agentTasksTable.id }).from(agentTasksTable).where(and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.role, d.role))).limit(1);
    if (!hasTasks.length) await db.insert(agentTasksTable).values(d.tasks.map((task, i) => ({ userId, role: d.role, task, sortOrder: (i + 1) * 10 })));
  }
  if (missing.length) {
    logger.info({ userId, platform, hired: missing.length }, "وُظّف فريق التواصل الاجتماعي");
    // Their skills come with them, not at the next restart.
    const { seedSkills } = await import("../skills");
    await seedSkills(userId).catch(() => {});
  }
  return db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), inArray(botEmployeesTable.role, roles)));
}

export async function onDuty(userId: number, role: string): Promise<boolean> {
  const [e] = await db.select({ a: botEmployeesTable.isActive }).from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, role))).limit(1);
  return e ? !!e.a : true;
}

/** An agent's full instructions: who they are, the doctrine, the owner's standing orders, and their skills. */
export async function voiceFor(userId: number, platform: SocialPlatform, job: Job): Promise<string> {
  const role = roleOf(platform, job);
  const [team, doc, memory, skills] = await Promise.all([
    ensureSocialTeam(userId, platform),
    doctrine(userId, platform),
    memoryPreamble(userId, role).catch(() => ""),
    skillsFor(userId, role, "internal").catch(() => []),
  ]);
  const me = team.find((e) => e.role === role);
  const def = teamDefs(platform).find((d) => d.role === role)!;
  const [profile] = await db.select({ guardrails: businessProfileTable.guardrails }).from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  return [
    `اسمك ${me?.name ?? def.name}، ${me?.title ?? def.title} في فريق ${PLATFORM[platform].labelAr}.`,
    me?.persona ?? def.persona,
    profile?.guardrails ? `ما لا يُقال أبداً بأمر صاحب العمل: ${profile.guardrails}` : "",
    "",
    doc,
    memory ? `\n${memory}` : "",
    skillsPreamble(skills),
  ].filter(Boolean).join("\n");
}

// ── What the team did ────────────────────────────────────────────
export async function activity(userId: number, platform: SocialPlatform, job: Job, action: string, text: string, ref: Record<string, unknown> | null = null) {
  await db.insert(socialActivityTable).values({ userId, platform, role: roleOf(platform, job), action: action.slice(0, 30), text: text.slice(0, 2000), ref })
    .catch((err) => logger.warn({ err: String(err) }, "social activity log failed"));
}

export async function recentActivity(userId: number, platform: SocialPlatform, limit = 60) {
  return db.select().from(socialActivityTable).where(and(eq(socialActivityTable.userId, userId), eq(socialActivityTable.platform, platform)))
    .orderBy(desc(socialActivityTable.createdAt)).limit(limit);
}

/** Who is on the team, who is on duty, and what each did this week — for the dashboard's team panel. */
export async function teamStatus(userId: number, platform: SocialPlatform) {
  const team = await ensureSocialTeam(userId, platform);
  const byRole = await db.select({ role: socialActivityTable.role, n: sql<number>`count(*)`, last: sql<Date>`max(${socialActivityTable.createdAt})` })
    .from(socialActivityTable)
    .where(and(eq(socialActivityTable.userId, userId), eq(socialActivityTable.platform, platform), sql`${socialActivityTable.createdAt} > now() - interval '7 days'`))
    .groupBy(socialActivityTable.role);
  return teamDefs(platform).map((d) => {
    const e = team.find((x) => x.role === d.role);
    const s = byRole.find((r) => r.role === d.role);
    return { role: d.role, job: d.job, id: e?.id ?? null, name: e?.name ?? d.name, title: e?.title ?? d.title, avatar: e?.avatar ?? d.avatar,
      isActive: e ? !!e.isActive : true, actions7d: Number(s?.n ?? 0), lastAt: s?.last ?? null };
  });
}
