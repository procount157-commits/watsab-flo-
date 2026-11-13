// السيناريو التجريبي على واتساب والسوشيال، وإشارات واتساب (علامة القراءة ومؤشر الكتابة) تحت مفاتيح الإيقاف.
// قاعدة الاختبار وحدها، بلا شبكة: كل fetch يُعدّ ويُرفض، والمقبس مزيّف يعدّ ما وصله.
//   DATABASE_URL=postgres://postgres:x@127.0.0.1:55443/postgres npx tsx src/lib/__tests__/org-e2e-channels.test.ts
export {};
if (!/127\.0\.0\.1:(55443|55444|55445)/.test(process.env["DATABASE_URL"] ?? "")) { console.error("على قاعدة الاختبار وحدها"); process.exit(1); }

let fetched = 0;
globalThis.fetch = (async (url: any) => { fetched++; throw new Error(`no network in this test: ${url}`); }) as any;
process.env["GEMINI_API_KEY"] = "test-key";
process.env["GROQ_API_KEY"] = "test-key";

const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const SIM = await import("../org/simulation");
const C = await import("../org/sandbox-e2e-channels");
const E = await import("../org/sandbox-e2e");
const { ensureSimTables } = await import("../org/sim-schema");
const { forgetControls, setControl } = await import("../org/controls");
const { signalAllowed } = await import("../org/gateway");
const { forgetSwitches, setTeamPaused } = await import("../graph/switch");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};
const A = 11, B = 12;
await ensureSimTables();
const clean = async () => {
  for (const t of ["sim_e2e_runs", "sim_fixtures", "employee_tasks", "org_audit_log", "org_controls", "bot_employees", "business_profile", "unsubscribed_phones", "agent_memory"]) {
    await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${A}, ${B})`)).catch(() => {});
  }
  forgetControls(); forgetSwitches(A); forgetSwitches(B);
};
await clean();

// ── المقبس المزيّف ──────────────────────────────────────────────
const { waManager, WhatsAppInstance, markRead } = await import("../whatsapp");
const inst: any = Object.create(WhatsAppInstance.prototype);
Object.assign(inst, { userId: A, state: {}, log: { info() {}, warn() {}, error() {}, debug() {} }, pendingSendAborts: new Map(), socketGeneration: 1, rememberSent() {}, recordOutbound() {} });
(waManager as any).instances.set(A, inst);
const wired: any[] = [], reads: any[] = [], presence: string[] = [];
inst.state.socket = {
  ws: { readyState: 1 }, onWhatsApp: async () => [{ exists: true }],
  sendPresenceUpdate: async (p: string) => { presence.push(p); },
  sendMessage: async (jid: string, body: any) => { wired.push({ jid, body }); return { key: { id: "fake" } }; },
  readMessages: async (keys: any[]) => { reads.push(...keys); },
};
inst.state.connected = true; inst.state.status = "connected";
const key = { remoteJid: "971500000046@s.whatsapp.net", id: "m1", fromMe: false };

// ── واتساب: السيناريو ────────────────────────────────────────────
const tickets = async (runId: number) => (await db.execute<any>(sql`SELECT task_id, parent_task_id, task_type, owner_role, status, input_refs FROM employee_tasks WHERE user_id = ${A} AND (input_refs->>'simRunId')::int = ${runId} ORDER BY task_id`)).rows;
const events = async (ids: number[]) => (await db.execute<any>(sql`SELECT ticket_id, action_type, status FROM ticket_action_events WHERE user_id = ${A} AND ticket_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) ORDER BY id`)).rows;

const f0 = fetched;
const w1 = await C.runWaE2e(A);
check("واتساب: اكتمل بثماني خطوات", w1.status === "succeeded" && w1.steps === 8, w1);
check("واتساب: بلا نموذج يعيده سيف بملاحظة", w1.accepted === false);
check("واتساب: نداء النموذج محسوب ومحدود", w1.modelCalls >= 0 && w1.modelCalls <= E.E2E_CALLS, w1.modelCalls);
check("واتساب: تنفيذ تجريبي، ولا شيء وصل المقبس", w1.sandbox.length >= 1 && wired.length === 0 && reads.length === 0 && presence.length === 0, { sandbox: w1.sandbox, wired, reads, presence });
void f0;
const wd = await E.e2eRun(A, w1.runId);
check("واتساب: القناة مسجّلة whatsapp", wd!.run.channel === "whatsapp" && wd!.run.summary.channel === "whatsapp", wd!.run.channel);
const wk = wd!.steps.map((s: any) => s.kind);
check("واتساب: هال ← شمّة ← الرد ← خالد ← سيف ← البوابة ← شمّة ← درس", wk.join() === "classification,routing,reply_draft,followup_plan,returned,sandbox_execution,outcome_event,learning_candidate", wk);
check("واتساب: الأسماء من سجل الموظفين", wd!.steps.map((s: any) => s.actor_name).join() === "هال,شمّة,هال,خالد,سيف,البوابة,شمّة,شمّة", wd!.steps.map((s: any) => s.actor_name));
check("واتساب: صنّف الرسالة سؤالاً أو اهتماماً", ["question", "interested"].includes(wd!.steps[0].detail.verdict.intent), wd!.steps[0].detail);
check("واتساب: بيانات الاختبار معلَّمة", wd!.run.is_test === true && wd!.run.fixture.test_data === true);
const wt = await tickets(w1.runId);
check("واتساب: ست تذاكر sim_", wt.length === 6 && wt.every((t: any) => t.task_type.startsWith("sim_wa_") && t.input_refs.test_data === true), wt.map((t: any) => t.task_type));
const wb = Object.fromEntries(wt.map((t: any) => [t.task_type, t]));
check("واتساب: كل تذكرة ابنة سابقتها، والنتيجة ابنة التوجيه",
  wb.sim_wa_route.parent_task_id === wb.sim_wa_classify.task_id && wb.sim_wa_reply.parent_task_id === wb.sim_wa_route.task_id
  && wb.sim_wa_followup.parent_task_id === wb.sim_wa_reply.task_id && wb.sim_wa_check.parent_task_id === wb.sim_wa_followup.task_id
  && wb.sim_wa_outcome.parent_task_id === wb.sim_wa_route.task_id);
check("واتساب: الأدوار من departments.ts", wb.sim_wa_classify.owner_role === "sales" && wb.sim_wa_route.owner_role === "chief" && wb.sim_wa_followup.owner_role === "followup" && wb.sim_wa_check.owner_role === "vetter" && wb.sim_wa_outcome.owner_role === "chief");
check("واتساب: الخطوات تشير إلى تذاكرها", wd!.steps.filter((s: any) => s.ticket_id).length === 6);
const we = await events(wt.map((t: any) => Number(t.task_id)));
check("واتساب: كل تذكرة لها سطر فعلها في السجل", wt.every((t: any) => we.some((e: any) => Number(e.ticket_id) === Number(t.task_id) && e.action_type === `sim.${t.task_type.slice(4)}`)), we);
check("واتساب: رفض البوابة سطرٌ تحت تذكرة الفحص", we.some((e: any) => Number(e.ticket_id) === Number(wb.sim_wa_check.task_id) && e.action_type === "gate.whatsapp" && e.status === "refused"), we);
const wg = wd!.steps.find((s: any) => s.kind === "sandbox_execution");
check("واتساب: البوابة رفضت بالرمز simulation", wg.detail.gate.code === "simulation" && !wg.detail.gate.allowed);
check("واتساب: لا درس في ذاكرة أحد", Number((await db.execute<any>(sql`SELECT count(*)::int AS n FROM agent_memory WHERE user_id = ${A}`)).rows[0].n) === 0);

const w2 = await C.runWaE2e(A, { reply: async () => "أهلاً بك، التكلفة تعتمد على حجم العمل. كم عدد الفواتير الشهرية تقريباً؟" });
check("واتساب: رد سليم: سيف يقبل", w2.status === "succeeded" && w2.accepted === true, w2);
const w2d = await E.e2eRun(A, w2.runId);
check("واتساب: الكلمة لهال", w2d!.steps[2].actor_name === "هال" && w2d!.steps[4].kind === "accepted");
check("واتساب: حساب آخر لا يرى سيناريو غيره", (await E.e2eRun(B, w2.runId)) === null);
check("واتساب: لا شيء وصل المقبس بعد الدورتين", wired.length === 0 && reads.length === 0 && presence.length === 0);

check("التوجيه: الشكوى لسام وطلب الإيقاف بلا رد", C.routeWa("complaint").role === "support" && C.routeWa("opt_out").role === null && C.routeWa("question").role === "sales");
check("المتابعة: مرة واحدة لمن أظهر اهتماماً، ولا شيء للشكوى", C.planWaFollowup("interested").follow && !C.planWaFollowup("complaint").follow);

// ── السوشيال ─────────────────────────────────────────────────────
const s1 = await C.runSocialE2e(A);
check("إنستجرام: اكتمل بسبع خطوات", s1.status === "succeeded" && s1.steps === 7, s1);
check("إنستجرام: بلا نموذج يعيده الحارس", s1.accepted === false);
const sd = await E.e2eRun(A, s1.runId);
check("إنستجرام: القناة social والمنصة instagram", sd!.run.channel === "social" && sd!.run.summary.platform === "instagram" && sd!.run.summary.source === "comment");
check("إنستجرام: المراقب ← المصنّفة ← الكاتب ← الحارس ← البوابة ← المدير ← درس", sd!.steps.map((s: any) => s.kind).join() === "found,classification,reply_draft,returned,sandbox_execution,outcome_event,learning_candidate", sd!.steps.map((s: any) => s.kind));
check("إنستجرام: الأسماء من teamDefs", sd!.steps.map((s: any) => s.actor_name).join() === "ريّان,لمياء,تركي,ماجد الحارس,البوابة,عبدالله,عبدالله", sd!.steps.map((s: any) => s.actor_name));
check("إنستجرام: السؤال عن السعر فرصة", sd!.steps[1].detail.isLead === true, sd!.steps[1].detail);
const st = await tickets(s1.runId);
check("إنستجرام: خمس تذاكر sim_ مربوطة", st.length === 5 && st.every((t: any) => t.task_type.startsWith("sim_soc_")), st.map((t: any) => t.task_type));
const sb = Object.fromEntries(st.map((t: any) => [t.task_type, t]));
check("إنستجرام: السلسلة والنتيجة لمدير الحساب",
  sb.sim_soc_triage.parent_task_id === sb.sim_soc_watch.task_id && sb.sim_soc_reply.parent_task_id === sb.sim_soc_triage.task_id
  && sb.sim_soc_guard.parent_task_id === sb.sim_soc_reply.task_id && sb.sim_soc_outcome.parent_task_id === sb.sim_soc_watch.task_id && sb.sim_soc_outcome.owner_role === "ig_manager");
const se = await events(st.map((t: any) => Number(t.task_id)));
check("إنستجرام: سطر فعل لكل تذكرة، ورفض البوابة تحت تذكرة الحارس", st.every((t: any) => se.some((e: any) => Number(e.ticket_id) === Number(t.task_id) && e.action_type.startsWith("sim.")))
  && se.some((e: any) => Number(e.ticket_id) === Number(sb.sim_soc_guard.task_id) && e.action_type === "gate.instagram" && e.status === "refused"), se);
check("إنستجرام: البوابة رفضت بالرمز simulation", sd!.steps[4].detail.gate.code === "simulation");

const s2 = await C.runSocialE2e(A, { platform: "tiktok", source: "dm" }, { reply: async () => "أهلاً، نساعدكم في متطلبات الامتثال. ما حجم نشاطكم تقريباً؟" });
check("تيك توك (خاص): اكتمل وقبله الحارس", s2.status === "succeeded" && s2.steps === 7 && s2.accepted === true, s2);
const s2d = await E.e2eRun(A, s2.runId);
check("تيك توك: مسؤول الخاص حمد يكتب، والحارس سيف، والمدير فيصل", s2d!.steps[2].actor_name === "حمد" && s2d!.steps[2].actor_role === "tt_dm" && s2d!.steps[3].actor_name === "سيف" && s2d!.steps[5].actor_name === "فيصل", s2d!.steps.map((s: any) => s.actor_name));
check("تيك توك: البوابة رفضت على قناة tiktok بنوع reply", s2d!.steps[4].detail.gate.code === "simulation" && s2d!.steps[4].detail.sandbox?.channel === "tiktok" && s2d!.steps[4].detail.sandbox?.kind === "reply", s2d!.steps[4].detail);

// ── القناة في المسار ─────────────────────────────────────────────
check("القناة: الافتراضي البريد، والمجهول يُرفض", C.e2eChannelOf(undefined) === "email" && C.e2eChannelOf("") === "email" && C.e2eChannelOf("whatsapp") === "whatsapp" && C.e2eChannelOf("social") === "social" && C.e2eChannelOf("sms") === null);
const runs = await E.e2eRuns(A);
check("القائمة تحمل القناة", runs.some((r: any) => r.channel === "whatsapp") && runs.some((r: any) => r.channel === "social"));

// إيقاف الحساب: لا سيناريو
await setControl({ scope: "account", userId: A, target: "", engaged: true, actor: A });
const halted = await C.runWaE2e(A).then(() => null, (e) => e);
check("الحساب موقوف: لا سيناريو واتساب", halted instanceof Error && /موقوف/.test(halted.message), String(halted));
await setControl({ scope: "account", userId: A, target: "", engaged: false, actor: A });
forgetControls();

// ── إشارات واتساب تحت المفاتيح ───────────────────────────────────
const reset = async () => { await db.execute(sql`DELETE FROM org_controls WHERE user_id = ${A} OR user_id IS NULL`); await setTeamPaused(A, false).catch(() => {}); forgetControls(); forgetSwitches(A); reads.length = 0; presence.length = 0; };
await db.execute(sql`INSERT INTO business_profile (user_id) VALUES (${A}) ON CONFLICT (user_id) DO NOTHING`);

await reset();
await markRead(A, key, "sales");
check("لا إيقاف: علامة القراءة تخرج كما كانت", reads.length === 1, reads);

const levels: Array<{ scope: "account" | "channel" | "department" | "employee" | "global"; target: string; userId: number | null; name: string }> = [
  { scope: "account", target: "", userId: A, name: "الحساب" },
  { scope: "channel", target: "whatsapp", userId: A, name: "قناة واتساب" },
  { scope: "department", target: "whatsapp", userId: A, name: "قسم واتساب" },
  { scope: "employee", target: "sales", userId: A, name: "الموظف هال" },
  { scope: "global", target: "", userId: null, name: "المنصة" },
];
for (const l of levels) {
  await reset();
  await setControl({ scope: l.scope, userId: l.userId, target: l.target, engaged: true, reason: "اختبار", actor: A });
  await markRead(A, key, "sales");
  check(`${l.name} موقوف: لا علامة قراءة`, reads.length === 0, reads);
}
await reset();
await setControl({ scope: "employee", userId: A, target: "support", engaged: true, reason: "اختبار", actor: A });
await markRead(A, key, "sales");
check("إيقاف موظف آخر لا يمنع علامة هال", reads.length === 1);
await reset();
await setControl({ scope: "channel", userId: A, target: "email", engaged: true, reason: "اختبار", actor: A });
check("إيقاف البريد لا يمسّ إشارات واتساب", await signalAllowed(A, { role: "sales" }));
await reset();
await setTeamPaused(A, true); forgetSwitches(A);
await markRead(A, key, "sales");
check("الفريق موقوف (المفتاح القديم): لا علامة قراءة", reads.length === 0);
check("...ورسالة صاحب العمل اليدوية تكتب كما كانت (HUMAN_KINDS)", await signalAllowed(A, { role: null, kind: "manual" }) && !(await signalAllowed(A, { role: null, kind: "reply" })));
await reset();
await SIM.withSimulation(SIM.newSimContext({ userId: A, kind: "manual" }), async () => { await markRead(A, key, "sales"); });
check("المحاكاة: لا علامة قراءة", reads.length === 0);

// مؤشر الكتابة: الطريقة نفسها التي يمرّ بها كل إرسال
await reset();
await setControl({ scope: "account", userId: A, target: "", engaged: true, actor: A });
await inst.simulateHumanPresence("971500000046@s.whatsapp.net", "تمام", "reply");
check("الحساب موقوف: لا مؤشر كتابة ولا حضور", presence.length === 0, presence);
await reset();
await setControl({ scope: "employee", userId: A, target: "sales", engaged: true, actor: A });
const { asAgent } = await import("../agent-context");
await asAgent(A, "sales", () => inst.simulateHumanPresence("971500000046@s.whatsapp.net", "تمام", "reply"));
check("الموظف موقوف: لا مؤشر كتابة من دوره", presence.length === 0, presence);
await reset();
const t0 = Date.now();
await inst.simulateHumanPresence("971500000046@s.whatsapp.net", "تمام", "reply");
check("لا إيقاف: المؤشر كما كان (حضور ← كتابة ← توقف)", presence.join() === "available,composing,paused", { presence, ms: Date.now() - t0 });

// فشل القراءة مغلق: مفاتيح لا تُقرأ ← لا علامة
await reset();
const realExec = db.execute.bind(db);
(db as any).execute = async (q: any) => { const s = JSON.stringify(q?.queryChunks ?? q ?? ""); if (/org_controls/.test(s)) throw new Error("down"); return realExec(q); };
forgetControls();
await markRead(A, key, "sales");
(db as any).execute = realExec;
check("المفاتيح لا تُقرأ: لا علامة قراءة (الفشل مغلق)", reads.length === 0, reads);

(waManager as any).instances.delete(A);
await reset();
await clean();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
