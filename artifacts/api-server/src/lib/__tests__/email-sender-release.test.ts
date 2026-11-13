// فكّ إمهال صندوقٍ يدوياً: يعود إلى التدوير، ويبقى السبب مكتوباً، ولا يفكّ
// أحدٌ صندوق غيره — لا من الدالة ولا من المسار. على قاعدة اختبارٍ مؤقتة وحدها:
//   DATABASE_URL=postgres://postgres:x@127.0.0.1:55441/postgres npx tsx src/lib/__tests__/email-sender-release.test.ts
export {};
if (!/(127\.0\.0\.1|localhost):(55446|55445|55439|55440|55441|55442|55444)\//.test(process.env["DATABASE_URL"] ?? "")) { console.error("على قاعدة الاختبار وحدها"); process.exit(1); }
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("no network in this test"); }) as any;

const { db, usersTable, emailSendersTable, emailAgentActivityTable } = await import("@workspace/db");
const { eq, inArray, and } = await import("drizzle-orm");
const { releaseSenderHold, liveSenders } = await import("../email/senders");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};

const A = 9101, B = 9102;
await db.delete(usersTable).where(inArray(usersTable.id, [A, B]));
await db.insert(usersTable).values([
  { id: A, name: "مالك أ", phone: "971500009101", passwordHash: "x" } as any,
  { id: B, name: "مالك ب", phone: "971500009102", passwordHash: "x" } as any,
]);
const later = new Date(Date.now() + 20 * 3_600_000);
const box = (userId: number, fromEmail: string) => ({ userId, fromEmail, smtpHost: "smtp.invalid", smtpUser: fromEmail, smtpPass: "p", status: "active", heldUntil: later, heldReason: "ارتداد ٦٪ من ٨٠ رسالة في يومين" });
const [a1] = await db.insert(emailSendersTable).values(box(A, "a1@test.invalid") as any).returning();
const [b1] = await db.insert(emailSendersTable).values(box(B, "b1@test.invalid") as any).returning();
const row = async (id: number) => (await db.select().from(emailSendersTable).where(eq(emailSendersTable.id, id)).limit(1))[0]!;

// ── الدالة ───────────────────────────────────────────────────────
check("قبلها: الصندوق المُمهَل خارج التدوير", !(await liveSenders(A)).some((s) => s.id === a1!.id));
check("مستخدمٌ لا يفكّ صندوق غيره (null)", (await releaseSenderHold(A, b1!.id)) === null);
const theirs = await row(b1!.id);
check("وصندوق الآخر باقٍ مُمهَلاً كما هو", theirs.heldUntil?.getTime() === later.getTime() && /ارتداد/.test(theirs.heldReason ?? ""), theirs);
const r = await releaseSenderHold(A, a1!.id, new Date("2026-11-13T08:30:00Z"));
const mine = await row(a1!.id);
check("صندوقه هو: held_until = null", r !== null && mine.heldUntil === null, mine);
check("والسبب: أفرج عنه المالك يدوياً <التاريخ>", /^أفرج عنه المالك يدوياً .*(2026|٢٠٢٦)/.test(mine.heldReason ?? ""), mine.heldReason);
check("ويعيد العنوان والمهلة السابقة", r?.email === "a1@test.invalid" && r?.wasHeldUntil?.getTime() === later.getTime());
check("بعدها: عاد إلى التدوير", (await liveSenders(A)).some((s) => s.id === a1!.id));
check("الحالة لم تُمسّ (active)", mine.status === "active");
check("صندوقٌ غير موجود: null", (await releaseSenderHold(A, 99_999_999)) === null);

// ── المسار، بجلسةٍ مزيّفة كما في org-safety-db ──────────────────
await db.update(emailSendersTable).set({ heldUntil: later, heldReason: "ارتداد" }).where(eq(emailSendersTable.id, a1!.id));
const express = (await import("express")).default;
const emailRouter = (await import("../../routes/email")).default;
let session: any = { userId: A };
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.session = session; next(); });
app.use("/email", emailRouter);
const server = await new Promise<any>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}/email`;
const release = (id: number | string) => realFetch(`${base}/senders/${id}/release`, { method: "POST" });

check("المسار: صندوق مستخدمٍ آخر ← 404", (await release(b1!.id)).status === 404);
check("المسار: ولم يُفكّ", (await row(b1!.id)).heldUntil !== null);
check("المسار: رقم غير صالح ← 400", (await release("abc")).status === 400);
const res = await release(a1!.id);
const body = await res.json() as any;
check("المسار: صندوقه ← 200 وheld_until = null", res.status === 200 && body.ok && (await row(a1!.id)).heldUntil === null, body);
check("المسار: يكتب سبب الإفراج اليدوي", /^أفرج عنه المالك يدوياً/.test((await row(a1!.id)).heldReason ?? ""));
const acts = await db.select().from(emailAgentActivityTable).where(and(eq(emailAgentActivityTable.userId, A), eq(emailAgentActivityTable.action, "release")));
check("المسار: يُسجَّل نشاطٌ لماجد (email_guard)", acts.length === 1 && acts[0]!.role === "email_guard" && /a1@test\.invalid/.test(acts[0]!.text), acts);
check("المسار: لا نشاط باسم الآخر", (await db.select().from(emailAgentActivityTable).where(eq(emailAgentActivityTable.userId, B))).length === 0);
session = { userId: B };
check("المسار: الآخر يفكّ صندوقه هو", (await release(b1!.id)).status === 200 && (await row(b1!.id)).heldUntil === null);
session = {};
check("المسار: بلا جلسة ← 401", (await release(a1!.id)).status === 401);
server.close();

await db.delete(usersTable).where(inArray(usersTable.id, [A, B]));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
