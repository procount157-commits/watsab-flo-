// Requests as tasks and client deadlines, against the real tables for user 1
// and without a model: requests read from the learning answer (a date only
// when written), a repeat not added twice, finished ones closed by number,
// overdue ones told once; deadlines that remind once inside their window as a
// suggestion in the client's group, roll forward when recurring, and end when
// not — with month ends that do not exist handled.

export {};
const { and, eq, like } = await import("drizzle-orm");
const { db, waGroupTasksTable, clientObligationsTable, waGroupSuggestionsTable } = await import("@workspace/db");
const { parseTasks, applyTasks, openTasks, remindOverdue, TASK_SLA_HOURS } = await import("../groups/tasks");
const { nextDue, reminderText, sweepObligations } = await import("../groups/obligations");

const USER = 1, G = "120363999000777888@g.us";
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };
async function clean() {
  await db.delete(waGroupTasksTable).where(eq(waGroupTasksTable.userId, USER));
  await db.delete(clientObligationsTable).where(eq(clientObligationsTable.userId, USER));
  await db.delete(waGroupSuggestionsTable).where(and(eq(waGroupSuggestionsTable.userId, USER), like(waGroupSuggestionsTable.triggerMessageId, "obl-%")));
}
await clean();

// ── Tasks ────────────────────────────────────────────────────────
const now = new Date("2026-10-05T08:00:00Z");
const p = parseTasks("[الملف]\nx\n[/الملف]\n[طلبات]\n- إرسال كشف حساب بنك الإمارات لشهر سبتمبر | بلا | أحمد\n- تجهيز إقرار ضريبة القيمة المضافة | 2026-10-20 | المدير المالي\n- <ما طلبه>\n- لا يوجد\n[/طلبات]\n[أُنجز]\n2\n[/أُنجز]", now);
check("requests are read, placeholders dropped", p.added.length === 2, JSON.stringify(p.added.map((x) => x.text)));
check("a date is taken only as written", p.added[0]!.due === null && p.added[1]!.due?.toISOString().startsWith("2026-10-20") === true);
check("...and who asked", p.added[0]!.by === "أحمد" && p.added[1]!.by === "المدير المالي");
check("finished ones are read by number", p.done.join(",") === "2");
check("a date long gone is not a due date", parseTasks("[طلبات]\n- طلب قديم جداً هنا | 2020-01-01\n[/طلبات]", now).added[0]!.due === null);

const at = new Date(Date.now() - 3_600_000);
const r1 = await applyTasks(USER, G, [], parseTasks("[طلبات]\n- إرسال كشف حساب بنك الإمارات لشهر سبتمبر | بلا | أحمد\n[/طلبات]"), at);
let open = await openTasks(USER, G);
check("a request becomes an open task due a working day after it was asked", r1.added === 1 && open.length === 1 && Math.round((open[0]!.dueAt!.getTime() - at.getTime()) / 3_600_000) === TASK_SLA_HOURS);
const r2 = await applyTasks(USER, G, open, parseTasks("[طلبات]\n- إرسال كشف حساب بنك الإمارات لشهر سبتمبر | بلا | أحمد\n- موعد مكالمة يوم الخميس | بلا\n[/طلبات]"), at);
open = await openTasks(USER, G);
check("the same request is not added twice", r2.added === 1 && open.length === 2);
const r3 = await applyTasks(USER, G, open, parseTasks("[أُنجز]\n1\n[/أُنجز]"), at);
open = await openTasks(USER, G);
check("a finished one is closed by its number", r3.closed === 1 && open.length === 1 && open[0]!.text.includes("مكالمة"));
await db.update(waGroupTasksTable).set({ dueAt: new Date(Date.now() - 60_000) }).where(eq(waGroupTasksTable.id, open[0]!.id));
const told = await remindOverdue(USER);
const again = await remindOverdue(USER);
check("an overdue task is told once", told === 1 && again === 0);

// ── Deadlines ────────────────────────────────────────────────────
check("monthly from the 31st lands on the month's last day", nextDue("2026-01-31", "monthly") === "2026-02-28");
check("quarterly moves three months", nextDue("2026-09-28", "quarterly") === "2026-12-28");
check("yearly in a leap year", nextDue("2028-02-29", "yearly") === "2029-02-28");
check("a one-off has no next date", nextDue("2026-10-01", "none") === null);
const txt = reminderText({ title: "إقرار VAT الربع الثالث", dueDate: "2026-10-28", documents: "فواتير المبيعات والمشتريات", clientName: "النور" });
check("the reminder says the date and the documents, and no figure of its own", txt.includes("فواتير المبيعات") && !/\d+\s?(درهم|%|غرامة)/.test(txt) && !/AED/i.test(txt));

const day = (offset: number) => new Date(Date.now() + 4 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
const [soon] = await db.insert(clientObligationsTable).values({ userId: USER, groupJid: G, clientName: "النور العقارية", kind: "vat", title: "إقرار VAT", dueDate: day(5), recurrence: "quarterly", remindDays: 7, documents: "الفواتير" }).returning();
const [later] = await db.insert(clientObligationsTable).values({ userId: USER, groupJid: G, clientName: "النور العقارية", kind: "license", title: "تجديد الرخصة", dueDate: day(40), remindDays: 7 }).returning();
const [past] = await db.insert(clientObligationsTable).values({ userId: USER, clientName: "شركة بلا قروب", kind: "ct", title: "ضريبة الشركات", dueDate: day(-2), recurrence: "yearly", remindDays: 7 }).returning();
const [gone] = await db.insert(clientObligationsTable).values({ userId: USER, clientName: "مرة واحدة", kind: "other", title: "تقرير", dueDate: day(-1), remindDays: 3 }).returning();
const s1 = await sweepObligations(new Date(), USER);
const sugg = await db.select().from(waGroupSuggestionsTable).where(and(eq(waGroupSuggestionsTable.userId, USER), like(waGroupSuggestionsTable.triggerMessageId, "obl-%")));
check("inside its window, a reminder waits in the client's group as a suggestion", sugg.length === 1 && sugg[0]!.triggerMessageId === `obl-${soon!.id}-${day(5)}` && sugg[0]!.status === "pending");
check("...and one far off does not yet", !sugg.some((x) => x.triggerMessageId?.startsWith(`obl-${later!.id}-`)));
const [pastNow] = await db.select().from(clientObligationsTable).where(eq(clientObligationsTable.id, past!.id));
check("a recurring deadline that passed moves to its next date", pastNow!.dueDate === nextDue(day(-2), "yearly") && pastNow!.active);
const [goneNow] = await db.select().from(clientObligationsTable).where(eq(clientObligationsTable.id, gone!.id));
check("a one-off that passed ends", goneNow!.active === false && s1.closed === 1);
await sweepObligations(new Date(), USER);
const sugg2 = await db.select().from(waGroupSuggestionsTable).where(and(eq(waGroupSuggestionsTable.userId, USER), like(waGroupSuggestionsTable.triggerMessageId, "obl-%")));
check("a deadline is reminded once, however often the sweep runs", sugg2.length === 1);

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
