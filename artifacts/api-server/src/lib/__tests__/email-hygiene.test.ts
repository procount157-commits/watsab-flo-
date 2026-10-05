// List hygiene against the real tables for user 1: the risk of each address
// (role addresses low, a personal mailbox where another bounced high), the
// send order lowest-risk first with the riskiest held, a real DNS lookup
// marking a dead domain, a list cleaned of what cannot arrive, and the
// warm-up schedule.

export {};
const { and, eq, like } = await import("drizzle-orm");
const { db, emailContactsTable, emailListsTable, emailListMembersTable } = await import("@workspace/db");
const { riskOf, byRisk, domainSignals, verifyDomains, hygieneReport, cleanList, warmupPlan } = await import("../email/hygiene");

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };
async function clean() {
  await db.delete(emailListsTable).where(and(eq(emailListsTable.userId, USER), like(emailListsTable.name, "اختبار النظافة%")));
  await db.delete(emailContactsTable).where(and(eq(emailContactsTable.userId, USER), like(emailContactsTable.source, "hygiene-test%")));
}
await clean();

const sig = new Map([["bigbroker.ae", { n: 40, bounced: 1 }], ["huge.ae", { n: 30, bounced: 0 }], ["small.ae", { n: 2, bounced: 0 }]]);
const c = (email: string, extra: any = {}) => ({ email, mxOk: true, status: "active", ...extra });
check("a role address is low risk even at a domain that bounced", riskOf(c("info@bigbroker.ae"), sig) === "low");
check("a personal mailbox where another bounced is high risk", riskOf(c("ahmed@bigbroker.ae"), sig) === "high");
check("a personal mailbox at a large company is medium", riskOf(c("sara@huge.ae"), sig) === "medium");
check("a personal mailbox at a small company is low", riskOf(c("omar@small.ae"), sig) === "low");
check("a dead domain is high risk", riskOf(c("x@dead.ae", { mxOk: false }), sig) === "high");
const ordered = byRisk([c("ahmed@bigbroker.ae"), c("sara@huge.ae"), c("info@bigbroker.ae")], sig, true);
check("the riskiest are held and the rest go lowest-risk first", ordered.held === 1 && ordered.kept.map((x) => x.email).join(",") === "info@bigbroker.ae,sara@huge.ae");
check("...and nothing is held when the owner switches it off", byRisk([c("ahmed@bigbroker.ae")], sig, false).held === 0);

const [list] = await db.insert(emailListsTable).values({ userId: USER, name: "اختبار النظافة" } as any).returning();
const rows = await db.insert(emailContactsTable).values([
  { userId: USER, email: "info@gmail.com", source: "hygiene-test" },
  { userId: USER, email: "someone@no-such-domain-flowhub-test-9341.ae", source: "hygiene-test" },
  { userId: USER, email: "gone@gmail.com", source: "hygiene-test", status: "bounced" },
] as any).returning();
await db.insert(emailListMembersTable).values(rows.map((r) => ({ listId: list!.id, contactId: r.id })));
const v = await verifyDomains(USER, rows.map((r) => r.id));
const after = await db.select().from(emailContactsTable).where(like(emailContactsTable.source, "hygiene-test%"));
check("a real lookup marks a domain with no mail server dead", after.find((x) => x.email.includes("no-such-domain"))?.mxOk === false, JSON.stringify(v));
check("...and one with a mail server alive, with the time it was checked", after.find((x) => x.email === "info@gmail.com")?.mxOk === true && !!after.find((x) => x.email === "info@gmail.com")?.mxCheckedAt);
const rep = await hygieneReport(USER, list!.id);
check("the list's report counts dead domains and bounces", rep.total === 3 && rep.deadDomain === 1 && rep.bounced === 1 && rep.role === 1 && rep.personal === 1, JSON.stringify({ t: rep.total, d: rep.deadDomain, b: rep.bounced, r: rep.role }));
const cl = await cleanList(USER, list!.id);
check("cleaning takes out the dead and the bounced, and keeps the rest", cl.removed === 2 && cl.kept === 1);
check("...who stay in the account's records", (await db.select().from(emailContactsTable).where(like(emailContactsTable.source, "hygiene-test%"))).length === 3);
check("domain signals count contacts per domain", ((await domainSignals(USER)).get("gmail.com")?.bounced ?? 0) >= 1);

const plan = warmupPlan(300, 0, true, 14);
check("the warm-up starts at 50 and grows to the cap", plan[0]!.cap === 50 && plan[plan.length - 1]!.cap === 300 && plan.every((p, i) => i === 0 || p.cap >= plan[i - 1]!.cap));
check("...and is the cap itself when switched off", warmupPlan(300, 0, false, 3).every((p) => p.cap === 300));

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
