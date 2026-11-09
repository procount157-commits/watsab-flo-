// تشغيل الموظفين: النبض، الطابور، الحارس، التسليم. الجزء الأول بلا قاعدة:
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/org-runtime.test.ts
// والبقية على قاعدة الاختبار وحدها، بلا شبكة ولا إرسال ولا نموذج حقيقي:
//   DATABASE_URL=postgres://t:t@127.0.0.1:55439/t npx tsx src/lib/__tests__/org-runtime.test.ts
export {};
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// لا شبكة أبداً: كل نداء يُسجَّل، والنموذج هو ما يقوله modelAnswer.
const prompts: string[] = [];
let fetched = 0;
let modelAnswer: string | null = "الحكم: سليم";
globalThis.fetch = (async (url: any, init: any) => {
  fetched++;
  const u = String(url);
  if (!/generativelanguage|groq|openrouter|anthropic|pollinations|openai/.test(u)) throw new Error(`no network in this test: ${u}`);
  if (init?.body) prompts.push(String(init.body));
  if (modelAnswer == null) throw new Error("model down");
  const text = modelAnswer;
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }], candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], content: [{ text }] }), { status: 200, headers: { "content-type": "application/json" } });
}) as any;
process.env["GROQ_API_KEY"] = "test-key";

const R = await import("../org/registry");
const T = await import("../org/tasks");
const H = await import("../org/handoffs");
const Q = await import("../org/queue");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};

// ── بلا قاعدة ─────────────────────────────────────────────────────
check("قسم الموظف باسميه ومفتاحه", ["instagram", "social", "instagram.dm", "ig_dm"].every((n) => R.haltNames("ig_dm").includes(n)) && R.haltNames("accounts_writer").includes("target_accounts") && R.haltNames("chief").includes("executive"));
check("email_manager = email.director", R.employeeKeyOf("email_manager") === "email.director");
check("email = email.copywriter", R.employeeKeyOf("email") === "email.copywriter");
check("ops = ops.controller", R.employeeKeyOf("ops") === "ops.controller");
check("ig_guard = instagram.guard", R.employeeKeyOf("ig_guard") === "instagram.guard");
check("دور وظّفه المهندس: custom", R.employeeKeyOf("tax_helper") === "custom.tax_helper");
const allKeys = Object.values(R.ROLE_MAP).map((x) => x.key);
check("كل مفتاح فريد", new Set(allKeys).size === allKeys.length);
check("أقسام الهيكل فقط", Object.values(R.ROLE_MAP).every((x) => (R.DEPARTMENTS as readonly string[]).includes(x.department)));
check("لينكدإن كله بلا تنفيذ", Object.entries(R.ROLE_MAP).filter(([r]) => r.startsWith("li_")).every(([, x]) => x.execution === "none" && !x.fn));
check("الناقل والمحلل في السوشيال بلا تنفيذ", R.ROLE_MAP["ig_inviter"]!.execution === "none" && R.ROLE_MAP["tt_analyst"]!.execution === "none");
check("part_of يقول من يحمله", Object.values(R.ROLE_MAP).filter((x) => x.execution === "part_of").every((x) => allKeys.includes(x.carriedBy!)));
check("own له دالة", Object.values(R.ROLE_MAP).filter((x) => x.execution === "own").every((x) => !!x.fn));
const now = Date.now();
check("لا صف = no_execution، لا سليم", R.heartbeatState(null, 60, now) === "no_execution");
check("نبضٌ في موعده سليم", R.heartbeatState({ status: "idle", lastBeatAt: new Date(now - 60_000) }, 60, now) === "healthy");
check("بعد ضعف الفترة: متأخر", R.heartbeatState({ status: "idle", lastBeatAt: new Date(now - 121_000) }, 60, now) === "late");
check("موقوف يقول موقوف ولو قديماً", R.heartbeatState({ status: "halted", lastBeatAt: new Date(0) }, 60, now) === "halted");
check("بلا موعد: لا يتأخر أبداً", R.heartbeatState({ status: "idle", lastBeatAt: new Date(0) }, null, now) === "healthy");
check("التراجع يتضاعف", T.backoffSec(0) === 60 && T.backoffSec(1) === 120 && T.backoffSec(3) === 480);
check("ولا يتجاوز ساعة", T.backoffSec(20) === 3600);
check("الموافقة قبل الاعتماد", T.initialStatus({ approvalRequired: true, unmetDeps: 2 }) === "waiting_for_approval");
check("اعتمادٌ ناقص ينتظر", T.initialStatus({ unmetDeps: 1 }) === "waiting_for_dependency");
check("بلا شيء: الطابور", T.initialStatus({ unmetDeps: 0 }) === "queued");

const verdicts = { overall: { sent: 300, positive: 3, bounceRate: 1 }, avoidAngles: ["x"], decisions: [], angles: [
  { key: "x", label: "س", verdict: "rewrite", why: "صفر رد", sent: 160, positive: 0 },
  { key: "y", label: "ص", verdict: "scale", why: "ردود", sent: 100, positive: 3 },
  { key: "z", label: "ع", verdict: "watch", why: "صغيرة", sent: 10, positive: 0 },
] };
const dir = H.directiveFrom(verdicts as any);
check("التوجيه: ما فشل يُتجنَّب", dir.avoidAngles.join() === "x");
check("التوجيه: ما نفع يتقدّم", dir.priorityAngles.join() === "y");
check("التوجيه: العيّنة الصغيرة لا تُذكر", !dir.lines.some((l) => l.includes("«ع»")));
check("القطاع المقدَّم أولاً وبقية الترتيب كما هو", H.orderByPriority([{ sector: "أ" }, { sector: "ب" }, { sector: "ج" }], ["ج"]).map((x) => x.sector).join() === "ج,أ,ب");

const subs = [
  { subject: "Top {{company}}", sent: 40, opened: 20, replied: 4, rate: 50 },
  { subject: "Small", sent: 29, opened: 29, replied: 9, rate: 100 },
  { subject: "Mid", sent: 200, opened: 60, replied: 2, rate: 30 },
  { subject: "مكتب — الخطوة 2", sent: 90, opened: 60, replied: 9, rate: 66 },
  { subject: "Silent", sent: 60, opened: 0, replied: 0, rate: 0 },
];
const vs = H.verifiedSubjects({ measurable: true, subjects: subs });
check("حصّة: أقل من ٣٠ لا يدخل", !vs.some((s) => s.subject === "Small"));
check("حصّة: اسم تسلسل ليس عنواناً", !vs.some((s) => s.subject.includes("الخطوة")));
check("حصّة: الرد أولاً", vs[0]!.subject === "Top {{company}}" && vs[1]!.subject === "Mid", vs);
check("حصّة: بلا قياس فتح لا يدخل إلا ما جلب رداً", H.verifiedSubjects({ measurable: false, subjects: subs }).every((s) => s.replied > 0));

check("نيّة الرد بلغة النتائج", H.outcomeOf("interested") === "positive" && H.outcomeOf("opt_out") === "negative" && H.outcomeOf("unclear") === "neutral");
check("مفتاح العيب بلا اقتباس ولا أرقام", H.issueKey("الرسالة 120 كلمة «نص»") === H.issueKey("الرسالة 95 كلمة «آخر»"));
check("مقترح مريم: حالةٌ لها جمهور فقط", H.pickRetarget([
  { cohort: "replied_later", label: "ل", eligible: 9, inCohort: 9, angle: {} as any, guards: [], priority: 1 },
  { cohort: "opened", label: "ف", eligible: 5, inCohort: 9, angle: {} as any, guards: [], priority: 3 },
  { cohort: "clicked", label: "ن", eligible: 0, inCohort: 9, angle: {} as any, guards: [], priority: 2 },
])?.cohort === "opened");

check("غير مؤهل: طلب الإيقاف", Q.ineligibleReason({ contactStatus: "unsubscribed" }) === "opted_out");
check("غير مؤهل: ارتدّ", Q.ineligibleReason({ contactStatus: "bounced" }) === "bounced");
check("غير مؤهل: ردّ", Q.ineligibleReason({ contactStatus: "active", repliedAt: new Date() }) === "replied");
check("غير مؤهل: ردّت شركته", Q.ineligibleReason({ contactStatus: "active", companyReplied: true }) === "company_replied");
check("نشطٌ صامت: مؤهل، لا يُلغى لقِدمه", Q.ineligibleReason({ contactStatus: "active" }) === null);
check("أسبوعٌ وزيادة: قديمة", Q.staleMessage(new Date(Date.now() - 8 * 86_400_000)) && !Q.staleMessage(new Date(Date.now() - 6 * 86_400_000)));

const { ORG_RUNTIME_SQL } = await import("../org/schema");
const here = dirname(fileURLToPath(import.meta.url));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const mig = norm(readFileSync(join(here, "../../../../../lib/db/migrations/073_org_runtime.sql"), "utf8"));
check("073 يحمل كل ما عند الإقلاع", ORG_RUNTIME_SQL.every((q) => mig.includes(norm(q))));

if (!/127\.0\.0\.1:55439/.test(process.env["DATABASE_URL"] ?? "")) {
  console.log(`\n${pass} نجح، ${fail} فشل (بلا قاعدة)`);
  process.exit(fail ? 1 : 0);
}

// ── على القاعدة ───────────────────────────────────────────────────
const { db, emailMessagesTable } = await import("@workspace/db");
const { sql, eq } = await import("drizzle-orm");
const { ensureOrgTables } = await import("../org/schema");
const { execute, runAs, beat, forgetRuntimeCache, workerId } = await import("../org/runtime");
const { setControl, forgetControls, isHalted } = await import("../org/controls");
const { forgetSwitches } = await import("../graph/switch");
const W = await import("../org/watchdog");
const { gateSend } = await import("../org/gateway");
const { complete } = await import("../llm");
const { asAgent } = await import("../agent-context");
const { memoryPreamble, remember } = await import("../agent-memory");
const { brief, rememberLesson } = await import("../email/agent");

const A = 13, B = 14;
const rows = async <X = any>(q: any): Promise<X[]> => (await db.execute<any>(q)).rows as X[];
const one = async <X = any>(q: any): Promise<X> => (await rows<X>(q))[0]!;
const clean = async () => {
  for (const t of ["employee_tasks", "employee_executions", "employee_heartbeats", "employee_feedback", "learning_events", "execution_events", "workflow_executions",
    "org_audit_log", "org_controls", "email_messages", "email_campaigns", "email_sequence_jobs", "email_sequences", "email_missions", "email_list_members", "email_lists", "email_contacts", "email_settings", "email_autopilot", "email_inbound", "target_accounts", "bot_employees", "agent_memory", "email_mission_log", "email_segments", "email_agent_activity"]) {
    await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${A}, ${B})`)).catch(() => db.execute(sql.raw(`DELETE FROM ${t}`)));
  }
  await db.execute(sql`DELETE FROM org_controls`);
  forgetControls(); forgetSwitches(A); forgetSwitches(B); forgetRuntimeCache(); T.forgetHandlers();
};
await ensureOrgTables();
await clean();
check("ensureOrgTables يُعاد بأمان مع أعمدة التشغيل", await ensureOrgTables());

const hb = (u: number, key: string) => one(sql`SELECT * FROM employee_heartbeats WHERE user_id = ${u} AND employee_key = ${key}`);
const execs = (u: number, key: string) => rows(sql`SELECT * FROM employee_executions WHERE user_id = ${u} AND employee_key = ${key} ORDER BY id`);

// ── السجل ──
await db.execute(sql`INSERT INTO bot_employees (user_id, name, role) VALUES (${A}, 'منصور', 'email_manager'), (${A}, 'اسمٌ غيّره صاحبه', 'email'), (${A}, 'ناقل', 'ig_inviter'), (${A}, 'جديد', 'tax_helper'), (${A}, 'راشد', 'email_registrar'), (${B}, 'نورة', 'email')`);
await R.backfillRegistry();
const staff = await rows(sql`SELECT id, role, name, employee_key, department, heartbeat_interval_sec FROM bot_employees WHERE user_id = ${A} ORDER BY id`);
check("الاسم لم يُمسّ", staff.find((s) => s.role === "email")!.name === "اسمٌ غيّره صاحبه");
check("المفتاح والقسم والفترة", staff[0].employee_key === "email.director" && staff[0].department === "email" && Number(staff[0].heartbeat_interval_sec) === 21600, staff[0]);
const before = JSON.stringify(staff);
await R.backfillRegistry();
check("يُعاد بلا تغيير", JSON.stringify(await rows(sql`SELECT id, role, name, employee_key, department, heartbeat_interval_sec FROM bot_employees WHERE user_id = ${A} ORDER BY id`)) === before);
check("حسابٌ آخر مفتاحه له", (await one(sql`SELECT employee_key FROM bot_employees WHERE user_id = ${B}`)).employee_key === "email.copywriter");

// ── runAs: النبض من تشغيلٍ حقيقي فقط ──
check("لا نبض قبل أي تشغيل", !(await hb(A, "email.director")));
let inv = await R.orgRegistry(A);
check("الجرد: بلا عامل يقول no_execution لا سليم", inv.find((x) => x.role === "email_manager")!.heartbeat_status === "no_execution");
check("الجرد: الناقل بلا تنفيذ", inv.find((x) => x.role === "ig_inviter")!.execution === "none");
check("الجرد: دورٌ غير معروف بلا تنفيذ", inv.find((x) => x.role === "tax_helper")!.execution === "none");
check("الجرد: مكان الجدولة والدالة", !!inv.find((x) => x.role === "email_manager")!.scheduler_location && !!inv.find((x) => x.role === "email_manager")!.execution_function);

const v = await runAs(A, "email_manager", { kind: "t" }, async () => "نتيجة");
check("runAs يعيد القيمة", v === "نتيجة");
let h = await hb(A, "email.director");
const ex0 = (await execs(A, "email.director"))[0];
check("النبض كُتب", h && h.status === "idle" && !!h.last_success_at && !!h.last_started_at && !!h.last_completed_at && !!h.next_beat_at && h.worker_id === workerId(), h);
check("سطر تنفيذ بمدته", ex0.status === "succeeded" && ex0.duration_ms != null && ex0.kind === "t" && Number(h.last_execution_id) === Number(ex0.id));
inv = await R.orgRegistry(A);
check("الجرد: الآن سليم بآخر نجاح", inv.find((x) => x.role === "email_manager")!.heartbeat_status === "healthy" && !!inv.find((x) => x.role === "email_manager")!.last_success);

let threw = "";
await runAs(A, "email_manager", { kind: "t" }, async () => { throw new Error("انكسر"); }).catch((e) => { threw = e.message; });
h = await hb(A, "email.director");
check("الخطأ يُرمى كما هو ويُكتب", threw === "انكسر" && h.status === "failed" && h.consecutive_failures === 1 && h.last_error === "انكسر" && !!h.last_failure_at, h);
await runAs(A, "email_manager", { kind: "t" }, async () => { throw new Error("انكسر"); }).catch(() => {});
check("الفشل المتتالي يُعدّ", (await hb(A, "email.director")).consecutive_failures === 2);
await runAs(A, "email_manager", { kind: "t" }, async () => 1);
h = await hb(A, "email.director");
check("النجاح يصفّر العدّ والخطأ", h.consecutive_failures === 0 && h.last_error === null && h.status === "idle");

modelAnswer = "جواب";
await runAs(A, "email_manager", { kind: "metered" }, () => asAgent(A, "email_manager", () => complete([{ role: "user", content: "مرحبا" }])));
const metered = (await execs(A, "email.director")).find((e) => e.kind === "metered");
check("نداءات النموذج ورموزه في سطر التنفيذ", metered.model_calls === 1 && Number(metered.tokens_in) > 0 && Number(metered.tokens_out) > 0 && !!metered.model, metered);

// عاملٌ كثير الدقّات: الجداول لا تكبر.
for (let i = 0; i < 40; i++) await runAs(A, "email_queue", { kind: "drain", respect: "none", sampleMin: 15 }, async () => i);
check("٤٠ دقّة: سطر تنفيذ واحد", (await execs(A, "worker.email_queue")).length === 1);
check("...ونبضٌ واحد صفّاً", !!(await hb(A, "worker.email_queue")));
const firstBeat = (await hb(A, "worker.email_queue")).last_beat_at;
await new Promise((r) => setTimeout(r, 30));
await runAs(A, "email_queue", { kind: "drain", respect: "none", sampleMin: 15 }, async () => 0);
check("...ولا كتابة في كل دقّة", String((await hb(A, "worker.email_queue")).last_beat_at) === String(firstBeat));
await runAs(A, "email_queue", { kind: "drain", respect: "none", sampleMin: 15 }, async () => { throw new Error("x"); }).catch(() => {});
check("...والخطأ يُكتب فوراً", (await hb(A, "worker.email_queue")).status === "failed");
await beat(A, "email_queue", { kind: "drain_empty" });

// الموقوف لا يعمل.
await setControl({ scope: "employee", userId: A, target: "email_opens", engaged: true, reason: "اختبار", actor: A });
let ran = false;
const halted = await execute(A, "email_opens", { kind: "t" }, async () => { ran = true; });
check("موظفٌ موقوف لا يعمل", !halted.ran && !ran);
check("...ولا سطر تنفيذ", (await execs(A, "email.opens")).length === 0);
check("...والنبض يقول موقوف", (await hb(A, "email.opens")).status === "halted");
check("...وحساب آخر لا يتأثر", (await execute(B, "email_opens", { kind: "t" }, async () => 1)).ran);
check("respect=account: مفتاح الموظف لا يوقف عاملاً يسأل عن موظفيه بنفسه", (await execute(A, "email_opens", { kind: "t", respect: "account" }, async () => 1)).ran);
await setControl({ scope: "account", userId: A, target: "", engaged: true, actor: A });
check("مفتاح الحساب يوقف respect=account", !(await execute(A, "email_opens", { kind: "t", respect: "account" }, async () => 1)).ran);
check("والمعفى عمداً لا يقف (التشغيل)", (await execute(A, "ops", { kind: "t", respect: "none" }, async () => 1)).ran);
await db.execute(sql`DELETE FROM org_controls`); forgetControls();

// ── كل اسم قسم يوقف النقاط الثلاث: runAs وcomplete وgateSend ──
const DEPT_CASES: Array<{ target: string; role: string; other: string; channel: "instagram" | "tiktok" | "whatsapp" | "email" }> = [
  { target: "instagram", role: "ig_dm", other: "tt_dm", channel: "instagram" },
  { target: "tiktok", role: "tt_dm", other: "ig_dm", channel: "tiktok" },
  { target: "whatsapp", role: "sales", other: "email_guard", channel: "whatsapp" },
  { target: "email", role: "email_guard", other: "sales", channel: "email" },
  { target: "target_accounts", role: "accounts_writer", other: "sales", channel: "email" },
  { target: "executive", role: "chief", other: "sales", channel: "whatsapp" },
  // ومفتاح الموظف يصلح اسماً لمفتاح القسم.
  { target: "email.copywriter", role: "email", other: "email_guard", channel: "email" },
];
const threePoints = async (role: string, channel: DEPT_CASES_CHANNEL) => {
  const n0 = (await rows(sql`SELECT 1 FROM receipts WHERE user_id = ${A} AND status = 'blocked'`)).length; void n0;
  const f0 = fetched;
  const out = await asAgent(A, role, () => complete([{ role: "user", content: "مرحبا" }]));
  const run = await execute(A, role, { kind: "dept_test" }, async () => 1);
  const gate = await gateSend({ userId: A, channel, kind: "campaign", recipient: channel === "email" ? "dept@example.com" : "971500000009", role });
  return { model: out === null && fetched === f0, run: !run.ran, gate: !gate.allowed && gate.code === "halted" };
};
type DEPT_CASES_CHANNEL = "instagram" | "tiktok" | "whatsapp" | "email";
modelAnswer = "جواب";
for (const c of DEPT_CASES) {
  await db.execute(sql`DELETE FROM org_controls`); forgetControls();
  await setControl({ scope: "department", userId: A, target: c.target, engaged: true, reason: "اختبار", actor: A });
  const on = await threePoints(c.role, c.channel);
  check(`قسم ${c.target}: complete يتوقف`, on.model, on);
  check(`قسم ${c.target}: runAs يتوقف`, on.run, on);
  check(`قسم ${c.target}: gateSend يتوقف`, on.gate, on);
  const other = await threePoints(c.other, c.other === "sales" ? "whatsapp" : c.other === "email_guard" ? "email" : c.other === "tt_dm" ? "tiktok" : "instagram");
  if (!["whatsapp", "email"].includes(c.target) || c.other !== "sales") check(`قسم ${c.target}: غيره يعمل`, !other.model && !other.run, other);
}
// القناة وحدها (بلا موظف) تكفي gateSend لأسماء القنوات.
for (const ch of ["instagram", "tiktok", "whatsapp", "email"] as const) {
  await db.execute(sql`DELETE FROM org_controls`); forgetControls();
  await setControl({ scope: "department", userId: A, target: ch, engaged: true, actor: A });
  check(`قسم ${ch}: gateSend بلا موظف يتوقف`, !(await gateSend({ userId: A, channel: ch, kind: "campaign", recipient: ch === "email" ? "d@example.com" : "971500000009" })).allowed);
}
await db.execute(sql`DELETE FROM org_controls`); forgetControls();
await setControl({ scope: "department", userId: A, target: "social", engaged: true, actor: A });
check("اسم P0 (social) ما زال يوقف", !(await execute(A, "ig_dm", { kind: "t" }, async () => 1)).ran);
await db.execute(sql`DELETE FROM org_controls`); forgetControls();
await setControl({ scope: "employee", userId: A, target: "email.copywriter", engaged: true, actor: A });
check("مفتاح موظف بمفتاحه الثابت: runAs", !(await execute(A, "email", { kind: "t" }, async () => 1)).ran);
check("...وcomplete", (await asAgent(A, "email", () => complete([{ role: "user", content: "x" }]))) === null);
check("...وgateSend", !(await gateSend({ userId: A, channel: "email", kind: "campaign", recipient: "d@example.com", role: "email" })).allowed);
await db.execute(sql`DELETE FROM org_controls`); forgetControls();

// ── الطابور ──
const mk = (over: Partial<Parameters<typeof T.createTask>[0]> = {}) => T.createTask({ userId: A, ownerRole: "email_registrar", taskType: "t_ok", ...over });
const w1 = "w1:1", w2 = "w2:1";
const t1 = (await mk({ idempotencyKey: "k-1" }));
const t1b = (await mk({ idempotencyKey: "k-1" }));
check("مفتاح التكرار: مهمة واحدة", !t1.duplicate && t1b.duplicate && t1b.task.taskId === t1.task.taskId);
check("...وحسابٌ آخر له مفتاحه", !(await T.createTask({ userId: B, ownerRole: "x", taskType: "t_ok", idempotencyKey: "k-1" })).duplicate);
check("حالتها queued", t1.task.status === "queued");

// الجدولة: ما لم يحن لا يؤخذ، والأولوية تُحترم.
await db.execute(sql`DELETE FROM employee_tasks`);
const future = await mk({ nextAttemptAt: new Date(Date.now() + 3600_000) });
const low = await mk({ priority: 200 });
const high = await mk({ priority: 10 });
let got = await T.claimDue(w1, { types: ["t_ok"], limit: 1, userId: A });
check("الأولوية أولاً", got[0]?.taskId === high.task.taskId);
got = await T.claimDue(w2, { types: ["t_ok"], limit: 5, userId: A });
check("ما لم يحن موعده لا يؤخذ", got.length === 1 && got[0]!.taskId === low.task.taskId, got.map((g) => g.taskId));
check("لا يأخذ عاملان المهمة نفسها", (await T.claimDue(w2, { types: ["t_ok"], userId: A })).length === 0);
void future;
// SKIP LOCKED حقيقي: طلبان معاً.
await db.execute(sql`DELETE FROM employee_tasks`);
for (let i = 0; i < 6; i++) await mk();
const [c1, c2] = await Promise.all([T.claimDue(w1, { types: ["t_ok"], limit: 4, userId: A }), T.claimDue(w2, { types: ["t_ok"], limit: 4, userId: A })]);
const claimed = [...c1, ...c2].map((x) => x.taskId);
check("طلبان متزامنان لا يتقاطعان", new Set(claimed).size === claimed.length && claimed.length === 6, claimed);
check("الإكمال لصاحب العقد فقط", !(await T.completeTask(c1[0]!, "غريب")) && (await T.completeTask(c1[0]!, w1)));

// المحاولات، التراجع، dead letter.
await db.execute(sql`DELETE FROM employee_tasks`);
const r1 = await mk({ maxRetries: 2 });
await T.claimDue(w1, { types: ["t_ok"], userId: A });
check("الفشل الأول: يعود", (await T.failTask(r1.task, w1, "س")) === "retry");
let tr = (await T.getTask(A, r1.task.taskId))!;
check("...بمهلة", tr.status === "queued" && tr.retryCount === 1 && tr.nextAttemptAt! > new Date() && tr.failureReason === "س");
check("...ولا يؤخذ قبلها", (await T.claimDue(w1, { types: ["t_ok"], userId: A })).length === 0);
await db.execute(sql`UPDATE employee_tasks SET next_attempt_at = now() WHERE task_id = ${r1.task.taskId}`);
await T.claimDue(w1, { types: ["t_ok"], userId: A });
check("نفدت المحاولات: dead letter", (await T.failTask(r1.task, w1, "ص")) === "dead_letter");
tr = (await T.getTask(A, r1.task.taskId))!;
check("...failed وdead_letter", tr.status === "failed" && tr.deadLetter);
const rt = await T.retryTask(A, r1.task.taskId, A);
check("إعادتها بيد صاحب العمل", rt?.status === "queued" && rt.retryCount === 0 && !rt.deadLetter);
check("...مكتوبة في السجل", (await rows(sql`SELECT 1 FROM org_audit_log WHERE user_id = ${A} AND action = 'task.retried'`)).length === 1);
check("حسابٌ آخر لا يعيدها", (await T.retryTask(B, r1.task.taskId, B)) === null);

// الاعتماد.
await db.execute(sql`DELETE FROM employee_tasks`);
const p1 = await mk(), p2 = await mk();
const child = await mk({ dependsOn: [p1.task.taskId, p2.task.taskId] });
check("تنتظر ما تعتمد عليه", child.task.status === "waiting_for_dependency");
check("لا اعتماد على مهمة حساب آخر", await T.createTask({ userId: B, ownerRole: "x", taskType: "t", dependsOn: [p1.task.taskId] }).then(() => false, () => true));
await T.claimDue(w1, { types: ["t_ok"], userId: A });
check("لا تؤخذ وهي تنتظر", (await T.getTask(A, child.task.taskId))!.status === "waiting_for_dependency");
await T.completeTask(p1.task, w1);
check("بقي اعتماد: تبقى", (await T.getTask(A, child.task.taskId))!.status === "waiting_for_dependency");
await T.completeTask(p2.task, w1);
check("اكتمل الكل: إلى الطابور", (await T.getTask(A, child.task.taskId))!.status === "queued");
const dep = await mk(), kid = await mk({ dependsOn: [dep.task.taskId], maxRetries: 1 });
await T.cancelTask(A, dep.task.taskId, A);
check("أُلغي ما تعتمد عليه: تُلغى", (await T.getTask(A, kid.task.taskId))!.status === "cancelled");

// الموافقة.
await db.execute(sql`DELETE FROM employee_tasks`);
const ap = await mk({ approvalRequired: true });
check("تنتظر الموافقة", ap.task.status === "waiting_for_approval" && ap.task.approvalStatus === "pending");
check("...ولا تؤخذ", (await T.claimDue(w1, { types: ["t_ok"], userId: A })).length === 0);
check("حسابٌ آخر لا يوافق", (await T.approveTask(B, ap.task.taskId, B)) === null);
const apd = await T.approveTask(A, ap.task.taskId, A);
check("الموافقة: إلى الطابور", apd?.status === "queued" && apd.approvalStatus === "approved");
check("...وسطرٌ في السجل", (await rows(sql`SELECT 1 FROM org_audit_log WHERE user_id = ${A} AND action = 'task.approved' AND actor = ${A}`)).length === 1);
const rj = await mk({ approvalRequired: true });
const rjd = await T.rejectTask(A, rj.task.taskId, A, "لا");
check("الرفض: تُلغى بسببها", rjd?.status === "cancelled" && rjd.approvalStatus === "rejected" && rjd.failureReason === "لا");
check("لا موافقة بعد الرفض", (await T.approveTask(A, rj.task.taskId, A)) === null);

// الإلغاء والانتهاء.
const cn = await mk();
check("الإلغاء", (await T.cancelTask(A, cn.task.taskId, A))?.status === "cancelled");
check("لا يُلغى مرتين", (await T.cancelTask(A, cn.task.taskId, A)) === null);
const ex = await mk({ expiresAt: new Date(Date.now() - 1000) });
check("ما انتهت مهلته لا يؤخذ", !(await T.claimDue(w1, { types: ["t_ok"], userId: A })).some((x) => x.taskId === ex.task.taskId));
check("expireTasks", (await T.expireTasks()) >= 1 && (await T.getTask(A, ex.task.taskId))!.status === "expired");

// العامل: كل معالج عبر runAs والمفتاح.
await db.execute(sql`DELETE FROM employee_tasks`); await db.execute(sql`DELETE FROM employee_executions`);
let handled = 0;
T.registerTaskHandler("t_ok", { external: false, run: async () => { handled++; return { done: true }; } });
T.registerTaskHandler("t_bad", { external: false, run: async () => { throw new Error("معطوب"); } });
const ok = await mk();
const bad = await mk({ taskType: "t_bad" });
const inbox = await mk({ taskType: "t_inbox" });
await T.runTaskWorkerOnce("wk:1");
check("العامل نفّذ", handled === 1 && (await T.getTask(A, ok.task.taskId))!.status === "completed");
check("...بمخرجه", (await T.getTask(A, ok.task.taskId))!.outputRefs?.done === true);
check("...وسطر تنفيذ بمهمته", (await rows(sql`SELECT 1 FROM employee_executions WHERE task_id = ${ok.task.taskId} AND status = 'succeeded'`)).length === 1);
check("الفاشل يعود بمهلة", (await T.getTask(A, bad.task.taskId))!.retryCount === 1);
check("ما لا معالج له يبقى في صندوق موظفه", (await T.getTask(A, inbox.task.taskId))!.status === "queued");
await setControl({ scope: "employee", userId: A, target: "email_registrar", engaged: true, actor: A });
const hq = await mk(); handled = 0;
await T.runTaskWorkerOnce("wk:1");
const hqt = (await T.getTask(A, hq.task.taskId))!;
check("موظفٌ موقوف: لا تُنفَّذ، وتعود بلا عقوبة", handled === 0 && hqt.status === "queued" && hqt.retryCount === 0 && hqt.nextAttemptAt! > new Date(), hqt);
await db.execute(sql`DELETE FROM org_controls`); forgetControls();

// ── الحارس ──
await db.execute(sql`DELETE FROM employee_tasks`); await db.execute(sql`DELETE FROM org_audit_log WHERE action = 'watchdog.finding'`); await db.execute(sql`DELETE FROM execution_events`);
await db.execute(sql`INSERT INTO employee_heartbeats (user_id, employee_key, status, last_beat_at, interval_sec) VALUES (${A}, 'email.analyst', 'idle', now() - interval '3 days', 86400), (${A}, 'email.data', 'idle', now() - interval '1 hour', 86400)`);
let f = await W.watchdogFindings(A);
check("نبضٌ فات ضعف فترته", f.some((x) => x.kind === "missed_heartbeat" && x.subject === "email.analyst"));
check("...وما في موعده لا يُذكر", !f.some((x) => x.kind === "missed_heartbeat" && x.subject === "email.data"));
check("...وحسابٌ آخر لا يراه", !(await W.watchdogFindings(B)).some((x) => x.subject === "email.analyst"));

T.registerTaskHandler("t_ext", { external: true, run: async () => {} });
const leaseOk = await mk(), leaseExt = await mk({ taskType: "t_ext" }), leaseUnknown = await mk({ taskType: "t_gone" });
await db.execute(sql`UPDATE employee_tasks SET status = 'running', lease_owner = 'مات', lease_expires_at = now() - interval '1 minute' WHERE user_id = ${A}`);
await db.execute(sql`INSERT INTO employee_executions (user_id, employee_key, status, kind, started_at) VALUES (${A}, 'email.data', 'running', 'علق', now() - interval '3 hours')`);
await db.execute(sql`UPDATE employee_heartbeats SET consecutive_failures = 4, last_error = 'x' WHERE user_id = ${A} AND employee_key = 'email.data'`);
const dupA = await mk({ input: { a: 1 }, taskType: "t_inbox" }), dupB = await mk({ input: { a: 1 }, taskType: "t_inbox" });
void dupA; void dupB;
const wait = await mk({ approvalRequired: true, taskType: "t_inbox2" });
await db.execute(sql`UPDATE employee_tasks SET updated_at = now() - interval '9 days' WHERE task_id = ${wait.task.taskId}`);
const round = await W.watchdogRound();
const kinds = round.findings.filter((x) => x.userId === A).map((x) => x.kind);
check("عقدٌ انتهى بلا أثر خارجي: يعود", (await T.getTask(A, leaseOk.task.taskId))!.status === "queued" && kinds.includes("lease_requeued"));
const ext = (await T.getTask(A, leaseExt.task.taskId))!;
check("عقدٌ انتهى وله أثر خارجي: لا يُعاد عمياناً", ext.status === "waiting_for_approval" && ext.approvalStatus === "pending" && kinds.includes("lease_needs_review"), ext);
check("معالجٌ مجهول: كذلك", (await T.getTask(A, leaseUnknown.task.taskId))!.status === "waiting_for_approval");
check("تنفيذٌ علق: يُغلق فاشلاً", round.closed === 1 && (await one(sql`SELECT status, error FROM employee_executions WHERE kind = 'علق'`)).status === "failed");
check("...ويُذكر", kinds.includes("stuck_execution"));
check("فشلٌ متكرر", kinds.includes("repeated_failures"));
check("انتظارٌ طويل", kinds.includes("waiting_too_long"));
check("تكرار مهام", kinds.includes("duplicate_task"));
const auditN = (await one(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE action = 'watchdog.finding' AND user_id = ${A}`)).n;
const eventsN = (await one(sql`SELECT count(*)::int AS n FROM execution_events WHERE user_id = ${A}`)).n;
check("كل نتيجة في السجل وفي الأحداث", auditN >= 5 && eventsN === auditN, { auditN, eventsN });
await W.watchdogRound();
check("مرورٌ ثانٍ: لا نمو", (await one(sql`SELECT count(*)::int AS n FROM execution_events WHERE user_id = ${A}`)).n === eventsN);
check("الحارس لم يلمس الشبكة ولا الطابور", (await rows(sql`SELECT 1 FROM email_messages WHERE user_id = ${A}`)).length === 0);
const appr = await T.approveTask(A, leaseExt.task.taskId, A);
check("بعد المراجعة تعود بالموافقة", appr?.status === "queued");

// الاحتفاظ.
await db.execute(sql`INSERT INTO employee_executions (user_id, employee_key, status, started_at) VALUES (${A}, 'old', 'succeeded', now() - interval '31 days'), (${A}, 'new', 'succeeded', now() - interval '29 days')`);
await db.execute(sql`INSERT INTO execution_events (user_id, event, created_at) VALUES (${A}, 'old', now() - interval '31 days'), (${A}, 'new', now() - interval '29 days')`);
const kept = await W.orgRetention();
check("الاحتفاظ: ٣٠ يوماً للتنفيذ والأحداث", kept.executions >= 1 && kept.events >= 1 && (await rows(sql`SELECT 1 FROM employee_executions WHERE employee_key = 'old'`)).length === 0 && (await rows(sql`SELECT 1 FROM employee_executions WHERE employee_key = 'new'`)).length === 1 && (await rows(sql`SELECT 1 FROM execution_events WHERE event = 'new'`)).length === 1);

// ── الدرس المعلّق لا يصل prompt ──
await remember(A, "sales", "instruction", "قاعدة كتبها نموذج", undefined, { pending: true });
await remember(A, "sales", "instruction", "قاعدة صاحب العمل");
const pre = await memoryPreamble(A, "sales");
check("المعلّق لا يدخل prompt", !pre.includes("قاعدة كتبها نموذج") && pre.includes("قاعدة صاحب العمل"));
await rememberLesson(A, "win", "درس كتبه نموذج", null, { pending: true });
await rememberLesson(A, "win", "درس محسوب بأرقامه", null);
const br = await brief(A, [], 3500);
check("brief كذلك", !br.includes("درس كتبه نموذج") && br.includes("درس محسوب بأرقامه"));
await db.execute(sql`UPDATE agent_memory SET approval_status = 'approved' WHERE user_id = ${A} AND content = 'درس كتبه نموذج'`);
check("بعد الاعتماد يدخل", (await brief(A, [], 3500)).includes("درس كتبه نموذج"));

// ── الطابور: الحجز والقِدم والتكرار ──
await clean();
T.forgetHandlers();
H.registerOrgHandlers();
const { emailContactsTable, emailCampaignsTable, targetAccountsTable, emailSequencesTable, emailSequenceJobsTable, emailSettingsTable, emailMissionsTable, emailListsTable, emailListMembersTable, emailAutopilotTable, emailInboundTable } = await import("@workspace/db");
const { nextQueued, drainOne, startCampaign, stallReason } = await import("../email/service");
const { count, resolve } = await import("../email/segments");
const contact = async (email: string, extra: any = {}) => (await db.insert(emailContactsTable).values({ userId: A, email, status: "active", mxOk: true, ...extra }).returning())[0]!;
const [camp] = await db.insert(emailCampaignsTable).values({ userId: A, name: "موجة", subject: "Subject", html: "<p>Hello</p>", status: "sending", language: "en" }).returning();
const queueMsg = async (c: any, days = 0, over: any = {}) => (await db.insert(emailMessagesTable).values({ userId: A, campaignId: camp!.id, contactId: c.id, toEmail: c.email, subject: "S", token: `t-${c.id}-${Math.random()}`, status: "queued", createdAt: new Date(Date.now() - days * 86_400_000), ...over }).returning())[0]!;

const c1a = await contact("a@reserved.ae", { sector: "عقارات" });
const c2a = await contact("b@free-of-desk.ae", { sector: "عقارات" });
await db.insert(targetAccountsTable).values({ userId: A, company: "محجوزة", domain: "reserved.ae", status: "researching", runDate: "2026-11-09" });
check("الموجة لا تختار نطاقاً محجوزاً", (await resolve(A, { sectors: ["عقارات"], notReserved: true }, { sendable: true })).every((x) => x.email !== "a@reserved.ae") && (await count(A, { sectors: ["عقارات"], notReserved: true }, true)) === 1);
check("...وبلا الشرط يختاره (حملة يدوية)", (await count(A, { sectors: ["عقارات"] }, true)) === 2);

const wave = await queueMsg(c1a);
check("رسالة موجة إلى نطاق له رسالة مكتب تنتظر: لا تخرج", (await nextQueued(A)) === null);
const [seq] = await db.insert(emailSequencesTable).values({ userId: A, name: "مكتب الحسابات · محجوزة", steps: [{ afterHours: 0, subject: "Hi", html: "<p>x</p>" }], isActive: true }).returning();
const [job] = await db.insert(emailSequenceJobsTable).values({ userId: A, sequenceId: seq!.id, contactId: c1a.id, stepIndex: 0, dueAt: new Date(), status: "sent" }).returning();
const deskMsg = await queueMsg(c1a, 0, { campaignId: null, sequenceJobId: job!.id });
check("ورسالة المكتب نفسها تخرج أولاً", (await nextQueued(A))?.id === deskMsg.id);
await setControl({ scope: "department", userId: A, target: "target_accounts", engaged: true, actor: A });
check("مفتاح target_accounts يمسك رسالة المكتب في المصرف", (await nextQueued(A))?.id !== deskMsg.id);
await db.execute(sql`DELETE FROM org_controls`); forgetControls();
await db.delete(emailMessagesTable).where(eq(emailMessagesTable.id, deskMsg.id));
await db.update(targetAccountsTable).set({ status: "sent", sequenceId: seq!.id, sentAt: null }).where(eq(targetAccountsTable.domain, "reserved.ae"));
check("دخلت الطابور ولم تخرج: ما زالت محجوزة", (await nextQueued(A)) === null);
await db.update(targetAccountsTable).set({ sentAt: new Date() }).where(eq(targetAccountsTable.domain, "reserved.ae"));
check("خرجت ولا متابعة تنتظر: تُفرج", (await nextQueued(A))?.id === wave.id);
await db.update(emailSequenceJobsTable).set({ status: "pending" }).where(eq(emailSequenceJobsTable.id, job!.id));
check("لها متابعة تنتظر: تبقى ممسوكة", (await nextQueued(A)) === null);
await db.update(targetAccountsTable).set({ status: "skipped" }).where(eq(targetAccountsTable.domain, "reserved.ae"));
check("تخطّاها المكتب: تُفرج", (await nextQueued(A))?.id === wave.id);
await db.delete(emailMessagesTable).where(eq(emailMessagesTable.userId, A));

// القِدم.
const old1 = await contact("old@one.ae"), old2 = await contact("stop@two.ae", { status: "unsubscribed" }), old3 = await contact("gone@three.ae", { status: "bounced" });
const old4 = await contact("said@four.ae", { lastRepliedAt: new Date() }), old5 = await contact("col@five.ae"), old6 = await contact("fresh@six.ae"), old7 = await contact("x@gmail.com");
await db.insert(emailInboundTable).values({ userId: A, fromEmail: "boss@five.ae", subject: "re", text: "yes", kind: "reply", state: "new" });
await db.insert(emailInboundTable).values({ userId: A, fromEmail: "other@gmail.com", subject: "re", text: "yes", kind: "reply", state: "new" });
const qm = { ok: await queueMsg(old1, 10), stop: await queueMsg(old2, 10), gone: await queueMsg(old3, 16), said: await queueMsg(old4, 40), col: await queueMsg(old5, 10), fresh: await queueMsg(old6, 1), free: await queueMsg(old7, 9) };
check("فحص القديم: ردّت شركته", (await Q.staleIneligible(A, old5)) === "company_replied");
check("...والبريد الحر لا يُعدّ شركة", (await Q.staleIneligible(A, old7)) === null);
check("...والصامت مؤهل", (await Q.staleIneligible(A, old1)) === null);
const freshStop = await contact("stop@fresh.ae", { status: "unsubscribed" });
const qFreshStop = await queueMsg(freshStop, 1);
const rev = await Q.queueReview(A);
check("التقرير: العدد والأعمار", rev.total === 8 && rev.age.under7 === 2 && rev.age.d7to14 === 4 && rev.age.d14to30 === 1 && rev.age.over30 === 1, rev.age);
check("التقرير: غير المؤهل", rev.ineligible.opted_out === 2 && rev.ineligible.bounced === 1 && rev.ineligible.replied === 1 && rev.ineligible.company_replied === 1, rev.ineligible);
check("التقرير: القديم المؤهل ممسوك ومعدود", rev.heldStale === 2 && rev.released === 0, rev.heldStale);
check("التقرير لا يغيّر شيئاً", (await rows(sql`SELECT 1 FROM email_messages WHERE user_id = ${A} AND status = 'queued'`)).length === 8);
check("القديم المؤهل لا يخرج وحده، والحديث يخرج", (await nextQueued(A))?.id === qFreshStop.id || (await nextQueued(A))?.id === qm.fresh.id);
{
  const ids = new Set<number>();
  for (const m of await rows(sql`SELECT id FROM email_messages WHERE user_id = ${A} AND status = 'queued'`)) ids.add(Number(m.id));
  await db.execute(sql`UPDATE email_messages SET status = 'parked' WHERE id IN (${qm.fresh.id}, ${qFreshStop.id})`);
  check("لم يبقَ إلا القديم: لا شيء يخرج", (await nextQueued(A)) === null);
  await db.execute(sql`UPDATE email_messages SET status = 'queued' WHERE id IN (${qm.fresh.id}, ${qFreshStop.id})`);
}
const done = await Q.applyQueueReview(A, A);
check("التطبيق: غير المؤهل بوضوح فقط", done.opted_out === 1 && done.bounced === 1 && done.replied === 1 && done.company_replied === 1, done);
const stat = async (m: any) => (await one(sql`SELECT status, error FROM email_messages WHERE id = ${m.id}`));
check("...بسبب مكتوب", (await stat(qm.stop)).status === "cancelled" && (await stat(qm.stop)).error === Q.INELIGIBLE_AR.opted_out);
check("...والصامت القديم باقٍ", (await stat(qm.ok)).status === "queued" && (await stat(qm.free)).status === "queued" && (await stat(qm.fresh)).status === "queued");
check("...ومكتوب في السجل", (await rows(sql`SELECT 1 FROM org_audit_log WHERE user_id = ${A} AND action = 'queue.cleaned'`)).length === 1);
check("ما دون الأسبوع لا يُمسّ ولو غير مؤهل", (await stat(qFreshStop)).status === "queued");
await db.execute(sql`UPDATE email_messages SET status = 'parked' WHERE id IN (${qm.fresh.id}, ${qFreshStop.id})`);

// الإفراج بعد إعادة التقييم.
const lateStop = await contact("late@stop.ae");
const qLate = await queueMsg(lateStop, 9);
await db.update(emailContactsTable).set({ status: "unsubscribed" }).where(eq(emailContactsTable.id, lateStop.id));
const notMine = await Q.releaseStale(B, {}, B);
check("حساب آخر لا يفرج", notMine.released === 0 && (await nextQueued(A)) === null);
const scoped = await Q.releaseStale(A, { campaignId: 999999 }, A);
check("نطاق حملةٍ أخرى لا يمسّ شيئاً", scoped.released === 0 && (await nextQueued(A)) === null);
const relOut = await Q.releaseStale(A, { campaignId: camp!.id }, A);
check("الإفراج: المؤهل يعود", relOut.released === 2 && [qm.ok.id, qm.free.id].includes((await nextQueued(A))?.id ?? 0), relOut);
check("...وغير المؤهل يُلغى بسببه لا يُفرج عنه", relOut.cancelled.opted_out === 1 && (await stat(qLate)).status === "cancelled", relOut.cancelled);
check("...ومكتوب في السجل", (await rows(sql`SELECT 1 FROM org_audit_log WHERE user_id = ${A} AND action = 'queue.released' AND actor = ${A}`)).length === 2);
check("...ولا يخرج شيء من الفحص نفسه (لا إرسال)", (await rows(sql`SELECT 1 FROM email_messages WHERE user_id = ${A} AND status = 'sent'`)).length === 0);
const revR = await Q.queueReview(A);
check("...والتقرير يعدّه مُفرَجاً", revR.released === 2 && revR.heldStale === 0, revR.released);
await db.execute(sql`UPDATE email_messages SET status = 'queued' WHERE id IN (${qm.fresh.id}, ${qFreshStop.id})`);
// رسالة المكتب القديمة ليست معفاة.
{
  const dc = await contact("boss@olddesk.ae");
  const [dq] = await db.insert(emailSequencesTable).values({ userId: A, name: "مكتب الحسابات · قديمة", steps: [{ afterHours: 0, subject: "Hi", html: "<p>x</p>" }], isActive: true }).returning();
  const [dj] = await db.insert(emailSequenceJobsTable).values({ userId: A, sequenceId: dq!.id, contactId: dc.id, stepIndex: 0, dueAt: new Date(), status: "sent" }).returning();
  const dm = await queueMsg(dc, 8, { campaignId: null, sequenceJobId: dj!.id });
  const firstPick = await nextQueued(A);
  check("رسالة مكتب أقدم من أسبوع ممسوكة كغيرها", firstPick?.id !== dm.id, firstPick?.id);
  await db.delete(emailMessagesTable).where(eq(emailMessagesTable.id, dm.id));
}

// المهمة المتروكة: لا تخرج وحدها ولا تُلغى.
const [ms] = await db.insert(emailMissionsTable).values({ userId: A, name: "متروكة", goal: "g", filter: {}, status: "paused", stage: "sending", campaignId: camp!.id }).returning();
await db.update(emailCampaignsTable).set({ missionId: ms!.id }).where(eq(emailCampaignsTable.id, camp!.id));
const nx = await nextQueued(A);
check("مهمة تُركت بعد الإفراج: تعود ممسوكة، والحديثة تُختار", [qm.fresh.id, qFreshStop.id].includes(nx?.id ?? 0), nx?.id);
const rev2 = await Q.queueReview(A);
check("...وتظهر ممسوكة في التقرير", rev2.heldDeadMission === 2 && rev2.byMission.some((m) => m.missionId === ms!.id && m.queued === 4), rev2);
const rel2 = await Q.releaseStale(A, { missionId: ms!.id }, A);
check("...والإفراج لا يخرجها، ويعدّها", rel2.released === 0, rel2);
await db.delete(emailMessagesTable).where(eq(emailMessagesTable.userId, A));
await db.delete(emailMissionsTable).where(eq(emailMissionsTable.id, ms!.id));
await db.update(emailCampaignsTable).set({ missionId: null }).where(eq(emailCampaignsTable.id, camp!.id));

// لا شركة في حملتين نشطتين.
await db.insert(emailSettingsTable).values({ userId: A, provider: "smtp", fromEmail: "me@ours.ae", fromName: "Team", smtpHost: "127.0.0.1", smtpPort: 1, smtpUser: "u", smtpPass: "p", guardHoldUntil: null } as any).onConflictDoNothing();
const dup1 = await contact("sales@dup.ae"), dup2 = await contact("info@dup.ae"), dupFree = await contact("y@gmail.com");
await queueMsg(dup1, 0);
const [listD] = await db.insert(emailListsTable).values({ userId: A, name: "ق" }).returning();
await db.insert(emailListMembersTable).values([{ listId: listD!.id, contactId: dup2.id }, { listId: listD!.id, contactId: dupFree.id }]);
const [camp2] = await db.insert(emailCampaignsTable).values({ userId: A, name: "ثانية", listId: listD!.id, subject: "Subject two", html: "<p>Hello there</p>", status: "draft", language: "en" }).returning();
const st2 = await startCampaign(A, camp2!.id);
const q2 = await rows(sql`SELECT to_email FROM email_messages WHERE campaign_id = ${camp2!.id}`);
check("شركة في حملة نشطة لا تدخل ثانية", !q2.some((x) => x.to_email === "info@dup.ae"), q2);
check("...والبريد الحر يدخل", q2.some((x) => x.to_email === "y@gmail.com") && st2.queued === 1, st2);

// ── السلسلة كاملة بنموذجٍ مستبدل ──
await clean();
T.forgetHandlers();
H.registerOrgHandlers();
const { anglesFor } = await import("../email/policy");
const { ensureEmailTeam } = await import("../email/team");
const { runSpecialist } = await import("../email/specialists");
const { runAutopilot } = await import("../email/autopilot");
const { runMission } = await import("../email/missions");
const { factsFor } = await import("../email/specialists");
const { handleInbound } = await import("../email/inbound");

await db.insert(emailSettingsTable).values({ userId: A, provider: "smtp", fromEmail: "me@ours.ae", fromName: "Team", smtpHost: "127.0.0.1", smtpPort: 1, smtpUser: "u", smtpPass: "p" } as any);
await ensureEmailTeam(A);
await R.backfillRegistry(A);
await db.insert(emailAutopilotTable).values({ userId: A, enabled: true, mode: "auto", waveSize: 30, maxTouches: 4 } as any);
const SECTOR = "عقارات";
const angles = anglesFor("aml", SECTOR);
const dead = angles[0]!;
check("للقطاع زاويتان على الأقل (شرط الاختبار)", angles.length >= 2);
// زاوية جُرّبت على ١٦٠ شركة بلا رد: حكمها rewrite بالحساب.
const [oldCamp] = await db.insert(emailCampaignsTable).values({ userId: A, name: "قديمة", subject: "Old subject", html: "<p>Old</p>", status: "completed", language: "en", completedAt: new Date(Date.now() - 86_400_000) }).returning();
await db.insert(emailMissionsTable).values({ userId: A, name: "قديمة", goal: "AML", filter: { sectors: [SECTOR] }, status: "active", stage: "done", track: "aml", angle: dead.id, campaignId: oldCamp!.id, createdAt: new Date(Date.now() - 5 * 86_400_000) });
const seedC = await db.insert(emailContactsTable).values(Array.from({ length: 160 }, (_, i) => ({ userId: A, email: `p${i}@seed${i}.ae`, status: "active", mxOk: true, sector: SECTOR, lastSentAt: new Date(Date.now() - 4 * 86_400_000) }))).returning();
await db.insert(emailMessagesTable).values(seedC.map((c, i) => ({ userId: A, campaignId: oldCamp!.id, contactId: c.id, toEmail: c.email, subject: "Old subject", token: `seed-${i}-${A}`, status: "sent", sentAt: new Date(Date.now() - 4 * 86_400_000) })));
// جمهور جديد لم يُراسَل، في قائمة.
const fresh = await db.insert(emailContactsTable).values(Array.from({ length: 20 }, (_, i) => ({ userId: A, email: `info@new${i}.ae`, company: `New ${i}`, status: "active", mxOk: true, sector: SECTOR }))).returning();
const [lst] = await db.insert(emailListsTable).values({ userId: A, name: "عقارات" }).returning();
await db.insert(emailListMembersTable).values(fresh.map((c) => ({ listId: lst!.id, contactId: c.id })));

// ١ · جاسم
modelAnswer = "الحكم: زاوية لم تنفع\nالأهم: تُستبدل\nالتفاصيل:\n- ١٦٠ شركة بلا رد نافع\nالخطوة: زاوية أخرى";
const rep = await runSpecialist(A, "email_analyst");
check("١ جاسم عمل بنموذجٍ مستبدل", !!rep && rep.verdict.includes("زاوية"), rep?.verdict);
const anExec = (await execs(A, "email.analyst")).at(-1);
check("١ نبضه وتنفيذه ونداء نموذجه", anExec.status === "succeeded" && anExec.model_calls >= 1 && (await hb(A, "email.analyst")).status === "idle", anExec);
const review = (await rows(sql`SELECT * FROM employee_tasks WHERE user_id = ${A} AND task_type = 'review_results'`));
check("١ مهمة لمنصور بدليلها", review.length === 1 && review[0].owner_role === "email_manager" && review[0].input_refs.angles.some((a: any) => a.key === dead.id && a.verdict === "rewrite"), review[0]?.input_refs);
await runSpecialist(A, "email_analyst");
check("١ مرةً في اليوم", (await rows(sql`SELECT 1 FROM employee_tasks WHERE user_id = ${A} AND task_type = 'review_results'`)).length === 1);
modelAnswer = null;
check("١ النموذج صامت: فشلٌ في النبض وnull للمستدعي", (await runSpecialist(A, "email_analyst")) === null && (await hb(A, "email.analyst")).status === "failed");
modelAnswer = "الحكم: سليم";

// ٢ · منصور
await T.runTaskWorkerOnce("e2e:1");
check("٢ منصور راجع بالعامل", (await one(sql`SELECT status FROM employee_tasks WHERE task_type = 'review_results' AND user_id = ${A}`)).status === "completed");
check("٢ نبض منصور من معالج حقيقي", !!(await hb(A, "email.director")));
const dirs = await rows(sql`SELECT * FROM employee_tasks WHERE user_id = ${A} AND task_type = 'strategy_directive' ORDER BY owner_role`);
check("٢ توجيه لسلمى ولنورة", dirs.length === 2 && dirs.every((d) => d.status === "queued" && d.input_refs.avoidAngles.includes(dead.id)), dirs.map((d) => d.status));
check("٢ بلا رسالة في agent_messages بدلها", dirs[0].created_by_role === "email_manager" && dirs[0].parent_task_id != null);

// ٣ · سلمى
const ap1 = await runAutopilot(A);
const waves = await rows(sql`SELECT * FROM email_missions WHERE user_id = ${A} AND stage = 'draft' ORDER BY id`);
check("٣ سلمى أطلقت موجة", ap1.waves === 1 && waves.length === 1, { ap1, waves: waves.length });
check("٣ بغير الزاوية التي حكم عليها جاسم", waves[0].angle !== dead.id, waves[0]?.angle);
check("٣ موجةٌ عادية تحترم الحجز", waves[0].filter.notReserved === true);
const dirS = (await rows(sql`SELECT * FROM employee_tasks WHERE user_id = ${A} AND task_type = 'strategy_directive' AND owner_role = 'email_strategist'`))[0];
check("٣ التوجيه اكتمل حين استُعمل، بمهمته", dirS.status === "completed" && dirS.output_refs[0].missionId === waves[0].id, dirS);
check("٣ نبض سلمى", (await hb(A, "email.strategist")).status === "idle");

// حصّة: نمطٌ بعيّنة كافية يدخل prompt.
await H.handoffSubjectGuidance(A, { measurable: true, subjects: [{ subject: "Your AML file", sent: 40, opened: 20, replied: 3, rate: 50 }] });
const noisy = await H.handoffSubjectGuidance(A, { measurable: true, subjects: [{ subject: "Tiny", sent: 5, opened: 5, replied: 5, rate: 100 }] });
check("حصّة: عيّنة صغيرة لا تصنع مهمة", noisy.length === 0);

// ٤ · نورة بنموذجٍ مستبدل، ٥ · ماجد
const mission = (await db.select().from(emailMissionsTable).where(eq(emailMissionsTable.id, waves[0].id)))[0]!;
const goodBody = `[عنوان] {{company|Your brokerage}} file check
[عنوان] Who owns the buyer file
[الرسالة]
[معاينة] One question about the file at your firm today
[عنوان كبير] A short note about your compliance file
Hello {{first_name|there}},

[ملخص] Real-estate firms handle buyer files every week, and {{company|your company}} may want a second pair of eyes on them. We check what is missing and tell you plainly.

[زر] Check my AML gaps

[تفاصيل]
- Buyer due diligence on file
- What we would review

Best regards,
The Pro Count team
[/الرسالة]
[متابعة بعد=72 جمهور=دافئ]
عنوان: A question for {{company|your company}}
[ملخص] One more thought on buyer files at {{company|your company}}: who keeps them today, and is that written down anywhere for the team?
[زر] Send me the checklist
The Pro Count team
[/متابعة]
[متابعة بعد=72 جمهور=بارد]
عنوان: File check
[ملخص] A short version of our note on buyer files at {{company|your company}}, with one simple question about who keeps them today.
[زر] Worth a look?
The Pro Count team
[/متابعة]
[السبب] زاوية جديدة`;
modelAnswer = goodBody.replace("We check what is missing", "guaranteed compliance, We check what is missing");
prompts.length = 0;
await runMission(mission);
const prompt1 = prompts.join("\n");
check("٤ prompt نورة فيه توجيه منصور", prompt1.includes("توجيه منصور") && prompt1.includes(dead.label), prompt1.length);
check("٤ وعناوين حصّة بعيّنتها", prompt1.includes("Your AML file") && !prompt1.includes("Tiny"));
const dirN = (await rows(sql`SELECT * FROM employee_tasks WHERE user_id = ${A} AND task_type = 'strategy_directive' AND owner_role = 'email'`))[0];
check("٤ توجيه نورة اكتمل حين كُتبت به", dirN.status === "completed" && dirN.output_refs[0].by === "email");
const fb = await rows(sql`SELECT * FROM employee_feedback WHERE user_id = ${A} AND employee_key = 'email.copywriter'`);
check("٥ ماجد رفض، والرفض وصل الكاتبة ملاحظة", fb.length >= 1 && fb.every((x) => x.verdict === "bad" && x.from_role === "email_guard"), fb.map((x) => x.note));
const m2 = (await db.select().from(emailMissionsTable).where(eq(emailMissionsTable.id, mission.id)))[0]!;
check("٥ لم تخرج، وعادت للكتابة", m2.stage === "draft" && !m2.campaignId);
const fbN = fb.length;
await runMission(m2);
check("٥ العيب نفسه لا يتكرر ملاحظة", (await rows(sql`SELECT 1 FROM employee_feedback WHERE user_id = ${A} AND employee_key = 'email.copywriter'`)).length === fbN);
check("٥ وعداده يزيد", (await rows(sql`SELECT 1 FROM employee_feedback WHERE user_id = ${A} AND (evidence->>'times')::int >= 2`)).length >= 1);
prompts.length = 0;
modelAnswer = goodBody;
const m3 = (await db.select().from(emailMissionsTable).where(eq(emailMissionsTable.id, mission.id)))[0]!;
await runMission(m3);
check("٥ الكتابة التالية فيها ما أوقفه ماجد", prompts.join("\n").includes("ما أوقفه ماجد"));
const m4 = (await db.select().from(emailMissionsTable).where(eq(emailMissionsTable.id, mission.id)))[0]!;
check("٥ نصٌّ سليم يمرّ ويدخل الطابور", m4.stage === "sending" && !!m4.campaignId, { stage: m4.stage, log: await rows(sql`SELECT kind, left(text, 120) AS t FROM email_mission_log WHERE mission_id = ${mission.id} ORDER BY id DESC LIMIT 3`) });
const queued = m4.campaignId ? await rows(sql`SELECT id, contact_id, to_email FROM email_messages WHERE campaign_id = ${m4.campaignId} AND status IN ('queued','ab_hold')`) : [];
check("٥ رسائل في الطابور لا إرسال", queued.length > 0 && (await rows(sql`SELECT 1 FROM email_messages WHERE campaign_id = ${m4.campaignId} AND status = 'sent'`)).length === 0);
const nora = await hb(A, "email.copywriter");
void nora;

// ٦ · البوابة: وضع الاختبار يرفض ويسجّل.
await setControl({ scope: "channel", userId: A, target: "email", engaged: true, reason: "وضع اختبار", actor: A });
const gate = await gateSend({ userId: A, channel: "email", kind: "campaign", recipient: queued[0]?.to_email, role: "email_guard" });
check("٦ البوابة ترفض", !gate.allowed && gate.code === "halted");
check("٦ والرفض في السجل", (await rows(sql`SELECT 1 FROM org_audit_log WHERE user_id = ${A} AND action = 'gate.refused' AND channel = 'email'`)).length >= 1);
check("٦ والمصرف لا يختار رسالة", (await drainOne(A)) === false && (stallReason(A)?.why ?? "").includes("مفتاح الإيقاف"));
check("٦ والطابور كما هو", (await rows(sql`SELECT 1 FROM email_messages WHERE campaign_id = ${m4.campaignId} AND status = 'sent'`)).length === 0);
await db.execute(sql`DELETE FROM org_controls`); forgetControls();
check("٦ لا نداء شبكة غير النموذج", !prompts.some((p) => p.includes("smtp")));

// ٧ · الرد يصل جاسم
await db.execute(sql`UPDATE email_messages SET status = 'sent', sent_at = now() WHERE id = ${queued[0]?.id}`);
await db.execute(sql`UPDATE email_contacts SET last_sent_at = now() WHERE id = ${queued[0]?.contact_id}`);
modelAnswer = "مسودة";
const inb = await handleInbound(A, { from: queued[0]?.to_email, fromName: "Buyer", subject: "Re: file", text: "Yes we are interested, please send the price and details for our company.", html: null, messageId: "<t@x>", inReplyTo: null, references: null } as any);
check("٧ الرد صُنّف رداً", inb?.isReply === true, inb);
await new Promise((r) => setTimeout(r, 200));
const le = await rows(sql`SELECT * FROM learning_events WHERE user_id = ${A} AND event_type = 'reply_outcome'`);
check("٧ حدثٌ لجاسم معلّق بالمهمة والزاوية", le.length === 1 && le[0].employee_key === "email.analyst" && Number(le[0].evidence.missionId) === mission.id && le[0].evidence.angle === m4.angle && le[0].outcome === "positive", le[0]);
const facts = await factsFor(A, "email_analyst");
check("٧ جاسم يقرؤه في وقائعه", facts.text.includes("الردود كما سجّلتها ليلى") && facts.text.includes("نافع 1"), facts.text.slice(-300));

// مريم: المقترح ينتظر، والموافقة تنشئ الموجة.
await db.execute(sql`UPDATE email_contacts SET last_sent_at = now() - interval '10 days', last_opened_at = now() - interval '9 days' WHERE email LIKE 'p%@seed%' AND user_id = ${A}`);
const tid = await H.handoffRetarget(A, [{ cohort: "opened", label: "فتحوا", eligible: 25, inCohort: 40, angle: { brief: "زاوية جديدة", subjectHint: "مختلف", why: "لم يردّوا", cta: "سؤال" }, guards: [], priority: 1 }]);
check("مريم: مهمة بموافقة", !!tid && (await T.getTask(A, tid!))!.status === "waiting_for_approval");
check("مريم: لا مقترحان معاً", (await H.handoffRetarget(A, [{ cohort: "clicked", label: "نقروا", eligible: 25, inCohort: 40, angle: {} as any, guards: [], priority: 1 }])) === null);
await db.execute(sql`UPDATE email_missions SET status = 'paused' WHERE user_id = ${A}`);
await runAutopilot(A);
check("قبل الموافقة: لا موجة", (await rows(sql`SELECT 1 FROM email_missions WHERE user_id = ${A} AND name LIKE 'إعادة استهداف%'`)).length === 0);
await T.approveTask(A, tid!, A);
await runAutopilot(A);
const rtm = await rows(sql`SELECT * FROM email_missions WHERE user_id = ${A} AND name LIKE 'إعادة استهداف%'`);
check("بعد الموافقة: الطيار أنشأها بجمهورها", rtm.length === 1 && rtm[0].filter.engagement.includes("opened_no_reply") && rtm[0].filter.take <= 25 && rtm[0].filter.notReserved === true, rtm[0]?.filter);
check("...ولا تُنشأ مرتين", (await T.getTask(A, tid!))!.status === "completed");

// فشل التسليم: مهمتان، مرةً في اليوم، ويعملهما العامل.
await H.handoffDeliveryFailure(A, "policy", { error: "x" });
await H.handoffDeliveryFailure(A, "policy", { error: "y" });
const dt = await rows(sql`SELECT * FROM employee_tasks WHERE user_id = ${A} AND task_type = 'delivery_failure' ORDER BY owner_role`);
check("فشل التسليم: لراشد ولمارك، مرةً", dt.length === 2 && dt.map((d) => d.owner_role).join() === "email_registrar,monitor", dt.map((d) => d.owner_role));
await T.runTaskWorkerOnce("e2e:2", 5);
const dt2 = await rows(sql`SELECT status, owner_role, failure_reason FROM employee_tasks WHERE user_id = ${A} AND task_type = 'delivery_failure'`);
check("...والعامل نفّذهما", dt2.every((d) => d.status === "completed"), dt2);

// سير عمل المكتب.
const { processAccount } = await import("../accounts/pipeline");
const [acc] = await db.insert(targetAccountsTable).values({ userId: A, company: "Nope", domain: "nope.example", status: "researching", runDate: "2026-11-09" }).returning();
await processAccount(A, acc!, { key: null, engaged: false });
const wfs = await rows(sql`SELECT * FROM workflow_executions WHERE user_id = ${A} AND workflow = 'accounts_desk'`);
const steps = wfs.length ? await rows(sql`SELECT employee_key, event FROM execution_events WHERE workflow_id = ${wfs[0].id}`) : [];
check("سير عمل لكل شركة بحدث لكل خطوة", wfs.length === 1 && wfs[0].status === "cancelled" && wfs[0].output.status === "no_site" && steps.some((s) => s.employee_key === "target_accounts.researcher" && s.event === "research"), { wfs, steps });

// عزل الحسابات.
check("عزل: لا مهام ولا نبض لحساب آخر", (await T.listTasks(B)).every((x) => x.userId === B) && !(await rows(sql`SELECT 1 FROM employee_tasks WHERE user_id = ${B} AND task_type = 'strategy_directive'`)).length);
check("عزل: B لا يقرأ توجيه A", (await H.activeTask(B, "email", "strategy_directive")) === null);
check("عزل: B لا يلغي مهمة A", (await T.cancelTask(B, tid!, B)) === null);
check("isHalted بلا مفتاح", !(await isHalted({ userId: A })).halted);

await clean();
console.log(`\n${pass} نجح، ${fail} فشل. نداءات الشبكة (نموذج مستبدل فقط): ${fetched}`);
process.exit(fail ? 1 : 0);
