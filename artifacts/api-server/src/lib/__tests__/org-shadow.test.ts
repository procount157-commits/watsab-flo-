// الظل والمحاكاة وحقول المدير وإصلاحات المسار D. الجزء الأول بلا قاعدة:
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/org-shadow.test.ts
// والبقية على قاعدة الاختبار وحدها، بلا شبكة ولا إرسال ولا نموذج حقيقي:
//   DATABASE_URL=postgres://t:t@127.0.0.1:55444/t npx tsx src/lib/__tests__/org-shadow.test.ts
export {};
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let fetched = 0;
globalThis.fetch = (async (url: any) => { fetched++; throw new Error(`no network in this test: ${url}`); }) as any;
process.env["GEMINI_API_KEY"] = "test-key";
process.env["GROQ_API_KEY"] = "test-key";

const SIM = await import("../org/simulation");
const SH = await import("../org/shadow");
const { ORG_SIM_SQL } = await import("../org/sim-schema");
const C = await import("../org/ceo");
const R = await import("../org/readiness");
const { corePrompt } = await import("../prompt-core");
const { personaPreamble } = await import("../agent-router");
const { gateSend } = await import("../org/gateway");
const { listPlans } = await import("../../routes/plans");
const E = await import("../org/sandbox-e2e");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};

// ── بلا قاعدة ─────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const mig = norm(readFileSync(join(here, "../../../../../lib/db/migrations/075_shadow.sql"), "utf8"));
check("075 يحمل كل عبارة في ORG_SIM_SQL", ORG_SIM_SQL.every((q) => mig.includes(norm(q))), ORG_SIM_SQL.find((q) => !mig.includes(norm(q))));

// الحكم بالكود
const ok = (text: string) => ({ text, issues: [] as string[] });
const bad = (text: string, ...issues: string[]) => ({ text, issues });
check("المقترح لم يكتب: no_output", SH.verdictOf(ok("x"), { text: null, issues: [] }).verdict === "no_output");
check("المقترح خالف: failed_checks حتى لو خالف الحالي", SH.verdictOf(bad("x", "a"), bad("y", "b")).verdict === "failed_checks");
check("الحالي خالف والمقترح سليم: better", SH.verdictOf(bad("x", "a"), ok("y")).verdict === "better");
check("الحالي لم يكتب والمقترح سليم: better", SH.verdictOf({ text: null, issues: [] }, ok("y")).verdict === "better");
check("كلاهما سليم: same", SH.verdictOf(ok("x"), ok("y")).verdict === "same");
check("تصنيفٌ بلا نص يُعدّ مخرجاً", SH.verdictOf(ok("x"), { text: null, label: "hot", issues: [] }).verdict === "same");
const sum0 = SH.summarize([]);
check("لا تشغيل: إنذار", sum0.warnings.length === 1 && !sum0.ok);
const sumNo = SH.summarize([{ verdict: "no_samples" }]);
check("لا عيّنات: إنذار", /لا عيّنات/.test(sumNo.warnings.join()) && !sumNo.ok);
const sumF = SH.summarize([{ verdict: "same" }, { verdict: "failed_checks" }]);
check("خالف في عيّنة: إنذار، وليس ok", /خالف/.test(sumF.warnings.join()) && !sumF.ok && sumF.samples === 2);
check("كلها سليمة: ok بلا إنذار", SH.summarize([{ verdict: "same" }, { verdict: "better" }]).ok && !SH.summarize([{ verdict: "same" }]).warnings.length);
check("بلا مسار: إنذار يقوله", /لا مسار/.test(SH.summarize([{ verdict: "no_model_path" }]).warnings.join()));
check("السقف والعيّنات كما في المواصفة", SH.SHADOW_DAILY_CALLS === 40 && SH.SHADOW_MAX_SAMPLES === 3);

// سياق المحاكاة
check("خارج المحاكاة: لا محاكاة ولا بديل", !SIM.inSimulation() && SIM.personaFor("email", "OLD") === "OLD" && SIM.takeSimCall());
const ctx = SIM.newSimContext({ userId: 1, kind: "manual", personas: { email: "NEW", "whatsapp.sales": "SALES-NEW" }, budget: 2 });
await SIM.withSimulation(ctx, async () => {
  check("داخلها: dryRun", SIM.dryRun() && SIM.inSimulation());
  check("البديل بالدور", SIM.personaFor("email", "OLD") === "NEW");
  check("والبديل بمفتاح الموظف", SIM.personaFor("sales", "OLD") === "SALES-NEW");
  check("دور بلا بديل: المحفوظ", SIM.personaFor("email_guard", "G") === "G");
  check("الميزانية تُعدّ وتنفد", SIM.takeSimCall() && SIM.takeSimCall() && !SIM.takeSimCall() && ctx.budget.used === 2);
  await SIM.withPersona("email", null, async () => check("withPersona(null): يعود المحفوظ", SIM.personaFor("email", "OLD") === "OLD"));
  await SIM.withPersona("email", "X", async () => check("withPersona: بديل آخر", SIM.personaFor("email", "OLD") === "X"));
  const core = corePrompt({ channel: "email", role: "email", identity: "اسمك نورة", persona: "OLD-PERSONA" });
  check("corePrompt: البديل يحلّ محل الشخصية", core.includes("NEW") && !core.includes("OLD-PERSONA"));
  const pre = personaPreamble({ agent: { name: "سارة", title: null, persona: "قديمة", role: "sales" } as any });
  check("personaPreamble: البديل", pre.includes("SALES-NEW") && !pre.includes("قديمة"));
});
check("corePrompt خارجها: الشخصية المحفوظة كما هي", corePrompt({ channel: "email", role: "email", identity: "x", persona: "OLD-PERSONA" }).includes("OLD-PERSONA"));

// البوابة ترفض كل شيء في المحاكاة، قبل أي قناة وأي قراءة
const sim2 = SIM.newSimContext({ userId: 1, kind: "manual" });
const f0 = fetched;
const refused = await SIM.withSimulation(sim2, async () => Promise.all([
  gateSend({ userId: 1, channel: "whatsapp", kind: "reply", recipient: "971500000001" }),
  gateSend({ userId: 1, channel: "email", kind: "campaign", recipient: "a@b.c" }),
  gateSend({ userId: 1, channel: "email", kind: "owner_notice", recipient: "me@x", selfAddressed: true }),
  gateSend({ userId: 1, channel: "instagram", kind: "dm", recipient: "h" }),
  gateSend({ userId: 1, channel: "tiktok", kind: "post" }),
  gateSend({ userId: 1, channel: "whatsapp", kind: "manual", recipient: "971500000002" }),
]));
check("المحاكاة: كل قناة وكل نوع مرفوض بالرمز simulation", refused.every((r) => !r.allowed && r.code === "simulation"), refused);
check("...وكل محاولة تنفيذٌ تجريبي مسجَّل", sim2.sandbox.length === refused.length && sim2.sandbox[0]!.channel === "whatsapp");
check("...ولا شبكة", fetched === f0);

// حقول المدير §8 وعتبة الهدر
const pack: any = {
  accountId: 1, day: "2026-11-10", windowDays: 7, thin: false,
  activity: { executions: 400, emailsSent: 30, inbound: 4, waSends: 10, tasksClosed: 5 },
  outcomes: { positiveReplies: 2, companiesPositive: 2, qualifiedLeads: 1, meetings: 0, bounced: 1, bounceRate: null, humanOpens: 3 },
  departments: [
    // الشكل الحقيقي: المشترك ٢٬٨٩٣ نداء بلا نتيجة خاصة به.
    { department: "shared", executions: 300, failed: 2, successRate: 0.99, tokens: 1_900_000, calls: 2893, costUsd: null, outcome: null, outcomeLabel: null },
    { department: "executive", executions: 3, failed: 0, successRate: null, tokens: 40_000, calls: 30, costUsd: null, outcome: null, outcomeLabel: null },
    { department: "email", executions: 90, failed: 1, successRate: 0.98, tokens: 300_000, calls: 400, costUsd: null, outcome: 2, outcomeLabel: "ردود نافعة على الموجات" },
    { department: "whatsapp", executions: 7, failed: 0, successRate: null, tokens: 120_000, calls: 200, costUsd: null, outcome: 0, outcomeLabel: "محادثات حارة أو مهتمة أو طلب" },
  ],
  overdueEmployees: [], failingEmployees: [], noExecutionEmployees: ["whatsapp.vetter"], failingWorkflows: [], campaignsWithLeads: [],
  channels: [{ channel: "email", state: "sending", sent: 30, positive: 2 }, { channel: "linkedin", state: "no_driver", sent: 0, positive: null }],
  queue: { emailQueued: 0, heldStale: 0 }, approvalsWaiting: 0, problems: [],
};
const waste = C.wastefulDepartment(pack.departments);
check("الهدر: المشترك (٢٬٨٩٣ نداء) والتنفيذي لا يُحكم عليهما", waste?.department === "whatsapp", waste);
check("الهدر: بلا قسم ذي نتيجة لا هدر", C.wastefulDepartment(pack.departments.slice(0, 2)) === null);
const vm = C.verifiedMetrics(pack);
check("verified_metrics: كل رقم بمصدره، والنسبة بلا عيّنة null", vm.every((m) => !!m.source) && vm.find((m) => m.key === "bounce_rate")!.value === null && vm.find((m) => m.key === "emails_sent")!.value === 30);
const gaps = C.dataGaps(pack);
check("data_gaps: الارتداد، نسبة النجاح القليلة، بلا تنفيذ، القناة بلا مشغّل", ["bounce_rate", "success_rate:whatsapp", "no_execution:whatsapp.vetter", "channel:linkedin"].every((k) => gaps.some((g) => g.key === k)), gaps);
check("confidence: قليل الوقائع منخفض", C.reportConfidence({ ...pack, thin: true }, [], "validated") === "low");
check("confidence: فجوات كثيرة متوسط أو أدنى", C.reportConfidence(pack, gaps, "validated") !== "high");
check("confidence: بلا فجوات ونص متحقق عالٍ", C.reportConfidence(pack, [], "validated") === "high" && C.reportConfidence(pack, [], "facts_only") === "medium");

// الجاهزية: المتوقف عمداً
check("OPTIONAL لا يُحسب محظوراً", R.overallStatus([{ status: "READY" }, { status: "OPTIONAL" }]) === "READY");
check("OPTIONAL مع ما يحتاج اختباراً", R.overallStatus([{ status: "NEEDS_TEST" }, { status: "OPTIONAL" }]) === "NEEDS_TEST");
check("OPTIONAL وحده لا يجعل الكل جاهزاً", R.overallStatus([{ status: "OPTIONAL" }]) === "BLOCKED");
check("المحظور يبقى محظوراً", R.overallStatus([{ status: "OPTIONAL" }, { status: "BLOCKED" }]) === "BLOCKED");

// /api/plans: الجدول الغائب
const missing = async () => { throw Object.assign(new Error('relation "subscription_plans" does not exist'), { code: "42P01" }); };
check("الخطط: جدول غائب = قائمة فارغة", (await listPlans(missing as any)).length === 0);
check("الخطط: لوحة المدير كذلك", (await listPlans(missing as any, true)).length === 0);
check("الخطط: الموجود يعود كما هو", (await listPlans((async () => ({ rows: [{ id: 1 }] })) as any)).length === 1);
check("الخطط: خطأ آخر يُرمى", await listPlans((async () => { throw Object.assign(new Error("x"), { code: "57P01" }); }) as any).then(() => false, () => true));

// تحليل جاسم بالكود
const fx = E.WEAK_FIXTURE.data;
const findings = E.analyseCampaign(fx as any, () => ["مبالغة"]);
check("جاسم: فتح ضعيف، لا رد نافع، ارتداد، وحارس", ["low_open", "no_positive", "bounce", "guard", "vague_subject"].every((c) => findings.some((f) => f.code === c)), findings);
check("بيانات الاختبار معلَّمة", (fx as any).test_data === true && /اختبار/.test(fx.name));

// ── على القاعدة ───────────────────────────────────────────────────
if (!/127\.0\.0\.1:(55444|55440)/.test(process.env["DATABASE_URL"] ?? "")) {
  console.log(`\n${pass} passed, ${fail} failed (بلا قاعدة)`);
  process.exit(fail ? 1 : 0);
}

const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const { ensureSimTables } = await import("../org/sim-schema");
const { setControl, forgetControls } = await import("../org/controls");
const { pendingProviderBuckets } = await import("../org/providers");
const A = 5, B = 6;
await ensureSimTables();
for (const t of ["shadow_runs", "improvement_proposals", "email_missions", "bot_employees", "receipts", "llm_usage", "employee_heartbeats", "employee_executions", "org_controls"]) {
  await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${A}, ${B})`)).catch(() => {});
}
forgetControls();
check("ensureSimTables مرتين بأمان", await ensureSimTables());
await db.execute(sql`INSERT INTO bot_employees (user_id, name, role, employee_key, persona) VALUES
  (${A}, 'ريم', 'collector', 'shared.collector', 'OLD-REEM'), (${A}, 'راشد', 'email_registrar', 'email.registrar', 'x'), (${A}, 'نورة', 'email', 'email.copywriter', 'OLD-NORA'),
  (${B}, 'نورة', 'email', 'email.copywriter', 'B-NORA')`);
const [prop] = (await db.execute<any>(sql`INSERT INTO improvement_proposals (user_id, requested_by, target, reason, new_value, category, risk)
  VALUES (${A}, 'system.seed', 'prompt:email.copywriter', 'اختبار', '{"libraryVersion":"1"}'::jsonb, 'prompt_external', 'approval_required') RETURNING change_id`)).rows;
for (const [u, n] of [[A, 4], [B, 3]] as const) for (let i = 0; i < n; i++) {
  await db.execute(sql`INSERT INTO email_missions (user_id, name, goal, filter) VALUES (${u}, ${`m${u}-${i}`}, ${`هدف ${u}-${i}`}, '{}'::jsonb)`);
}

// مسار حقيقي بلا شبكة: نورة لا تجد نموذجاً → no_output، والعزل
const r1 = await SH.runShadow(A, { employeeKey: "email.copywriter" });
const mine = (await db.execute<any>(sql`SELECT id FROM email_missions WHERE user_id = ${A}`)).rows.map((x: any) => Number(x.id));
check("الظل: ٣ عيّنات على الأكثر", r1.ran === 3, r1);
check("عزل: كل عيّنة من الحساب نفسه", r1.rows.every((x: any) => mine.includes(Number(x.sample_ref?.id))), r1.rows.map((x: any) => x.sample_ref));
check("بلا نموذج: no_output، والمقترح مربوط بمقترحه", r1.rows.every((x: any) => x.verdict === "no_output" && Number(x.proposal_id) === Number(prop.change_id)));
check("كل نسخة نداء واحد محسوب", r1.callsUsed === 6 && r1.rows.every((x: any) => Number(x.model_calls) === 2), r1.callsUsed);
check("callsToday يجمعها", (await SH.callsToday(A)) === 6 && (await SH.callsToday(B)) === 0);
const leaks = (await db.execute<any>(sql`SELECT (SELECT count(*)::int FROM receipts WHERE user_id = ${A} AND action = 'llm.call') AS r,
  (SELECT count(*)::int FROM employee_heartbeats WHERE user_id = ${A}) AS h, (SELECT count(*)::int FROM employee_executions WHERE user_id = ${A}) AS e`)).rows[0];
await new Promise((ok) => setTimeout(ok, 200));
const usage = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM llm_usage WHERE user_id = ${A}`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0];
check("المحاكى خارج الإيصالات والنبض والتنفيذ والاستهلاك ومقاييس المزوّد", leaks.r === 0 && leaks.h === 0 && leaks.e === 0 && Number(usage.n) === 0 && pendingProviderBuckets() === 0, { leaks, usage, buckets: pendingProviderBuckets() });
const s1 = await SH.shadowSummary(A, { proposalId: Number(prop.change_id) });
check("خلاصة المقترح: إنذار لم يكتب", s1.samples === 3 && s1.warnings.some((w) => /لم يكتب/.test(w)) && !s1.ok, s1);

// السقف: ٤٠ في اليوم، وما لا يكفي لعيّنة يقال
const r2 = await SH.runShadow(A, { employeeKey: "email.copywriter", budget: 9 });
check("السقف: عيّنة واحدة ثم budget", r2.ran === 0 || r2.rows.some((x: any) => x.verdict === "budget"), r2.rows.map((x: any) => x.verdict));
check("ولم يتجاوز السقف", (await SH.callsToday(A)) <= 9);
await db.execute(sql`DELETE FROM shadow_runs WHERE user_id = ${A}`);

// المفاتيح تعمل: asAgent على الدور
await setControl({ scope: "employee", userId: A, target: "email.copywriter", engaged: true, actor: A });
const r3 = await SH.runShadow(A, { employeeKey: "email.copywriter" });
check("الموظف موقوف: لا عيّنة ولا نداء", r3.ran === 0 && r3.callsUsed === 0 && r3.skipped.some((s) => /موقوف/.test(s.why)), r3);
await setControl({ scope: "employee", userId: A, target: "email.copywriter", engaged: false, actor: A });

// الشخصيتان: المحفوظة ثم المقترحة، والحكم بالكود
const seen: string[] = [];
const stub = (key: string, role: string, judge: (p: string) => string[]) => ({
  key, role, maxCalls: 1,
  samples: async (u: number) => (await db.execute<any>(sql`SELECT id FROM email_missions WHERE user_id = ${u} ORDER BY id LIMIT 3`)).rows.map((x: any) => ({ ref: { id: Number(x.id) }, excerpt: "x", data: x })),
  run: async () => { const p = SIM.personaFor(role, "NONE") ?? "NONE"; seen.push(p.slice(0, 20)); return { text: p, issues: judge(p) }; },
});
const r4 = await SH.runShadow(A, { adapters: [stub("shared.collector", "collector", (p) => (p.includes("##") ? ["عناوين أقسام في النص"] : []))] as any });
const reem = r4.rows.filter((x: any) => x.employee_key === "shared.collector");
check("الحالية: المحفوظة كما هي", seen[0] === "OLD-REEM", seen);
check("المقترحة: نص المكتبة لهذا الحساب", /^## /.test(seen[1] ?? ""), seen[1]);
check("المقترح خالف: failed_checks", reem.length === 3 && reem.every((x: any) => x.verdict === "failed_checks"), reem.map((x: any) => x.verdict));
const reg = r4.rows.find((x: any) => x.employee_key === "email.registrar");
check("موظف بالكود وحده: no_model_path بلا نداء", reg?.verdict === "no_model_path" && Number(reg.model_calls) === 0 && /بالكود/.test(reg.detail), reg);
const nora = r4.rows.filter((x: any) => x.employee_key === "email.copywriter");
check("بلا مسار في هذه الدفعة: no_model_path", nora.length === 1 && nora[0].verdict === "no_model_path");
await db.execute(sql`DELETE FROM shadow_runs WHERE user_id = ${A}`);

// الجدول: أيام العمل 06:30، مرة في اليوم، لمن عنده مقترح ولم يُوقَف
SH.forgetShadowSchedule();
const ran: number[] = [];
const fake = (async (u: number) => { ran.push(u); return { batchId: "", ran: 0, skipped: [], callsUsed: 0, rows: [] }; }) as any;
check("قبل 06:30 لا شيء", (await SH.shadowTick(new Date("2026-11-10T02:00:00Z"), fake)).length === 0);
check("السبت لا شيء", (await SH.shadowTick(new Date("2026-11-14T03:00:00Z"), fake)).length === 0);
const t1 = await SH.shadowTick(new Date("2026-11-10T02:45:00Z"), fake);
check("الثلاثاء 06:45: الحساب صاحب المقترح وحده", t1.includes(A) && !t1.includes(B), t1);
check("ومرة واحدة في اليوم", (await SH.shadowTick(new Date("2026-11-10T03:45:00Z"), fake)).length === 0);

// المسارات
const express = (await import("express")).default;
const simRouter = (await import("../../routes/org-sim")).default;
const orgRouter = (await import("../../routes/org")).default;
let session: any = { userId: A };
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.session = session; next(); });
app.use("/org/sim", simRouter);
app.use("/org", orgRouter);
const server = await new Promise<any>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}/org`;
const http = async (path: string, init?: any) => {
  const { request } = await import("node:http");
  return new Promise<{ status: number; body: any }>((ok, no) => {
    const u = new URL(base + path);
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: init?.method ?? "GET", headers: { "content-type": "application/json" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok({ status: res.statusCode!, body: d ? JSON.parse(d) : null }));
    });
    req.on("error", no); if (init?.body) req.write(JSON.stringify(init.body)); req.end();
  });
};
const run = await http("/sim/shadow/run", { method: "POST", body: { employeeKey: "email.copywriter" } });
check("POST /sim/shadow/run", run.status === 200 && run.body.ran === 3, run);
const res = await http(`/sim/shadow/results?proposalId=${prop.change_id}`);
check("GET النتائج بالمقترح، وخلاصته", res.status === 200 && res.body.results.length === 3 && res.body.summary?.samples === 3);
const pr = await http(`/proposals/${prop.change_id}`);
check("المقترح يحمل shadow بإنذاراته", pr.status === 200 && pr.body.shadow?.samples === 3 && pr.body.shadow.warnings.length > 0, pr.body?.shadow);
session = { userId: B };
const other = await http(`/sim/shadow/results?proposalId=${prop.change_id}`);
check("حساب آخر لا يرى ظل غيره", other.body.results.length === 0);
session = { userId: A };
const emp = await http(`/employees/email.copywriter`);
check("ملف الموظف يحمل shadow", emp.status === 200 && emp.body.shadow?.samples === 3, emp.body?.shadow);
server.close();

for (const t of ["shadow_runs", "improvement_proposals", "email_missions", "bot_employees", "agent_tasks", "org_controls", "org_audit_log"]) await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${A}, ${B})`)).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
