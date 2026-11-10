// ── Scheduled work an employee does on its own ────────────────────
// Grok Bot calls these routines: a name, an instruction, and a trigger. The
// monitor's twenty-minute sweep was the only scheduled thing here and its
// interval lived in the source, so the owner could not add "every morning,
// list the leads who went quiet" without a deploy.
//
// A routine is not a reply. Nothing it produces is sent to a customer: it
// writes into the employee's own memory, or reports to the owner. That
// boundary is deliberate — scheduled work that could message customers is how
// an account sends three hundred unprompted messages at 4am.

import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  db, agentRoutinesTable, agentRoutineRunsTable, botEmployeesTable,
  autoReplyLogTable, leadSourcesTable, followUpJobsTable,
  type AgentRoutine,
} from "@workspace/db";
import { complete } from "./llm";
import { remember, memoryPreamble } from "./agent-memory";
import { logger } from "./logger";
import { asWorker } from "./agent-context";
import { accountHalted } from "./org/controls";
import { everyMs } from "./org/workers";

/** Gulf time, which is what the owner means by "in the morning". */
const TZ_OFFSET_HOURS = 4;
const gulfHour = (d = new Date()) => (d.getUTCHours() + TZ_OFFSET_HOURS) % 24;

/**
 * Is this routine due?
 *
 * A daily routine fires once inside its hour; an interval routine fires when
 * enough time has passed. Exported so a test can check the decision without a
 * clock or a model.
 */
export function isDue(r: Pick<AgentRoutine, "triggerKind" | "everyMinutes" | "atHour" | "lastRunAt" | "isActive">, now = new Date()): boolean {
  if (!r.isActive) return false;
  const last = r.lastRunAt ? new Date(r.lastRunAt).getTime() : 0;

  if (r.triggerKind === "daily") {
    if (r.atHour === null || r.atHour === undefined) return false;
    if (gulfHour(now) !== r.atHour) return false;
    // Once per day, not once per sweep inside the hour.
    return now.getTime() - last > 23 * 60 * 60_000;
  }

  const every = Math.max(5, r.everyMinutes ?? 60);
  return now.getTime() - last >= every * 60_000;
}

/**
 * Facts a routine can reason about.
 *
 * Deliberately a fixed, small set rather than letting a routine query freely:
 * an instruction the owner wrote in Arabic should not be able to reach
 * arbitrary rows, and everything here is already on their dashboard.
 */
async function situation(userId: number): Promise<string> {
  const day = new Date(Date.now() - 24 * 60 * 60_000);
  const [[replies], gaps, [leads], [queued], recent] = await Promise.all([
    db.select({
      replied: sql<number>`count(*) filter (where ${autoReplyLogTable.reply} is not null)`,
      silent:  sql<number>`count(*) filter (where ${autoReplyLogTable.reply} is null)`,
      wins:    sql<number>`count(*) filter (where ${autoReplyLogTable.outcome} = 'win')`,
      losses:  sql<number>`count(*) filter (where ${autoReplyLogTable.outcome} = 'loss')`,
    }).from(autoReplyLogTable)
      .where(and(eq(autoReplyLogTable.userId, userId), gte(autoReplyLogTable.createdAt, day))),
    db.select({ q: autoReplyLogTable.incoming, n: sql<number>`count(*)` })
      .from(autoReplyLogTable)
      .where(and(eq(autoReplyLogTable.userId, userId), isNull(autoReplyLogTable.reply),
                 sql`${autoReplyLogTable.skipped} ~ 'لا توجد معلومة|تطابق ضعيف|بالإنجليزية|تعليمات للبوت'`))
      .groupBy(autoReplyLogTable.incoming).orderBy(desc(sql`count(*)`)).limit(8),
    db.select({
      total: sql<number>`count(*)`,
      hot:   sql<number>`count(*) filter (where ${leadSourcesTable.lastIntent} = 'interested')`,
      cold:  sql<number>`count(*) filter (where ${leadSourcesTable.lastIntent} = 'not_interested')`,
    }).from(leadSourcesTable).where(eq(leadSourcesTable.userId, userId)),
    db.select({ n: sql<number>`count(*)` }).from(followUpJobsTable)
      .where(and(eq(followUpJobsTable.userId, userId), eq(followUpJobsTable.status, "pending"))),
    db.select({ incoming: autoReplyLogTable.incoming, reply: autoReplyLogTable.reply, outcome: autoReplyLogTable.outcome })
      .from(autoReplyLogTable)
      .where(and(eq(autoReplyLogTable.userId, userId), isNotNull(autoReplyLogTable.reply)))
      .orderBy(desc(autoReplyLogTable.createdAt)).limit(10),
  ]);

  const lines = [
    `آخر ٢٤ ساعة: ${Number(replies?.replied ?? 0)} رد، ${Number(replies?.silent ?? 0)} صمت، ` +
    `${Number(replies?.wins ?? 0)} أدّى لاهتمام، ${Number(replies?.losses ?? 0)} أدّى لانصراف.`,
    `العملاء: ${Number(leads?.total ?? 0)} إجمالاً، ${Number(leads?.hot ?? 0)} مهتم، ${Number(leads?.cold ?? 0)} غير مهتم.`,
    `متابعات في الانتظار: ${Number(queued?.n ?? 0)}.`,
  ];
  if (gaps.length) {
    lines.push("أسئلة لم يُجَب عنها:", ...gaps.filter((g) => g.q).map((g) => `- ${g.n}× «${g.q}»`));
  }
  if (recent.length) {
    lines.push("آخر الردود ونتائجها:", ...recent.map((r) =>
      `- «${(r.incoming ?? "").slice(0, 70)}» → «${(r.reply ?? "").slice(0, 90)}»` +
      (r.outcome ? ` [${r.outcome === "win" ? "أدّى لاهتمام" : "أدّى لانصراف"}]` : "")));
  }
  return lines.join("\n");
}

/**
 * Carry out one routine, in the voice of the employee who owns it.
 *
 * The output is stored, not sent. When the instruction produces a rule the
 * employee should follow from now on, it is also written into that employee's
 * memory as a standing instruction — which is how a routine changes behaviour
 * rather than just filing a report.
 */
export async function runRoutine(r: AgentRoutine): Promise<{ output?: string; error?: string }> {
  const [emp] = await db.select().from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, r.userId), eq(botEmployeesTable.role, r.role))).limit(1);

  const [facts, mem] = await Promise.all([
    situation(r.userId),
    memoryPreamble(r.userId, r.role),
  ]);

  const system = [
    emp ? `أنت ${emp.name}${emp.title ? `، ${emp.title}` : ""}.` : "",
    emp?.persona ? `شخصيتك: ${emp.persona}` : "",
    mem,
    "",
    "هذه مهمة دورية تؤديها بنفسك، لا محادثة مع عميل. لا تكتب رسالة موجَّهة لعميل.",
    "اكتب بالعربية، موجزاً ومحدداً. إن لم تجد ما يستحق الذكر فقل ذلك بسطر واحد.",
    "إن توصّلت إلى قاعدة يجب أن تلتزم بها من الآن، اكتبها في آخر ردك بهذا الشكل بالضبط:",
    "قاعدة: <القاعدة في سطر واحد>",
  ].filter(Boolean).join("\n");

  const out = await asWorker(r.userId, r.role, () => complete([
    { role: "system", content: system },
    { role: "user", content: `${r.instruction}\n\n— الوضع الحالي —\n${facts}` },
  ]));

  if (!out?.text) {
    return { error: "تعذّر الوصول إلى النموذج" };
  }

  // Any rule it committed to becomes a standing instruction it will carry into
  // every future conversation.
  for (const line of out.text.split("\n")) {
    const m = /^\s*قاعدة\s*[:：]\s*(.+)$/.exec(line);
    if (m?.[1]) await remember(r.userId, r.role, "instruction", m[1], undefined, { pending: true });
  }

  return { output: out.text };
}

/** Every routine that is due, across all accounts. Called by the scheduler. */
export async function runDueRoutines(now = new Date()): Promise<number> {
  const all = await db.select().from(agentRoutinesTable)
    .where(eq(agentRoutinesTable.isActive, true))
    .orderBy(asc(agentRoutinesTable.lastRunAt));

  let ran = 0;
  for (const r of all) {
    if (!isDue(r, now)) continue;
    // Before the stamp: a routine that falls due while the account is stopped runs when it returns.
    if (await accountHalted(r.userId, "routines")) continue;
    // Stamped before the work, not after: a routine whose model call hangs for
    // two minutes must not be picked up again by the next sweep.
    await db.update(agentRoutinesTable).set({ lastRunAt: now })
      .where(eq(agentRoutinesTable.id, r.id));

    try {
      const res = await runRoutine(r);
      await db.insert(agentRoutineRunsTable).values({
        routineId: r.id, userId: r.userId,
        output: res.output ?? null, error: res.error ?? null,
      });
      logger.info({ userId: r.userId, routine: r.name, ok: !res.error }, "نُفِّذت مهمة دورية");
    } catch (err: any) {
      await db.insert(agentRoutineRunsTable).values({
        routineId: r.id, userId: r.userId, error: String(err?.message ?? err).slice(0, 500),
      });
      logger.error({ userId: r.userId, routine: r.name, err: String(err?.message ?? err) }, "فشلت مهمة دورية");
    }
    ran++;
  }
  return ran;
}

/** Suggested starting routines, in the owner's own terms. */
export const ROUTINE_TEMPLATES = [
  {
    name: "مراجعة ما فاتني",
    instruction: "راجع الأسئلة التي لم يُجَب عنها، ورتّبها بالأهم. قل لصاحب العمل ما المعلومة الناقصة التي لو أضافها لأجبت عن أكثرها.",
    triggerKind: "daily" as const, atHour: 9,
  },
  {
    name: "ماذا نجح وماذا فشل",
    instruction: "انظر في ردودك ونتائجها، وحدّد ما الذي يقود العميل للاهتمام وما الذي ينفّره. استخرج قاعدة واحدة واضحة تلتزم بها.",
    triggerKind: "daily" as const, atHour: 21,
  },
  {
    name: "العملاء الذين بردوا",
    instruction: "من العملاء المهتمين، من الذي توقف عن الرد؟ اقترح لصاحب العمل من يستحق متابعة شخصية منه لا من البوت.",
    triggerKind: "interval" as const, everyMinutes: 720,
  },
] as const;

/**
 * Sweep for due routines every five minutes.
 *
 * Five rather than one: the finest trigger is "every 5 minutes", and a sweep
 * that runs more often than the shortest trigger only costs queries. The first
 * sweep waits two minutes so it never races session restore on boot.
 */
export function startRoutineScheduler(): void {
  const SWEEP_MS = 5 * 60_000;
  const sweep = () => runDueRoutines().catch((err) => {
    logger.error({ err: String(err?.message ?? err) }, "فشل مرور المهام الدورية");
    throw err;
  });

  everyMs("agent.routines", SWEEP_MS, sweep, { firstMs: 2 * 60_000 });
  logger.info({ sweepMin: SWEEP_MS / 60_000 }, "مجدول المهام الدورية بدأ");
}
