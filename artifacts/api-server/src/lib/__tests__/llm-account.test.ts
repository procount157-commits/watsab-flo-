// مزوّد النموذج لكل حساب: llm_account_settings تجاوزٌ اختياري فوق llm_settings المشترك.
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/llm-account.test.ts          (المقارنة فقط)
//   DATABASE_URL=postgres://t:t@127.0.0.1:55442/t npx tsx src/lib/__tests__/llm-account.test.ts      (الكل)
// لا شبكة ولا مفتاح حقيقي: كل fetch مستبدل، والمفاتيح قيم وهمية، ولا يُطبع مفتاح في أي سطر.
export {};
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHARED = "fake-shared-key-0001", OWN = "fake-own-key-0002", OWN2 = "fake-own-key-0003";
const seen: Array<{ host: string; key: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const key = String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
  if (u.includes("api.groq.com") || u.includes("api.deepseek.com")) {
    seen.push({ host: new URL(u).host, key });
    return new Response(JSON.stringify({ choices: [{ message: { content: "جاهز" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error("no network in this test");
}) as any;
delete process.env["LLM_PROVIDER"];
for (const k of ["GROQ_API_KEY", "GROQ_API_KEYS", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_API_KEYS", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY", "THEGRID_API_KEY", "THEGRID_USERS"]) delete process.env[k];

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); } };
/** ما يُطبع عند الفشل: أي مفتاح كما هو → وصفه فقط. */
const who = (k: string) => (k === SHARED ? "shared" : k === OWN ? "own" : k === OWN2 ? "own2" : k ? "other" : "none");

const { LLM_ACCOUNT_SQL } = await import("../org/schema");
const here = dirname(fileURLToPath(import.meta.url));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const mig = norm(readFileSync(join(here, "../../../../../lib/db/migrations/081_llm_account_settings.sql"), "utf8"));
check("081 يحمل كل عبارة في LLM_ACCOUNT_SQL", LLM_ACCOUNT_SQL.every((q) => mig.includes(norm(q))));
check("081 لا ينقل ولا ينسخ: لا INSERT ولا UPDATE ولا DELETE", !/\b(INSERT|UPDATE|DELETE)\b/i.test(mig.replace(/--[^\n]*/g, "")));
check("081 يُعاد بأمان", /CREATE TABLE IF NOT EXISTS llm_account_settings/.test(mig));

if (!/127\.0\.0\.1:(55442|55446|55440)\//.test(process.env["DATABASE_URL"] ?? "")) {
  console.log(`\nllm-account: ${pass} ok, ${fail} failed (بلا قاعدة)`);
  process.exit(fail ? 1 : 0);
}

const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const { ensureOrgTables } = await import("../org/schema");
const L = await import("../llm");
const { asAgent } = await import("../agent-context");
const one = async (q: any) => (await db.execute<any>(q)).rows[0];

const A = 21, B = 22, C = 23;
for (const id of [A, B, C]) await db.execute(sql`INSERT INTO users (id, phone, password_hash, display_name) VALUES (${id}, ${`9715009900${id}`}, '!test-fixture-no-login', ${`llm-account ${id}`}) ON CONFLICT (id) DO NOTHING`);
check("الجداول تُنشأ، ومرتين", (await ensureOrgTables()) && (await ensureOrgTables()));
// قاعدة الاختبار وحدها: المشترك هو أول صف، فلا صف غير صفّنا.
await db.execute(sql`DELETE FROM llm_settings`);
await db.execute(sql`DELETE FROM llm_account_settings WHERE user_id IN (${A}, ${B}, ${C})`);
await db.execute(sql`INSERT INTO llm_settings (user_id, provider, api_key, model) VALUES (${A}, 'groq', ${SHARED}, NULL)`);
L.invalidateStoredProvider();

const msgs = [{ role: "user" as const, content: "مرحبا" }];
const call = async (u: number | null) => { seen.length = 0; const out = u == null ? await L.complete(msgs) : await asAgent(u, "sales", () => L.complete(msgs)); return { out, first: seen[0] }; };

// قبل أي تجاوز: الكل على المشترك، حرفياً كما كان.
for (const u of [A, B]) {
  const r = await call(u);
  check(`بلا تجاوز: الحساب ${u} على المشترك`, r.out?.provider === "groq" && who(r.first?.key ?? "") === "shared", { provider: r.out?.provider, key: who(r.first?.key ?? "") });
}
check("بلا تجاوز: الحالة «database» كما كانت", ((await L.providerStatusAsync(B)) as any).source === "database" && (await L.providerStatusAsync(B)).accountOverride === false);

// تجاوز للحساب ب وحده، بمزوّد آخر.
await db.execute(sql`INSERT INTO llm_account_settings (user_id, provider, api_key, model) VALUES (${B}, 'deepseek', ${OWN}, 'deepseek-chat')`);
L.invalidateStoredProvider();
const rb = await call(B);
check("ب بتجاوزه: مزوّده ومفتاحه", rb.out?.provider === "deepseek" && rb.first?.host === "api.deepseek.com" && who(rb.first?.key ?? "") === "own", { provider: rb.out?.provider, host: rb.first?.host, key: who(rb.first?.key ?? "") });
const ra = await call(A);
check("أ بلا تجاوز: المشترك كما هو", ra.out?.provider === "groq" && who(ra.first?.key ?? "") === "shared", { provider: ra.out?.provider, key: who(ra.first?.key ?? "") });
const rc = await call(C);
check("ج (لا صف له في الجدولين): المشترك", rc.out?.provider === "groq" && who(rc.first?.key ?? "") === "shared");
const rn = await call(null);
check("نداء بلا حساب: المشترك", rn.out?.provider === "groq" && who(rn.first?.key ?? "") === "shared");
check("resolveProvider بالحساب صراحةً", (await L.resolveProvider(B))?.provider === "deepseek" && (await L.resolveProvider(A))?.provider === "groq" && (await L.resolveProvider(A))?.scope === undefined);
const sb: any = await L.providerStatusAsync(B), sa: any = await L.providerStatusAsync(A);
check("الحالة: ب «account» ومفتاحه مقنَّع", sb.source === "account" && sb.accountOverride === true && sb.provider === "deepseek" && sb.maskedKey !== OWN && !JSON.stringify(sb).includes(OWN));
check("الحالة: أ «database» بلا تجاوز", sa.source === "database" && sa.accountOverride === false && sa.provider === "groq" && !JSON.stringify(sa).includes(SHARED));
check("المشترك لم يُمسّ", (await one(sql`SELECT count(*)::int AS n, max(api_key) AS k FROM llm_settings`)).n === 1 && who((await one(sql`SELECT api_key AS k FROM llm_settings`)).k) === "shared");

// ── المسارات ──
const express = (await import("express")).default;
const kb = (await import("../../routes/knowledge")).default;
let session: any = {};
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.session = session; next(); });
app.use("/kb", kb);
const server = await new Promise<any>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}/kb`;
const req = async (method: string, p: string, b?: unknown) => { const r = await realFetch(`${base}${p}`, { method, headers: b ? { "Content-Type": "application/json" } : undefined, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, text: await r.text() }; };
const body = (r: { text: string }) => JSON.parse(r.text);

session = { userId: C };
let r = await req("GET", "/provider");
check("GET بلا تجاوز: المشترك", r.status === 200 && body(r).source === "database" && body(r).accountOverride === false && !r.text.includes(SHARED));
r = await req("PUT", "/provider", { provider: "groq", apiKey: OWN2, scope: "account" });
check("PUT «لهذا الحساب فقط»: يُحفظ ويُجرَّب بمفتاحه", r.status === 200 && body(r).scope === "account" && body(r).working === true && who(seen[seen.length - 1]?.key ?? "") === "own2" && !r.text.includes(OWN2));
check("...في llm_account_settings وحده", (await one(sql`SELECT count(*)::int AS n FROM llm_account_settings WHERE user_id = ${C}`)).n === 1 && (await one(sql`SELECT count(*)::int AS n FROM llm_settings WHERE user_id = ${C}`)).n === 0);
r = await req("GET", "/provider");
check("GET بعده: «account»", body(r).source === "account" && body(r).accountOverride === true && !r.text.includes(OWN2));
check("ج بتجاوزه، وأ على المشترك", who((await call(C)).first?.key ?? "") === "own2" && who((await call(A)).first?.key ?? "") === "shared");
r = await req("POST", "/provider/test");
check("اختبار ج يجرّب مفتاحه", body(r).ok === true && who(seen[seen.length - 1]?.key ?? "") === "own2");
r = await req("DELETE", "/provider?scope=account");
check("DELETE scope=account: يعود إلى المشترك", r.status === 200 && (await one(sql`SELECT count(*)::int AS n FROM llm_account_settings WHERE user_id = ${C}`)).n === 0 && who((await call(C)).first?.key ?? "") === "shared");
check("...والمشترك باقٍ", (await one(sql`SELECT count(*)::int AS n FROM llm_settings`)).n === 1);
// الافتراض كما كان: بلا scope يُكتب llm_settings بصف الحساب نفسه (upsert)، لا التجاوز.
session = { userId: A };
r = await req("PUT", "/provider", { provider: "groq", apiKey: SHARED });
check("PUT بلا scope: llm_settings كما كان", r.status === 200 && body(r).scope === "shared" && (await one(sql`SELECT count(*)::int AS n FROM llm_account_settings WHERE user_id = ${A}`)).n === 0 && (await one(sql`SELECT count(*)::int AS n FROM llm_settings WHERE user_id = ${A}`)).n === 1);
check("مزوّد غير مدعوم 400 في النطاقين", (await req("PUT", "/provider", { provider: "x", apiKey: "fake-key-xxxx", scope: "account" })).status === 400);
check("لا شبكة غير المستبدَل", seen.every((s) => s.host === "api.groq.com" || s.host === "api.deepseek.com"));
server.close();

await db.execute(sql`DELETE FROM llm_account_settings WHERE user_id IN (${A}, ${B}, ${C})`);
await db.execute(sql`DELETE FROM llm_settings WHERE user_id IN (${A}, ${B}, ${C})`);
console.log(`\nllm-account: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
