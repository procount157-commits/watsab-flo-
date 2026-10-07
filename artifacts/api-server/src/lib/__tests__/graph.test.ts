// The graph's foundations: receipts that cannot be rewritten, the off
// switch that stops an employee's thinking wherever it is called from,
// contracts that hold (no node reviews itself, no side effect without an
// authority), and the goal's pace measured against the owner's anchor.

export {};
const { receipt, graphOf, tokensOf, firstBroken } = await import("../graph/receipts");
const { offDuty, setTeamPaused } = await import("../graph/switch");
const { GRAPHS, contractProblems, WHATSAPP_GRAPH } = await import("../graph/contracts");
const { pace, MEASURES } = await import("../graph/goals");
const { complete } = await import("../llm");
const { asAgent } = await import("../agent-context");
const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };
const U = 1;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Receipts ─────────────────────────────────────────────────────
const before = Number(((await db.execute(sql`SELECT count(*)::int AS n FROM receipts WHERE user_id = ${U}`)).rows[0] as any).n);
receipt({ userId: U, node: "sales", action: "reply", subject: "971500000009", why: "اختبار" });
receipt({ userId: U, node: "email_guard", action: "email.clean", why: "اختبار" });
await wait(400);
const after = Number(((await db.execute(sql`SELECT count(*)::int AS n FROM receipts WHERE user_id = ${U}`)).rows[0] as any).n);
check("a receipt is written for each act", after - before === 2, `${after - before}`);
check("the ledger is intact", (await firstBroken(U)) === null);
const edit = await db.execute(sql`UPDATE receipts SET why = 'تلاعب' WHERE user_id = ${U}`).then(() => "changed", (e) => String(e?.cause?.message ?? e?.message ?? e));
check("a receipt cannot be changed", /append-only/.test(edit), edit.slice(0, 60));
const del = await db.execute(sql`DELETE FROM receipts WHERE user_id = ${U}`).then(() => "deleted", (e) => String(e?.cause?.message ?? e?.message ?? e));
check("...or deleted", /append-only/.test(del));
check("each node lands in its graph", graphOf("ig_writer") === "social" && graphOf("email_guard") === "email" && graphOf("sales") === "whatsapp" && graphOf("chief") === "manager");
check("tokens are estimated from characters when not given", tokensOf(400) === 100);

// ── The off switch ───────────────────────────────────────────────
await db.execute(sql`INSERT INTO business_profile (user_id) VALUES (${U}) ON CONFLICT (user_id) DO NOTHING`);
await setTeamPaused(U, true);
check("with the team paused, every employee is off duty", (await offDuty(U, "sales")) === "الفريق كله موقوف");
const n0 = Number(((await db.execute(sql`SELECT count(*)::int AS n FROM receipts WHERE user_id = ${U} AND action = 'llm.call' AND status = 'blocked'`)).rows[0] as any).n);
const out = await asAgent(U, "sales", () => complete([{ role: "user", content: "مرحبا" }], 5_000));
await wait(300);
const n1 = Number(((await db.execute(sql`SELECT count(*)::int AS n FROM receipts WHERE user_id = ${U} AND action = 'llm.call' AND status = 'blocked'`)).rows[0] as any).n);
check("a paused employee's model call does not happen", out === null);
check("...and leaves a «blocked» receipt saying why", n1 - n0 === 1);
await setTeamPaused(U, false);
check("back on, they may work", (await offDuty(U, "sales")) === null);

// ── Contracts ────────────────────────────────────────────────────
for (const g of GRAPHS) check(`the ${g.id} graph's contracts hold`, contractProblems(g).length === 0, contractProblems(g).join(" · "));
const selfReview = { ...WHATSAPP_GRAPH, nodes: WHATSAPP_GRAPH.nodes.map((n) => n.id === "reviewer" ? { ...n, reviews: ["reviewer"] } : n) };
check("a node that reviews itself is refused", contractProblems(selfReview).some((p) => p.includes("يراجع نفسه")));
const agentSends = { ...WHATSAPP_GRAPH, nodes: WHATSAPP_GRAPH.nodes.map((n) => n.id === "sales" ? { ...n, sideEffect: "idempotent" as const, authorisedBy: "code" as const } : n) };
check("an employee that would send on its own judgement is refused", contractProblems(agentSends).some((p) => p.includes("sales")));
check("every graph is explained in one breath", GRAPHS.every((g) => g.oneBreath.length > 20 && g.oneBreath.length < 220));

// ── Goals ────────────────────────────────────────────────────────
const start = new Date("2026-10-07"), end = new Date("2026-12-31");
const mid = new Date("2026-11-19");
check("just past halfway with eleven done is on track", pace(11, 20, start, end, mid).state === "on_track");
check("halfway with three done is behind", pace(3, 20, start, end, mid).state === "behind");
check("the weekly need is what is left over the time left", pace(3, 20, start, end, mid).perWeek > 2.5);
check("past the deadline short of target is missed", pace(12, 20, start, end, new Date("2027-01-02")).state === "missed");
check("the anchor and the counters are named measures", !!MEASURES["clients_won"] && !!MEASURES["stops"] && !!MEASURES["email_bounce_pct"]);

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
