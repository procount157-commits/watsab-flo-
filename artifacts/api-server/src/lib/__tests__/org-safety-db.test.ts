// The switches against a real database, and no network: providers are a stub
// that counts. Throwaway Postgres only, never the live one:
//   DATABASE_URL=postgres://t:t@127.0.0.1:55439/t npx tsx src/lib/__tests__/org-safety-db.test.ts
export {};
if (!/127\.0\.0\.1:(55439|55440)/.test(process.env["DATABASE_URL"] ?? "")) { console.error("على قاعدة الاختبار وحدها"); process.exit(1); }

// No provider may be reached, whichever path is wrong: any fetch is recorded and refused.
let fetched = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { fetched++; throw new Error("no network in this test"); }) as any;
process.env["GEMINI_API_KEY"] = "test-key";
process.env["GROQ_API_KEY"] = "test-key";

const { db, emailSettingsTable, emailContactsTable, emailMessagesTable, emailCampaignsTable, unsubscribedPhonesTable, emailListsTable } = await import("@workspace/db");
const { sql, eq, and } = await import("drizzle-orm");
const { gateSend, flushAllowed, pendingAllowed } = await import("../org/gateway");
const { isHalted, setControl, forgetControls, accountHalted, activeAccounts, audit, modelHalted } = await import("../org/controls");
const { ensureOrgTables } = await import("../org/schema");
const { forgetSwitches, setTeamPaused } = await import("../graph/switch");
const { complete } = await import("../llm");
const { asAgent, asWorker } = await import("../agent-context");
const { sendEmail, EmailHalted, EmailSuppressed } = await import("../email/provider");
const { describeImage } = await import("../vision");
const { transcribe } = await import("../voice");
const { classifyWithAI } = await import("../intent");
const { driverFor } = await import("../social/drivers");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};
const A = 11, B = 12;
const msgs = [{ role: "user" as const, content: "مرحبا" }];
const reset = async () => { await db.execute(sql`DELETE FROM org_controls`); forgetControls(); forgetSwitches(A); forgetSwitches(B); };
const refusals = async (u: number) => Number(((await db.execute(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE user_id = ${u} AND action = 'gate.refused'`)).rows[0] as any).n);
const wa = (userId: number, kind = "campaign", recipient = "971500000001", role: string | null = null) => gateSend({ userId, channel: "whatsapp", kind, recipient, role });
const mail = (userId: number, recipient = "a@example.com") => gateSend({ userId, channel: "email", kind: "campaign", recipient });

await ensureOrgTables();
// Run again on the same database, it starts from the same place.
for (const t of ["org_audit_log", "unsubscribed_phones", "email_messages", "email_campaigns", "email_contacts", "email_settings", "social_threads", "bot_employees"]) {
  await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${A}, ${B})`));
}
check("ensureOrgTables is idempotent, on top of a pushed schema and the migration", await ensureOrgTables());
await reset();

// ── Constraints hold ──
const bad = (q: any) => db.execute(q).then(() => false, () => true);
check("org_controls refuses an unknown scope", await bad(sql`INSERT INTO org_controls (scope, target) VALUES ('galaxy', '')`));
check("org_controls refuses a global with an account", await bad(sql`INSERT INTO org_controls (scope, user_id) VALUES ('global', ${A})`));
check("employee_tasks refuses an unknown status", await bad(sql`INSERT INTO employee_tasks (user_id, owner_role, task_type, status) VALUES (${A}, 'x', 'y', 'nope')`));
await db.execute(sql`INSERT INTO employee_tasks (user_id, owner_role, task_type, idempotency_key) VALUES (${A}, 'x', 'y', 'k1')`);
check("employee_tasks: one idempotency key per account", await bad(sql`INSERT INTO employee_tasks (user_id, owner_role, task_type, idempotency_key) VALUES (${A}, 'x', 'y', 'k1')`));
check("...and another account may use the same key", !(await bad(sql`INSERT INTO employee_tasks (user_id, owner_role, task_type, idempotency_key) VALUES (${B}, 'x', 'y', 'k1')`)));
await db.execute(sql`DELETE FROM employee_tasks`);
await db.execute(sql`INSERT INTO agent_memory (user_id, role, kind, content) VALUES (${A}, 'sales', 'win', 'x')`);
const mem = (await db.execute<any>(sql`SELECT approval_status, version FROM agent_memory WHERE user_id = ${A} LIMIT 1`)).rows[0];
check("agent_memory: what exists is approved, at version 1", mem.approval_status === "approved" && Number(mem.version) === 1);
await db.execute(sql`INSERT INTO bot_employees (user_id, name, role, employee_key) VALUES (${A}, 'x', 'email', 'email.copywriter')`);
check("bot_employees: employee_key unique per account", await bad(sql`INSERT INTO bot_employees (user_id, name, role, employee_key) VALUES (${A}, 'y', 'email2', 'email.copywriter')`));
await db.execute(sql`DELETE FROM bot_employees WHERE user_id = ${A}`);
await db.execute(sql`DELETE FROM agent_memory WHERE user_id = ${A}`);

// ── With nothing engaged, everything goes ──
check("no switch: WhatsApp allowed", (await wa(A)).allowed);
check("no switch: email allowed", (await mail(A)).allowed);
check("no switch: not halted", !(await isHalted({ userId: A })).halted);
check("no switch: no refusal logged", (await refusals(A)) === 0);
check("no audit row per allowed send, only a counter", pendingAllowed().some((c) => c.userId === A && c.n >= 1));
await flushAllowed();
const rolled = (await db.execute<any>(sql`SELECT count, channel FROM org_audit_log WHERE user_id = ${A} AND action = 'gate.allowed' AND channel = 'whatsapp'`)).rows;
check("the counter is written as one row with a count", rolled.length === 1 && Number(rolled[0].count) >= 1, rolled);

// ── Every level blocks gateSend and complete() ──
const levels: Array<{ scope: any; userId: number | null; target: string; blocksWa: boolean; blocksMail: boolean; blocksModel: boolean; role?: string }> = [
  { scope: "global", userId: null, target: "", blocksWa: true, blocksMail: true, blocksModel: true },
  { scope: "account", userId: A, target: "", blocksWa: true, blocksMail: true, blocksModel: true },
  { scope: "channel", userId: A, target: "whatsapp", blocksWa: true, blocksMail: false, blocksModel: false },
  { scope: "channel", userId: null, target: "email", blocksWa: false, blocksMail: true, blocksModel: false },
  { scope: "department", userId: A, target: "email", blocksWa: false, blocksMail: true, blocksModel: true, role: "email_followup" },
  { scope: "employee", userId: A, target: "sales", blocksWa: true, blocksMail: false, blocksModel: true, role: "sales" },
];
for (const l of levels) {
  await reset();
  await setControl({ ...l, engaged: true, reason: "اختبار", actor: A });
  const name = `${l.scope}${l.userId === null ? " (platform)" : ""}${l.target ? `:${l.target}` : ""}`;
  // The department case has its employee on the model call only: that employee's WhatsApp send would stop too (next check).
  const w = await wa(A, "campaign", "971500000001", l.scope === "employee" ? l.role : null), m = await mail(A);
  if (l.scope === "department") check(`${name}: its employee's send on another channel stops too`, !(await wa(A, "campaign", "971500000001", l.role)).allowed);
  check(`${name}: WhatsApp ${l.blocksWa ? "refused" : "goes"}`, w.allowed !== l.blocksWa, w);
  check(`${name}: email ${l.blocksMail ? "refused" : "goes"}`, m.allowed !== l.blocksMail, m);
  const f0 = fetched;
  const out = await asAgent(A, l.role ?? "sales", () => complete(msgs, 2_000));
  if (l.blocksModel) check(`${name}: complete() refused before any network`, out === null && fetched === f0, fetched - f0);
  if (l.scope === "channel") check(`${name}: a channel switch does not stop thinking`, !(await isHalted({ userId: A, role: "sales" })).halted);
  // One account's switch does not touch the other; a platform switch does.
  const other = await wa(B, "campaign", "971500000002", l.role ?? null);
  const expectOther = l.userId === null && l.blocksWa;
  check(`${name}: the other account ${expectOther ? "is stopped too" : "is untouched"}`, other.allowed !== expectOther, other);
}

// complete() outside an employee: the platform's switch applies and nothing else.
await reset();
await setControl({ scope: "account", userId: A, target: "", engaged: true, actor: A });
const f1 = fetched;
await complete(msgs, 2_000);
check("outside asAgent, an account switch does not apply (the call goes on to its providers)", fetched > f1, fetched - f1);
await reset();
await setControl({ scope: "global", userId: null, target: "", engaged: true, actor: 1 });
const f2 = fetched;
check("outside asAgent, the platform's switch stops it, before any network", (await complete(msgs, 2_000)) === null && fetched === f2);
await reset();
// asWorker: the bypass closed. Collector, ops, coach, routines go this way.
await setControl({ scope: "account", userId: A, target: "", engaged: true, actor: A });
const f3 = fetched;
check("asWorker: an account switch stops a background job, before any network", (await asWorker(A, "collector", () => complete(msgs, 2_000))) === null && fetched === f3);
await reset();

// The direct model calls.
await setControl({ scope: "account", userId: A, target: "", engaged: true, actor: A });
const f4 = fetched;
check("vision obeys the account", (await describeImage(Buffer.from("x"), "image/jpeg", "", 1_000, A)) === null);
check("voice obeys the account", (await transcribe(Buffer.from("x"), "audio/ogg", 1_000, A)) === null);
check("the direct Pollinations call obeys the account", (await classifyWithAI("مرحبا", 1_000, A)) === null);
check("...none of them reached the network", fetched === f4, fetched - f4);
check("modelHalted: another account is free", !(await modelHalted(B)));
await reset();
await setControl({ scope: "global", userId: null, target: "", engaged: true, actor: 1 });
const f5 = fetched;
check("vision obeys the platform with no account known", (await describeImage(Buffer.from("x"))) === null && fetched === f5);
await reset();

// The old switches, and what they never stopped.
await db.execute(sql`INSERT INTO business_profile (user_id) VALUES (${A}) ON CONFLICT (user_id) DO NOTHING`);
await setTeamPaused(A, true);
check("team_paused: the machine's send is refused", !(await wa(A)).allowed);
check("team_paused: the owner's own message goes", (await wa(A, "manual")).allowed);
check("team_paused: a worker skips the account", await accountHalted(A, "test_worker"));
check("activeAccounts drops only the halted", JSON.stringify(await activeAccounts([A, B], "test_worker")) === JSON.stringify([B]));
await setTeamPaused(A, false);
await db.execute(sql`INSERT INTO bot_employees (user_id, name, role, is_active) VALUES (${A}, 'x', 'wa_campaigns', false)`);
forgetSwitches(A);
check("is_active=false: that employee's send is refused", (await wa(A, "campaign", "971500000001", "wa_campaigns")).scope === "employee");
const f6 = fetched;
check("is_active=false: that employee's thinking too", (await asAgent(A, "wa_campaigns", () => complete(msgs, 2_000))) === null && fetched === f6);
check("is_active=false: a send with no employee on it goes", (await wa(A)).allowed);
await db.execute(sql`DELETE FROM bot_employees WHERE user_id = ${A}`);
forgetSwitches(A);

// ── Opt-out ──
await reset();
await db.insert(unsubscribedPhonesTable).values({ userId: A, phone: "+971 50 111 2222", reason: "stop" });
const op = await wa(A, "campaign", "0501112222");
check("WhatsApp: opted out in any spelling of the number is refused", !op.allowed && op.code === "opted_out", op);
check("WhatsApp: ...on follow-ups too", (await wa(A, "followup", "971501112222")).code === "opted_out");
check("WhatsApp: ...and logged", ((await db.execute<any>(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE user_id = ${A} AND action = 'gate.refused' AND why LIKE 'opted_out:%'`)).rows[0].n) >= 2);
check("WhatsApp: the same number on another account is theirs to message", (await wa(B, "campaign", "0501112222")).allowed);
check("WhatsApp: the acknowledgement of the stop still goes", (await wa(A, "optout_ack", "0501112222")).allowed);
await db.insert(emailContactsTable).values([
  { userId: A, email: "No@Example.com", status: "unsubscribed" }, { userId: A, email: "spam@example.com", status: "complained" },
  { userId: A, email: "bounce@example.com", status: "bounced" }, { userId: A, email: "yes@example.com", status: "active" },
]);
check("email: unsubscribed is refused, whatever the case", (await mail(A, "no@example.com")).code === "opted_out");
check("email: complained is refused", (await mail(A, "spam@example.com")).code === "opted_out");
check("email: bounced is the bounce guard's, not an opt-out", (await mail(A, "bounce@example.com")).allowed);
check("email: active goes", (await mail(A, "yes@example.com")).allowed);
check("email: another account's opt-out is not this one's", (await mail(B, "no@example.com")).allowed);
await db.execute(sql`INSERT INTO social_threads (user_id, platform, handle, status) VALUES (${A}, 'instagram', 'quiet_one', 'stopped')`);
check("instagram: a stopped thread is refused", (await gateSend({ userId: A, channel: "instagram", kind: "dm", recipient: "quiet_one" })).code === "opted_out");
check("instagram: anyone else goes", (await gateSend({ userId: A, channel: "instagram", kind: "dm", recipient: "other" })).allowed);

// ── LinkedIn ──
const li = await gateSend({ userId: A, channel: "linkedin", kind: "post" });
check("linkedin: refused with nothing engaged", !li.allowed && li.code === "no_driver");
check("linkedin: no driver is handed out", driverFor("linkedin" as any, A) === null);

// ── The social driver cannot act past a switch ──
await reset();
let touched = 0;
const { DRIVERS } = await import("../social/drivers");
const real = DRIVERS.instagram!;
const savedDm = real.sendDm, savedPub = real.publish;
real.sendDm = (async () => { touched++; return { ok: true }; }) as any;
real.publish = (async () => { touched++; return { ok: true }; }) as any;
await setControl({ scope: "channel", userId: A, target: "instagram", engaged: true, actor: A });
const d = driverFor("instagram", A)!;
const r1 = await d.sendDm({} as any, { handle: "someone" }, "x", { fresh: true });
const r2 = await d.publish({} as any, "x");
check("social: a halted DM never reaches the driver", !r1.ok && !r2.ok && touched === 0, { r1, r2, touched });
await reset();
const r3 = await d.sendDm({} as any, { handle: "someone" }, "x", { fresh: true });
check("social: with the switch off it does", r3.ok && touched === 1);
real.sendDm = savedDm; real.publish = savedPub;

// ── Email: the send itself, and the queue ──
await db.insert(emailSettingsTable).values({ userId: A, provider: "resend", apiKey: "k", fromEmail: "owner@a.example" }).onConflictDoNothing();
const [settings] = await db.select().from(emailSettingsTable).where(eq(emailSettingsTable.userId, A));
const out0 = { subject: "s", html: "<p>x</p>", text: "x", messageId: "<m@a>", unsubscribeUrl: null };
await setControl({ scope: "account", userId: A, target: "", engaged: true, actor: A });
const f7 = fetched;
const e1 = await sendEmail(settings!, { ...out0, to: "yes@example.com" }).then(() => null, (e) => e);
check("sendEmail: halted throws EmailHalted, before any network", e1 instanceof EmailHalted && fetched === f7, e1);
const e2 = await sendEmail(settings!, { ...out0, to: "owner@a.example", kind: "owner_notice" }).then(() => null, (e) => e);
check("sendEmail: owner_notice to the owner goes through a stop (reaches the provider)", !(e1 instanceof EmailHalted && e2 instanceof EmailHalted) && fetched === f7 + 1, e2);
const e3 = await sendEmail(settings!, { ...out0, to: "yes@example.com", kind: "owner_notice" }).then(() => null, (e) => e);
check("sendEmail: owner_notice to anyone else is refused", e3 instanceof EmailHalted && fetched === f7 + 1, e3);
await reset();
const e4 = await sendEmail(settings!, { ...out0, to: "no@example.com" }).then(() => null, (e) => e);
check("sendEmail: an opted-out address throws EmailSuppressed", e4 instanceof EmailSuppressed, e4);

// drainQueues is what runs in production; its window is Mon–Fri, so the switch's
// effect is read from the row and the stall reason, whichever day this runs.
const { drainQueues, stallReason } = await import("../email/service");
const [camp] = await db.insert(emailCampaignsTable).values({ userId: A, name: "t", subject: "s", html: "<p>x</p>", status: "sending" } as any).returning();
const [contact] = await db.select().from(emailContactsTable).where(and(eq(emailContactsTable.userId, A), eq(emailContactsTable.email, "yes@example.com")));
const [queued] = await db.insert(emailMessagesTable).values({ userId: A, campaignId: camp!.id, contactId: contact!.id, toEmail: "yes@example.com", subject: "s", token: "tok-halt-1", status: "queued" }).returning();
await setControl({ scope: "channel", userId: A, target: "email", engaged: true, reason: "اختبار الطابور", actor: A });
const f8 = fetched;
// الثلاثاء ١٠ نوفمبر ٢٠٢٦، ١١:٠٠ دبي: داخل نافذة البريد مهما كان يوم التشغيل.
const FIXED = Date.parse("2026-11-10T07:00:00Z");
const RealDate = Date;
(globalThis as any).Date = new Proxy(RealDate, {
  construct: (T: any, a: any[]) => new T(...(a.length ? a : [FIXED])),
  get: (T: any, k) => (k === "now" ? () => FIXED : T[k]),
});
await drainQueues();
(globalThis as any).Date = RealDate;
const [after] = await db.select().from(emailMessagesTable).where(eq(emailMessagesTable.id, queued!.id));
check("a queued email stays queued when halted, not failed, not cancelled", after!.status === "queued", after!.status);
check("...nothing reached the network", fetched === f8, fetched - f8);
check("...and the reason shows on the queue", /مفتاح الإيقاف/.test(stallReason(A)?.why ?? ""), stallReason(A));
await reset();

// ── WhatsApp, through the real send path on a fake socket: nothing can reach a wire here ──
const { sendMessage, waManager, WhatsAppInstance } = await import("../whatsapp");
const { isFirewallError, isFirewallRefusal } = await import("../wa-firewall");
// Built without its constructor: waManager.get() would open a real connection to WhatsApp.
const inst: any = Object.create(WhatsAppInstance.prototype);
Object.assign(inst, { userId: A, state: {}, log: { info() {}, warn() {}, error() {} }, pendingSendAborts: new Map(), socketGeneration: 1, rememberSent() {}, recordOutbound() {} });
(waManager as any).instances.set(A, inst);
let wired: any[] = [];
let duringTyping: (() => Promise<void>) | null = null;
inst.state.socket = {
  ws: { readyState: 1 },
  onWhatsApp: async () => [{ exists: true }],
  sendPresenceUpdate: async () => { if (duringTyping) { const f = duringTyping; duringTyping = null; await f(); } },
  sendMessage: async (jid: string, body: any) => { wired.push({ jid, body }); return { key: { id: `fake-${wired.length}` } }; },
  readMessages: async () => {},
};
inst.state.connected = true;
inst.state.status = "connected";
inst.simulateHumanPresence = async () => { await inst.state.socket.sendPresenceUpdate(); };
// Past the sending hours and the firewall's pacing: only the org gate is on trial here.
await setControl({ scope: "account", userId: A, target: "", engaged: true, reason: "اختبار السلك", actor: A });
const blocked = await sendMessage(A, "971500000044", "x", undefined, undefined, undefined, undefined, { kind: "campaign" }).then(() => null, (e) => e);
check("WhatsApp wrapper: a switch throws FIREWALL:, and callers know what to do with that", isFirewallError(blocked), blocked);
const direct = await inst.sendMessage("971500000044", "ack").then(() => null, (e: any) => e);
check("WhatsApp class method, the internal path: same gate", isFirewallError(direct), direct);
const diag = await inst.directSend("971500000044", "x").then(() => null, (e: any) => e);
check("directSend: same gate", /اختبار السلك/.test(String(diag?.message)), diag);
check("...nothing reached the socket", wired.length === 0, wired);
await reset();
const refused = await sendMessage(A, "0501112222", "x", undefined, undefined, undefined, undefined, { kind: "followup" }).then(() => null, (e) => e);
check("WhatsApp wrapper: an opted-out number throws FIREWALL-REFUSED:", isFirewallRefusal(refused), refused);
check("...nothing reached the socket", wired.length === 0, wired);
await inst.sendMessage("0501112222", "تم", undefined, undefined, undefined, undefined, { kind: "optout_ack" });
check("the stop's acknowledgement does reach it", wired.length === 1, wired);
wired = [];
await inst.sendMessage("971500000045", "مرحبا", undefined, undefined, undefined, undefined, { kind: "reply" });
check("with no switch, a send reaches the socket as before", wired.length === 1 && wired[0].body.text === "مرحبا", wired);
wired = [];
duringTyping = async () => { await setControl({ scope: "account", userId: A, target: "", engaged: true, reason: "أُطفئ أثناء الكتابة", actor: A }); };
const midway = await inst.sendMessage("971500000046", "x", undefined, undefined, undefined, undefined, { kind: "reply", gated: true }).then(() => null, (e: any) => e);
check("a switch engaged while it types stops it at the last moment", isFirewallError(midway) && wired.length === 0, { midway, wired });
await reset();
inst.state.socket = null; inst.state.connected = false;

// ── Fail closed ──
await db.execute(sql`ALTER TABLE org_controls RENAME TO org_controls_away`);
forgetControls();
const h = await isHalted({ userId: A });
check("controls table unreadable: halted, reason given", h.halted && h.reason === "controls unavailable", h);
const fc = await wa(A);
check("controls table unreadable: gateSend refuses", !fc.allowed && fc.code === "halted", fc);
const f9 = fetched;
check("controls table unreadable: complete() refuses, in or out of an employee", (await complete(msgs, 2_000)) === null && (await asAgent(A, "sales", () => complete(msgs, 2_000))) === null && fetched === f9, fetched - f9);
check("controls table unreadable: a worker skips", await accountHalted(A, "fail_closed"));
const fe = await sendEmail(settings!, { ...out0, to: "yes@example.com" }).then(() => null, (e) => e);
check("controls table unreadable: sendEmail refuses and keeps it queued", fe instanceof EmailHalted && fetched === f9, fe);
await db.execute(sql`ALTER TABLE org_controls_away RENAME TO org_controls`);
forgetControls();
check("back: clear again", !(await isHalted({ userId: A })).halted);

// ── Idempotency, audit, the cache ──
const k1 = await gateSend({ userId: A, channel: "whatsapp", kind: "campaign", recipient: "971500000009", idempotencyKey: "send-1" });
const k2 = await gateSend({ userId: A, channel: "whatsapp", kind: "campaign", recipient: "971500000009", idempotencyKey: "send-1" });
const k3 = await gateSend({ userId: B, channel: "whatsapp", kind: "campaign", recipient: "971500000009", idempotencyKey: "send-1" });
check("an idempotency key lets one through", k1.allowed && !k2.allowed && k2.code === "duplicate", { k1, k2 });
check("...per account", k3.allowed);
const n0 = await refusals(B);
await setControl({ scope: "account", userId: B, target: "", engaged: true, reason: "x", actor: B });
await wa(B); await wa(B);
check("every refusal is a row", (await refusals(B)) - n0 === 2);
check("setting a switch is a row", ((await db.execute<any>(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE user_id = ${B} AND action = 'control.engaged'`)).rows[0].n) >= 1);
await setControl({ scope: "account", userId: B, target: "", engaged: false, actor: B });
check("releasing takes effect at once in this process", (await wa(B)).allowed);
check("the switch keeps one row per scope and account", ((await db.execute<any>(sql`SELECT count(*)::int AS n FROM org_controls WHERE user_id = ${B} AND scope = 'account'`)).rows[0].n) === 1);
await db.execute(sql`UPDATE org_controls SET engaged = true WHERE user_id = ${B} AND scope = 'account'`);
check("a change behind the cache is seen within its ten seconds, not before", !(await isHalted({ userId: B })).halted);
forgetControls();
check("...and after it", (await isHalted({ userId: B })).halted);
await reset();
await audit({ userId: A, action: "x.test", why: "y" });

// ── The routes, over HTTP on this machine ──
const express = (await import("express")).default;
const orgRouter = (await import("../../routes/org")).default;
let session: any = { userId: A, isAdmin: false };
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.session = session; next(); });
app.use("/org", orgRouter);
const server = await new Promise<any>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}/org`;
const put = (body: unknown) => realFetch(`${base}/controls`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
check("PUT global as an account owner: 403", (await put({ scope: "global", engaged: true })).status === 403);
check("nothing was engaged by that", !(await isHalted({ userId: A })).halted);
check("PUT account on someone else's: 403", (await put({ scope: "account", engaged: true, reason: "من المسار", userId: B })).status === 403);
const own = await (await put({ scope: "account", engaged: true, reason: "من المسار" })).json() as any;
check("PUT account on one's own: stops it, and only it", own.userId === A && (await isHalted({ userId: A })).halted && !(await isHalted({ userId: B })).halted, own);
check("PUT with no boolean: 400", (await put({ scope: "account", engaged: "yes" })).status === 400);
const seen = await (await realFetch(`${base}/controls`)).json() as any;
check("GET controls: one's own switch is there", seen.controls.some((c: any) => c.scope === "account" && c.user_id === A && c.engaged));
await put({ scope: "account", engaged: false });
check("PUT release: free again", !(await isHalted({ userId: A })).halted);
const logged = await (await realFetch(`${base}/audit?limit=5`)).json() as any;
check("GET audit: the change is logged, by whom", logged.audit.some((x: any) => x.action === "control.released" && x.actor === A));
check("GET audit: limit holds", logged.audit.length <= 5);
await db.execute(sql`INSERT INTO org_audit_log (user_id, action, why) VALUES (${B}, 'x.other', 'سرّ')`);
const theirs = await (await realFetch(`${base}/audit?limit=500&all=1`)).json() as any;
check("GET audit: another account's rows stay theirs, even asking for all", !theirs.audit.some((x: any) => x.user_id === B));
session = { userId: 1, isAdmin: true };
check("as an admin: all=1 shows them", (await (await realFetch(`${base}/audit?limit=500&all=1`)).json() as any).audit.some((x: any) => x.user_id === B));
check("as an admin: PUT global works", (await put({ scope: "global", engaged: true, reason: "تجربة" })).status === 200 && (await isHalted({ userId: A })).scope === "global");
check("as an admin: and comes off", (await put({ scope: "global", engaged: false })).status === 200 && !(await isHalted({ userId: A })).halted);
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
await db.execute(sql`DELETE FROM org_audit_log WHERE action = 'x.test'`);
process.exit(fail ? 1 : 0);
