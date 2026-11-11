// السيناريو التجريبي والمحاكاة على القنوات الحقيقية، وإقصاء المحاكى من الأرقام، وخروج واتساب.
// قاعدة الاختبار وحدها، بلا شبكة: المزوّدون يرفضون وكل fetch يُعدّ.
//   DATABASE_URL=postgres://t:t@127.0.0.1:55444/t npx tsx src/lib/__tests__/org-e2e.test.ts
export {};
if (!/127\.0\.0\.1:(55449|55447|55445|55444|55440)/.test(process.env["DATABASE_URL"] ?? "")) { console.error("على قاعدة الاختبار وحدها"); process.exit(1); }

let fetched = 0;
globalThis.fetch = (async (url: any) => { fetched++; throw new Error(`no network in this test: ${url}`); }) as any;
process.env["GEMINI_API_KEY"] = "test-key";
process.env["GROQ_API_KEY"] = "test-key";

const { db, emailSettingsTable } = await import("@workspace/db");
const { sql, eq } = await import("drizzle-orm");
const SIM = await import("../org/simulation");
const E = await import("../org/sandbox-e2e");
const { ensureSimTables } = await import("../org/sim-schema");
const { forgetControls } = await import("../org/controls");
const { sendEmail, EmailHalted } = await import("../email/provider");
const { driverFor, DRIVERS } = await import("../social/drivers");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};
const A = 7, B = 8;
await ensureSimTables();
const clean = async () => {
  for (const t of ["sim_e2e_runs", "sim_fixtures", "employee_tasks", "org_audit_log", "executive_reports", "receipts", "employee_heartbeats", "employee_executions", "wa_session_events", "notify_outbox", "telegram_settings", "email_settings", "org_controls", "employee_scorecards", "bot_employees", "agent_tasks"]) {
    await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${A}, ${B})`)).catch(() => {});
  }
  forgetControls();
};
await clean();

// ── كل قناة لا ترسل شيئاً في المحاكاة ─────────────────────────────
await db.insert(emailSettingsTable).values({ userId: A, provider: "resend", apiKey: "k", fromEmail: "owner@a.example" }).onConflictDoNothing();
const [settings] = await db.select().from(emailSettingsTable).where(eq(emailSettingsTable.userId, A));
const mail = { subject: "s", html: "<p>x</p>", text: "x", messageId: "<m@a>", unsubscribeUrl: null };

const { sendMessage, waManager, WhatsAppInstance } = await import("../whatsapp");
const inst: any = Object.create(WhatsAppInstance.prototype);
Object.assign(inst, { userId: A, state: {}, log: { info() {}, warn() {}, error() {} }, pendingSendAborts: new Map(), socketGeneration: 1, rememberSent() {}, recordOutbound() {} });
(waManager as any).instances.set(A, inst);
const wired: any[] = [];
inst.state.socket = { ws: { readyState: 1 }, onWhatsApp: async () => [{ exists: true }], sendPresenceUpdate: async () => {}, sendMessage: async (jid: string, body: any) => { wired.push({ jid, body }); return { key: { id: "fake" } }; }, readMessages: async () => {} };
inst.state.connected = true; inst.state.status = "connected";
inst.simulateHumanPresence = async () => {};

let touched = 0;
const ig = DRIVERS.instagram!;
const saved = { dm: ig.sendDm, pub: ig.publish, rc: ig.replyToComment };
ig.sendDm = (async () => { touched++; return { ok: true }; }) as any;
ig.publish = (async () => { touched++; return { ok: true }; }) as any;
ig.replyToComment = (async () => { touched++; return { ok: true }; }) as any;

const ctx = SIM.newSimContext({ userId: A, kind: "manual" });
const f0 = fetched;
await SIM.withSimulation(ctx, async () => {
  const e1 = await sendEmail(settings!, { ...mail, to: "x@example.com" }).then(() => null, (e) => e);
  check("بريد: sendEmail يرفض قبل المزوّد", e1 instanceof EmailHalted && fetched === f0, e1);
  const e2 = await sendEmail(settings!, { ...mail, to: "owner@a.example", kind: "owner_notice" } as any).then(() => null, (e) => e);
  check("بريد: حتى إشعار صاحب العمل لنفسه", e2 instanceof EmailHalted && fetched === f0, e2);
  const w1 = await sendMessage(A, "971500000044", "x", undefined, undefined, undefined, undefined, { kind: "reply" }).then(() => null, (e) => e);
  const w2 = await inst.sendMessage("971500000044", "ack", undefined, undefined, undefined, undefined, { kind: "optout_ack" }).then(() => null, (e: any) => e);
  const w3 = await inst.directSend("971500000044", "x").then(() => null, (e: any) => e);
  check("واتساب: الغلاف والطريقة وdirectSend كلها ترفض", !!w1 && !!w2 && !!w3, { w1: String(w1), w2: String(w2), w3: String(w3) });
  check("...ولا شيء وصل المقبس", wired.length === 0, wired);
  const d = driverFor("instagram", A)!;
  const s1 = await d.sendDm({} as any, { handle: "h" }, "x", { fresh: true });
  const s2 = await d.publish({} as any, "x");
  check("سوشيال: لا شيء وصل المشغّل", !s1.ok && !s2.ok && touched === 0, { s1, s2, touched });
});
check("كل محاولة تنفيذ تجريبي في السياق", ctx.sandbox.length >= 6 && ctx.sandbox.every((x) => /محاكاة/.test(x.why)), ctx.sandbox.length);
const audited = Number((await db.execute<any>(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE user_id = ${A} AND action = 'gate.simulation'`)).rows[0].n);
check("ومسجّلة في السجل gate.simulation", audited >= 6, audited);
check("ولا gate.refused عادية تُحسب عليه", Number((await db.execute<any>(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE user_id = ${A} AND action = 'gate.refused'`)).rows[0].n) === 0);
ig.sendDm = saved.dm; ig.publish = saved.pub; ig.replyToComment = saved.rc;
// خارج المحاكاة يعمل كما كان
await inst.sendMessage("971500000045", "مرحبا", undefined, undefined, undefined, undefined, { kind: "reply" });
check("خارجها يصل المقبس كما كان", wired.length === 1);

// ── السيناريو بمسار نورة الحقيقي، بلا شبكة ─────────────────────────
await db.execute(sql`INSERT INTO bot_employees (user_id, name, role, employee_key) VALUES (${A}, 'نورة', 'email', 'email.copywriter') ON CONFLICT DO NOTHING`).catch(() => {});
const f1 = fetched;
const run = await E.runE2e(A);
check("اكتمل بثماني خطوات", run.status === "succeeded" && run.steps === 8, run);
check("نورة بلا نموذج: ماجد يعيد بملاحظة", run.accepted === false);
check("نداء النموذج محسوب ومحدود", run.modelCalls >= 1 && run.modelCalls <= E.E2E_CALLS, run.modelCalls);
check("لم يُرسل شيء: تنفيذ تجريبي واحد على الأقل", run.sandbox.length >= 1);
void f1;
const detail = await E.e2eRun(A, run.runId);
const kinds = detail!.steps.map((s: any) => s.kind);
check("الترتيب: جاسم ← منصور ← سلمى ← نورة ← ماجد ← البوابة ← جاسم ← درس", kinds.join() === "analysis,review,plan,revision,returned,sandbox_execution,outcome_event,learning_candidate", kinds);
check("بيانات الاختبار معلَّمة", detail!.run.is_test === true && detail!.run.fixture.test_data === true);
const tickets = (await db.execute<any>(sql`SELECT task_id, parent_task_id, task_type, owner_role, status, input_refs FROM employee_tasks WHERE user_id = ${A} AND (input_refs->>'simRunId')::int = ${run.runId} ORDER BY task_id`)).rows;
check("ست تذاكر sim_ مربوطة بآبائها", tickets.length === 6 && tickets.every((t: any) => t.task_type.startsWith("sim_") && t.input_refs.test_data === true));
const byType = Object.fromEntries(tickets.map((t: any) => [t.task_type, t]));
check("المراجعة ابنة التحليل، والتخطيط ابن المراجعة، والكتابة ابنة التخطيط، والنتيجة لجاسم",
  byType.sim_review.parent_task_id === byType.sim_analysis.task_id && byType.sim_plan.parent_task_id === byType.sim_review.task_id && byType.sim_revision.parent_task_id === byType.sim_plan.task_id
  && byType.sim_guard.parent_task_id === byType.sim_revision.task_id && byType.sim_outcome.parent_task_id === byType.sim_analysis.task_id && byType.sim_outcome.owner_role === "email_analyst");
check("الخطوات تشير إلى تذاكرها", detail!.steps.filter((s: any) => s.ticket_id).length === 6);
const gateStep = detail!.steps.find((s: any) => s.kind === "sandbox_execution");
check("البوابة رفضت بالرمز simulation", gateStep.detail.gate.code === "simulation" && !gateStep.detail.gate.allowed);
const lesson = detail!.steps.find((s: any) => s.kind === "learning_candidate");
check("درسٌ مرشّح معلّق، لا في ذاكرة أحد", lesson.detail.status === "pending" && Number((await db.execute<any>(sql`SELECT count(*)::int AS n FROM agent_memory WHERE user_id = ${A} AND approval_status = 'pending'`)).rows[0].n) === 0);

// نورة تكتب: ماجد يقبل، بكاتبٍ مُبدَل
const good = { subjects: ["goAML deadline for {{company|your company}}"], html: '<p class="lead">Brokers in the UAE must file through goAML; is {{company|your company}} set up?</p><p class="cta"><a href="#">Check my AML gaps</a></p>' };
const run2 = await E.runE2e(A, { write: async () => good });
check("نسخة سليمة: ماجد يقبل", run2.status === "succeeded" && run2.accepted === true, run2);
const other = await E.e2eRun(B, run2.runId);
check("حساب آخر لا يرى سيناريو غيره", other === null);

// ── المحاكى خارج الأرقام ──────────────────────────────────────────
const { collectFacts } = await import("../org/ceo");
const { orgOverview } = await import("../org/overview");
const S = await import("../org/scorecards");
const facts = await collectFacts(A);
check("وقائع المدير: تذاكر المحاكاة لا تُعدّ مغلقة", facts.activity.tasksClosed === 0, facts.activity);
const leak = (await db.execute<any>(sql`SELECT (SELECT count(*)::int FROM receipts WHERE user_id = ${A} AND action = 'llm.call') AS r, (SELECT count(*)::int FROM employee_heartbeats WHERE user_id = ${A}) AS h, (SELECT count(*)::int FROM employee_executions WHERE user_id = ${A}) AS e`)).rows[0];
check("لا إيصال نموذج ولا نبض ولا تنفيذ من السيناريو", leak.r === 0 && leak.h === 0 && leak.e === 0, leak);
check("ولا قسم يُحسب له استهلاك", facts.departments.every((d) => d.tokens === 0 && d.executions === 0));
await db.execute(sql`UPDATE employee_tasks SET status = 'queued', expires_at = now() - interval '1 hour', completed_at = NULL WHERE user_id = ${A} AND task_type = 'sim_plan'`);
const ov = await orgOverview(A);
const realActive = Number((await db.execute<any>(sql`SELECT count(*)::int AS n FROM employee_tasks WHERE user_id = ${A} AND left(task_type, 4) <> 'sim_' AND task_type <> 'ops_daily' AND status IN ('pending','queued','running','waiting_for_dependency','waiting_for_approval')`)).rows[0].n);
check("اللوحة: لا مهام نشطة ولا فائتة من المحاكاة", ov.tasks.active === realActive && ov.tasks.overdue === 0 && ov.queue.tasksQueued === 0, { tasks: ov.tasks, realActive });
check("وقائع المدير: لا موعد فائت من المحاكاة", (await collectFacts(A)).overdueEmployees.every((o) => o.employeeKey !== "email.strategist"));
const card = await S.computeScorecard(A, { role: "email_analyst", createdAt: new Date(Date.now() - 60 * 86_400_000) }, "weekly");
const simIds = new Set(tickets.map((t: any) => Number(t.task_id)));
const evid = JSON.stringify(card.metrics.map((m: any) => m.evidence?.employee_tasks ?? []));
check("البطاقة: لا دليل من تذاكر المحاكاة", ![...simIds].some((id) => new RegExp(`\\b${id}\\b`).test(evid)), evid);

// ── تقرير المدير: الحقول الجديدة بالكود ───────────────────────────
const { runCeoDaily } = await import("../org/ceo");
const rep = await runCeoDaily(A, { llm: (async () => null) as any });
check("التقرير يُحفظ بحقول §8", rep.ran && Array.isArray(rep.report.verified_metrics) && Array.isArray(rep.report.overdue_tickets) && Array.isArray(rep.report.assigned_ticket_ids) && Array.isArray(rep.report.data_gaps) && ["low", "medium", "high"].includes(rep.report.confidence), rep.report && Object.keys(rep.report));
check("قليل الوقائع: ثقة منخفضة، وفجوة thin", rep.report.confidence === "low" && rep.report.data_gaps.some((g: any) => g.key === "thin"));
check("تذاكر المحاكاة ليست فائتة في التقرير", rep.report.overdue_tickets.every((t: any) => !String(t.taskType).startsWith("sim_")));

// ── خروج واتساب ───────────────────────────────────────────────────
await db.execute(sql`INSERT INTO telegram_settings (user_id, bot_token, chat_id, enabled) VALUES (${A}, 't', '1', true) ON CONFLICT (user_id) DO UPDATE SET chat_id = '1', enabled = true`);
inst.awaitingRescanSince = null;
const n1 = await inst.markAwaitingRescan();
const n2 = await inst.markAwaitingRescan();
const out = Number((await db.execute<any>(sql`SELECT count(*)::int AS n FROM notify_outbox WHERE user_id = ${A} AND kind = 'wa_logged_out'`)).rows[0].n);
check("إشعارٌ واحد لكل خروج، بالعربية", n1 === true && n2 === false && out === 1, { n1, n2, out });
const body = (await db.execute<any>(sql`SELECT body FROM notify_outbox WHERE user_id = ${A} AND kind = 'wa_logged_out'`)).rows[0]?.body ?? "";
check("...ويقول أين يُصلح", /\/connect/.test(body) && /واتساب/.test(body));
inst.awaitingRescanSince = null;
check("بعد الاتصال يعود الحق في إشعار", (await inst.markAwaitingRescan()) === true);
await db.execute(sql`INSERT INTO wa_session_events (user_id, event, detail) VALUES (${A}, 'connected', null), (${A}, 'auto_repair', 'x')`);
const { readiness } = await import("../org/readiness");
const rd = await readiness(A, { verify: false, deps: { waState: async () => ({ connected: false, status: "disconnected" }) } });
const lo = rd.items.find((i) => i.id === "whatsapp.logged_out");
check("الجاهزية: خروج واتساب BLOCKED ويشير إلى /connect", lo?.status === "BLOCKED" && lo.goto === "/connect", lo);
check("الرد الآلي المتوقف عمداً: OPTIONAL لا BLOCKED", rd.items.filter((i) => /auto_reply/.test(i.id)).every((i) => i.status !== "BLOCKED"), rd.items.filter((i) => /auto_reply/.test(i.id)).map((i) => i.status));
await new Promise((ok) => setTimeout(ok, 21_000));
const ov2 = await orgOverview(A);
check("اللوحة: خطر خروج واتساب", ov2.risks.some((r: any) => r.kind === "wa_logged_out"));
await db.execute(sql`INSERT INTO wa_session_events (user_id, event) VALUES (${A}, 'connected')`);
check("بعد الاتصال يختفي البند", !(await readiness(A, { verify: false, deps: { waState: async () => null } })).items.some((i) => i.id === "whatsapp.logged_out"));

(waManager as any).instances.delete(A);
await clean();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
