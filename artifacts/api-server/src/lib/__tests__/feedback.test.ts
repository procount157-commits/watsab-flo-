// Learning from every edit, and the team page, against the real tables for
// user 1 and without a model: an edit that changed nothing counts as sent as
// written; the closest edited cases come back as lessons for the same
// employee and not for another; accuracy and usage add up per employee; the
// employee a model call belongs to is known inside asAgent; and the team page
// sorts people into departments and notices two with one name.

export {};
const { and, eq, like } = await import("drizzle-orm");
const { db, agentFeedbackTable, llmUsageTable, botEmployeesTable } = await import("@workspace/db");
const { recordFeedback, lessonsFor, accuracyByRole, recordUsage, usageByRole, likeness } = await import("../feedback");
const { asAgent, currentAgent } = await import("../agent-context");
const { teamOverview, departmentOf } = await import("../team-overview");

const USER = 1, ROLE = "tt_writer_test", OTHER = "ig_writer_test";
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };
async function clean() {
  await db.delete(agentFeedbackTable).where(and(eq(agentFeedbackTable.userId, USER), like(agentFeedbackTable.role, "%_test")));
  await db.delete(llmUsageTable).where(and(eq(llmUsageTable.userId, USER), like(llmUsageTable.role, "%_test")));
  await db.delete(botEmployeesTable).where(and(eq(botEmployeesTable.userId, USER), like(botEmployeesTable.role, "%_test")));
}
await clean();

check("the same words score 1, unrelated ones 0", likeness("السعر يعتمد على حجم شغلك", "السعر  يعتمد على حجم شغلك") === 1 && likeness("hello there", "مرحبا") === 0);
await recordFeedback({ userId: USER, role: ROLE, channel: "social", kind: "comment", context: "كم سعر المحاسبة الشهرية؟", original: "تواصل معنا", final: "  تواصل   معنا ", verdict: "edited" });
const [same] = await db.select().from(agentFeedbackTable).where(eq(agentFeedbackTable.role, ROLE));
check("an 'edit' that only moved spaces counts as sent as written", same?.verdict === "approved" && same.score === 1);
await recordFeedback({ userId: USER, role: ROLE, channel: "social", kind: "comment", context: "كم سعر المحاسبة الشهرية لشركة عقارات؟", original: "السعر ٥٠٠ درهم", final: "يعتمد على حجم العمل — راسلنا على الخاص ونعطيك التفاصيل", verdict: "edited" });
await recordFeedback({ userId: USER, role: ROLE, channel: "social", kind: "comment", context: "ما شاء الله منشور جميل", original: "شكراً! هل تحتاج خدمات محاسبة؟", verdict: "rejected" });
await recordFeedback({ userId: USER, role: OTHER, channel: "social", kind: "comment", context: "كم سعر المحاسبة الشهرية؟", original: "شيء آخر", final: "درس إنستجرام", verdict: "edited" });
const l = await lessonsFor(USER, ROLE, "بكم المحاسبة الشهرية لشركة عقارات صغيرة؟");
check("the closest edit comes back as a lesson", l.includes("راسلنا على الخاص") && l.indexOf("راسلنا على الخاص") < (l.indexOf("رفض") === -1 ? Infinity : l.indexOf("رفض")));
check("...a rejection is a lesson too", l.includes("رفض ما كتبتَه"));
check("...and another employee's edits are not", !l.includes("درس إنستجرام"));
check("an employee with no edits has no lessons", (await lessonsFor(USER, "nobody_test", "x")) === "");
const acc = (await accuracyByRole(USER)).get(ROLE);
check("accuracy counts sent-as-written, edited and rejected", acc?.approved === 1 && acc.edited === 1 && acc.rejected === 1 && acc.rate === 33, JSON.stringify(acc));

await recordUsage(USER, ROLE, { ok: true, charsIn: 4_000, charsOut: 400, ms: 1_200 });
await recordUsage(USER, ROLE, { ok: false, charsIn: 4_000, charsOut: 0, ms: 20_000 });
const u = (await usageByRole(USER)).get(ROLE);
check("usage adds up per employee per day", u?.calls === 2 && u.failed === 1 && u.tokens === 2_100, JSON.stringify(u));

check("outside asAgent nobody is thinking", currentAgent() === undefined);
const inside = await asAgent(USER, ROLE, async () => { await new Promise((r) => setTimeout(r, 5)); return currentAgent(); });
check("inside asAgent the employee is known, across awaits", inside?.role === ROLE && inside.userId === USER);

check("roles fall into departments", departmentOf("tt_dm") === "tiktok" && departmentOf("email_guard") === "email" && departmentOf("chief") === "core" && departmentOf("groups") === "groups");
await db.insert(botEmployeesTable).values([
  { userId: USER, name: "مكرر", role: "ig_dm_test", kind: "internal", title: "أ", priority: 1 } as any,
  { userId: USER, name: "مكرر", role: "tt_dm_test", kind: "internal", title: "ب", priority: 2 } as any,
]);
const t = await teamOverview(USER);
check("the team page notices two employees with one name", t.people.filter((p: any) => p.name === "مكرر").every((p: any) => p.duplicateName));
check("...and lists departments", t.departments.some((d: any) => d.key === "tiktok") && t.totals.people >= 2);

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
