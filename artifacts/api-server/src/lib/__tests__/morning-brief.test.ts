// The morning brief, composed for user 1 from real rows and without sending
// anything: each section appears when it has something and not otherwise;
// the machine's sleep is reported; and the brief is due once a day, from its
// hour until five hours later.

export {};
const { and, eq, inArray } = await import("drizzle-orm");
const { db, waGroupTasksTable, dealsTable, clientMeetingsTable, clientObligationsTable, hostSleepsTable, socialAccountsTable } = await import("@workspace/db");
const { composeBrief, briefDue } = await import("../morning-brief");

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };
const sleepIds: number[] = [];
async function clean() {
  await db.delete(waGroupTasksTable).where(eq(waGroupTasksTable.userId, USER));
  await db.delete(clientMeetingsTable).where(eq(clientMeetingsTable.userId, USER));
  await db.delete(dealsTable).where(eq(dealsTable.userId, USER));
  await db.delete(clientObligationsTable).where(eq(clientObligationsTable.userId, USER));
  await db.delete(socialAccountsTable).where(eq(socialAccountsTable.userId, USER));
  if (sleepIds.length) await db.delete(hostSleepsTable).where(inArray(hostSleepsTable.id, sleepIds));
}
await clean();

const quiet = await composeBrief(USER);
check("a quiet morning has no late or deals section", !quiet.text.includes("متأخر") && !quiet.text.includes("صفقات جديدة"));
check("...but always yesterday's numbers", quiet.text.includes("أمس:"));

await db.insert(waGroupTasksTable).values({ userId: USER, groupJid: "x@g.us", text: "كشف حساب", dueAt: new Date(Date.now() - 3_600_000) });
await db.insert(dealsTable).values({ userId: USER, title: "النور العقارية", channel: "email" } as any);
const in2h = new Date(Date.now() + 2 * 3_600_000);
const gulfHour = (new Date().getUTCHours() + 4) % 24;
if (gulfHour < 21) await db.insert(clientMeetingsTable).values({ userId: USER, name: "أحمد", company: "النور", startsAt: in2h });
await db.insert(clientObligationsTable).values({ userId: USER, clientName: "النور", title: "إقرار VAT", dueDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) });
await db.insert(socialAccountsTable).values({ userId: USER, platform: "tiktok", profile: "tt_desk", username: "procount", state: "restricted" } as any);
const [sl] = await db.insert(hostSleepsTable).values({ seconds: 1_800 }).returning();
sleepIds.push(sl!.id);
const busy = await composeBrief(USER);
check("an overdue request is under late", busy.text.includes("متأخر") && busy.text.includes("طلب عميل متأخر"));
check("a new deal is listed with its channel", busy.text.includes("النور العقارية — البريد"));
if (gulfHour < 21) check("today's meeting is listed", busy.text.includes("اجتماع") && busy.text.includes("أحمد"));
check("a deadline within the week is listed", busy.text.includes("إقرار VAT"));
check("a restricted social account needs the owner", busy.text.includes("تيك توك: مقيَّد"));
check("the machine's sleep is reported", busy.text.includes("الجهاز نام"));

// 05:30 UTC is 09:30 Gulf.
const at = (h: number) => new Date(Date.UTC(2026, 9, 6, h - 4, 30));
const s = { enabled: true, hour: 8, lastSentOn: null as string | null };
check("due once its hour has come", briefDue(s, at(9)) && !briefDue(s, at(7)));
check("late is fine, the evening is not", briefDue(s, at(12)) && !briefDue(s, at(13)));
check("not twice in a day", !briefDue({ ...s, lastSentOn: "2026-10-06" }, at(9)));
check("not when switched off", !briefDue({ ...s, enabled: false }, at(9)));

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
