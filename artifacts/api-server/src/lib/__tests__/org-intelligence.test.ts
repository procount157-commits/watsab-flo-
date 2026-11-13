// البطاقات، الذاكرة، المقترحات، الرئيس التنفيذي، الجاهزية. الجزء الأول بلا قاعدة:
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/org-intelligence.test.ts
// والبقية على قاعدة الاختبار وحدها، بلا شبكة ولا إرسال ولا نموذج حقيقي:
//   DATABASE_URL=postgres://t:t@127.0.0.1:55440/t npx tsx src/lib/__tests__/org-intelligence.test.ts
export {};
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const realFetch = globalThis.fetch;
let fetched = 0;
globalThis.fetch = (async (url: any) => { fetched++; throw new Error(`no network in this test: ${url}`); }) as any;

const S = await import("../org/scorecards");
const C = await import("../org/ceo");
const P = await import("../org/proposals");
const M = await import("../org/memory");
const R = await import("../org/readiness");
const V = await import("../org/providers");
const { ORG_INTELLIGENCE_SQL } = await import("../org/schema");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};

// ── بلا قاعدة ─────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const mig = norm(readFileSync(join(here, "../../../../../lib/db/migrations/074_org_intelligence.sql"), "utf8"));
check("074 يحمل كل عبارة في ORG_INTELLIGENCE_SQL", ORG_INTELLIGENCE_SQL.every((q) => mig.includes(norm(q))), ORG_INTELLIGENCE_SQL.find((q) => !mig.includes(norm(q))));

const spec = { key: "k", label: "k", weight: 10, minSample: 10 };
const low = S.buildMetric(spec, 9, 0.9, 90, "x", { t: [1] });
check("دون الحد: الحالة الحرفية بلا رقم", low.status === "INSUFFICIENT DATA" && low.value === null && low.score === null, low);
check("ودليله باقٍ", low.evidence["t"]![0] === 1);
const ok = S.buildMetric(spec, 10, 0.9, 90, "x");
check("عند الحد: رقم", ok.status === "OK" && ok.score === 90 && ok.value === 0.9);
check("الدرجة تُقصّ إلى ٠..١٠٠", S.buildMetric(spec, 10, 2, 250, "x").score === 100);
check("الثقة من العيّنة", S.confidenceFrom(5, 10) === "none" && S.confidenceFrom(10, 10) === "low" && S.confidenceFrom(20, 10) === "medium" && S.confidenceFrom(50, 10) === "high");
const m = (key: string, weight: number, score: number | null, n = 100) => S.buildMetric({ key, label: key, weight, minSample: 10 }, score == null ? 0 : n, score == null ? null : score / 100, score, key);
const cmp = S.composite([m("role", 60, 50), m("gen", 40, 100)]);
check("متوسط موزون", cmp.status === "OK" && cmp.score === 70, cmp);
check("دور بلا عيّنة: لا درجة من مجرد العموم", S.composite([m("role", 60, null), m("gen", 40, 100)]).status === "INSUFFICIENT DATA" && S.composite([m("role", 60, null), m("gen", 40, 100)]).score === null);
check("وزن صفر لا يدخل الدرجة", S.composite([m("a", 10, 80), m("d", 0, 10)]).score === 80);
check("الثقة أدنى ما في المقاييس", S.composite([m("a", 10, 80, 12), m("b", 10, 80, 500)]).confidence === "low");
check("الاتجاه على المشترك وحده", S.trendOf([m("a", 10, 90), m("b", 10, 10)], [m("a", 10, 80), m("b", 10, null)]).delta === 10);
check("لا مشترك: unknown لا رقم", S.trendOf([m("a", 10, 90)], [m("a", 10, null)]).direction === "unknown");
check("فرق صغير: ثابت", S.trendOf([m("a", 10, 80.5)], [m("a", 10, 80)]).direction === "flat");
check("موظف جديد", S.isNewEmployee(new Date(), Date.now()) && !S.isNewEmployee(new Date(Date.now() - 20 * 86_400_000), Date.now()));
check("مفتاح الفترة", S.periodKeyOf("weekly", new Date("2026-11-09T10:00:00Z")) === "weekly:2026-W46" && S.periodKeyOf("monthly", new Date("2026-11-30T21:00:00Z")) === "monthly:2026-12");
check("درجة الرد النافع بالنسبة لا بالعدد", S.positiveRateScore(1, 100) === 100 && S.positiveRateScore(1, 200) === 50 && S.positiveRateScore(10, 2000) === 50);
check("زمن الرد", S.responseTimeScore(3_600_000) === 100 && S.responseTimeScore(24 * 3_600_000) === 0);
check("حكم بلا عيّنة غير منضبط", !S.verdictDisciplined({ key: "a", verdict: "scale", sent: 10 }) && S.verdictDisciplined({ key: "a", verdict: "watch", sent: 10 }) && S.verdictDisciplined({ key: "a", verdict: "rewrite", sent: 10, why: "مزوّد البريد رفض ٥ رسالة" }));
const daily = [...Array(30).keys()].map((i) => ({ day: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), companies: 10, positive: i >= 15 ? 2 : 0 }));
check("حكم سبق تحسّناً", S.verdictsImprovement([{ at: "2026-10-16T00:00:00Z", ref: 1 }], daily).improved === 1);
check("قليلٌ على جانب: لا يُحكم", S.verdictsImprovement([{ at: "2026-10-02T00:00:00Z", ref: 1 }], daily).judged === 0);
check("نموذج كل دور", S.modelFor("email") === "copywriter" && S.modelFor("email_analyst") === "analyst" && S.modelFor("email_replies") === "reply_specialist" && S.modelFor("accounts_researcher") === "researcher" && S.modelFor("ops") === "operations" && S.modelFor("ig_dm") === "general");

check("أرقام هندية", C.numbersIn("نجح ٣٢ من ٥٠ بنسبة ٦٤٫٥٪").join() === "32,50,64.5");
check("أرقام بالكلمات", C.numbersIn("خمسة ردود والعشرين").includes(5) && C.numbersIn("خمسة ردود والعشرين").includes(20));
check("فاصل الآلاف", C.numbersIn("١٬٢٣٤ رسالة")[0] === 1234);
const fp = { a: 32, rate: 0.64, text: "فشل 3 مرات" };
check("رقم من الوقائع يمرّ", C.unknownNumbers("32 ردّاً بنسبة 64٪ و3 مرات", fp).length === 0);
check("رقم مخترع يُكشف", C.unknownNumbers("٧٧ ردّاً", fp)[0] === 77);
check("كلمة رقم مخترعة تُكشف", C.unknownNumbers("خمسة ردود", fp)[0] === 5);
check("تقريب مخترع لا يمرّ", C.unknownNumbers("32.4 ردّ", { a: 32 }).length === 1);
const facts = (over: Partial<import("../org/ceo").FactPack> = {}): import("../org/ceo").FactPack => ({
  accountId: 1, day: "2026-11-09", windowDays: 7, activity: { executions: 40, emailsSent: 120, inbound: 12, waSends: 30, tasksClosed: 5 },
  outcomes: { positiveReplies: 4, companiesPositive: 3, qualifiedLeads: 2, meetings: 1, bounced: 2, bounceRate: 0.02, humanOpens: 9 }, departments: [], overdueEmployees: [], failingEmployees: [],
  noExecutionEmployees: [], failingWorkflows: [], campaignsWithLeads: [], channels: [], queue: { emailQueued: 0, heldStale: 0 }, approvalsWaiting: 0, problems: [{ id: "x", severity: "warn", problem: "p", why: "w", owner: "ops", category: "internal_analytics", metric: null }], thin: false, ...over,
});
const stub = (answers: Array<string | null>) => { let i = 0; const f: any = async () => { const a = answers[Math.min(i++, answers.length - 1)]; return a == null ? null : { text: a, provider: "stub" }; }; f.calls = () => i; return f; };
const good = JSON.stringify({ executive_summary: "خرج 120 رسالة وجاء 4 ردود نافعة.", ranking: ["x", "مخترع"] });
const bad = JSON.stringify({ executive_summary: "حققنا 999 رداً نافعاً.", ranking: [] });
let llm = stub([good]);
let nar = await C.writeNarrative(facts(), "p", llm);
check("نص سليم يُقبل من أول مرة", nar.status === "validated" && llm.calls() === 1 && !!nar.summary);
check("ومعرّف مخترع يسقط من الترتيب", nar.ranking.join() === "x");
llm = stub([bad, good]);
nar = await C.writeNarrative(facts(), "p", llm);
check("رقم مخترع: يُعاد مرة، ويُقبل الثاني", nar.status === "validated" && llm.calls() === 2);
llm = stub([bad, bad, good]);
nar = await C.writeNarrative(facts(), "p", llm);
check("مرتان: الوقائع بلا نص، ولا ثالثة", nar.status === "facts_only" && nar.summary === null && llm.calls() === 2 && nar.violations.includes(999));
check("نموذج غائب", (await C.writeNarrative(facts(), "p", stub([null]))).status === "model_unavailable");
check("JSON فاسد: لا نص", (await C.writeNarrative(facts(), "p", stub(["ليس JSON"]))).summary === null);
const probs = [{ id: "a" }, { id: "b" }, { id: "c" }] as any[];
check("الترتيب: ما قال النموذج ثم الباقي، بلا ضياع", C.rankProblems(probs, ["c", "z", "c"]).map((p: any) => p.id).join() === "c,a,b");
const deps = [{ department: "email", tokens: 5000, calls: 1, costUsd: null, outcome: 3, outcomeLabel: "ردود", executions: 0, failed: 0, successRate: null }, { department: "whatsapp", tokens: 9000, calls: 1, costUsd: null, outcome: 0, outcomeLabel: "x", executions: 0, failed: 0, successRate: null }];
check("أفضل قسم بالنتيجة لا بالاستهلاك", C.bestDepartment(deps)!.department === "email");
check("مستهلك بلا نتيجة", C.wastefulDepartment(deps)!.department === "whatsapp");
check("لا نتيجة: لا أفضل", C.bestDepartment([{ ...deps[1]! }]) === null);
check("خلاصة التحسينات بلا مقارنة", C.improvementsVerdict([]) === "none" && C.improvementsVerdict([{ title: "x", metric: null, before: null, after: null, verdict: "INSUFFICIENT DATA" }]) === "INSUFFICIENT DATA");

check("التصنيف: ما يُحظر", ["external_strategy", "pricing", "promises", "limits", "channel_activation", "prompt_external", "permissions", "account_config", "financial", "deletion", "security"].every((c) => P.classify(c).risk === "approval_required"));
check("التصنيف: المنخفض", ["prompt_internal", "memory", "internal_analytics"].every((c) => P.classify(c).risk === "low"));
check("فئة مجهولة: موافقة", P.classify("whatever").risk === "approval_required" && P.classify(null).risk === "approval_required");
check("تعليمات بلا مدخل مكتبة: موافقة", P.classifyPrompt(undefined).risk === "approval_required");
check("نتيجة الدرس من رقمين", M.lessonOutcome(1, 2) === "improved" && M.lessonOutcome(2, 1) === "worse" && M.lessonOutcome(2, 1, "lower") === "improved" && M.lessonOutcome(null, 1) === "INSUFFICIENT DATA");
check("حالة الاتصال: لا ضبط محظور", R.connectionStatus({ configured: false, checked: false, provenWork: true }) === "BLOCKED");
check("لم يُفحص: يحتاج اختباراً", R.connectionStatus({ configured: true, checked: false, provenWork: true }) === "NEEDS_TEST");
check("نجح الفحص بلا عمل حقيقي: يحتاج اختباراً", R.connectionStatus({ configured: true, checked: true, ok: true, provenWork: false }) === "NEEDS_TEST");
check("نجح وعمل: جاهز", R.connectionStatus({ configured: true, checked: true, ok: true, provenWork: true }) === "READY");
check("الكل: READY فقط إن كلها", R.overallStatus([{ status: "READY" }]) === "READY" && R.overallStatus([{ status: "READY" }, { status: "NEEDS_TEST" }]) === "NEEDS_TEST" && R.overallStatus([{ status: "NEEDS_TEST" }, { status: "BLOCKED" }]) === "BLOCKED" && R.overallStatus([]) === "BLOCKED");
const st = V.parseStructured<{ a: string }>("كلام ```json\n{\"a\": \"}\", \"n\": 2}\n``` بعده", { a: "string", n: "number" });
check("مخرج منظَّم من نص ملفوف", st.ok && st.value.a === "}");
check("حقل خاطئ يُرفض", !V.parseStructured("{\"a\": 1}", { a: "string" }).ok);
check("لا JSON يُرفض", !V.parseStructured("لا", { a: "string" }).ok);
check("حقل اختياري", V.parseStructured("{}", { a: { optional: "string" } }).ok);
const row = V.providerRow({ task_type: "t", provider: "p", model: "m", calls: 4, failures: 1, tokens_in: 1, tokens_out: 1, latency_ms: 400, cost_usd: 0, guard_passed: 3, guard_failed: 1 });
check("سطر المزوّد: كلفة غير معروفة null، وحارس بلا عيّنة null", row.costUsd === null && row.guardPassRate === null && row.successRate === 0.75 && row.avgLatencyMs === 100);

// ── على قاعدة الاختبار ───────────────────────────────────────────
if (!/127\.0\.0\.1:(55446|55445|55440|55441|55442|55444)/.test(process.env["DATABASE_URL"] ?? "")) {
  console.log(`\n${pass} passed, ${fail} failed (بلا قاعدة)`);
  process.exit(fail ? 1 : 0);
}
process.env["GROQ_API_KEY"] = "test-key";
const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const { ensureOrgTables } = await import("../org/schema");
const { setControl, forgetControls } = await import("../org/controls");
const { forgetRuntimeCache } = await import("../org/runtime");
const { backfillRegistry } = await import("../org/registry");
const { asAgent } = await import("../agent-context");
const { execute } = await import("../org/runtime");

const A = 13, B = 14;
const one = async (q: any) => (await db.execute<any>(q)).rows[0];
const rows = async (q: any) => (await db.execute<any>(q)).rows;
check("الجداول تُنشأ فوق المخطط", await ensureOrgTables());
// عزلٌ لا قائمة: كل جدول فيه user_id (عدا المضاف فقط) يُفرَّغ لحسابَي الاختبار وللحساب الفارغ (١٥)، فما تتركه
// مجموعات أخرى على الأرقام نفسها (org-runtime يكتب لـ١٣ و١٤ في execution_events وreceipts وغيرها،
// وorg-stage5 يكتب لـ١٥) لا يدخل الأعداد. قيدٌ أجنبي بين جدولين يُحلّ بالإعادة حتى لا يبقى تقدّم.
const MINE = [A, B, 15];
let pending = (await rows(sql`SELECT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables tb USING (table_schema, table_name)
  WHERE c.table_schema = 'public' AND c.column_name = 'user_id' AND tb.table_type = 'BASE TABLE' AND c.table_name <> 'users'
    -- السجلات المضافة فقط (receipts) ترفض الحذف بقادحها عمداً؛ لا تُمسّ، ولا فحص هنا يعدّها.
    AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = (quote_ident(c.table_name))::regclass AND NOT g.tgisinternal AND g.tgname LIKE '%append_only%')`)).map((r: any) => String(r.t));
for (let round = 0; pending.length && round < 10; round++) {
  const left: string[] = [];
  for (const t of pending) await db.execute(sql.raw(`DELETE FROM "${t}" WHERE user_id IN (${MINE.join(", ")})`)).catch(() => left.push(t));
  if (left.length === pending.length) break;
  pending = left;
}
check("عزل: لا صف باقٍ لحسابات الاختبار", pending.length === 0 || (await Promise.all(pending.map(async (t) => (await one(sql.raw(`SELECT count(*)::int AS n FROM "${t}" WHERE user_id IN (${MINE.join(", ")})`))).n))).every((n) => n === 0), pending);
// مفتاح عام تركه غيرنا مشغولاً يوقف كل ما يلي لسببٍ لا يخص هذا الملف.
await db.execute(sql`DELETE FROM org_controls WHERE scope = 'global'`);
forgetControls(); forgetRuntimeCache();
await db.execute(sql`INSERT INTO business_profile (user_id, name) VALUES (${A}, 'شركة أ'), (${B}, 'شركة ب')`);
const OLD = new Date(Date.now() - 60 * 86_400_000);
const hire = async (u: number, role: string, name = role, persona = `شخصية ${role}`, createdAt = OLD) => { await db.execute(sql`INSERT INTO bot_employees (user_id, name, role, kind, persona, created_at) VALUES (${u}, ${name}, ${role}, 'internal', ${persona}, ${createdAt})`); };
await hire(A, "email"); await hire(A, "email_analyst"); await hire(A, "ops"); await hire(B, "email"); await hire(A, "email_guard", "ماجد", "شخصية الحارس");
await hire(A, "email_replies", "ليلى"); await hire(A, "accounts_researcher", "فهد"); await hire(A, "accounts_email", "سالم");
await backfillRegistry(A); await backfillRegistry(B);

// البطاقات: التنفيذات
const NOW = new Date();
const exec = async (u: number, key: string, status: string, ago = 1) => Number((await one(sql`INSERT INTO employee_executions (user_id, employee_key, status, kind, started_at, finished_at, duration_ms) VALUES (${u}, ${key}, ${status}, 't', now() - make_interval(days => ${ago}), now() - make_interval(days => ${ago}), 100) RETURNING id`)).id);
const execIds: number[] = [];
for (let i = 0; i < 8; i++) execIds.push(await exec(A, "ops.controller", "succeeded"));
for (let i = 0; i < 2; i++) await exec(A, "ops.controller", "failed");
let card = await S.computeScorecard(A, { role: "ops", createdAt: OLD }, "weekly", NOW);
const succ = card.metrics.find((x) => x.key === "success_rate")!;
check("نسبة النجاح من الصفوف", succ.status === "OK" && succ.value === 0.8 && succ.score === 80 && succ.sampleSize === 10, succ);
check("الدليل: أرقام الصفوف نفسها", succ.evidence["employee_executions"]!.includes(execIds[0]!), succ.evidence);
check("الحساب مكتوب", /8/.test(succ.calculation) && /10/.test(succ.calculation));
check("الفترة وحجم العيّنة", card.period === "weekly" && !!card.periodStart && card.periodKey.startsWith("weekly:"));
check("عمليات بلا مهام: لا درجة، فالنجاح وحده لا يكفي", card.status === "INSUFFICIENT DATA" && card.score === null, card.calculation);
check("بلا درجة: confidence none واتجاه مجهول", card.confidence === "none" && card.trend.direction === "unknown");
const task = async (u: number, role: string, status: string, ago = 1) => one(sql`INSERT INTO employee_tasks (user_id, owner_role, task_type, status, updated_at, created_at) VALUES (${u}, ${role}, 't', ${status}, now() - make_interval(days => ${ago}), now() - make_interval(days => ${ago})) RETURNING task_id`);
for (let i = 0; i < 9; i++) await task(A, "ops", "completed");
await task(A, "ops", "failed");
for (let i = 0; i < 7; i++) await exec(A, "ops.controller", "succeeded", i + 1);
await db.execute(sql`INSERT INTO org_audit_log (user_id, action, kind, meta) VALUES (${A}, 'watchdog.finding', 'missed_heartbeat', ${JSON.stringify({ subject: "ops.controller" })}::jsonb)`);
for (let i = 0; i < 3; i++) await exec(A, "ops.controller", "failed", 2);
card = await S.computeScorecard(A, { role: "ops", createdAt: OLD }, "weekly", NOW);
check("عمليات بمهام وأيام: درجة وحالة OK", card.status === "OK" && card.score != null && card.score > 0 && card.score <= 100, card.calculation);
check("الثقة من العيّنة، لا none", card.confidence !== "none");
check("الدرجة = حساب الأوزان", card.calculation.includes("متوسط موزون"));
const newCard = await S.computeScorecard(A, { role: "ops", createdAt: new Date() }, "weekly", NOW);
check("موظف جديد: لا درجة ولو كملت عيّنته", newCard.status === "INSUFFICIENT DATA" && newCard.score === null && newCard.note === "موظف جديد");
const empty = await S.computeScorecard(A, { role: "email_analyst", createdAt: OLD }, "monthly", NOW);
check("محلل بلا أحكام: INSUFFICIENT DATA لا صفر", empty.status === "INSUFFICIENT DATA" && empty.score === null && empty.metrics.filter((x) => x.weight > 0).every((x) => x.status === "INSUFFICIENT DATA" ));
await exec(B, "ops.controller", "succeeded");
const bCard = await S.computeScorecard(B, { role: "ops", createdAt: OLD }, "weekly", NOW);
check("عزل: تنفيذات حساب أ لا تُعدّ لحساب ب", bCard.metrics.find((x) => x.key === "success_rate")!.sampleSize === 1);

// الكاتب: الردود لكل شركة، لا العدد.
const [cont] = await rows(sql`INSERT INTO email_contacts (user_id, email, status) VALUES (${A}, 'x@c0.example', 'active') RETURNING id`);
const [camp] = await rows(sql`INSERT INTO email_campaigns (user_id, name, status, subject, html) VALUES (${A}, 'موجة', 'sending', 's', 'h') RETURNING id`).catch(async () => rows(sql`INSERT INTO email_campaigns (user_id, name, status) VALUES (${A}, 'موجة', 'sending') RETURNING id`));
const [mission] = await rows(sql`INSERT INTO email_missions (user_id, name, goal, campaign_id, track, angle) VALUES (${A}, 'م', 'g', ${camp.id}, 'aml', 'ang') RETURNING id`);
const msgIds: number[] = [];
for (let i = 0; i < 60; i++) {
  const [r] = await rows(sql`INSERT INTO email_messages (user_id, campaign_id, contact_id, to_email, subject, status, token, sent_at, opened_at, open_count) VALUES (${A}, ${camp.id}, ${cont.id}, ${`a@c${i}.example`}, 's', 'sent', ${`tok${A}-${i}`}, now() - interval '2 days', now() - interval '1 day', 5) RETURNING id`);
  msgIds.push(r.id);
}
const copy = async () => (await S.computeScorecard(A, { role: "email", createdAt: OLD }, "weekly", NOW)).metrics.find((x) => x.key === "positive_per_company")!;
let pc = await copy();
check("صفر رد نافع على ٦٠ شركة: صفر، ولو فُتحت كلها", pc.status === "OK" && pc.score === 0 && pc.sampleSize === 60, pc);
await db.execute(sql`INSERT INTO email_inbound (user_id, message_id, from_email, kind, solicited, intent, state) VALUES (${A}, ${msgIds[0]!}, 'a@c0.example', 'reply', true, 'interested', 'new'), (${A}, ${msgIds[0]!}, 'a@c0.example', 'reply', true, 'interested', 'new')`);
pc = await copy();
check("ردّان من شركة واحدة: شركة واحدة، بلا فضل كمّ", pc.value === Math.round((1 / 60) * 10000) / 10000 && Math.abs(pc.score! - 100) < 1e-6, pc);
check("بلا رسالة منسوبة: لا تُحسب لغيره", (await S.computeScorecard(B, { role: "email", createdAt: OLD }, "weekly", NOW)).metrics.find((x) => x.key === "positive_per_company")!.sampleSize === 0);
// قبل دقيقة لا «الآن»: now() في القاعدة بالميكروثانية ونهاية النافذة (new Date()) بالمللي، فصفٌّ كُتب في المللي
// نفسه يقع بعد النهاية ويسقط من العيّنة — فشلٌ متقطع لا علاقة له بالحساب.
await db.execute(sql`INSERT INTO email_agent_activity (user_id, role, action, text, ref, created_at) SELECT ${A}, 'email_guard', 'pass', 'x', ${JSON.stringify({ missionId: mission.id })}::jsonb, now() - interval '1 minute' FROM generate_series(1, 4)`);
await db.execute(sql`INSERT INTO email_agent_activity (user_id, role, action, text, ref, created_at) VALUES (${A}, 'email_guard', 'pass', 'x', ${JSON.stringify({ missionId: mission.id, issues: ["ع"] })}::jsonb, now() - interval '1 minute')`);
const ga = (await S.computeScorecard(A, { role: "email", createdAt: OLD }, "weekly", new Date())).metrics.find((x) => x.key === "guard_acceptance")!;
check("قبول الحارس", ga.value === 0.8, ga);

// التخزين والعزل
const stored = await S.scoreAccount(A, ["weekly"], NOW);
check("العامل يحفظ بطاقة لكل موظف", stored === 7 && (await one(sql`SELECT count(*)::int AS n FROM employee_scorecards WHERE user_id = ${A}`)).n === 7, stored);
const again = await S.scoreAccount(A, ["weekly"], NOW);
check("يُعاد بلا تكرار", again === 7 && (await one(sql`SELECT count(*)::int AS n FROM employee_scorecards WHERE user_id = ${A}`)).n === 7);
const latest = await S.latestScorecards(A, "weekly");
check("الحفظ يُبقي الدليل والحساب", latest.some((c) => c.employeeKey === "ops.controller" && c.status === "OK" && !!c.calculation && Object.keys(c.evidence).length > 0));
check("عزل القراءة: لا بطاقات لحساب ب", (await S.latestScorecards(B, "weekly")).length === 0);

// الذاكرة
const lessonA = await M.proposeLesson(A, { layer: "department", department: "email", content: "درس أ" });
check("الدرس يبدأ معلّقاً ولا يُقرأ", (await M.departmentMemory(A, "email")).length === 0);
check("حساب آخر لا يعتمد درسك", !(await M.decideLesson(B, "department", lessonA.id, "approved", B)));
check("صاحبه يعتمده فيُقرأ", (await M.decideLesson(A, "department", lessonA.id, "approved", A)) && (await M.departmentMemory(A, "email")).some((x) => x.content === "درس أ"));
check("عزل: لا يراه حساب آخر", (await M.departmentMemory(B, "email")).length === 0);
await db.execute(sql`INSERT INTO department_memory (user_id, department, kind, content, approval_status, expiry_at) VALUES (${A}, 'email', 'x', 'منتهٍ', 'approved', now() - interval '1 day')`);
check("منتهي المدة لا يُقرأ", !(await M.departmentMemory(A, "email")).some((x) => x.content === "منتهٍ"));
await db.execute(sql`INSERT INTO agent_memory (user_id, role, kind, content, approval_status) VALUES (${A}, 'email', 'win', 'معتمد أ', 'approved'), (${A}, 'email', 'win', 'معلّق', 'pending'), (${B}, 'email', 'win', 'سرّ ب', 'approved')`);
const emA = await M.employeeMemory(A, "email");
check("طبقة الموظف: المعتمد لحسابه فقط", emA.some((x) => x.content === "معتمد أ") && !emA.some((x) => x.content === "معلّق" || x.content === "سرّ ب"));
await M.proposeLesson(A, { layer: "account", key: "market", content: "الإمارات" });
check("معرفة الحساب معلّقة أولاً", (await M.accountKnowledge(A)).length === 0);
const knowId = (await one(sql`SELECT id FROM account_knowledge WHERE user_id = ${A} AND key = 'market'`)).id;
await M.decideLesson(A, "account", knowId, "approved", A);
check("ثم تُقرأ، ولا يراها غيره", (await M.accountKnowledge(A)).length === 1 && (await M.accountKnowledge(B)).length === 0);
await M.proposeLesson(A, { layer: "account", key: "market", content: "الخليج" });
check("تغيّرت القيمة: تعود معلّقة بنسخة أعلى", (await M.accountKnowledge(A)).length === 0 && Number((await one(sql`SELECT version FROM account_knowledge WHERE id = ${knowId}`)).version) === 2);
// الحلقة كاملة
const evId = await M.observe(A, { role: "email", eventType: "reply_pattern", outcome: "positive", evidence: { inbound: 1 } });
const lesson = await M.proposeLesson(A, { layer: "employee", role: "email", content: "اكتبي أقصر", eventId: evId });
check("لا تطبيق قبل الموافقة", (await M.markLessonApplied(A, "employee", lesson.id, { metric: "m", value: 1 })) === null);
await M.decideLesson(A, "employee", lesson.id, "approved", A);
const appl = await M.markLessonApplied(A, "employee", lesson.id, { metric: "positive_rate", value: 0.01 });
check("تطبيق بخط أساس", appl != null);
const meas = await M.measureLesson(A, "employee", lesson.id, 0.02, 80);
check("قياس ونتيجة محفوظة", meas?.outcome === "improved" && (await M.lessonHistory(A, "employee", lesson.id)).some((e: any) => e.event_type === "lesson_measured" && e.outcome === "improved"));
check("قياس بلا رقم: INSUFFICIENT DATA", (await M.measureLesson(A, "employee", lesson.id, null))?.outcome === "INSUFFICIENT DATA");
check("عزل: لا يقيس درس غيره", (await M.measureLesson(B, "employee", lesson.id, 1)) === null);

// المقترحات والتعليمات
const { PROMPT_LIBRARY } = await import("../org/prompts");
const extKey = Object.keys(PROMPT_LIBRARY).find((k) => PROMPT_LIBRARY[k]!.externalBehavior && k === "email.copywriter")!;
const intKey = Object.keys(PROMPT_LIBRARY).find((k) => !PROMPT_LIBRARY[k]!.externalBehavior && k === "email.analyst") ?? Object.keys(PROMPT_LIBRARY).find((k) => !PROMPT_LIBRARY[k]!.externalBehavior)!;
check("المكتبة فيها الكاتبة خارجية والمحلل داخلي", !!extKey && !!intKey, { extKey, intKey });
const persona0 = (await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${A} AND employee_key = 'email.copywriter'`)).persona;
const seeded = await P.seedPromptProposals(A);
const seedRows = await rows(sql`SELECT * FROM improvement_proposals WHERE user_id = ${A} AND requested_by = 'system.seed'`);
check("البذر: مقترح لكل موظف في المكتبة، معلّق", seeded === seedRows.length && seeded > 0 && seedRows.every((r: any) => r.status === "proposed"), seeded);
check("البذر يُعاد بلا تكرار", (await P.seedPromptProposals(A)) === 0);
check("البذر لا يغيّر الشخصية", (await one(sql`SELECT persona, prompt_version FROM bot_employees WHERE user_id = ${A} AND employee_key = 'email.copywriter'`)).persona === persona0);
check("عزل: بذر أ لا يصل ب", (await P.listProposals(B)).length === 0);
let refusedWith = 0;
try { await P.activatePrompt(A, extKey); } catch (e: any) { refusedWith = e.status; }
check("تعليمات خارجية بلا موافقة: مرفوضة", refusedWith === 403);
check("والشخصية كما هي", (await one(sql`SELECT persona, prompt_version FROM bot_employees WHERE user_id = ${A} AND employee_key = ${extKey}`)).prompt_version === null);
check("والرفض في السجل", (await one(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE user_id = ${A} AND action = 'prompt.refused'`)).n === 1);
const extRow = seedRows.find((r: any) => r.target === `prompt:${extKey}`);
let crossAcc = 0;
try { await P.approveProposal(B, extRow.change_id, B); } catch (e: any) { crossAcc = e.status; }
check("حساب آخر لا يوافق على مقترحك", crossAcc === 409 && (await P.getProposal(A, extRow.change_id))!.status === "proposed");
const done = await P.approveProposal(A, extRow.change_id, A);
const after = await one(sql`SELECT persona, prompt_version FROM bot_employees WHERE user_id = ${A} AND employee_key = ${extKey}`);
// الموظف المُوظَّف يأخذ مسودة ملفه فوراً (registry.backfillRegistry)، فالتفعيل يكتب نص الملف المجمَّع إن وُجد، وإلا نص المكتبة.
const activeDoc = await one(sql`SELECT count(*)::int AS n FROM employee_documentation WHERE user_id = ${A} AND employee_key = ${extKey} AND status = 'active'`).catch(() => ({ n: 0 }));
check("الموافقة تفعّل: النص المرسوم في persona", done.applied && done.proposal.status === "applied" && after.persona !== persona0 && (after.persona.includes("## الهوية") || Number(activeDoc?.n) === 1));
check("نسختان محفوظتان، والجديدة النشطة", (await rows(sql`SELECT version, active FROM employee_prompt_versions WHERE user_id = ${A} AND employee_key = ${extKey} ORDER BY version`)).map((v: any) => `${v.version}:${v.active}`).join() === "1:false,2:true");
check("كتلة الحساب من اسمه: لا تسريب بروكاونت", !after.persona.includes("Pro Count for Accounting"));
check("التفعيل في السجل", (await one(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE user_id = ${A} AND action = 'prompt.activated'`)).n === 1);
const rb = await P.rollbackProposal(A, extRow.change_id, A);
const restored = await one(sql`SELECT persona, prompt_version FROM bot_employees WHERE user_id = ${A} AND employee_key = ${extKey}`);
check("الإرجاع يعيد النص والنسخة نفسيهما", rb.status === "rolled_back" && restored.persona === persona0 && restored.prompt_version === null);
check("والنسخة السابقة نشطة", (await rows(sql`SELECT version FROM employee_prompt_versions WHERE user_id = ${A} AND employee_key = ${extKey} AND active`)).map((v: any) => v.version).join() === "1");
check("والإرجاع في السجل", (await one(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE user_id = ${A} AND action = 'prompt.rolled_back'`)).n === 1);
let twice = 0;
try { await P.rollbackProposal(A, extRow.change_id, A); } catch (e: any) { twice = e.status; }
check("لا إرجاع مرتين", twice === 409);
const intHire = await one(sql`SELECT 1 AS x FROM bot_employees WHERE user_id = ${A} AND employee_key = ${intKey}`);
if (!intHire) { const role = Object.entries((await import("../org/departments")).ROLE_MAP).find(([, v]) => v.key === intKey)![0]; await hire(A, role); await backfillRegistry(A); }
const low1 = await P.activatePrompt(A, intKey);
check("تحليلي داخلي: يعمل منخفض الخطر بمقترح مطبَّق", low1.version === 2 && (await P.getProposal(A, low1.changeId))!.status === "applied" && (await P.getProposal(A, low1.changeId))!.risk === "low");
await P.rollbackProposal(A, low1.changeId, A);
const noLowering = await P.createProposal({ userId: A, requestedBy: "email.copywriter", target: `prompt:${extKey}`, category: "prompt_internal", reason: "خفض" });
check("لا يُخفض التصنيف بقول الطالب", noLowering.risk === "approval_required" && noLowering.category === "prompt_external");
const cfg = await P.createProposal({ userId: A, requestedBy: "ceo", target: "config:daily_cap", category: "limits", reason: "سبب", newValue: { cap: 999 } });
const cfgDone = await P.approveProposal(A, cfg.change_id, A);
check("هدف إعدادات: يُعتمد ولا يُطبَّق آلياً", !cfgDone.applied && cfgDone.proposal.status === "approved");

const autoLow = await P.createProposal({ userId: A, requestedBy: "ceo", target: "analytics:dash", category: "internal_analytics", reason: "س" });
check("منخفض الخطر يُعتمد وحده ويُكتب", autoLow.status === "approved" && autoLow.risk === "low" && (await one(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE user_id = ${A} AND action = 'proposal.auto_approved'`)).n === 1);

// الرئيس التنفيذي
const ceoStub = stub([JSON.stringify({ executive_summary: "ملخص بلا أرقام.", ranking: [] })]);
const first = await C.runCeoDaily(A, { llm: ceoStub });
check("يوظَّف ويكتب تقريره", first.ran && !!first.report && (await one(sql`SELECT employee_key, department, title FROM bot_employees WHERE user_id = ${A} AND role = 'ceo_agent'`)).employee_key === "executive.ceo");
check("سطر تنفيذ ونبض له", (await one(sql`SELECT count(*)::int AS n FROM employee_executions WHERE user_id = ${A} AND employee_key = 'executive.ceo' AND kind = 'ceo_daily'`)).n === 1);
const rep = first.report;
for (const f of ["executive_summary", "period", "account_id", "department_performance", "employee_alerts", "operational_risks", "revenue_opportunities", "resource_issues", "top_priorities", "recommended_actions", "actions_requiring_approval", "previous_improvement_results"]) check(`حقل ${f}`, f in rep, Object.keys(rep));
check("الحساب في التقرير", rep.account_id === A);
check("أفضل قسم من النتيجة الحقيقية", rep.answers.bestDepartment?.department === "email" && rep.answers.bestDepartment.value === 2, rep.answers.bestDepartment);
check("الحملات ذات الردود", rep.answers.campaignsWithLeads[0]?.positive === 1);
check("عزل: لا تقرير لحساب ب بعد", (await C.listReports(B)).length === 0);
check("يوظَّف مرة واحدة", (await C.runCeoDaily(A, { llm: stub([good]) })).ran && (await one(sql`SELECT count(*)::int AS n FROM bot_employees WHERE user_id = ${A} AND role = 'ceo_agent'`)).n === 1);
check("صف واحد في اليوم", (await C.listReports(A)).length === 1);
const lying = await C.runCeoDaily(A, { llm: stub([bad, bad]) });
check("نص كاذب مرتين: الوقائع بلا نص", lying.report.narrative_status === "facts_only" && lying.report.executive_summary === null && (await one(sql`SELECT body FROM executive_reports WHERE id = ${lying.report.id}`)).body.length > 0);
const thin = await C.runCeoDaily(B, { llm: stub([good]) });
check("وقائع قليلة: يقولها ولا يكتب النموذج", thin.report.thin_data === true && /قليلة/.test(thin.report.executive_summary) && thin.report.narrative_status === "facts_only");
// التوصيات
await db.execute(sql`INSERT INTO employee_heartbeats (user_id, employee_key, status, consecutive_failures, last_error) VALUES (${A}, 'email.guard', 'failed', 5, 'خطأ') ON CONFLICT (user_id, employee_key) DO UPDATE SET consecutive_failures = 5, last_error = 'خطأ'`);
const withProb = await C.runCeoDaily(A, { llm: stub([JSON.stringify({ executive_summary: "فشل 5 مرات.", ranking: [] })]) });
check("مشكلة تصير أولوية ومهمة", withProb.report.top_priorities[0]?.id === "failing:email.guard" && withProb.report.recommended_actions[0]?.taskId > 0, withProb.report.top_priorities);
check("منخفض الخطر: بلا موافقة", withProb.report.recommended_actions[0].approvalRequired === false);
const recTask = await one(sql`SELECT status, approval_required, input_refs FROM employee_tasks WHERE task_id = ${withProb.report.recommended_actions[0].taskId}`);
check("المهمة بخط أساسها", recTask.status === "queued" && recTask.input_refs.baseline.value === 5);
const nTasks = (await one(sql`SELECT count(*)::int AS n FROM employee_tasks WHERE user_id = ${A} AND task_type = 'ceo_recommendation'`)).n;
await C.runCeoDaily(A, { llm: stub([good]) });
check("التكرار لا يصنع مهمة جديدة", (await one(sql`SELECT count(*)::int AS n FROM employee_tasks WHERE user_id = ${A} AND task_type = 'ceo_recommendation'`)).n === nTasks);
await db.execute(sql`INSERT INTO email_messages (user_id, to_email, subject, status, token, created_at) VALUES (${A}, 'q@held.example', 's', 'queued', 'tok-held', now() - interval '10 days')`);
const held = await C.runCeoDaily(A, { llm: stub([good]) });
const heldRec = held.report.actions_requiring_approval.find((x: any) => x.category === "external_strategy");
check("ما يخرج للناس: ينتظر موافقة", !!heldRec && (await one(sql`SELECT status, approval_status FROM employee_tasks WHERE task_id = ${heldRec.taskId}`)).status === "waiting_for_approval", held.report.actions_requiring_approval);
await db.execute(sql`UPDATE employee_tasks SET created_at = now() - interval '8 days' WHERE task_id = ${withProb.report.recommended_actions[0].taskId}`);
await db.execute(sql`UPDATE employee_heartbeats SET consecutive_failures = 0 WHERE user_id = ${A} AND employee_key = 'email.guard'`);
const later = await C.runCeoDaily(A, { llm: stub([good]) });
const moved = later.report.previous_improvement_results.find((x: any) => x.metric === "failures:email.guard");
check("هل تحرّكت توصية الأسبوع الماضي؟", moved?.verdict === "improved" && moved.before === 5 && moved.after === 0 && later.report.answers.lastWeekImprovements !== "none", later.report.previous_improvement_results);
check("والنتيجة محفوظة في التاريخ", (await one(sql`SELECT count(*)::int AS n FROM learning_events WHERE user_id = ${A} AND event_type = 'ceo_rec_outcome'`)).n >= 1);
await setControl({ scope: "employee", userId: A, target: "ceo_agent", engaged: true, reason: "اختبار", actor: A });
let stubCalled = stub([good]);
const haltedRun = await C.runCeoDaily(A, { llm: stubCalled });
check("المفتاح يوقفه قبل أي نموذج", !haltedRun.ran && stubCalled.calls() === 0 && !!haltedRun.reason);
await setControl({ scope: "employee", userId: A, target: "ceo_agent", engaged: false, actor: A });
await setControl({ scope: "account", userId: A, target: "", engaged: true, reason: "ق", actor: A });
stubCalled = stub([good]);
check("مفتاح الحساب يوقفه", !(await C.runCeoDaily(A, { llm: stubCalled })).ran && stubCalled.calls() === 0);
await setControl({ scope: "account", userId: A, target: "", engaged: false, actor: A });

// الجاهزية
const noNet = { verifySmtp: async () => { throw new Error("لا يصل هنا"); }, imapLogin: async () => { throw new Error("لا يصل هنا"); }, waState: async () => null };
const emptyR = await R.readiness(A, { verify: true, deps: noNet });
const it = (r: any, id: string) => r.items.find((x: any) => x.id === id);
check("بلا بيانات دخول: محظور، وله ما يفعله المدير", it(emptyR, "email.smtp").status === "BLOCKED" && !!it(emptyR, "email.smtp").action);
check("IMAP كذلك", it(emptyR, "email.imap").status === "BLOCKED" && it(emptyR, "email.imap").ok === false);
check("بلا ضبط لا اتصال يُفتح", fetched === 0);
check("الكل محظور", emptyR.status === "BLOCKED");
check("لينكدإن لا تصل READY أبداً", it(emptyR, "linkedin.readiness").status !== "READY");
check("الوضع القديم محفوظ في صحة التكامل", (await one(sql`SELECT status FROM integration_health WHERE user_id = ${A} AND integration = 'email_smtp'`)).status === "down");
await db.execute(sql`INSERT INTO email_settings (user_id, provider, smtp_host, smtp_user, smtp_pass, from_email, imap_host, daily_cap) VALUES (${B}, 'smtp', 'smtp.test', 'u', 'p', 'a@b.test', 'imap.test', 100)`);
let smtpCalls = 0, imapCalls = 0;
const fakeOk = { verifySmtp: async () => { smtpCalls++; return { ok: true, detail: "ok" }; }, imapLogin: async () => { imapCalls++; return { ok: true, detail: "ok" }; }, waState: async () => ({ connected: true, status: "connected" }) };
const unverified = await R.readiness(B, { verify: false, deps: fakeOk });
check("بلا verify: لا اتصال، وNEEDS_TEST", smtpCalls === 0 && imapCalls === 0 && it(unverified, "email.smtp").status === "NEEDS_TEST" && it(unverified, "email.imap").status === "NEEDS_TEST");
const verified = await R.readiness(B, { verify: true, deps: fakeOk });
check("اتصال سليم بلا عمل حقيقي: ليس READY", smtpCalls === 1 && imapCalls === 1 && it(verified, "email.smtp").status === "NEEDS_TEST", it(verified, "email.smtp"));
check("واتساب متصل بلا إرسال: ليس READY", it(verified, "whatsapp.connection").status === "NEEDS_TEST");
await db.execute(sql`INSERT INTO email_messages (user_id, to_email, subject, status, token, sent_at) VALUES (${B}, 'a@c.example', 's', 'sent', 'tok-b-1', now())`);
const proven = await R.readiness(B, { verify: true, deps: fakeOk });
check("سليم وعمل: READY", it(proven, "email.smtp").status === "READY" && it(proven, "email.smtp").ok === true);
check("عزل: إرسال ب لا يُعدّ لأ", it(await R.readiness(A, { verify: false, deps: noNet }), "email.smtp").status === "BLOCKED");
let senderCalls = 0;
await db.execute(sql`INSERT INTO email_senders (user_id, smtp_host, smtp_user, smtp_pass, from_email) VALUES (${B}, 'h', 'u', 'p', 'box2@b.test') ON CONFLICT DO NOTHING`);
const boxes = await R.readiness(B, { verify: true, deps: { ...fakeOk, verifySmtp: async (x: any) => { senderCalls++; return x.fromEmail === "box2@b.test" ? { ok: false, detail: "auth" } : { ok: true, detail: "ok" }; } } });
check("صندوق إضافي يفشل اتصاله: محظور باسمه، بلا إرسال", senderCalls === 2 && it(boxes, "email.mailboxes").status === "BLOCKED" && /box2@b\.test/.test(it(boxes, "email.mailboxes").detail));
await db.execute(sql`DELETE FROM email_senders WHERE user_id = ${B}`);
const badSmtp = await R.readiness(B, { verify: true, deps: { ...fakeOk, verifySmtp: async () => ({ ok: false, detail: "auth" }) } });
check("فشل الاتصال محظور بسببه", it(badSmtp, "email.smtp").status === "BLOCKED" && /auth/.test(it(badSmtp, "email.smtp").detail));
await db.execute(sql`INSERT INTO social_accounts (user_id, platform, profile, state, dry_run) VALUES (${B}, 'instagram', 'p', 'logged_in', true)`);
check("السوشيال في dry_run: يحتاج اختباراً", it(await R.readiness(B, { deps: fakeOk }), "instagram.account").status === "NEEDS_TEST");
await db.execute(sql`UPDATE business_profile SET team_paused = true WHERE user_id = ${B}`);
const paused = await R.readiness(B, { deps: fakeOk });
check("إيقاف الفريق يُرى", it(paused, "org.team_paused").status === "BLOCKED");
await db.execute(sql`UPDATE business_profile SET team_paused = false WHERE user_id = ${B}`);

// مقاييس المزوّد
await asAgent(A, "email", async () => {
  V.noteProviderCall({ provider: "groq", model: "m1", ok: true, ms: 100, charsIn: 400, charsOut: 40 });
  V.noteProviderCall({ provider: "groq", model: "m1", ok: false, ms: 300 });
});
const metered = await execute(A, "ops", { kind: "kind_x" }, async () => { V.noteProviderCall({ provider: "groq", model: "m1", ok: true, ms: 50, charsIn: 40, charsOut: 4 }); V.noteGuardResult(A, "ops", true); return 1; });
check("الجمع في الذاكرة بلا صف لكل نداء", metered.ran && V.pendingProviderBuckets() >= 2 && (await one(sql`SELECT count(*)::int AS n FROM provider_metrics WHERE user_id = ${A}`)).n === 0);
const report = await V.providerReport(A, 7);
const byRole = report.byTask.find((r: any) => r.task_type === "role:email")!;
check("التقرير لكل نوع مهمة", byRole.calls === 2 && byRole.failures === 1 && byRole.avgLatencyMs === 200 && byRole.tokensIn === 100, byRole);
check("نوع المهمة من الجولة", report.byTask.some((r: any) => r.task_type === "kind_x" && r.calls === 1));
// جودة السرد (noteQuality في ceo.ts) تُسجَّل على حساب أ أيضاً من جولات الرئيس أعلاه: الحارس يُقرأ في نوع مهمته.
check("الحارس على من كتب", report.byTask.filter((r: any) => r.task_type === "kind_x").reduce((a: number, r: any) => a + r.guardPassed, 0) === 1);
check("الكلفة غير المعروفة null", byRole.costUsd === null);
check("ملاحظة llm_settings", report.notes.some((n: string) => n.includes("llm_settings")));
check("عزل: لا شيء لحساب ب", (await V.providerReport(B, 7)).byTask.length === 0);

check("لا شبكة في كل ما سبق: النموذج مستبدل والفحص مستبدل", fetched === 0, fetched);

// ── المسارات ── (تشغيل /ceo/run بنموذجه الحقيقي: fetch مرفوض، فالتقرير بلا نص)
const express = (await import("express")).default;
const orgMod = await import("../../routes/org");
let session: any = {};
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.session = session; next(); });
app.use("/org", orgMod.default);
app.use((err: any, _req: any, res: any, _next: any) => { console.log("route error:", err?.message); res.status(500).json({ error: String(err?.message ?? err) }); });
const server = await new Promise<any>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}/org`;
const get = async (p: string) => { const r = await realFetch(`${base}${p}`); return { status: r.status, body: await r.json() as any }; };
const post = async (p: string, b: unknown = {}) => { const r = await realFetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() as any }; };
const PATHS = ["/overview", "/employees", "/employees/email.copywriter", "/scorecards", "/ceo/reports", "/readiness", "/proposals", "/providers", "/admin/overview"];
for (const p of PATHS) check(`بلا جلسة: ${p} ← 401`, (await get(p)).status === 401);
for (const p of ["/ceo/run", "/proposals", "/proposals/1/approve", "/proposals/1/reject", "/proposals/1/rollback"]) check(`بلا جلسة: POST ${p} ← 401`, (await post(p)).status === 401);
session = { userId: A, isAdmin: false };
const ov = await get("/overview");
check("اللوحة: الأعداد من السجل", ov.status === 200 && ov.body.employees.total >= 8 && ov.body.employees.failed + ov.body.employees.healthy + ov.body.employees.delayed + ov.body.employees.running + ov.body.employees.paused + ov.body.employees.no_execution === ov.body.employees.total, ov.body.employees);
check("اللوحة: الشكل الموثَّق", ["tasks", "departments", "queue", "integrations", "risks", "approvals", "outcomes"].every((k) => k in ov.body));
check("اللوحة: موظف بلا نبض no_execution لا سليم", ov.body.employees.no_execution > 0);
check("اللوحة: الاتجاهات بأرقامها", ov.body.outcomes.find((o: any) => o.key === "positive_replies").current === 2 && ov.body.outcomes.find((o: any) => o.key === "human_opens").current === 60);
check("اللوحة: موافقات", ov.body.approvals.proposals > 0);
check("الموظفون", (await get("/employees")).body.employees.some((e: any) => e.key === "email.copywriter" && "weekly" in e));
const prof = await get("/employees/email.copywriter");
check("ملف الموظف: كل حقول العقد", prof.status === 200 && ["profile", "prompt", "tools", "permissions", "heartbeat", "heartbeatHistory", "tasks", "errors", "memory", "trends", "feedback", "proposals"].every((k) => k in prof.body), Object.keys(prof.body));
check("ملف الموظف: نسخ التعليمات", prof.body.prompt.versions.length === 2 && prof.body.prompt.library.externalBehavior === true);
check("ملف الموظف: ذاكرته من الطبقات", prof.body.memory.employee.some((x: any) => x.content === "معتمد أ") && !JSON.stringify(prof.body.memory).includes("سرّ ب"));
check("موظف حساب آخر أو مجهول: 404", (await get("/employees/no.such")).status === 404);
session = { userId: 15, isAdmin: false };
check("عزل: موظف أ ليس في حساب فارغ", (await get("/employees/email.copywriter")).status === 404);
check("عزل: لا تقارير", (await get("/ceo/reports")).body.reports.length === 0);
check("عزل: لا مقترحات", (await get("/proposals")).body.proposals.length === 0);
check("عزل: مقترح غيرك 404", (await get(`/proposals/${extRow.change_id}`)).status === 404);
check("عزل: موافقته 409", (await post(`/proposals/${extRow.change_id}/approve`)).status === 409);
check("عزل: لوحة بلا موظفين", (await get("/overview")).body.employees.total === 0);
check("المدير وحده: 403", (await get("/admin/overview")).status === 403);
session = { userId: A, isAdmin: false };
check("البطاقات: period خاطئة 400", (await get("/scorecards?period=daily")).status === 400);
const sc = await get("/scorecards?period=weekly");
check("البطاقات: محفوظة", sc.body.scorecards.length >= 7 && sc.body.scorecards.every((c: any) => c.status === "OK" ? typeof c.score === "number" : c.score === null));
check("بطاقة موظف واحد", (await get("/scorecards?employee=ops.controller")).body.scorecards.length === 1);
check("التقارير", (await get("/ceo/reports")).body.reports.every((r: any) => r.account_id === A));
const crt = await post("/proposals", { target: "config:x", reason: "س", category: "pricing", newValue: 1 });
check("إنشاء مقترح لا يطبّق", crt.status === 201 && crt.body.proposal.status === "proposed" && crt.body.proposal.classification.risk === "approval_required");
check("إنشاء بلا سبب 400", (await post("/proposals", { target: "config:x", category: "pricing" })).status === 400);
check("هدف تعليمات لا مكتبة له 400", (await post("/proposals", { target: "prompt:no.such", reason: "س" })).status === 400);
const rej = await post(`/proposals/${crt.body.proposal.change_id}/reject`, { reason: "لا" });
check("الرفض بسببه", rej.status === 200 && rej.body.proposal.status === "rejected" && rej.body.proposal.decision_note === "لا");
check("رقم فاسد 400", (await post("/proposals/abc/approve")).status === 400);
check("لا إرجاع لغير المطبَّق 409", (await post(`/proposals/${crt.body.proposal.change_id}/rollback`)).status === 409);
const provR = await get("/providers?days=7");
check("المزوّدون", provR.status === 200 && Array.isArray(provR.body.byTask) && Array.isArray(provR.body.health) && provR.body.notes.length > 0);
// الحد
orgMod.forgetRateLimits();
const firstRun = await post("/ceo/run");
check("التشغيل بالطلب: النموذج غائب، والوقائع محفوظة", firstRun.status === 200 && firstRun.body.ran === true && firstRun.body.report.narrative_status === "model_unavailable" && firstRun.body.report.executive_summary === null, firstRun.body);
const secondRun = await post("/ceo/run");
check("مرة ثانية فوراً: 429 بمهلتها", secondRun.status === 429 && secondRun.body.retryAfterSec > 0 && secondRun.body.retryAfterSec <= 300);
session = { userId: B, isAdmin: false };
check("الحد لكل حساب لا عام", (await post("/ceo/run")).status === 200);
check("الحد نقي", orgMod.rateLimited("k", 1000, 1000) === 0 && orgMod.rateLimited("k", 1000, 1500) === 500 && orgMod.rateLimited("k", 1000, 2001) === 0);
const rv = await get("/readiness");
check("الجاهزية بلا verify", rv.status === 200 && rv.body.verified === false && it(rv.body, "email.smtp").status === "NEEDS_TEST");
session = { userId: 1, isAdmin: true };
const admin = await get("/admin/overview");
check("المدير: أعداد فقط", admin.status === 200 && Object.values(admin.body).every((v) => typeof v === "number") && admin.body.accounts >= 2, admin.body);
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
