// التوجيه بالدليل، الأسعار، وسجل العمّال. الجزء الأول بلا قاعدة؛ الثاني على قاعدة اختبار وحدها:
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/org-ops.test.ts           (الصرف فقط)
//   DATABASE_URL=postgres://t:t@127.0.0.1:55446/t npx tsx src/lib/__tests__/org-ops.test.ts       (الكل)
// لا شبكة: كل fetch مستبدل، ولا رسالة تخرج.
export {};
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const calledModels: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.includes("api.groq.com")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calledModels.push(body.model);
    return new Response(JSON.stringify({ choices: [{ message: { content: "أهلاً، كيف أخدمك؟" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error("no network in this test");
}) as any;
process.env["GROQ_API_KEY"] = "test-key";
delete process.env["LLM_PROVIDER"];
for (const k of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_API_KEYS", "ZHIPU_API_KEY", "THEGRID_API_KEY"]) delete process.env[k];

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); } };

const R = await import("../org/routing");
const P = await import("../org/prices");
const W = await import("../org/workers");
const { meterFacts } = await import("../org/runtime");
const { ORG_OPS_SQL } = await import("../org/schema");

// ── صنف العمل ──
check("sales يرد على عميل", R.taskClassOf("sales") === "customer_reply");
check("email كاتب", R.taskClassOf("email") === "writer" && R.taskClassOf("accounts_writer") === "writer");
check("ceo_agent سرد", R.taskClassOf("ceo_agent") === "narrative");
check("ig_dm رد، tt_triage مصنِّف", R.taskClassOf("ig_dm") === "customer_reply" && R.taskClassOf("tt_triage") === "classifier");
check("دور مجهول other", R.taskClassOf("zzz") === "other" && R.taskClassOf(null) === "other");

// ── الترتيب بالدليل ──
const c = (provider: string, model: string) => ({ provider, model });
const ev = (calls: number, failures: number, ms: number, qp: number, qf: number) => ({ calls, failures, latencyMs: ms * calls, qPassed: qp, qFailed: qf });
const list = [c("groq", "a"), c("groq", "b"), c("openrouter", "x"), c("pollinations", "")];
const E = (m: Record<string, ReturnType<typeof ev>>, cls: string) => new Map(Object.entries(m).map(([k, v]) => [`${k}|${cls}`, v]));
check("عيّنة أقل من 20: لا رأي", R.evidenceScore(ev(19, 0, 100, 0, 0)) === null && R.evidenceScore(ev(20, 0, 100, 0, 0)) != null);
const keys = (xs: Array<{ provider: string; model: string }>) => xs.map((x) => `${x.provider}/${x.model}`).join(",");
check("بلا دليل: الترتيب كما هو", keys(R.orderByEvidence(list, "analyst", new Map())) === keys(list));
check("عيّنة قليلة لا تحرّك", keys(R.orderByEvidence(list, "analyst", E({ "openrouter|x": ev(10, 0, 100, 10, 0), "groq|a": ev(30, 15, 5000, 0, 0) }, "analyst"))) === keys(list));
const better = R.orderByEvidence(list, "analyst", E({ "groq|a": ev(30, 15, 5000, 0, 0), "openrouter|x": ev(30, 0, 500, 0, 0) }, "analyst"));
check("الأفضل بالدليل يتقدّم إلى خانة المؤهَّل", keys(better) === "openrouter/x,groq/b,groq/a,pollinations/", keys(better));
check("لا يضيف ولا يحذف", better.length === list.length && new Set(keys(better).split(",")).size === list.length);
const pinned = R.orderByEvidence(list, "analyst", E({ "groq|a": ev(30, 15, 5000, 0, 0), "openrouter|x": ev(30, 0, 500, 0, 0) }, "analyst"), { fixed: (x) => x.model === "a" });
check("المثبَّت لا يتحرك", pinned[0]!.model === "a");
const tiered = R.orderByEvidence(list, "analyst", E({ "groq|a": ev(30, 15, 5000, 0, 0), "openrouter|x": ev(30, 0, 500, 0, 0) }, "analyst"), { tierOf: (x) => (x.provider === "groq" ? 0 : 1) });
check("الدليل لا يعبر الطبقة (الدفع أولاً)", tiered[0]!.provider === "groq" && tiered[2]!.provider === "openrouter");
const quality = R.orderByEvidence(list, "analyst", E({ "groq|a": ev(40, 0, 500, 5, 35), "groq|b": ev(40, 0, 500, 35, 5) }, "analyst"));
check("الجودة تفصل بين متساويين في النجاح والزمن", quality[0]!.model === "b");
const cf = R.orderByEvidence(list, "customer_reply", E({ "openrouter|x": ev(5, 0, 500, 1, 0) }, "customer_reply"), { fixed: (x) => x.model === "a" });
check("عمل العميل: من اجتاز مرةً يتقدّم على من لم يجتز، حتى المثبَّت", cf[0]!.provider === "openrouter" && cf.length === 4, keys(cf));
check("...والعمل الداخلي لا يُطبَّق عليه ذلك", R.orderByEvidence(list, "analyst", E({ "openrouter|x": ev(5, 0, 500, 1, 0) }, "analyst"))[0]!.model === "a");
check("لا أحد اجتاز: الترتيب كما هو", keys(R.orderByEvidence(list, "writer", E({ "groq|b": ev(30, 0, 100, 0, 30) }, "writer"))) === keys(list));

// ── الأسعار ──
const refused = (x: any) => { try { P.validatePrice(x); return false; } catch (e) { return e instanceof P.PriceRefused; } };
check("لا سعر بلا مصدر", refused({ provider: "groq", model: "m", inputPerMillion: 1, outputPerMillion: 2 }));
check("لا سعر سالب", refused({ provider: "groq", model: "m", inputPerMillion: -1, outputPerMillion: 2, source: "https://x" }));
check("مزوّد بحروف غير مقبولة يُرفض", refused({ provider: "Groq AI", inputPerMillion: 1, outputPerMillion: 1, source: "https://x" }));
check("costOf", Math.abs(P.costOf({ inputPerMillion: 1, outputPerMillion: 2 }, 1_000_000, 500_000) - 2) < 1e-9);
const pm = new Map([["groq|m", { provider: "groq", model: "m", inputPerMillion: 1, outputPerMillion: 1, currency: "USD", source: "s" }], ["groq|e", { provider: "groq", model: "e", inputPerMillion: 1, outputPerMillion: 1, currency: "EUR", source: "s" }]]);
check("بلا صف سعر: null", P.usdCost(pm, "groq", "other", 10, 10) === null);
check("سعر بغير الدولار لا يدخل costUsd", P.usdCost(pm, "groq", "e", 10, 10) === null && P.usdCost(pm, "groq", "m", 1_000_000, 0) === 1);
check("التنفيذ: نداءٌ بلا سعر يجعل الكلفة null", meterFacts({ calls: 2, tokensIn: 1, tokensOut: 1, model: "groq", lastProvider: "groq", lastModel: "m", costUsd: 0.1, costUnknown: true }).costUsd === null);
check("التنفيذ: كلها مسعَّرة", meterFacts({ calls: 1, tokensIn: 1, tokensOut: 1, model: "groq", lastProvider: "groq", lastModel: "m", costUsd: 0.25 }).costUsd === 0.25);
check("التنفيذ: المزوّد والنموذج منفصلان", (() => { const f = meterFacts({ calls: 1, tokensIn: 0, tokensOut: 0, model: "groq", lastProvider: "groq", lastModel: "qwen/x" }); return f.provider === "groq" && f.model === "qwen/x"; })());
check("جولة بلا نداء: لا كلفة", meterFacts({ calls: 0, tokensIn: 0, tokensOut: 0, model: null }).costUsd === null);

// ── صحة العامل ──
const now = Date.parse("2026-11-10T10:00:00Z");
const row = (o: Partial<Record<string, unknown>>) => ({ worker_id: "w", name: "n", interval_ms: 60_000, scope: "all", started_at: new Date(now - 3_600_000), first_due_at: new Date(now - 3_000_000), last_tick_at: null, last_ok_at: null, last_error: null, last_error_at: null, last_duration_ms: null, ticks: 0, errors: 0, ...o }) as any;
check("دقّةٌ أقدم من 3× الفاصل: عالق", W.workerHealth(row({ last_tick_at: new Date(now - 181_000), last_ok_at: new Date(now - 181_000) }), now).health === "stuck");
check("ضمن 3×: سليم", W.workerHealth(row({ last_tick_at: new Date(now - 170_000), last_ok_at: new Date(now - 170_000) }), now).health === "ok");
check("آخر دقّة فشلت", W.workerHealth(row({ last_tick_at: new Date(now - 10_000), last_ok_at: new Date(now - 100_000), last_error_at: new Date(now - 9_000) }), now).health === "failing");
check("لم تدقّ ولم يحن موعدها: ينتظر", W.workerHealth(row({ first_due_at: new Date(now + 60_000) }), now).health === "waiting");
check("لم تدقّ وفات موعدها بـ3×: عالق", W.workerHealth(row({ first_due_at: new Date(now - 200_000) }), now).health === "stuck");

const here = dirname(fileURLToPath(import.meta.url));
const norm = (x: string) => x.replace(/\s+/g, " ").trim();
const mig = norm(readFileSync(join(here, "../../../../../lib/db/migrations/079_org_ops.sql"), "utf8"));
check("079 يحمل كل عبارة في ORG_OPS_SQL", ORG_OPS_SQL.every((q) => mig.includes(norm(q))));
check("079 لا يبذر سعراً", !/INSERT INTO provider_prices/i.test(mig));

// ── على القاعدة ──
if (!/127\.0\.0\.1:(55446|55442)\//.test(process.env["DATABASE_URL"] ?? "")) {
  console.log(`org-ops (pure): ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const { ensureOrgTables } = await import("../org/schema");
const { execute } = await import("../org/runtime");
const { complete } = await import("../llm");
const { asAgent } = await import("../agent-context");
const V = await import("../org/providers");
const { watchdogFindings } = await import("../org/watchdog");
const one = async (q: any) => ((await db.execute<any>(q)).rows[0]);
const A = 17;

check("الجداول تُنشأ، ومرتين", (await ensureOrgTables()) && (await ensureOrgTables()));
await db.execute(sql`DELETE FROM provider_prices`); await db.execute(sql`DELETE FROM worker_registry`); await db.execute(sql`DELETE FROM provider_metrics`);
await db.execute(sql`DELETE FROM employee_executions WHERE user_id = ${A}`);
check("provider_prices فارغ بعد الإقلاع", (await one(sql`SELECT count(*)::int AS n FROM provider_prices`)).n === 0);

// سجل العمّال: صف واحد مهما دقّ، والخطأ يُرى
const w: any = { name: "test.loop", intervalMs: 60_000, scope: "all", startedAt: Date.now(), firstDueAt: Date.now(), lastTickAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, lastDurationMs: null, ticks: 0, errors: 0, inFlight: 0 };
for (let i = 0; i < 5; i++) await W.tickOnce(w, async () => {});
check("لا صف لكل دقّة", (await one(sql`SELECT count(*)::int AS n FROM worker_registry WHERE name = 'test.loop'`)).n === 1);
check("الدقّات تُعدّ في الصف نفسه", Number((await one(sql`SELECT ticks FROM worker_registry WHERE name = 'test.loop'`)).ticks) === 5);
await W.tickOnce(w, async () => { throw new Error("انكسر عمداً"); });
const after = await one(sql`SELECT * FROM worker_registry WHERE name = 'test.loop'`);
check("الخطأ يُسجَّل ولا يُرمى", after.last_error === "انكسر عمداً" && Number(after.errors) === 1 && Number(after.ticks) === 6);
check("ويُرى فاشلاً", (await W.workerReport()).workers.find((x) => x.name === "test.loop")?.health === "failing");
// everyMs الحقيقي: يمسك الرمي، ولا يضاعف الاسم
let n = 0;
W.everyMs("test.every", 1_000, () => { n++; if (n === 2) throw new Error("مرة"); }, { firstMs: 0, unref: true });
W.everyMs("test.every", 1_000, () => { n += 100; }, { unref: true });
await new Promise((r) => setTimeout(r, 3_300));
W.stopWorker("test.every");
await new Promise((r) => setTimeout(r, 200));
const ev2 = await one(sql`SELECT count(*)::int AS rows, max(ticks)::int AS ticks, max(errors)::int AS errors FROM worker_registry WHERE name = 'test.every'`);
check("everyMs: صف واحد، دقّات، خطأ ممسوك، والاسم لا يُضاعف", ev2.rows === 1 && ev2.ticks >= 3 && ev2.errors === 1 && n < 100, ev2);
// دقّة فاتت: الحارس يراها
await db.execute(sql`UPDATE worker_registry SET last_tick_at = now() - interval '10 minutes', last_ok_at = now() - interval '10 minutes', last_error_at = NULL WHERE name = 'test.loop'`);
const f = await watchdogFindings();
check("الحارس: آخر دقّة أقدم من 3× الفاصل ← stuck_worker", f.some((x) => x.kind === "stuck_worker" && x.subject === "worker:test.loop"));
check("...ولا يُقال في تقرير حساب", !(await watchdogFindings(A)).some((x) => x.kind === "stuck_worker"));
check("الجرد يقول عالق", (await W.workerReport()).stuck >= 1);

// تنظيف صفوف العمليات السابقة: المعرّف كله إن لم ينبض أيّ صف له منذ ست ساعات، والحالي لا يُمسّ أبداً.
const me = (await W.workerReport()).workerId;
const reg = (id: string, name: string, ago: string) => db.execute(sql`INSERT INTO worker_registry (worker_id, name, interval_ms, updated_at) VALUES (${id}, ${name}, 60000, now() - ${ago}::interval)`);
await db.execute(sql`DELETE FROM worker_registry WHERE worker_id LIKE 'test-%'`);
await reg("test-dead:1", "a", "7 hours"); await reg("test-dead:1", "b", "3 days");
await reg("test-sibling:2", "daily", "9 hours"); await reg("test-sibling:2", "flush", "1 minute");
await reg("test-recent:3", "a", "1 hour");
await db.execute(sql`UPDATE worker_registry SET updated_at = now() - interval '10 hours' WHERE worker_id = ${me} AND name = 'test.loop'`);
const byId = async () => Object.fromEntries((await db.execute<any>(sql`SELECT worker_id, count(*)::int AS n FROM worker_registry WHERE worker_id LIKE 'test-%' OR worker_id = ${me} GROUP BY 1`)).rows.map((r: any) => [r.worker_id, r.n]));
const gone = await W.workerRetention();
const left = await byId();
check("التنظيف: عملية ميتة تُحذف كلها", gone === 2 && !left["test-dead:1"], { gone, left });
check("...وشقيقة حية بصفٍّ قديم تبقى كلها", left["test-sibling:2"] === 2, left);
check("...وما نبض قبل ساعة يبقى", left["test-recent:3"] === 1, left);
check("...والعملية الحالية لا تُمسّ ولو قدم صفها", (await one(sql`SELECT count(*)::int AS n FROM worker_registry WHERE worker_id = ${me} AND name = 'test.loop'`)).n === 1);
check("...والجرد والحارس كما كانا", (await W.workerReport()).workers.some((x) => x.name === "test.loop") && (await W.stuckWorkers()).some((x) => x.name === "test.loop"));
check("مدة أقصر تُطلب صراحةً", (await W.workerRetention(0.5)) === 1 && !(await byId())["test-recent:3"]);
check("الافتراض ست ساعات وكل ساعة", W.WORKER_STALE_HOURS === 6 && W.WORKER_GC_MS === 3_600_000);
await reg("test-boot:4", "a", "8 hours");
W.startWorkerRegistryGc(); W.startWorkerRegistryGc();
await new Promise((r) => setTimeout(r, 400));
check("عند الإقلاع: يُنظَّف فوراً", !(await byId())["test-boot:4"]);
check("...ويُسجَّل دورياً مرة واحدة", W.workerStates().filter((x) => x.name === "org.worker_registry_gc").length === 1 && W.workerStates().find((x) => x.name === "org.worker_registry_gc")!.intervalMs === 3_600_000);
W.stopWorker("org.worker_registry_gc");
await db.execute(sql`DELETE FROM worker_registry WHERE worker_id LIKE 'test-%' OR name = 'org.worker_registry_gc'`);
await db.execute(sql`UPDATE worker_registry SET updated_at = now() WHERE worker_id = ${me} AND name = 'test.loop'`);

// التوجيه والتنفيذ: groq وحده بمفتاح، ثلاثة نماذج + pollinations
const msgs = [{ role: "user" as const, content: "مرحبا" }];
calledModels.length = 0;
const r1 = await execute(A, "sales", { kind: "ops_test" }, () => complete(msgs));
check("بلا دليل: المثبَّت أولاً", calledModels[0] === "qwen/qwen3.8-27b", calledModels);
const e1 = await one(sql`SELECT provider, model, cost_usd FROM employee_executions WHERE id = ${(r1 as any).executionId}`);
check("التنفيذ يحمل المزوّد والنموذج", e1.provider === "groq" && e1.model === "qwen/qwen3.8-27b", e1);
check("بلا سعر: الكلفة null", e1.cost_usd === null);

// دليل: النموذج الثاني اجتاز فحص الرد، والمثبَّت لم يجتز قط
const day = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
await db.execute(sql`INSERT INTO provider_metrics (user_id, provider, model, day, task_type, task_class, calls, failures, latency_ms, guard_passed, guard_failed)
  VALUES (${A}, 'groq', 'openai/gpt-oss-20b', ${day}, 'x', 'customer_reply', 25, 0, 25000, 20, 1), (${A}, 'groq', 'qwen/qwen3.8-27b', ${day}, 'x', 'customer_reply', 25, 0, 25000, 0, 20)`);
R.forgetRoutingEvidence();
calledModels.length = 0;
await asAgent(A, "sales", () => complete(msgs));
check("رد العميل: من اجتاز الجودة يتقدّم على المثبَّت الذي لم يجتز", calledModels[0] === "openai/gpt-oss-20b", calledModels);
calledModels.length = 0;
await asAgent(A, "email_analyst", () => complete(msgs));
check("صنفٌ آخر بلا دليل: الترتيب الحالي", calledModels[0] === "qwen/qwen3.8-27b", calledModels);

// الجودة تُسجَّل على من كتب، ثم تُفرَّغ في صف صنفها
await asAgent(A, "sales", async () => { V.noteQuality(true, { provider: "groq", model: "m-q" }); V.noteQuality(false, { provider: "groq", model: "m-q" }); V.noteQuality(true, { provider: "none", model: "" }); });
await V.flushProviderMetrics();
const q = await one(sql`SELECT task_class, guard_passed, guard_failed FROM provider_metrics WHERE user_id = ${A} AND model = 'm-q'`);
check("noteQuality: صف بصنف العمل، ورد قاعدة المعرفة لا يُنسب لأحد", q?.task_class === "customer_reply" && q.guard_passed === 1 && q.guard_failed === 1 && !(await one(sql`SELECT 1 AS x FROM provider_metrics WHERE provider = 'none'`)), q);

// الأسعار: الرفض قبل الكتابة، ثم الكلفة حيث يوجد صف
let threw = false; try { await P.setPrices(1, [{ provider: "groq", model: "openai/gpt-oss-20b", inputPerMillion: 1, outputPerMillion: 1, source: "https://groq.com/pricing" }, { provider: "groq", model: "y", inputPerMillion: 1, outputPerMillion: 1 }]); } catch (e) { threw = e instanceof P.PriceRefused; }
check("سطرٌ بلا مصدر يرفض الطلب كله", threw && (await one(sql`SELECT count(*)::int AS n FROM provider_prices`)).n === 0);
await P.setPrices(1, [{ provider: "groq", model: "openai/gpt-oss-20b", inputPerMillion: 1000, outputPerMillion: 2000, source: "اختبار: رقم وهمي للاختبار وحده" }]);
P.forgetPrices();
const r2 = await execute(A, "sales", { kind: "ops_test" }, () => complete(msgs));
const e2 = await one(sql`SELECT provider, model, cost_usd FROM employee_executions WHERE id = ${(r2 as any).executionId}`);
check("بسعر: الكلفة تُحسب", e2.model === "openai/gpt-oss-20b" && Number(e2.cost_usd) > 0, e2);
const rep = await V.providerReport(A, 7);
check("التقرير: الكلفة لمن له سعر، وnull لغيره", rep.byTask.some((x: any) => x.model === "openai/gpt-oss-20b" && x.costUsd != null) && rep.byTask.some((x: any) => x.model === "qwen/qwen3.8-27b" && x.costUsd === null));

// المسارات
const express = (await import("express")).default;
const orgMod = await import("../../routes/org");
let session: any = {};
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.session = session; next(); });
app.use("/org", orgMod.default);
const server = await new Promise<any>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}/org`;
const call = async (p: string, method = "GET", b?: unknown) => { const r = await realFetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() as any }; };
check("بلا جلسة 401", (await call("/providers/prices")).status === 401);
session = { userId: A, isAdmin: false };
check("GET الأسعار لصاحب الحساب", (await call("/providers/prices")).body.prices.length === 1);
check("PUT لغير المالك 403", (await call("/providers/prices", "PUT", { prices: [{ provider: "groq", model: "z", inputPerMillion: 1, outputPerMillion: 1, source: "https://x" }] })).status === 403);
session = { userId: 1, isAdmin: true };
check("PUT بلا مصدر 400", (await call("/providers/prices", "PUT", { prices: [{ provider: "groq", model: "z", inputPerMillion: 1, outputPerMillion: 1 }] })).status === 400);
const put = await call("/providers/prices", "PUT", { prices: [{ provider: "groq", model: "openai/gpt-oss-20b", remove: true }] });
check("PUT للمالك يحذف", put.status === 200 && put.body.prices.length === 0);
session = { userId: A, isAdmin: false };
const inv = await call("/inventory");
check("الجرد يحمل صحة العمّال", inv.status === 200 && Array.isArray(inv.body.workers?.workers) && inv.body.workers.workers.some((x: any) => x.name === "test.loop"));
const ov = await call("/overview");
check("النظرة العامة تحمل ملخّص العمّال", ov.status === 200 && ov.body.workers && ov.body.workers.stuck >= 1);
server.close();

await db.execute(sql`DELETE FROM worker_registry WHERE name LIKE 'test.%'`);
console.log(`org-ops: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
