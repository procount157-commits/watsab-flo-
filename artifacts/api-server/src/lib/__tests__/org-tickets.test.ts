// التذاكر وسجل الأفعال. الجزء الأول بلا قاعدة:
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/org-tickets.test.ts
// والبقية على قاعدة اختبار وحدها، بلا شبكة ولا إرسال ولا نموذج:
//   DATABASE_URL=postgres://t:t@127.0.0.1:55441/t npx tsx src/lib/__tests__/org-tickets.test.ts
export {};
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let fetched = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  // المسارات المحلية للاختبار وحدها؛ كل ما عداها مرفوض ومعدود.
  if (/^http:\/\/127\.0\.0\.1:\d+\/org\/tickets/.test(u)) return realFetch(url, init);
  fetched++;
  throw new Error(`no network in this test: ${u}`);
}) as any;

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 400)); }
}

const L = await import("../org/ledger");
const K = await import("../org/tickets");
const T = await import("../org/tasks");
const C = await import("../org/controls");

// ── بلا قاعدة ─────────────────────────────────────────────────────
check("البصمة لا تتأثر بترتيب المفاتيح", L.payloadHash({ a: 1, b: { y: [1, 2], x: "س" } }) === L.payloadHash({ b: { x: "س", y: [1, 2] }, a: 1 }));
check("...وتتأثر بأي قيمة", L.payloadHash({ a: 1 }) !== L.payloadHash({ a: 2 }));
check("البصمة SHA-256", /^[a-f0-9]{64}$/.test(L.payloadHash({})));
check("الأولوية: الأرقام القديمة بأسمائها", T.priorityLevelOf(20) === "critical" && T.priorityLevelOf(60) === "high" && T.priorityLevelOf(100) === "normal" && T.priorityLevelOf(200) === "low");
check("الأولوية: الأسماء إلى أرقام تقرؤها الطوابير", Object.entries(T.PRIORITY_VALUE).every(([k, v]) => T.priorityLevelOf(v) === k));
check("الانتقالات: مسودة لا تكتمل", !K.canTransition("draft", "completed"));
check("الانتقالات: المكتملة تُعاد فتحها فقط", K.TRANSITIONS.completed.length === 1 && K.canTransition("completed", "queued"));
check("الانتقالات: تعمل ← مكتملة", K.canTransition("running", "completed") && !K.canTransition("queued", "completed"));
check("الإغلاق بلا مخرج ولا دليل مرفوض", K.closureProblems("completed", { taskType: "x" }, {}).length === 2);
check("دليل إرسالٍ من نوعه", K.closureProblems("completed", { taskType: "x", actionType: "send_message" }, { actualOutput: { sent: 1 }, evidence: [{ type: "note", ref: "قلت" }] }).length === 1);
check("...ويكفيه سطر البوابة", K.closureProblems("completed", { taskType: "x", actionType: "send_message" }, { actualOutput: { sent: 1 }, evidence: [{ type: "gate_event", id: 5 }] }).length === 0);
check("دليلٌ بلا رقم ولا مرجع ليس دليلاً", K.closureProblems("completed", { taskType: "x" }, { actualOutput: "تم", evidence: [{ type: "note" }] }).length === 1);
check("الفشل يتطلب أربعة", K.closureProblems("failed", { taskType: "x" }, {}).length === 4);
check("...والحجب كذلك", K.closureProblems("blocked", { taskType: "x" }, { reason: "ر", retryable: false, responsibleParty: "owner", suggestedResolution: "ح" }).length === 0);
const rows0: any[] = [{ scope: "task", userId: 1, target: "7", engaged: true, reason: null }];
check("مفتاح التذكرة يوقفها", C.decideHalt(rows0, { userId: 1, taskId: 7 }).scope === "task");
check("...ولا يوقف رقمها في حسابٍ آخر", !C.decideHalt(rows0, { userId: 2, taskId: 7 }).halted);
check("...ولا تذكرةً أخرى", !C.decideHalt(rows0, { userId: 1, taskId: 8 }).halted);
check("...ولا شيئاً بلا تذكرة", !C.decideHalt(rows0, { userId: 1, role: "email" }).halted);

const here = dirname(fileURLToPath(import.meta.url));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const mig = norm(readFileSync(join(here, "../../../../../lib/db/migrations/076_tickets.sql"), "utf8"));
check("076 يحمل كل ما عند الإقلاع", L.TICKET_SQL.every((q) => mig.includes(norm(q))));

if (!/127\.0\.0\.1:(55440|55441)/.test(process.env["DATABASE_URL"] ?? "")) {
  console.log(`\n${pass} نجح، ${fail} فشل (بلا قاعدة)`);
  process.exit(fail ? 1 : 0);
}

// ── على القاعدة ───────────────────────────────────────────────────
const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const { ensureOrgTables } = await import("../org/schema");
const { execute, runAs, forgetRuntimeCache } = await import("../org/runtime");
const { gateSend } = await import("../org/gateway");
const { forgetSwitches } = await import("../graph/switch");
const H = await import("../org/handoffs");

const A = 16, B = 17;
const rows = async <X = any>(q: any): Promise<X[]> => (await db.execute<any>(q)).rows as X[];
const one = async <X = any>(q: any): Promise<X> => (await rows<X>(q))[0]!;
const clean = async () => {
  for (const t of ["ticket_action_events", "employee_task_dependencies", "employee_tasks", "employee_executions", "employee_heartbeats", "org_audit_log", "org_controls", "unsubscribed_phones", "agent_memory", "bot_employees"]) {
    await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${A}, ${B})`));
  }
  C.forgetControls(); forgetSwitches(A); forgetSwitches(B); forgetRuntimeCache(); T.forgetHandlers(); L.forgetLedgerCache();
};
await ensureOrgTables();
check("الجداول تُنشأ", await L.ensureTicketTables());
await clean();
const owner = K.ownerActor(A);
const events = (id: number) => rows(sql`SELECT * FROM ticket_action_events WHERE ticket_id = ${id} ORDER BY id`);
const refused = async (p: Promise<unknown>, code?: string) => { try { await p; return false; } catch (e: any) { return e instanceof K.TicketRefused && (!code || e.code === code) ? e : false; } };

// قيد الحالات الجديد والمفتاح الجديد في القاعدة
check("القيد يقبل الحالات الجديدة", (await one(sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'employee_tasks_status'`)).d.includes("waiting_for_owner"));
check("...ونطاق task", (await one(sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'org_controls_scope'`)).d.includes("'task'"));
check("الإقلاع يُعاد بأمان", await L.ensureTicketTables());

// ── الإنشاء قبل العمل ──
const { ticket: t1, duplicate: d1 } = await K.intakeTicket({ userId: A, title: "رد على عرض شركة النور", createdBy: owner, actionType: "send_message", priority: "high", input: { to: "971500000001", text: "مرحبا" }, idempotencyKey: "intake:1" });
check("التذكرة مسودة قبل أي عمل", t1.status === "draft" && !d1 && t1.priorityLevel === "high" && t1.priority === 50 && t1.createdBy.kind === "owner");
check("...وسطر إنشائها", (await events(t1.taskId)).some((e) => e.action_type === "ticket.created"));
const again = await K.intakeTicket({ userId: A, title: "رد على عرض شركة النور", createdBy: owner, idempotencyKey: "intake:1" });
check("المفتاح نفسه: التذكرة نفسها", again.duplicate && again.ticket.taskId === t1.taskId);

// ── التكليف بمفتاح لا باسم ──
check("اسم العرض مرفوض", !!(await refused(K.assignTicket(A, t1.taskId, "نورة", owner), "invalid_assignee")));
check("الدور ليس مفتاحاً", !!(await refused(K.assignTicket(A, t1.taskId, "email", owner), "invalid_assignee")));
check("مفتاح مخترع مرفوض", !!(await refused(K.assignTicket(A, t1.taskId, "email.nobody", owner), "invalid_assignee")));
const a1 = await K.assignTicket(A, t1.taskId, "whatsapp.sales", owner);
check("التكليف بالمفتاح: الدور والقسم منه، والمسودة تصير معلّقة", a1.assignedTo === "whatsapp.sales" && a1.ownerRole === "sales" && a1.department === "whatsapp" && a1.status === "pending");
const a2 = await K.assignTicket(A, t1.taskId, "whatsapp.support", owner, "دعم");
check("إعادة التكليف تُسجَّل", a2.ownerRole === "support" && (await rows(sql`SELECT 1 FROM org_audit_log WHERE user_id = ${A} AND action = 'ticket.reassigned'`)).length === 1);
check("كل تغيير له رقم سجل على التذكرة", (await K.getTicket(A, t1.taskId)).auditEventIds.length >= 2);

// ── الموافقة على الحمولة بعينها ──
const p1 = await K.planTicket(A, t1.taskId, { expectedOutput: "رسالة واحدة", requiresApproval: true }, owner);
check("الخطة بموافقة: تنتظر، ببصمة", p1.status === "waiting_for_approval" && p1.approvalPayloadHash === L.payloadHash(L.ticketPayload(p1)));
check("بصمةٌ غير التي عُرضت: مرفوض", !!(await refused(K.approveTicket(A, t1.taskId, A, "0".repeat(64)), "payload_changed")));
check("بلا بصمة: مرفوض", !!(await refused(K.approveTicket(A, t1.taskId, A, ""), "invalid")));
const ap = await K.approveTicket(A, t1.taskId, A, p1.approvalPayloadHash!);
check("الموافقة بالبصمة: الطابور، والبصمة المعتمدة محفوظة", ap.status === "queued" && ap.approvedPayloadHash === p1.approvalPayloadHash && ap.approvedBy === A);
const wrongPayload = { actionType: "send_message", input: { to: "971500000001", text: "نصٌ آخر لم يُوافَق عليه" } };
let ran = 0;
check("تنفيذ حمولةٍ أخرى مرفوض", !!(await refused(K.executeTicket(A, t1.taskId, wrongPayload, async () => { ran++; }), "approval")) && ran === 0);
check("...ويعود ينتظر موافقة بسببه", (await K.getTicket(A, t1.taskId)).status === "waiting_for_approval" && (await K.getTicket(A, t1.taskId)).failureCode === "payload_changed");
check("...وسطر الرفض في سجلها", (await events(t1.taskId)).some((e) => e.action_type === "approval.payload_mismatch" && e.status === "refused"));
const cur1 = await K.getTicket(A, t1.taskId);
await K.approveTicket(A, t1.taskId, A, L.payloadHash(L.ticketPayload(cur1)));
const okRun = await K.executeTicket(A, t1.taskId, L.ticketPayload(await K.getTicket(A, t1.taskId)), async () => {
  const g = await gateSend({ userId: A, channel: "whatsapp", kind: "reply", recipient: "971500000001", role: "support" });
  return g.allowed;
});
check("الحمولة المعتمدة تُنفَّذ", okRun.value === true && okRun.ticket.status === "running" && okRun.ticket.attemptCount === 1);
const ev1 = await events(t1.taskId);
const gate1 = ev1.find((e) => e.action_type === "gate.whatsapp");
check("قرار البوابة سطرٌ تحت التذكرة", gate1 && gate1.status === "allowed" && gate1.input.recipient === "971500000001", ev1.map((e) => e.action_type));

// ── الإغلاق يتطلب الدليل ──
check("إغلاق بلا مخرج: مرفوض", !!(await refused(K.closeTicket(A, t1.taskId, { status: "completed", evidence: [{ type: "gate_event", id: gate1.id }] }, owner), "closure_incomplete")));
check("إغلاق بدليلٍ من غير نوعه: مرفوض", !!(await refused(K.closeTicket(A, t1.taskId, { status: "completed", actualOutput: { sent: 1 }, evidence: [{ type: "note", ref: "قال" }] }, owner), "closure_incomplete")));
const done1 = await K.closeTicket(A, t1.taskId, { status: "completed", actualOutput: { sent: 1 }, evidence: [{ type: "gate_event", id: gate1.id }] }, owner);
check("الإغلاق بالمخرج والدليل", done1.status === "completed" && done1.actualOutput.sent === 1 && done1.evidence.some((e: any) => e.type === "gate_event") && done1.durationMs != null);
check("المكتملة لا تُغلق مرة ثانية", !!(await refused(K.closeTicket(A, t1.taskId, { status: "completed", actualOutput: 1, evidence: [{ type: "gate_event", id: 1 }] }, owner), "bad_transition")));

// ── فعلٌ لكل إرسال، ولا يتيم ──
await db.execute(sql`INSERT INTO unsubscribed_phones (user_id, phone) VALUES (${A}, '971500000009')`);
for (let i = 0; i < 3; i++) await gateSend({ userId: A, channel: "whatsapp", kind: "campaign", recipient: `97150000010${i}`, role: "wa_campaigns" });
await gateSend({ userId: A, channel: "whatsapp", kind: "campaign", recipient: "971500000101", role: "wa_campaigns", recheck: true });
const off = await gateSend({ userId: A, channel: "whatsapp", kind: "campaign", recipient: "+971 50 000 0009", role: "wa_campaigns" });
const ops = await rows(sql`SELECT * FROM employee_tasks WHERE user_id = ${A} AND task_type = 'ops_daily'`);
check("بلا سياق: سجل عمليات يومي واحد للموظف", ops.length === 1 && ops[0].assigned_to === "whatsapp.campaigns" && ops[0].status === "running", ops.length);
const opsEv = await events(ops[0].task_id);
check("سطرٌ لكل محاولة إرسال، والفحص الثاني المسموح لا يضيف", opsEv.filter((e) => e.status === "allowed").length === 3, opsEv.length);
check("...والرفض سطرٌ بسببه", !off.allowed && opsEv.some((e) => e.status === "refused" && e.output.code === "opted_out"));
await gateSend({ userId: A, channel: "email", kind: "campaign", recipient: "x@y.z" });
check("بلا دور: سجل «unattributed» لا يتيم", (await rows(sql`SELECT 1 FROM employee_tasks WHERE user_id = ${A} AND task_type = 'ops_daily' AND assigned_to = 'custom.unattributed'`)).length === 1);

// ── runAs: تذكرة لعملٍ حقيقي، لا لكل دقّة ──
const before = (await rows(sql`SELECT 1 FROM employee_tasks WHERE user_id = ${A} AND task_type = 'ops_daily'`)).length;
for (let i = 0; i < 5; i++) await runAs(A, "monitor", { kind: "monitor_sweep", respect: "none" }, async () => i);
check("خمس دقّات بلا فعل: لا تذكرة", (await rows(sql`SELECT 1 FROM employee_tasks WHERE user_id = ${A} AND task_type = 'ops_daily'`)).length === before);
await runAs(A, "followup", { kind: "smart_followup", respect: "none" }, () => gateSend({ userId: A, channel: "whatsapp", kind: "followup", recipient: "971500000222", role: "followup" }));
await runAs(A, "followup", { kind: "smart_followup", respect: "none" }, () => gateSend({ userId: A, channel: "whatsapp", kind: "followup", recipient: "971500000223", role: "followup" }));
const run = await rows(sql`SELECT * FROM employee_tasks WHERE user_id = ${A} AND task_type = 'ops_daily' AND assigned_to = 'whatsapp.followup'`);
check("جولتان فيهما إرسال: تذكرة يومية واحدة للنوع", run.length === 1 && run[0].title.includes("smart_followup"), run.length);
const linked = await rows(sql`SELECT id FROM employee_executions WHERE user_id = ${A} AND employee_key = 'whatsapp.followup' AND task_id = ${run[0].task_id}`);
check("...وسطرا التنفيذ مربوطان بها (النداءات في receipts بلا نسخ)", linked.length === 2);
check("...والأفعال تحمل رقم التنفيذ", (await events(run[0].task_id)).every((e) => e.execution_id != null));

// ── عامل المهام: التذكرة قبل العمل، والدليل بعده ──
let seenTicket: number | null = null;
T.registerTaskHandler("tk_send", { external: true, run: async (t) => {
  seenTicket = L.currentTicket()?.ticketId ?? null;
  await gateSend({ userId: t.userId, channel: "whatsapp", kind: "reply", recipient: "971500000300", role: t.ownerRole });
  return { sent: 1 };
} });
const { task: w1 } = await T.createTask({ userId: A, ownerRole: "sales", taskType: "tk_send", input: { n: 1 }, title: "إرسال تجريبي", actionType: "send_message" });
check("المهمة تذكرةٌ قبل العمل", w1.status === "queued" && w1.title === "إرسال تجريبي" && w1.assignedTo === "whatsapp.sales");
await T.runTaskWorkerOnce("w-test", 5);
const w1d = await K.getTicket(A, w1.taskId);
check("العامل يعمل في سياقها", seenTicket === w1.taskId);
check("...وتكتمل بمخرجها ودليل تنفيذها ومحاولتها", w1d.status === "completed" && w1d.actualOutput?.sent === 1 && w1d.evidence.some((e: any) => e.type === "execution") && w1d.attemptCount === 1);
check("...وإرسالها تحتها لا في السجل اليومي", (await events(w1.taskId)).some((e) => e.action_type === "gate.whatsapp"));

// موافقة على حمولة، ثم تغيّرت الحمولة قبل أن يأخذها العامل
let approvedRuns = 0;
T.registerTaskHandler("tk_approved", { external: true, run: async () => { approvedRuns++; return { ok: 1 }; } });
const { task: w2 } = await T.createTask({ userId: A, ownerRole: "sales", taskType: "tk_approved", input: { amount: 100 }, approvalRequired: true, title: "عرض سعر" });
check("المهمة بموافقة تحمل بصمتها", w2.status === "waiting_for_approval" && w2.approvalPayloadHash === L.payloadHash({ actionType: "tk_approved", input: { amount: 100 } }));
await T.approveTask(A, w2.taskId, A);
await db.execute(sql`UPDATE employee_tasks SET input_refs = '{"amount": 900}'::jsonb WHERE task_id = ${w2.taskId}`);
await T.runTaskWorkerOnce("w-test", 5);
const w2d = await K.getTicket(A, w2.taskId);
check("العامل لا ينفّذ حمولةً غير المعتمدة", approvedRuns === 0 && w2d.status === "waiting_for_approval" && w2d.failureCode === "payload_changed");
check("...والرفض في السجل", (await rows(sql`SELECT 1 FROM org_audit_log WHERE user_id = ${A} AND action = 'task.payload_refused' AND meta->>'taskId' = ${String(w2.taskId)}`)).length === 1);
await T.approveTask(A, w2.taskId, A);
await T.runTaskWorkerOnce("w-test", 5);
check("الموافقة على الحمولة الجديدة: تُنفَّذ", approvedRuns === 1 && (await K.getTicket(A, w2.taskId)).status === "completed");

// ── الفشل والإعادة محاولاتٌ لا تذاكر ──
let tries = 0;
T.registerTaskHandler("tk_flaky", { external: false, run: async () => { tries++; throw new Error("المزوّد لا يردّ"); } });
const { task: w3 } = await T.createTask({ userId: A, ownerRole: "sales", taskType: "tk_flaky", input: {}, maxRetries: 2, idempotencyKey: "flaky:1" });
await T.runTaskWorkerOnce("w-test", 5);
await db.execute(sql`UPDATE employee_tasks SET next_attempt_at = now() WHERE task_id = ${w3.taskId}`);
await T.runTaskWorkerOnce("w-test", 5);
const w3d = await K.getTicket(A, w3.taskId);
check("فشلان: محاولتان على التذكرة نفسها، ثم ميتة", tries === 2 && w3d.attemptCount === 2 && w3d.status === "failed" && w3d.deadLetter, { tries, a: w3d.attemptCount, s: w3d.status });
check("...ولا تذكرة جديدة للإعادة", (await rows(sql`SELECT 1 FROM employee_tasks WHERE user_id = ${A} AND task_type = 'tk_flaky'`)).length === 1);
const r1 = await L.recordAction({ userId: A, ticketId: w3.taskId, actionType: "send.attempt", status: "failed", idempotencyKey: "send:w3" });
const r2 = await L.recordAction({ userId: A, ticketId: w3.taskId, actionType: "send.attempt", status: "ok", idempotencyKey: "send:w3" });
check("الفعل نفسه مرتين: محاولة ١ ثم ٢ تحت التذكرة نفسها", r1?.attemptNo === 1 && r2?.attemptNo === 2 && r1?.ticketId === r2?.ticketId);
const dupA = await gateSend({ userId: A, channel: "whatsapp", kind: "reply", recipient: "971500000400", role: "sales", idempotencyKey: "wa:once" });
const dupB = await gateSend({ userId: A, channel: "whatsapp", kind: "reply", recipient: "971500000400", role: "sales", idempotencyKey: "wa:once" });
const dupEv = await rows(sql`SELECT attempt_no, status FROM ticket_action_events WHERE user_id = ${A} AND idempotency_key = 'wa:once' ORDER BY attempt_no`);
check("إرسالٌ بالمفتاح نفسه: لا يخرج مرتين، والثاني محاولة ٢", dupA.allowed && !dupB.allowed && dupB.code === "duplicate" && dupEv.length === 2 && dupEv[1].attempt_no === 2 && dupEv[1].status === "refused");
const reo = await K.reopenTicket(A, w3.taskId, owner, "أصلحتُ المفتاح");
check("إعادة الفتح: الطابور بعدّاد جديد", reo.status === "queued" && reo.retryCount === 0 && !reo.deadLetter);
const fl = await K.getTicket(A, w3.taskId);
await db.execute(sql`UPDATE employee_tasks SET status = 'running' WHERE task_id = ${fl.taskId}`);
check("الفشل بلا تفاصيله مرفوض", !!(await refused(K.closeTicket(A, w3.taskId, { status: "failed", reason: "لا يردّ" }, owner), "closure_incomplete")));
const failed = await K.closeTicket(A, w3.taskId, { status: "failed", reason: "المزوّد لا يردّ", retryable: true, responsibleParty: "provider", suggestedResolution: "مفتاحٌ آخر", failureCode: "provider_down" }, owner);
check("الفشل بسببه ومسؤوله وحله", failed.status === "failed" && failed.retryable === true && failed.responsibleParty === "provider" && failed.nextAction === "مفتاحٌ آخر" && failed.failureCode === "provider_down");

// المهلة
const { task: w4 } = await T.createTask({ userId: A, ownerRole: "sales", taskType: "tk_none", input: {}, expiresAt: new Date(Date.now() - 1000), title: "انتهت مهلتها" });
await T.expireTasks();
check("المهلة: تنتهي", (await K.getTicket(A, w4.taskId)).status === "expired");
check("...وتُعاد", (await K.reopenTicket(A, w4.taskId, owner)).status === "queued");

// ── مفتاح التذكرة ──
const { task: w5 } = await T.createTask({ userId: A, ownerRole: "sales", taskType: "tk_none", input: {}, title: "توقف في منتصفها" });
const paused = await K.pauseTicket(A, w5.taskId, owner, "انتظر");
check("الإيقاف المؤقت: محجوبة بسببها", paused.status === "blocked" && paused.failureCode === "paused");
let inner = 0;
const halted = await execute(A, "sales", { kind: "tk_none", taskId: w5.taskId, respect: "none" }, async () => { inner++; });
check("runAs يحترم مفتاح التذكرة حتى المعفاة", !halted.ran && halted.halt.scope === "task" && inner === 0);
const g5 = await L.withTicket({ userId: A, role: "sales", kind: "x", ticketId: w5.taskId, executionId: null }, () => gateSend({ userId: A, channel: "whatsapp", kind: "reply", recipient: "971500000500", role: "sales" }));
check("...والبوابة ترفض إرسالها", !g5.allowed && g5.scope === "task");
check("...ورفضها تحتها", (await events(w5.taskId)).some((e) => e.status === "refused" && e.output.scope === "task"));
const g5b = await L.withTicket({ userId: B, role: "sales", kind: "x", ticketId: w5.taskId, executionId: null }, () => gateSend({ userId: B, channel: "whatsapp", kind: "reply", recipient: "971500000500", role: "sales" }));
check("رقمها في حسابٍ آخر لا يُوقف", g5b.allowed);
await K.reopenTicket(A, w5.taskId, owner);
check("إعادة الفتح ترفع المفتاح", (await execute(A, "sales", { kind: "tk_none", taskId: w5.taskId, respect: "none" }, async () => 1)).ran);
// الإلغاء في منتصف التنفيذ
const { task: w6 } = await T.createTask({ userId: A, ownerRole: "sales", taskType: "tk_none", input: {}, title: "تُلغى وهي تعمل" });
await db.execute(sql`UPDATE employee_tasks SET status = 'running' WHERE task_id = ${w6.taskId}`);
const sends: boolean[] = [];
await L.withTicket({ userId: A, role: "sales", kind: "x", ticketId: w6.taskId, executionId: null }, async () => {
  sends.push((await gateSend({ userId: A, channel: "whatsapp", kind: "reply", recipient: "971500000600", role: "sales" })).allowed);
  await K.cancelTicket(A, w6.taskId, owner, "غيّرتُ رأيي");
  sends.push((await gateSend({ userId: A, channel: "whatsapp", kind: "reply", recipient: "971500000601", role: "sales" })).allowed);
});
check("الإلغاء يوقف ما بعده في الجولة نفسها", sends[0] === true && sends[1] === false && (await K.getTicket(A, w6.taskId)).status === "cancelled");

// ── الأب والابن ──
const { ticket: par } = await K.intakeTicket({ userId: A, title: "حملة الربع الأول", createdBy: owner });
await K.assignTicket(A, par.taskId, "executive.ceo", owner);
const child = await K.handoffTicket(A, par.taskId, { to: "email.copywriter", title: "اكتبي الرسالة الأولى", input: { brief: "..." }, actionType: "write_email" }, { kind: "employee", id: "executive.ceo" });
const parD = await K.getTicket(A, par.taskId);
check("التسليم تذكرةٌ ابنة", child.parentTaskId === par.taskId && child.assignedTo === "email.copywriter" && child.ownerRole === "email");
check("...والأب يعرف لمن سلّم", parD.handoffTarget === "email.copywriter" && (await events(par.taskId)).some((e) => e.action_type === "ticket.handoff" && e.output.child === child.taskId));
check("التسليم لاسمٍ مرفوض", !!(await refused(K.handoffTicket(A, par.taskId, { to: "نورة", title: "x" }, owner), "invalid_assignee")));
const viaCtx = await L.withTicket({ userId: A, role: "email_analyst", kind: "specialist_report", ticketId: par.taskId, executionId: null },
  () => H.handoffReviewResults(A, { overall: { sent: 10, positive: 1, bounceRate: 0 }, angles: [], avoidAngles: [], decisions: [] }));
const rr = await K.getTicket(A, viaCtx!);
check("تسليم جاسم إلى منصور ابنٌ لتذكرة جولته", rr.parentTaskId === par.taskId && rr.title === "أحكام النتائج من جاسم" && rr.assignedTo === "email.director");
const det = await K.ticketDetail(A, par.taskId);
check("التفاصيل: الأبناء والخط الزمني", det.children.length === 2 && det.timeline.length > 0 && det.timeline.some((x) => x.source === "audit"));
const dep = await K.intakeTicket({ userId: A, title: "تعتمد على الحملة", createdBy: owner });
await K.assignTicket(A, dep.ticket.taskId, "email.strategist", owner);
const planned = await K.planTicket(A, dep.ticket.taskId, { dependsOn: [par.taskId] }, owner);
check("الاعتماد: تنتظر", planned.status === "waiting_for_dependency");
check("اعتمادٌ على تذكرة حسابٍ آخر مرفوض", !!(await refused((async () => {
  const x = await K.intakeTicket({ userId: B, title: "ب", createdBy: K.ownerActor(B) });
  await K.assignTicket(B, x.ticket.taskId, "email.strategist", K.ownerActor(B));
  return K.planTicket(B, x.ticket.taskId, { dependsOn: [par.taskId] }, K.ownerActor(B));
})(), "invalid")));
const graph = await K.dependencyGraph(A, { root: par.taskId });
check("المخطط: حافة اعتماد وحافتا أبوة", graph.edges.filter((e) => e.kind === "dependency").length === 1 && graph.edges.filter((e) => e.kind === "child").length === 2, graph.edges);

// الدرس المرشَّح
const mem = await K.proposeLesson(A, par.taskId, "الرسالة القصيرة جلبت ردوداً أكثر", owner);
check("الدرس يبدأ معلّقاً بمصدره", (await one(sql`SELECT approval_status, source_reference FROM agent_memory WHERE id = ${mem}`)).approval_status === "pending");

// تكليف المدير بتذكرة
const ceo = await import("../org/ceo");
const rec = await ceo.issueRecommendations(A, [{ id: "p1", problem: "ردود البريد قليلة", why: "٢ من ٣٠٠", category: "internal_analytics", owner: "email", severity: "critical", metric: "positive_replies" } as any]);
const ceoT = await K.getTicket(A, Number(rec.all[0]!.taskId));
check("المدير يكلّف بتذكرة: مفتاح، عنوان، منشئ، أولوية", ceoT.assignedTo === "email.copywriter" && ceoT.title === "ردود البريد قليلة" && ceoT.createdBy.id === "executive.ceo" && ceoT.priorityLevel === "critical" && !!ceoT.dueAt);

// ── الصيانة ──
const yesterday = new Date(Date.now() + 4 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
await db.execute(sql`UPDATE employee_tasks SET idempotency_key = ${`ops:whatsapp.campaigns:ops:${yesterday}`} WHERE task_id = ${ops[0].task_id}`);
await db.execute(sql`INSERT INTO ticket_action_events (ticket_id, user_id, action_type, status, created_at) VALUES (${ops[0].task_id}, ${A}, 'old', 'info', now() - interval '91 days')`);
const m = await L.ledgerMaintenance();
const opsDone = await K.getTicket(A, ops[0].task_id);
check("سجل الأمس يُغلق بأعداده ودليله", opsDone.status === "completed" && Number(opsDone.actualOutput.allowed) === 3 && opsDone.evidence.some((e: any) => e.type === "action_events") && m.closed >= 1);
check("الأحداث الأقدم من ٩٠ يوماً تُحذف، والتذكرة تبقى", m.deleted === 1 && (await rows(sql`SELECT 1 FROM ticket_action_events WHERE action_type = 'old'`)).length === 0);
check("سجل اليوم لا يُغلق", (await K.getTicket(A, run[0].task_id)).status === "running");

// ── المسارات ──
const express = (await import("express")).default;
const routes = (await import("../../routes/org-tickets")).default;
let session: any = {};
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.session = session; next(); });
app.use("/org/tickets", routes);
app.use((err: any, _req: any, res: any, _next: any) => { console.log("route error:", err?.message); res.status(500).json({ error: String(err?.message ?? err) }); });
const server = await new Promise<any>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}/org/tickets`;
const get = async (p: string) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() as any }; };
const post = async (p: string, b: unknown = {}) => { const r = await fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() as any }; };

for (const p of ["", "/inbox", "/queues", "/graph", `/${par.taskId}`, "/employees/email.copywriter"]) check(`بلا جلسة: GET ${p || "/"} ← 401`, (await get(p)).status === 401);
check("بلا جلسة: POST ← 401", (await post(`/${par.taskId}/cancel`)).status === 401);
session = { userId: A, isAdmin: false };
const list = await get("?limit=200");
check("القائمة: تذاكر الحساب بلا السجلات اليومية", list.status === 200 && list.body.total > 5 && list.body.tickets.every((t: any) => t.taskType !== "ops_daily"));
check("فلتر الحالة", (await get("?status=completed")).body.tickets.every((t: any) => t.status === "completed"));
check("فلتر الموظف", (await get("?employee=email.copywriter")).body.tickets.every((t: any) => t.assignedTo === "email.copywriter"));
check("فلتر الأولوية", (await get("?priority=critical")).body.tickets.some((t: any) => t.taskId === ceoT.taskId));
check("فلتر القسم", (await get("?department=whatsapp")).body.tickets.every((t: any) => t.department === "whatsapp"));
check("بحث", (await get(`?q=${encodeURIComponent("الربع الأول")}`)).body.tickets.some((t: any) => t.taskId === par.taskId));
check("حالة مجهولة: 400", (await get("?status=nope")).status === 400);
await db.execute(sql`UPDATE employee_tasks SET due_at = now() - interval '1 day' WHERE task_id = ${dep.ticket.taskId}`);
const od = await get("?overdue=1");
check("المتأخرة", od.body.tickets.length === 1 && od.body.tickets[0].taskId === dep.ticket.taskId && od.body.tickets[0].overdue);
const inbox = await get("/inbox");
check("صندوقك: ما ينتظر موافقتك ببصمته", inbox.body.approvals.some((t: any) => t.taskId === w2.taskId) === false && inbox.body.counts.approvals === inbox.body.approvals.length);
const { ticket: ap2 } = await K.intakeTicket({ userId: A, title: "ينتظرك", createdBy: owner, input: { x: 1 } });
await K.assignTicket(A, ap2.taskId, "whatsapp.sales", owner);
await K.planTicket(A, ap2.taskId, { requiresApproval: true }, owner);
const inbox2 = await get("/inbox");
const inA = inbox2.body.approvals.find((t: any) => t.taskId === ap2.taskId);
check("...يظهر فيه ببصمته", inA && /^[a-f0-9]{64}$/.test(inA.payloadHash));
check("الموافقة ببصمةٍ أخرى: 409", (await post(`/${ap2.taskId}/approve`, { payloadHash: "f".repeat(64) })).status === 409);
check("الموافقة ببصمتها: تم", (await post(`/${ap2.taskId}/approve`, { payloadHash: inA.payloadHash })).body.ticket.status === "queued");
check("الطوابير", (await get("/queues")).body.departments.some((d: any) => d.department === "email"));
check("تاريخ الموظف", (await get("/employees/email.copywriter")).body.tickets.length >= 2);
check("موظفٌ مجهول: 404", (await get("/employees/nobody.here")).status === 404);
const d2 = await get(`/${par.taskId}`);
check("التفاصيل عبر المسار", d2.status === 200 && d2.body.children.length === 2 && Array.isArray(d2.body.timeline));
check("المخطط عبر المسار", (await get("/graph")).body.nodes.length > 0);
check("تعليق", (await post(`/${par.taskId}/comment`, { text: "تابعوا" })).status === 200 && (await events(par.taskId)).some((e) => e.action_type === "ticket.comment"));
check("تكليف باسم عبر المسار: 400", (await post(`/${dep.ticket.taskId}/reassign`, { employeeKey: "سلمى" })).status === 400);
check("إعادة تكليف بالمفتاح", (await post(`/${dep.ticket.taskId}/reassign`, { employeeKey: "email.director", reason: "أقرب" })).body.ticket.assignedTo === "email.director");
check("إيقاف مؤقت", (await post(`/${dep.ticket.taskId}/pause`, { reason: "لاحقاً" })).body.ticket.status === "blocked");
check("إعادة فتح", (await post(`/${dep.ticket.taskId}/reopen`)).body.ticket.status === "queued");
check("إلغاء", (await post(`/${dep.ticket.taskId}/cancel`, { reason: "لا داعي" })).body.ticket.status === "cancelled");
check("رفض ما لا ينتظر موافقة: 409", (await post(`/${dep.ticket.taskId}/reject`)).status === 409);
const created = await post("", { title: "تذكرة من صاحب العمل", priority: "low", assignTo: "ops.monitor" });
check("إنشاء من صاحب العمل ثم تكليف", created.status === 201 && created.body.ticket.assignedTo === "ops.monitor" && created.body.ticket.priorityLevel === "low");
check("رقم غير صالح: 400", (await get("/abc")).status === 400);

// العزل: حساب ب لا يرى تذاكر أ ولا يمسّها
session = { userId: B, isAdmin: false };
check("عزل: القائمة", (await get("")).body.tickets.every((t: any) => t.userId === B));
check("عزل: التفاصيل 404", (await get(`/${par.taskId}`)).status === 404);
check("عزل: المخطط بجذر غيرك فارغ", (await get(`/graph?root=${par.taskId}`)).body.nodes.length === 0);
for (const a of ["assign", "reassign", "comment", "approve", "reject", "pause", "cancel", "reopen"]) {
  const r = await post(`/${ap2.taskId}/${a}`, { employeeKey: "email.copywriter", text: "x", payloadHash: inA.payloadHash, reason: "x" });
  check(`عزل: ${a} على تذكرة غيرك ← 404`, r.status === 404, r);
}
check("عزل: لم يتغيّر شيء على تذكرة أ", (await K.getTicket(A, ap2.taskId)).status === "queued" && (await rows(sql`SELECT 1 FROM org_controls WHERE user_id = ${B}`)).length === 0);
check("عزل: صندوقه فارغ من تذاكر أ", (await get("/inbox")).body.approvals.every((t: any) => t.userId === B));
server.close();

check("لا شبكة في كل ما سبق", fetched === 0, fetched);
await clean();
console.log(`\n${pass} نجح، ${fail} فشل`);
process.exit(fail ? 1 : 0);
