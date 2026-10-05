// ── A meeting the employees actually have ─────────────────────────
// The message bus produced sixteen messages between the employees with not one
// question or answer among them, and exactly one had ever been read. Every
// path led to the manager and nothing came back. That is a notification log,
// and the owner was right to say they were not talking.
//
// What makes this a discussion rather than a roundup is one rule: each
// employee is given the transcript so far and told to respond to what their
// colleagues said, not only to report their own numbers. The chair then puts a
// pointed question to whoever contradicted someone or left something
// unexplained, and that employee has to answer it.
//
// The output that matters is the decisions. A meeting that ends in a summary
// changes nothing; these end in rules written into the memory of the employee
// they apply to, which are in front of that employee on its very next reply.

import { and, desc, eq, gte, isNotNull, sql, inArray } from "drizzle-orm";
import {
  db, meetingsTable, meetingTurnsTable, botEmployeesTable,
  autoReplyLogTable, contactSegmentsTable, followupDeliberationsTable,
  opsAlertsTable, leadSourcesTable, followUpJobsTable, agentMemoryTable,
  meetingProposalsTable, socialAccountsTable,
  emailMessagesTable,
  type Meeting,
} from "@workspace/db";
import { complete } from "./llm";
import { remember } from "./agent-memory";
import { skillsFor, skillsPreamble } from "./agent-skills";
import { notify, esc } from "./telegram";
import { say } from "./agent-comms";
import { logger } from "./logger";
import { overview as emailOverview } from "./email/service";

export const CHAIR = "chief";

/**
 * How many replies must have a measured outcome before a meeting may decide
 * anything.
 *
 * The first real meeting ran on 42 replies with zero recorded outcomes and
 * produced four standing rules anyway — including one that overrode a
 * deliberately written skill, and one that froze follow-ups by making an
 * employee wait for a report nobody produces. A discussion about numbers that
 * say nothing is still a discussion; it is not grounds for legislating.
 */
export const MIN_EVIDENCE = 6;

/**
 * A decision that changes how the business runs rather than how an employee
 * talks. These become proposals for the owner, never rules that apply
 * themselves — stopping the sending is the owner's call, and an agent that can
 * halt it on a thin argument is a liability however good the argument sounds.
 */
const OPERATIONAL = /(أوقف|توقّف|توقف|تجميد|جمّد|جمد|لا ترسل|لا يرسل|لا تُرسل|امتنع|علّق|نوقف|إيقاف|انتظر تقرير|لا يُوقِف|حتى يصدر|قبل أن يقرأ|خفّض الحد|قلّل الحصة)/;

export function classifyDecision(rule: string): "behaviour" | "operational" {
  return OPERATIONAL.test(rule) ? "operational" : "behaviour";
}

/**
 * Who attends, in speaking order, and what each is there to account for.
 *
 * One voice per channel rather than all twenty-four: the team grew to cover
 * WhatsApp, email and Instagram, and a meeting where everyone speaks is a
 * meeting nobody reads. The briefs ask for a cause rather than a figure —
 * "where is the biggest drop between two steps" produces an argument, while
 * "how many" produces a number already on the agenda in front of everyone.
 *
 * A role an account has not hired is skipped silently, so an owner who never
 * set up Instagram still gets a meeting about what they do run.
 */
const AGENDA_ROLES: Array<{ role: string; brief: string }> = [
  { role: "collector",  brief: "أرقام الوصول والقراءة والتصنيف: ماذا تغيّر عن أمس، وأين أكبر هبوط بين خطوتين متتاليتين." },
  { role: "sales",      brief: "محادثاتك: ما الذي أدّى لاهتمام وما الذي صرف العميل، وبأي كلمات بالضبط." },
  { role: "email",      brief: "البريد: أي عنوان فُتح وأي قطاع ردّ، وما الذي تعلّمتِه من آخر موجة." },
  { role: "ig_manager", brief: "إنستجرام: كم محادثة خاصة بدأت من التعليقات، وأي منشور جلب أسئلة حقيقية لا إعجابات." },
  { role: "followup",   brief: "قراراتك في المتابعة: ماذا أرسلت وماذا أوقفت ولماذا." },
  { role: "ops",        brief: "حالة الرقم: أي خطر حظر، وما الذي قيّدته وعلى أي أساس." },
  { role: "support",    brief: "الشكاوى: ما الذي تكرّر منها، وهل سببه في البيع أم في الخدمة." },
];

// ── The numbers the meeting is called on ─────────────────────────

export type Agenda = Record<string, unknown>;

async function buildAgenda(userId: number): Promise<Agenda> {
  const day = new Date(Date.now() - 24 * 60 * 60_000);
  const [[replies], segs, [delibs], alerts, [leads], [queued], gaps, wins, losses] = await Promise.all([
    db.select({
      replied: sql<number>`count(*) filter (where ${autoReplyLogTable.reply} is not null)`,
      silent:  sql<number>`count(*) filter (where ${autoReplyLogTable.reply} is null)`,
      wins:    sql<number>`count(*) filter (where ${autoReplyLogTable.outcome} in ('win','qualified'))`,
      losses:  sql<number>`count(*) filter (where ${autoReplyLogTable.outcome} in ('loss','quiet'))`,
    }).from(autoReplyLogTable)
      .where(and(eq(autoReplyLogTable.userId, userId), gte(autoReplyLogTable.createdAt, day))),
    db.select({ segment: contactSegmentsTable.segment, n: sql<number>`count(*)` })
      .from(contactSegmentsTable).where(eq(contactSegmentsTable.userId, userId))
      .groupBy(contactSegmentsTable.segment),
    db.select({
      send: sql<number>`count(*) filter (where ${followupDeliberationsTable.verdict} = 'send')`,
      hold: sql<number>`count(*) filter (where ${followupDeliberationsTable.verdict} = 'hold')`,
      drop: sql<number>`count(*) filter (where ${followupDeliberationsTable.verdict} = 'drop')`,
    }).from(followupDeliberationsTable)
      .where(and(eq(followupDeliberationsTable.userId, userId), gte(followupDeliberationsTable.createdAt, day))),
    db.select({ level: opsAlertsTable.level, headline: opsAlertsTable.headline })
      .from(opsAlertsTable)
      .where(and(eq(opsAlertsTable.userId, userId), gte(opsAlertsTable.createdAt, day)))
      .orderBy(desc(opsAlertsTable.createdAt)).limit(3),
    db.select({
      total: sql<number>`count(*)`,
      hot:   sql<number>`count(*) filter (where ${leadSourcesTable.lastIntent} = 'interested')`,
      cold:  sql<number>`count(*) filter (where ${leadSourcesTable.lastIntent} = 'not_interested')`,
    }).from(leadSourcesTable).where(eq(leadSourcesTable.userId, userId)),
    db.select({ n: sql<number>`count(*)` }).from(followUpJobsTable)
      .where(and(eq(followUpJobsTable.userId, userId), eq(followUpJobsTable.status, "pending"))),
    db.select({ q: autoReplyLogTable.incoming, n: sql<number>`count(*)` })
      .from(autoReplyLogTable)
      .where(and(eq(autoReplyLogTable.userId, userId), sql`${autoReplyLogTable.reply} is null`))
      .groupBy(autoReplyLogTable.incoming).orderBy(desc(sql`count(*)`)).limit(5),
    db.select({ incoming: autoReplyLogTable.incoming, reply: autoReplyLogTable.reply })
      .from(autoReplyLogTable)
      .where(and(eq(autoReplyLogTable.userId, userId), inArray(autoReplyLogTable.outcome, ["win", "qualified"])))
      .orderBy(desc(autoReplyLogTable.createdAt)).limit(3),
    db.select({ incoming: autoReplyLogTable.incoming, reply: autoReplyLogTable.reply })
      .from(autoReplyLogTable)
      .where(and(eq(autoReplyLogTable.userId, userId), inArray(autoReplyLogTable.outcome, ["loss", "quiet"])))
      .orderBy(desc(autoReplyLogTable.createdAt)).limit(3),
  ]);

  const em = await emailOverview(userId).catch(() => null);
  return {
    ...(em && em.week.sent > 0 ? { "البريد": { "أُرسل ٧ أيام": em.week.sent, "فتح %": em.week.openRate, "رد %": em.week.replyRate, "ارتداد %": em.week.bounceRate, "ردود اليوم": em.today.replied } } : {}),
    "ردود ٢٤ ساعة": Number(replies?.replied ?? 0),
    "صمت":          Number(replies?.silent ?? 0),
    "أدّى لاهتمام":  Number(replies?.wins ?? 0),
    "أدّى لانصراف": Number(replies?.losses ?? 0),
    "التصنيف":      Object.fromEntries(segs.map((s) => [s.segment, Number(s.n)])),
    "متابعات":      { "للإرسال": Number(delibs?.send ?? 0), "مؤجلة": Number(delibs?.hold ?? 0), "موقوفة": Number(delibs?.drop ?? 0) },
    "منتظرة":       Number(queued?.n ?? 0),
    "العملاء":      { "إجمالي": Number(leads?.total ?? 0), "مهتم": Number(leads?.hot ?? 0), "غير مهتم": Number(leads?.cold ?? 0) },
    "تنبيهات":      alerts.map((a) => `[${a.level}] ${a.headline}`),
    "أسئلة صمت عنها": gaps.filter((g) => g.q).map((g) => `${g.n}× ${g.q}`),
    "ردود نجحت":    wins.map((w) => `«${(w.incoming ?? "").slice(0, 60)}» → «${(w.reply ?? "").slice(0, 120)}»`),
    "ردود فشلت":    losses.map((w) => `«${(w.incoming ?? "").slice(0, 60)}» → «${(w.reply ?? "").slice(0, 120)}»`),
    // Each channel's own figures. Without them the Instagram manager invented
    // a restriction that had never happened and the room built a plan on it:
    // a speaker given nothing about its own channel will fill the gap rather
    // than say it has nothing.
    ...(await channelFacts(userId)),
  };
}

/**
 * What each channel can actually say about itself today.
 *
 * Absent data is reported as absent rather than omitted — "Instagram: never
 * signed in" stops a fabrication that an empty section invites.
 */
async function channelFacts(userId: number): Promise<Record<string, unknown>> {
  const day = new Date(Date.now() - 24 * 60 * 60_000);
  const [desks, social, [mail]] = await Promise.all([
    db.select().from(socialAccountsTable).where(eq(socialAccountsTable.userId, userId)).catch(() => [] as any[]),
    db.execute<any>(sql`SELECT platform,
        (SELECT count(*) FROM social_comments c WHERE c.user_id = ${userId} AND c.platform = a.platform)::int AS comments,
        (SELECT count(*) FROM social_comments c WHERE c.user_id = ${userId} AND c.platform = a.platform AND c.status = 'drafted')::int AS drafted,
        (SELECT count(*) FROM social_comments c WHERE c.user_id = ${userId} AND c.platform = a.platform AND c.is_lead)::int AS leads,
        (SELECT count(*) FROM social_targets t WHERE t.user_id = ${userId} AND t.platform = a.platform AND t.status IN ('sent','invited','replied','declined'))::int AS reached,
        (SELECT count(*) FROM social_targets t WHERE t.user_id = ${userId} AND t.platform = a.platform AND t.status = 'replied')::int AS answered
      FROM social_accounts a WHERE a.user_id = ${userId}`).then((r) => r.rows).catch(() => [] as any[]),
    db.select({
      sent:   sql<number>`count(*) filter (where ${emailMessagesTable.sentAt} >= ${day})`,
      opened: sql<number>`count(*) filter (where ${emailMessagesTable.openedAt} >= ${day})`,
      failed: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'failed' and ${emailMessagesTable.createdAt} >= ${day})`,
      queued: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'queued')`,
    }).from(emailMessagesTable).where(eq(emailMessagesTable.userId, userId)).catch(() => []),
  ]);

  const IG_STATE: Record<string, string> = {
    logged_in: "مسجّل دخول", logged_out: "خارج الجلسة",
    checkpoint: "يطلب تأكيد الهوية", restricted: "مقيَّد", unknown: "لم يُسجَّل دخوله بعد",
  };

  const AR: Record<string, string> = { instagram: "إنستجرام", tiktok: "تيك توك", linkedin: "لينكدإن" };
  const out: Record<string, unknown> = {};
  for (const p of ["instagram", "tiktok", "linkedin"]) {
    const a = desks.find((d) => d.platform === p), f = social.find((x: any) => x.platform === p);
    out[AR[p]!] = !a ? "لم يُضبط بعد — لا بيانات"
      : `${IG_STATE[a.state] ?? a.state}${a.dryRun ? " · وضع التجربة" : ""} · ${Number(f?.comments ?? 0)} تعليق، ${Number(f?.drafted ?? 0)} رد ينتظر الاعتماد، ` +
        `${Number(f?.leads ?? 0)} فرصة، تواصلنا مع ${Number(f?.reached ?? 0)} وردّ ${Number(f?.answered ?? 0)}`;
  }
  return {
    ...out,
    "البريد": `${Number(mail?.sent ?? 0)} أُرسلت اليوم، ${Number(mail?.opened ?? 0)} فُتحت، ` +
      `${Number(mail?.failed ?? 0)} فشلت، ${Number(mail?.queued ?? 0)} في الطابور`,
  };
}

const fmtAgenda = (a: Agenda) =>
  Object.entries(a).map(([k, v]) =>
    Array.isArray(v) ? (v.length ? `${k}:\n  ${v.join("\n  ")}` : "")
    : typeof v === "object" && v ? `${k}: ${Object.entries(v).map(([x, y]) => `${x} ${y}`).join("، ")}`
    : `${k}: ${v}`,
  ).filter(Boolean).join("\n");

// ── Speaking ─────────────────────────────────────────────────────

/** Who is in the room and what each of them is responsible for. */
async function rosterBrief(userId: number): Promise<string> {
  const team = await db.select().from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.isActive, true)));
  const remit: Record<string, string> = {
    chief:     "تدير الفريق وتقرّر",
    sales:     "يحاور العملاء ويبيع",
    support:   "يتعامل مع الشكاوى فقط، ولا يبيع",
    followup:  "يقرّر متى تُرسل رسالة متابعة ومتى تُوقَف",
    collector: "تحلّل الأرقام والتصنيف — لا تراسل أي عميل",
    intake:    "يبني قائمة المتابعة من التصنيف — لا يراسل أي عميل",
    ops:       "يحمي الرقم من الحظر ويتحكّم في سرعة الإرسال — لا يراسل أي عميل",
    monitor:   "يراقب النظام — لا يراسل أي عميل",
  };
  return ["من في الاجتماع وما مسؤولية كل واحد:",
    ...team.map((t) => `- ${t.name}: ${remit[t.role] ?? t.title ?? t.role}`)].join("\n");
}

async function speaker(userId: number, role: string) {
  const [e] = await db.select().from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, role))).limit(1);
  return e ?? null;
}

/** The transcript so far, as a colleague would have heard it. */
function transcript(turns: Array<{ name: string; body: string }>): string {
  return turns.map((t) => `${t.name}: ${t.body}`).join("\n\n");
}

async function speak(opts: {
  userId: number; role: string; instruction: string;
  heard: Array<{ name: string; body: string }>;
  agenda: string;
  roster: string;
  maxLines: number;
}): Promise<string | null> {
  const e = await speaker(opts.userId, opts.role);
  if (!e) return null;

  // The employee brings its own expertise. Its skills are what make its
  // contribution worth hearing rather than a restatement of the numbers.
  const [internal, customer] = await Promise.all([
    skillsFor(opts.userId, opts.role, "internal").catch(() => []),
    skillsFor(opts.userId, opts.role, "interested").catch(() => []),
  ]);
  const expertise = skillsPreamble([
    ...internal,
    ...customer.filter((s) => /التفاوض|احتواء|خريطة/.test(s.name)),
  ]);

  const out = await complete([
    { role: "system", content: [
      `أنت ${e.name}${e.title ? `، ${e.title}` : ""}.`,
      e.persona ?? "",
      expertise,
      "",
      opts.roster,
      "",
      "أنت في اجتماع فريق. اقرأ ما قاله زملاؤك قبلك ورُدّ عليه — لا تُعد سرد أرقامك فقط.",
      "إن اختلفت مع أحدهم فقل ذلك باسمه وبسبب. إن سبّب لك أحدهم مشكلة فقلها.",
      `${opts.maxLines} أسطر كحد أقصى. بلا ترقيم وبلا عناوين. تكلّم كما يتكلّم موظف في اجتماع.`,
      "لا تجامل ولا تختم بعبارات مثل «شكراً» أو «في الختام».",
      "",
      // In the first meeting with all three channels present, the Instagram
      // manager announced that the account had been restricted after five
      // warnings. None of it had happened — the account has never been signed
      // in — and three colleagues then built a plan around it. A fabricated
      // number is worse here than in a reply, because the room repeats it.
      "لا تذكر رقماً ولا حالةً ولا حدثاً ليس في الأرقام المعطاة لك أعلاه.",
      "إن لم تكن قناتك مذكورة في الأرقام فقل «لا بيانات عن قناتي اليوم» — ولا تفترض ما حدث فيها.",
      "وإن ذكر زميلك رقماً لا تراه في الأرقام، فاسأله من أين جاء بدل أن تبني عليه.",
      "",
      opts.instruction,
    ].filter(Boolean).join("\n") },
    { role: "user", content: [
      `— أرقام اليوم —\n${opts.agenda}`,
      opts.heard.length ? `\n— ما قيل في الاجتماع حتى الآن —\n${transcript(opts.heard)}` : "",
    ].filter(Boolean).join("\n") },
  ]);
  return out?.text?.trim() ?? null;
}

async function record(
  userId: number, meetingId: number, seq: number, role: string,
  kind: string, body: string, inReplyTo?: number,
): Promise<number> {
  const [row] = await db.insert(meetingTurnsTable)
    .values({ meetingId, userId, seq, role, kind, body, inReplyTo: inReplyTo ?? null })
    .returning();
  return row!.id;
}

// ── The meeting ──────────────────────────────────────────────────

export async function runMeeting(userId: number, kind: "daily" | "pipeline" | "postmortem" = "daily") {
  const agenda = await buildAgenda(userId);
  const agendaText = fmtAgenda(agenda);
  const roster = await rosterBrief(userId);

  // Outcomes, not replies. Forty-two replies nobody reacted to tell you
  // nothing about which of them worked.
  const evidence = Number(agenda["أدّى لاهتمام"] ?? 0) + Number(agenda["أدّى لانصراف"] ?? 0);
  const couldDecide = evidence >= MIN_EVIDENCE;

  const chair = await speaker(userId, CHAIR);
  if (!chair) return { error: "لا يوجد مدير يرأس الاجتماع" };

  const title = kind === "daily" ? "اجتماع الفريق اليومي"
    : kind === "pipeline" ? "مراجعة خط المبيعات" : "مراجعة ما لم ينجح";

  const [meeting] = await db.insert(meetingsTable)
    .values({ userId, kind, title, agenda: agenda as any, evidenceCount: evidence, couldDecide }).returning();
  const id = meeting!.id;

  const heard: Array<{ name: string; body: string }> = [];
  let seq = 0;

  // 1. The chair opens, naming what this meeting is about rather than reading
  //    the numbers back — everyone has them.
  const opening = await speak({
    userId, role: CHAIR, agenda: agendaText, roster, heard, maxLines: 3,
    instruction: "أنت ترأسين الاجتماع. افتحيه بتحديد أهم شيء في أرقام اليوم يستحق النقاش، وسؤال واحد تريدين الإجابة عنه قبل نهاية الاجتماع. لا تسردي الأرقام — الجميع يراها.",
  });
  if (opening) { await record(userId, id, ++seq, CHAIR, "open", opening); heard.push({ name: chair.name, body: opening }); }

  // 2. Each employee speaks, having read the ones before it.
  for (const { role, brief } of AGENDA_ROLES) {
    const e = await speaker(userId, role);
    if (!e || !e.isActive) continue;
    const body = await speak({
      userId, role, agenda: agendaText, roster, heard, maxLines: 4,
      instruction: `دورك الآن. ${brief}\nرُدّ على ما قاله من سبقك إن كان يخصّك، ولا تكرّر كلامه.`,
    });
    if (!body) continue;
    await record(userId, id, ++seq, role, "report", body);
    heard.push({ name: e.name, body });
  }

  // 3. The chair puts one question to one employee. A meeting where nobody is
  //    asked anything is a status page.
  const q = await speak({
    userId, role: CHAIR, agenda: agendaText, roster, heard, maxLines: 2,
    instruction: [
      "اختاري موظفاً واحداً قال شيئاً يحتاج توضيحاً أو ناقض زميله، واسأليه سؤالاً محدداً واحداً.",
      "اكتبي بهذا الشكل بالضبط ولا شيء غيره:",
      "إلى: <اسم الموظف>",
      "السؤال: <سؤال واحد>",
    ].join("\n"),
  });

  let asked: string | null = null;
  let questionId: number | undefined;
  if (q) {
    const target = /(?:إلى|الموظف)\s*[:：]\s*(.+)/.exec(q)?.[1]?.trim();
    const text = /(?:السؤال|سؤال)\s*[:：]\s*([\s\S]+)/.exec(q)?.[1]?.trim();
    if (!target || !text) {
      logger.warn({ userId, got: q.slice(0, 120) }, "لم يُفهم سؤال المديرة — تخطّي خطوة السؤال");
    }
    if (target && text) {
      const team = await db.select().from(botEmployeesTable).where(eq(botEmployeesTable.userId, userId));
      const match = team.find((t) => target.includes(t.name) || t.name.includes(target));
      if (!match) logger.warn({ userId, target }, "المديرة سألت موظفاً غير موجود");
      if (match) {
        asked = match.role;
        questionId = await record(userId, id, ++seq, CHAIR, "question", `${match.name}، ${text}`);
        heard.push({ name: chair.name, body: `${match.name}، ${text}` });

        const answer = await speak({
          userId, role: match.role, agenda: agendaText, roster, heard, maxLines: 3,
          instruction: `${chair.name} سألتك سؤالاً مباشراً. أجب عنه تحديداً، ولا تتهرّب ولا تُعد ما قلته سابقاً.`,
        });
        if (answer) {
          await record(userId, id, ++seq, match.role, "answer", answer, questionId);
          heard.push({ name: match.name, body: answer });
        }
      }
    }
  }

  // 4. Decisions. This is the only part that changes anything.
  const closing = await speak({
    userId, role: CHAIR, agenda: agendaText, roster, heard, maxLines: 6,
    instruction: !couldDecide ? [
      "أغلقي الاجتماع بلا قرارات.",
      `عدد الردود التي لها نتيجة مقيسة اليوم ${evidence} فقط، وهذا أقل من أن يُبنى عليه قرار.`,
      "اكتبي بهذا الشكل بالضبط:",
      "الخلاصة: <سطران: ما نوقشه، ولماذا لا يكفي لاتخاذ قرار>",
      "نحتاج: <ما الذي يلزم جمعه قبل الاجتماع القادم لنقرر، سطر واحد>",
      "",
      "لا تكتبي أي سطر يبدأ بـ«قرار». الانضباط هنا أهم من أن تبدو الاجتماعات مثمرة.",
    ].join("\n") : [
      "أغلقي الاجتماع. اكتبي بهذا الشكل بالضبط:",
      "الخلاصة: <سطران عمّا اتُّفق عليه>",
      "قرار لـ<اسم الموظف>: <سلوك محدد يفعله أو يتوقف عنه، سطر واحد>",
      "",
      "ثلاثة قرارات كحد أقصى، ولكل قرار موظف واحد باسمه.",
      "القرار سلوك يُنفَّذ لا نصيحة: «لا تذكر السعر قبل أن يخبرك بحجمه» لا «كن أكثر احترافية».",
      "لا تُصدري قراراً لا يسنده شيء قيل في الاجتماع.",
      // She assigned a sales decision to the data analyst and a support
      // decision to operations, because nothing told her what they do.
      "لكل قرار موظفٌ مسؤوليته تشمله. لا تعطي قراراً عن مراسلة العملاء لمن لا يراسل أحداً،",
      "ولا قراراً عن الشكاوى لغير المسؤول عنها. راجعي قائمة المسؤوليات أعلاه قبل أن تكتبي.",
      // She overrode the discovery skill — which names the licence question as
      // the most important one — on the basis of a conversation about numbers
      // with no outcomes in them.
      "لا تنقضي مهارة مكتوبة للفريق إلا بدليل من ردود لها نتيجة مقيسة. المهارات وُضعت عن دراسة،",
      "ورأيٌ في اجتماع واحد لا يكفي لإلغائها.",
      "القرار يخصّ كيف يتكلّم الموظف. إيقاف الإرسال أو تجميد المتابعة ليس قرارك — إن رأيتِه لازماً",
      "فاكتبيه كقرار عادي وسيُعرض على صاحب العمل، ولن يُطبَّق قبل موافقته.",
    ].join("\n"),
  });

  const decisions: Array<{ role: string; name: string; rule: string; status: string }> = [];
  let summary = "";
  if (closing) {
    await record(userId, id, ++seq, CHAIR, "decide", closing);
    summary = /الخلاصة\s*[:：]\s*(.+?)(?=\nقرار|$)/s.exec(closing)?.[1]?.trim() ?? closing.slice(0, 400);

    const team = await db.select().from(botEmployeesTable).where(eq(botEmployeesTable.userId, userId));
    for (const line of closing.split("\n")) {
      const m = /قرار\s*(?:لـ|ل)\s*([^:：]+)\s*[:：]\s*(.+)/.exec(line);
      if (!m) continue;
      const who = team.find((t) => m[1]!.includes(t.name));
      if (!who || decisions.length >= 3) continue;
      // A rule about how to word a customer message is meaningless for someone
      // who never writes one, and would sit in their prompt for good.
      //
      // The real fix is the roster in the closing prompt — she assigns badly
      // when she does not know who does what. This is a narrow backstop, and
      // deliberately narrow: a first version matched any rule containing
      // "يرسل" and threw away a correct instruction to operations to check
      // number quality *before* anything is sent. It now only catches rules
      // about composing a message, which is the case that was actually wrong.
      const aboutWording = /(صياغة|التحية|تحيّ|اذكر السعر|لا تذكر السعر|اعتذار|نص الرسالة|أول سؤال|اسأل العميل)/.test(m[2]!);
      const talksToCustomers = ["sales", "support", "chief", "followup"].includes(who.role);
      if (aboutWording && !talksToCustomers) {
        logger.warn({ userId, role: who.role, rule: m[2]!.slice(0, 80) },
          "قرار عن مراسلة العملاء أُسنِد لمن لا يراسلهم — أُسقط");
        continue;
      }
      const rule = m[2]!.trim();

      if (classifyDecision(rule) === "operational") {
        // Stopping the business is the owner's call. The agents may argue for
        // it — they may not do it.
        await db.insert(meetingProposalsTable).values({
          userId, meetingId: id, role: who.role, roleName: who.name, rule,
          reason: "يغيّر تشغيل الإرسال أو المتابعة — يحتاج موافقتك",
        });
        decisions.push({ role: who.role, name: who.name, rule, status: "معلّق بانتظار موافقتك" });
        logger.info({ userId, role: who.role }, "قرار تشغيلي — عُرض على صاحب العمل ولم يُطبَّق");
        continue;
      }

      decisions.push({ role: who.role, name: who.name, rule, status: "طُبِّق" });
      // A behaviour decision lands in that employee's own memory, which is what
      // makes a meeting change anything instead of producing minutes.
      await remember(userId, who.role, "instruction", rule);
      await say({ userId, fromRole: CHAIR, toRole: who.role, kind: "directive",
        body: `قرار اجتماع اليوم: ${rule}` }).catch(() => {});
    }
  }

  await db.update(meetingsTable)
    .set({ summary, decisions: decisions as any, status: "done", endedAt: new Date() })
    .where(eq(meetingsTable.id, id));

  if (decisions.length > 0) {
    await notify(userId, [
      `<b>🗓️ ${esc(title)}</b>`, "",
      esc(summary), "",
      "<b>القرارات:</b>",
      ...decisions.map((d) => `• <b>${esc(d.name)}</b>: ${esc(d.rule)}` +
        (d.status.startsWith("معلّق") ? "\n  <i>⏸ ينتظر موافقتك</i>" : "")),
    ].join("\n")).catch(() => {});
  }

  logger.info({ userId, meetingId: id, turns: seq, evidence, couldDecide,
    applied: decisions.filter((d) => d.status === "طُبِّق").length,
    proposed: decisions.filter((d) => d.status !== "طُبِّق").length, asked },
    "انتهى اجتماع الفريق");
  return { id, title, turns: seq, summary, decisions, evidence, couldDecide };
}

export async function meetingWithTurns(userId: number, id: number) {
  const [m] = await db.select().from(meetingsTable)
    .where(and(eq(meetingsTable.id, id), eq(meetingsTable.userId, userId))).limit(1);
  if (!m) return null;
  const turns = await db.select().from(meetingTurnsTable)
    .where(eq(meetingTurnsTable.meetingId, id)).orderBy(meetingTurnsTable.seq);
  return { ...m, turns };
}

export async function recentMeetings(userId: number, limit = 10): Promise<Meeting[]> {
  return db.select().from(meetingsTable).where(eq(meetingsTable.userId, userId))
    .orderBy(desc(meetingsTable.startedAt)).limit(limit);
}

/**
 * One meeting a day, in the evening.
 *
 * Gated on the hour rather than a timer set for it, so a process restarted at
 * 20:30 does not skip the day.
 */
export function startMeetings(): void {
  const HOUR = 20;   // Gulf time
  let lastDay = "";
  const sweep = async () => {
    const gulf = new Date(Date.now() + 4 * 60 * 60_000);
    const day = gulf.toISOString().slice(0, 10);
    if (gulf.getUTCHours() !== HOUR || day === lastDay) return;
    lastDay = day;
    const accounts = await db.selectDistinct({ userId: botEmployeesTable.userId }).from(botEmployeesTable);
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    for (const { userId } of accounts) {
      // A day with no customer contact has nothing to meet about, and a
      // meeting held anyway costs nine model calls to say so.
      const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(autoReplyLogTable)
        .where(and(eq(autoReplyLogTable.userId, userId), gte(autoReplyLogTable.createdAt, since)));
      if (Number(n) === 0) { logger.info({ userId }, "لا اجتماع اليوم — لا نشاط"); continue; }
      await runMeeting(userId, "daily").catch((err) =>
        logger.error({ userId, err: String(err?.message ?? err) }, "فشل اجتماع الفريق"));
    }
  };
  setTimeout(() => { void sweep(); setInterval(() => void sweep(), 30 * 60_000); }, 5 * 60_000);
  logger.info({ hour: HOUR }, "اجتماع الفريق اليومي مجدول");
}
