// المرحلة ٥ والبنود المتبقية: التفعيل الآلي منخفض الخطر، «اعتماد كل المؤهل»، حالات planned/no_account،
// الناقل والمحلل، تذاكر owner_action، عدّاد المهام، بذر الملفات للموظف الجديد، وجاهزية الصوت.
// الجزء الأول بلا قاعدة:
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/org-stage5.test.ts
// والبقية على قاعدة الاختبار وحدها، بلا شبكة ولا إرسال ولا نموذج حقيقي:
//   DATABASE_URL=postgres://t:t@127.0.0.1:55447/t npx tsx src/lib/__tests__/org-stage5.test.ts
export {};

let fetched = 0;
globalThis.fetch = (async (url: any) => { fetched++; throw new Error(`no network in this test: ${url}`); }) as any;
process.env["GROQ_API_KEY"] = "test-key";

const { ROLE_MAP } = await import("../org/departments");
const AN = await import("../social/analyst");
const { isPlanned } = await import("../org/registry");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};

// ── بلا قاعدة ─────────────────────────────────────────────────────
check("الناقل في إنستغرام وتيك توك: own بخطوته", ROLE_MAP["ig_inviter"]!.execution === "own" && ROLE_MAP["tt_inviter"]!.execution === "own" && /inviteCommenters/.test(ROLE_MAP["ig_inviter"]!.fn ?? ""));
check("المحلل: own يومي", ROLE_MAP["ig_analyst"]!.execution === "own" && ROLE_MAP["tt_analyst"]!.intervalSec === 86_400);
check("لينكدإن بلا مشغّل", ROLE_MAP["li_inviter"]!.execution === "none" && ROLE_MAP["li_analyst"]!.execution === "none" && isPlanned("linkedin") && !isPlanned("instagram"));
const F0 = { platform: "instagram" as const, days: 7, posts: 0, comments: 0, leadComments: 0, questions: 0, praise: 0, repliesPublished: 0, dmsReceived: 0, messagesSent: 0, outreachSent: 0, outreachReplied: 0, topPost: null, bestList: null };
check("لا شيء = INSUFFICIENT", AN.insufficient(F0) && !AN.insufficient({ ...F0, comments: 3 }));
const F1 = { ...F0, comments: 12, questions: 4, posts: 3 };
check("الأرقام من الوقائع: تمرّ", AN.numbersGrounded("جاءت 4 أسئلة من 12 تعليقاً على 3 منشورات خلال ٧ أيام.", F1));
check("رقمٌ مخترع: يُرفض", !AN.numbersGrounded("ارتفع التفاعل 35٪", F1));
check("نص الوقائع بلا نموذج", /12 تعليقاً على 3/.test(AN.factsText(F1)));

const URL_ = process.env["DATABASE_URL"] ?? "";
if (!/127\.0\.0\.1:(55449|55447|55445|55444|55440)\//.test(URL_)) {
  console.log(`\n${pass} passed, ${fail} failed (بلا قاعدة)`);
  process.exit(fail ? 1 : 0);
}

// ── على القاعدة ───────────────────────────────────────────────────
const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const { ensureOrgTables } = await import("../org/schema");
const { ensureTicketTables } = await import("../org/ledger");
const { ensureSimTables } = await import("../org/sim-schema");
const { ensureDocsTables } = await import("../org/docs/schema");
const { ensureVoiceTables } = await import("../org/voice/schema");
const { setControl, forgetControls } = await import("../org/controls");
const { forgetRuntimeCache } = await import("../org/runtime");
const P = await import("../org/proposals");
const AA = await import("../org/auto-apply");
const BK = await import("../org/bulk");
const K = await import("../org/tickets");
const L = await import("../org/ledger");
const T = await import("../org/tasks");
const VT = await import("../org/voice/tickets");
const { orgOverview } = await import("../org/overview");
const { orgRegistry, backfillRegistry } = await import("../org/registry");
const { collectFacts } = await import("../org/ceo");
const DS = await import("../org/docs/dossier");
const ENG = await import("../social/engine");
const { PROMPT_LIBRARY } = await import("../org/prompts");

await ensureOrgTables(); await ensureTicketTables(); await ensureSimTables(); await ensureDocsTables(); await ensureVoiceTables();
const A = 11, B = 12, C = 13, D = 14, S = 15, V = 16, W = 17, X = 18, Y = 19;
const ALL = [A, B, C, D, S, V, W, X, Y];
const wipe = async () => {
  for (const t of ["shadow_runs", "improvement_proposals", "employee_prompt_versions", "employee_documentation", "account_knowledge", "agent_memory", "employee_tasks", "ticket_action_events",
    "employee_heartbeats", "employee_executions", "org_controls", "org_audit_log", "social_activity", "social_actions", "social_targets", "social_comments", "social_posts", "social_messages", "social_threads",
    "social_accounts", "call_transcripts", "call_participants", "owner_calls", "integration_health", "bot_employees"]) {
    await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${ALL.join(",")})`)).catch(() => {});
  }
};
await wipe();
forgetControls(); forgetRuntimeCache();
const hire = (u: number, role: string, key: string | null, name: string, persona = `أنا ${name}`) =>
  db.execute(sql`INSERT INTO bot_employees (user_id, name, role, kind, persona, employee_key, department, is_active) VALUES (${u}, ${name}, ${role}, 'internal', ${persona}, ${key}, ${key ? key.split(".")[0] : null}, true)`);
const audits = async (u: number, action: string) => (await db.execute<any>(sql`SELECT * FROM org_audit_log WHERE user_id = ${u} AND action = ${action} ORDER BY id`)).rows;
const prop = async (u: number, target: string) => (await db.execute<any>(sql`SELECT * FROM improvement_proposals WHERE user_id = ${u} AND target = ${target} ORDER BY change_id DESC LIMIT 1`)).rows[0];
const shadow = (u: number, key: string, proposalId: number | null, verdict: string, ref = true) =>
  db.execute(sql`INSERT INTO shadow_runs (user_id, batch_id, employee_key, proposal_id, library_version, sample_ref, verdict, detail, model_calls, trigger)
    VALUES (${u}, ${`t:${u}`}, ${key}, ${proposalId}, ${String(PROMPT_LIBRARY[key]!.version)}, ${ref ? sql`'{"id":1}'::jsonb` : sql`NULL::jsonb`}, ${verdict}, 'اختبار', 0, 'manual')`);

// ════ ١. المرحلة ٥ ═════════════════════════════════════════════════
const INT = "email.registrar", INT2 = "email.opens", EXT = "email.director", CODE = "ops.monitor";
check("المكتبة: الداخلي داخلي والخارجي خارجي", PROMPT_LIBRARY[INT]!.externalBehavior === false && PROMPT_LIBRARY[INT2]!.externalBehavior === false && PROMPT_LIBRARY[EXT]!.externalBehavior === true);
await hire(A, "email_registrar", INT, "راشد", "OLD-RASHED"); await hire(A, "email_opens", INT2, "فتحات"); await hire(A, "email_manager", EXT, "المدير", "OLD-DIR");
await hire(A, "monitor", CODE, "المراقب", "OLD-MON");
await hire(B, "email_registrar", INT, "راشد ب", "B-OLD");
await P.seedPromptProposals(A); await P.seedPromptProposals(B); await DS.seedDossiers(A); await DS.seedDossiers(B);
const pInt = await prop(A, `prompt:${INT}`), pInt2 = await prop(A, `prompt:${INT2}`), pExt = await prop(A, `prompt:${EXT}`), pB = await prop(B, `prompt:${INT}`), pCode = await prop(A, `prompt:${CODE}`);
check("البذر: مقترحات معلّقة، الداخلي low والخارجي approval_required", pInt?.risk === "low" && pExt?.risk === "approval_required" && pInt.status === "proposed" && pExt.status === "proposed");

check("بلا ظل: لا شيء يُفعَّل", (await AA.autoApplyLowRisk(A)).every((r) => !r.applied));
await shadow(A, INT, Number(pInt.change_id), "same");
await shadow(A, EXT, Number(pExt.change_id), "better");
await shadow(B, INT, Number(pB.change_id), "same");
await shadow(B, INT, Number(pB.change_id), "failed_checks");
const r1 = await AA.autoApplyLowRisk(A, { trigger: "test" });
const after = await prop(A, `prompt:${INT}`), extAfter = await prop(A, `prompt:${EXT}`);
check("الداخلي بعيّنة سليمة: فُعّل", r1.some((x) => x.changeId === Number(pInt.change_id) && x.applied) && after.status === "applied" && after.rollback_version != null, r1);
check("الخارجي لا يُفعَّل آلياً أبداً، حتى بظلٍّ أفضل", extAfter.status === "proposed" && !r1.some((x) => x.changeId === Number(pExt.change_id) && x.applied));
const [rashed] = (await db.execute<any>(sql`SELECT persona, prompt_version FROM bot_employees WHERE user_id = ${A} AND employee_key = ${INT}`)).rows;
check("الشخصية الجديدة تعمل", rashed.persona !== "OLD-RASHED" && rashed.prompt_version != null);
const au = await audits(A, "proposal.auto_applied");
check("مُدقَّق: auto_applied منخفض الخطر والإرجاع متاح", au.length === 1 && au[0].meta.risk === "low" && au[0].meta.rollbackAvailable === true && au[0].meta.basis === "shadow" && au[0].actor == null, au);
const rB = await AA.autoApplyLowRisk(B);
check("failed_checks يحجب (حساب ب)", (await prop(B, `prompt:${INT}`)).status === "proposed" && rB.some((x) => /failed_checks/.test(x.why)), rB);
check("عزل: ظل أ لا يفعّل في ب", (await db.execute<any>(sql`SELECT persona FROM bot_employees WHERE user_id = ${B} AND employee_key = ${INT}`)).rows[0].persona === "B-OLD");
// no_model_path + ملف كامل: لمن هو بالكود وحده فعلاً (المراقب)
await shadow(A, CODE, Number(pCode.change_id), "no_model_path", false);
// والفتحات تصوغ تقريرها بنموذج: صفٌّ قديم مكتوب no_model_path (قبل تصحيح الخريطة) لا يمرّ
await shadow(A, INT2, Number(pInt2.change_id), "no_model_path", false);
const r2 = await AA.autoApplyLowRisk(A);
const g2 = r2.find((x) => x.changeId === Number(pCode.change_id));
check("بالكود وحده وملف كامل: فُعّل", !!g2?.applied && g2.basis === "no_model_path", r2);
const g2o = r2.find((x) => x.changeId === Number(pInt2.change_id));
check("له نموذج وصفٌّ قديم no_model_path: لا يُفعَّل، «لم يُجرَّب»", !!g2o && !g2o.applied && /لم يُجرَّب/.test(g2o.why) && (await prop(A, `prompt:${INT2}`)).status === "proposed", g2o);
// الإرجاع
const back = await P.rollbackProposal(A, Number(pInt.change_id), A);
const [rashed2] = (await db.execute<any>(sql`SELECT persona FROM bot_employees WHERE user_id = ${A} AND employee_key = ${INT}`)).rows;
check("الإرجاع يعيد ما كان", back.status === "rolled_back" && rashed2.persona === "OLD-RASHED");
// ملف ناقص يحجب no_model_path (حساب ب، موظف آخر)
await hire(B, "monitor", CODE, "المراقب ب");
await P.seedPromptProposals(B); await DS.seedDossiers(B);
const pB2 = await prop(B, `prompt:${CODE}`);
await db.execute(sql`UPDATE employee_documentation SET sections = sections || '{"mission":""}'::jsonb WHERE user_id = ${B} AND employee_key = ${CODE}`);
await shadow(B, CODE, Number(pB2.change_id), "no_model_path", false);
const gB2 = await AA.shadowGate(B, { change_id: Number(pB2.change_id), target: `prompt:${CODE}` });
check("بلا مسار والملف ناقص: لا يمرّ", !gB2.ok && /ناقص/.test(gB2.why), gB2);
// mixed وnot_covered يحجبان (حساب س)
await hire(X, "email_registrar", INT, "راشد س"); await hire(X, "email_opens", INT2, "فتحات س");
await P.seedPromptProposals(X); await DS.seedDossiers(X);
const pC = await prop(X, `prompt:${INT}`), pC2 = await prop(X, `prompt:${INT2}`);
await shadow(X, INT, Number(pC.change_id), "same"); await shadow(X, INT, Number(pC.change_id), "mixed");
await shadow(X, INT2, Number(pC2.change_id), "not_covered", false);
const gC = await AA.shadowGate(X, { change_id: Number(pC.change_id), target: `prompt:${INT}` });
const gC2 = await AA.shadowGate(X, { change_id: Number(pC2.change_id), target: `prompt:${INT2}` });
check("mixed يحجب ولو مع عيّنة same", !gC.ok && /مختلط/.test(gC.why), gC);
check("not_covered يحجب: «لم يُجرَّب»", !gC2.ok && /لم يُجرَّب/.test(gC2.why), gC2);
const rC = await AA.autoApplyLowRisk(X);
check("ولا تفعيل آلي لأيٍّ منهما", rC.every((x) => !x.applied) && (await prop(X, `prompt:${INT}`)).status === "proposed" && (await prop(X, `prompt:${INT2}`)).status === "proposed", rC);
const bC = await BK.bulkApprove(X, X, { dryRun: true });
const bC2 = bC.items.find((i) => i.kind === "proposal" && i.id === Number(pC2.change_id));
check("الاعتماد الجماعي: يُترك، وصاحب العمل يرى «لم يُجرَّب»", bC2?.result === "skipped" && /^لم يُجرَّب/.test(bC2.why), bC2);
check("...والمختلط يُترك بسببه", bC.items.find((i) => i.kind === "proposal" && i.id === Number(pC.change_id))?.result === "skipped");
// «same» لأن الاثنين خالفا الحد نفسه ليس دليلاً (المنشئ، 2026-11-11: ١٢٣ و١٢٨ كلمة) — حساب ي
await hire(Y, "email_registrar", INT, "راشد ي");
await P.seedPromptProposals(Y); await DS.seedDossiers(Y);
const pY = await prop(Y, `prompt:${INT}`);
const shadowIssues = (u: number, key: string, proposalId: number, verdict: string, issues: string[]) =>
  db.execute(sql`INSERT INTO shadow_runs (user_id, batch_id, employee_key, proposal_id, library_version, sample_ref, verdict, detail, model_calls, trigger, current_issues, proposed_issues)
    VALUES (${u}, ${`t:${u}`}, ${key}, ${proposalId}, ${String(PROMPT_LIBRARY[key]!.version)}, '{"id":1}'::jsonb, ${verdict}, 'اختبار', 2, 'manual', ${JSON.stringify(issues)}::jsonb, ${JSON.stringify(issues)}::jsonb)`);
await shadowIssues(Y, INT, Number(pY.change_id), "same", []);
await shadowIssues(Y, INT, Number(pY.change_id), "same", ["الرسالة ١٢٨ كلمة — الحد ١١٠ تقريباً"]);
const gY = await AA.shadowGate(Y, { change_id: Number(pY.change_id), target: `prompt:${INT}` });
check("بوابة: same بمخالفةٍ في المقترح يحجب ولو مع عيّنة سليمة", !gY.ok && /خالف فحص الكود في 1 عيّنة/.test(gY.why) && /ليس دليلاً/.test(gY.why), gY);
const rY = await AA.autoApplyLowRisk(Y);
check("...ولا تفعيل آلي", rY.every((x) => !x.applied) && (await prop(Y, `prompt:${INT}`)).status === "proposed", rY);
const bY = (await BK.bulkApprove(Y, Y, { dryRun: true })).items.find((i) => i.kind === "proposal" && i.id === Number(pY.change_id));
check("...والاعتماد الجماعي يتركه بسببه", bY?.result === "skipped" && /ليس دليلاً/.test(bY.why), bY);
await shadowIssues(Y, INT, Number(pY.change_id), "better", ["مبالغة أو ضمان: best"]);
await db.execute(sql`DELETE FROM shadow_runs WHERE user_id = ${Y} AND verdict = 'same' AND jsonb_array_length(proposed_issues) > 0`);
check("better بمخالفةٍ باقية في المقترح يحجب أيضاً", !(await AA.shadowGate(Y, { change_id: Number(pY.change_id), target: `prompt:${INT}` })).ok);
await db.execute(sql`DELETE FROM shadow_runs WHERE user_id = ${Y} AND jsonb_array_length(proposed_issues) > 0`);
const gY2 = await AA.shadowGate(Y, { change_id: Number(pY.change_id), target: `prompt:${INT}` });
check("كل العيّنات same/better ومخالفات المقترح فارغة: يمرّ", gY2.ok && gY2.samples === 1, gY2);

// ════ ٢. «اعتماد كل المؤهل» ═══════════════════════════════════════
await db.execute(sql`INSERT INTO improvement_proposals (user_id, requested_by, target, reason, category, risk) VALUES (${A}, 'test', 'limits:daily', 'رفع الحد', 'limits', 'approval_required')`);
const lib = (proof: any) => JSON.stringify({ type: "price", kind: "objection", signal: "s", response: "r", proof, nextStep: "n", roles: ["sales_specialist"], language: "ar" });
await db.execute(sql`INSERT INTO account_knowledge (user_id, key, value, source_reference, approval_status) VALUES
  (${A}, 'objection.ok', ${lib({ text: "x", status: "approved_knowledge", source: "voice" })}, 't', 'pending'),
  (${A}, 'objection.owner', ${lib({ text: "y", status: "needs_owner_approval", source: "none" })}, 't', 'pending'),
  (${A}, 'playbook.sales_specialist', '{"role":"sales_specialist","text":"t"}', 't', 'pending'),
  (${B}, 'objection.ok', ${lib({ text: "x", status: "approved_knowledge", source: "voice" })}, 't', 'pending')`);
await db.execute(sql`INSERT INTO agent_memory (user_id, role, content, approval_status) VALUES (${A}, 'email', 'درس معلّق', 'pending')`).catch(() => {});
const [tA] = (await db.execute<any>(sql`INSERT INTO employee_tasks (user_id, owner_role, task_type, status, input_refs) VALUES (${A}, 'email_manager', 'review_results', 'waiting_for_approval', '{"title":"راجع"}'::jsonb) RETURNING task_id`)).rows;
const [tB] = (await db.execute<any>(sql`INSERT INTO employee_tasks (user_id, owner_role, task_type, status, input_refs) VALUES (${B}, 'email_registrar', 'review_results', 'waiting_for_approval', '{"title":"ب"}'::jsonb) RETURNING task_id`)).rows;
await db.execute(sql`INSERT INTO social_accounts (user_id, platform, profile, dry_run, mode, autopilot) VALUES (${A}, 'instagram', 'ig_desk', true, 'approve', false)`);

const express = (await import("express")).default;
const orgRouter = (await import("../../routes/org")).default;
let session: any = { userId: A };
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.session = session; next(); });
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
session = {};
check("بلا جلسة: 401", (await http("/approvals/bulk", { method: "POST", body: { confirm: true } })).status === 401 && (await http("/approvals/bulk")).status === 401);
session = { userId: A };
check("بلا تأكيد: 400", (await http("/approvals/bulk", { method: "POST", body: {} })).status === 400);
const pv = await http("/approvals/bulk");
const pending0 = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM improvement_proposals WHERE user_id = ${A} AND status = 'proposed'`)).rows[0].n;
check("المعاينة لا تغيّر شيئاً", pv.status === 200 && pv.body.dryRun && pv.body.items.length > 0 && pending0 >= 2, pv.body);
const run = await http("/approvals/bulk", { method: "POST", body: { confirm: true } });
const items: any[] = run.body?.items ?? [];
const it = (kind: string, pred: (i: any) => boolean) => items.find((i) => i.kind === kind && pred(i));
check("مقترح تعليمات بظل سليم: اعتُمد وفُعّل (بيد المالك)", it("proposal", (i) => i.id === Number(pExt.change_id))?.result === "approved" && (await prop(A, `prompt:${EXT}`)).status === "applied", items);
check("مقترح غير التعليمات: تُرك بسببه", it("proposal", (i) => i.label === "limits:daily")?.result === "skipped" && (await prop(A, "limits:daily")).status === "proposed");
check("اعتراض دليله معتمد: اعتُمد", it("objection", (i) => i.label === "objection.ok")?.result === "approved");
check("اعتراض يحتاج موافقة المالك: تُرك", it("objection", (i) => i.label === "objection.owner")?.result === "skipped" && /موافقة المالك/.test(it("objection", (i) => i.label === "objection.owner")?.why));
check("الكتيّب: تُرك", it("playbook", () => true)?.result === "skipped");
check("مهمة تنتظر: اعتُمدت بالدالة العادية", it("task", (i) => i.id === Number(tA.task_id))?.result === "approved"
  && (await db.execute<any>(sql`SELECT status FROM employee_tasks WHERE task_id = ${tA.task_id}`)).rows[0].status === "queued");
check("لا شيء من حساب ب في النتيجة", !items.some((i) => i.id === Number(tB.task_id) && i.kind === "task") && (await db.execute<any>(sql`SELECT status FROM employee_tasks WHERE task_id = ${tB.task_id}`)).rows[0].status === "waiting_for_approval"
  && (await db.execute<any>(sql`SELECT approval_status FROM account_knowledge WHERE user_id = ${B} AND key = 'objection.ok'`)).rows[0].approval_status === "pending");
const actors = (await db.execute<any>(sql`SELECT action, actor FROM org_audit_log WHERE user_id = ${A} AND action IN ('proposal.approved','task.approved','lesson.approved','approvals.bulk')`)).rows;
check("كل اعتماد مدقَّق بالفاعل = صاحب الجلسة", actors.length >= 4 && actors.every((x: any) => Number(x.actor) === A), actors);
const [sa] = (await db.execute<any>(sql`SELECT dry_run, mode, autopilot FROM social_accounts WHERE user_id = ${A} AND platform = 'instagram'`)).rows;
const lessons = (await db.execute<any>(sql`SELECT approval_status FROM agent_memory WHERE user_id = ${A}`).catch(() => ({ rows: [] as any[] }))).rows;
check("لا يمسّ إعدادات التواصل ولا الدروس", sa.dry_run === true && sa.mode === "approve" && sa.autopilot === false && lessons.every((l: any) => l.approval_status === "pending"));
session = { userId: B };
const runB = await http("/approvals/bulk", { method: "POST", body: { confirm: true } });
check("حساب ب: يرى ويعتمد ما له وحده", runB.status === 200 && runB.body.items.every((i: any) => i.id !== Number(tA.task_id) || i.kind !== "task"));

// ════ ٣. تذاكر المالك (owner_action) ══════════════════════════════
session = { userId: A };
const mk = async (n: number) => VT.createActionTicket({ userId: A, ownerRole: "email_manager", employeeKey: EXT, title: `بند ${n}`, expectedOutcome: "نتيجة", dueAt: new Date(Date.now() + 86_400_000), source: { kind: "call", id: 900 + n }, idempotencyKey: `t5:${n}` });
const o1 = await mk(1), o2 = await mk(2), o3 = await mk(3);
const t1 = await K.getTicket(A, o1.taskId);
check("تذكرة المكالمة تنتظر المالك", t1.status === "waiting_for_owner" && t1.taskType === "owner_action");
const done = await K.approveTicket(A, o1.taskId, A, L.payloadHash(L.ticketPayload(t1)), "نفّذها هذا الأسبوع");
const ev = done.evidence.find((e: any) => e.type === "approval_event");
const [evRow] = ev?.id ? (await db.execute<any>(sql`SELECT id, user_id, actor FROM org_audit_log WHERE id = ${ev.id}`)).rows : [];
check("موافقة: مكتملة، مخرجها قرار المالك", done.status === "completed" && (done.actualOutput as any)?.decision === "approved" && (done.actualOutput as any)?.note === "نفّذها هذا الأسبوع", done);
check("دليلها رقم حدث الموافقة في سجل الحساب", !!evRow && Number(evRow.user_id) === A && Number(evRow.actor) === A, ev);
const rej = await K.rejectTicket(A, o2.taskId, A, "ليس الآن");
check("رفض: ملغاة بسببها", rej.status === "cancelled" && rej.failureReason === "ليس الآن" && (rej.actualOutput as any)?.decision === "rejected");
const viaTasks = await http(`/tasks/${o3.taskId}/approve`, { method: "POST", body: {} });
check("الموافقة من صفحة المهام تُكملها أيضاً", viaTasks.status === 200 && viaTasks.body.task.status === "completed" && viaTasks.body.task.evidence.some((e: any) => e.type === "approval_event"), viaTasks.body);
session = { userId: B };
check("حساب آخر لا يوافق على تذكرة أ", (await http(`/tasks/${o2.taskId}/approve`, { method: "POST", body: {} })).status === 409);
server.close();

// ════ ٤. عدّاد المهام ═══════════════════════════════════════════════
await db.execute(sql`INSERT INTO employee_tasks (user_id, owner_role, task_type, status, input_refs) VALUES
  (${C}, 'ops', 'x', 'queued', '{}'::jsonb), (${C}, 'ops', 'x', 'waiting_for_owner', '{}'::jsonb), (${C}, 'ops', 'x', 'waiting_for_owner', '{}'::jsonb),
  (${C}, 'ops', 'x', 'blocked', '{}'::jsonb), (${C}, 'ops', 'x', 'completed', '{}'::jsonb), (${C}, 'ops', 'x', 'draft', '{}'::jsonb)`);
const ov = await orgOverview(C);
check("النشطة تشمل ما ينتظرك والمحجوبة، وكلٌّ يُعرض وحده", ov.tasks.active === 4 && ov.tasks.waitingForOwner === 2 && ov.tasks.blocked === 1, ov.tasks);

// ════ ٥. ملف للموظف الجديد بلا إعادة تشغيل ══════════════════════════
await hire(D, "email_registrar", null, "جديد");
const dossiersOf = async () => (await db.execute<any>(sql`SELECT count(*)::int AS n FROM employee_documentation WHERE user_id = ${D}`)).rows[0].n;
check("قبل الملء: لا ملف", (await dossiersOf()) === 0);
await backfillRegistry(D);
check("عند التوظيف (ملء المفتاح): مسودة الملف", (await dossiersOf()) === 1 && (await db.execute<any>(sql`SELECT status FROM employee_documentation WHERE user_id = ${D}`)).rows[0].status === "draft");
await hire(D, "email_opens", null, "جديد ٢");
await DS.docsTick(); await DS.docsTick();
check("المرور الدوري يلتقط من فاته، ومرتين بأمان", (await dossiersOf()) === 2);

// POST /org/sim/shadow/run: بعد اكتماله يمرّ التفعيل الآلي، ويُقال ما فُعّل — للمراقب (بالكود وحده)
// وحده؛ المسجّل والفتحات يصوغان تقريريهما بنموذج فـ«لم يُجرَّب» ولا يُفعَّلان.
await hire(D, "monitor", null, "مراقب");
await DS.docsTick();
await P.seedPromptProposals(D);
const simApp = express();
simApp.use(express.json());
simApp.use((req: any, _res, next) => { req.session = { userId: D }; next(); });
simApp.use("/org/sim", (await import("../../routes/org-sim")).default);
const simServer = await new Promise<any>((ok) => { const s = simApp.listen(0, "127.0.0.1", () => ok(s)); });
const simRes = await new Promise<any>((ok, no) => {
  import("node:http").then(({ request }) => {
    const req = request({ hostname: "127.0.0.1", port: simServer.address().port, path: "/org/sim/shadow/run", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on("error", no); req.write("{}"); req.end();
  });
});
simServer.close();
const autoD: any[] = simRes.body?.autoApplied ?? [];
check("تشغيل الظل يدوياً يتبعه التفعيل الآلي: المراقب وحده (بالكود وملف كامل)", simRes.status === 200 && autoD.filter((x) => x.applied).map((x) => x.employeeKey).join() === "ops.monitor", autoD);
check("...والمسجّل والفتحات «لم يُجرَّب» فلا يُفعَّلان", ["email.registrar", "email.opens"].every((k) => autoD.some((x) => x.employeeKey === k && !x.applied && /لم يُجرَّب/.test(x.why))), autoD);

// ════ ٦. planned / no_account، الناقل، المحلل ══════════════════════
await hire(S, "li_manager", "linkedin.manager", "خليفة"); await hire(S, "li_inviter", "linkedin.inviter", "منيرة");
await hire(S, "ig_inviter", "instagram.inviter", "نوف"); await hire(S, "ig_analyst", "instagram.analyst", "هيا");
await hire(S, "tt_inviter", "tiktok.inviter", "لولوة"); await hire(S, "tt_analyst", "tiktok.analyst", "مها");
let reg = await orgRegistry(S);
const st = (k: string) => reg.find((r) => r.key === k)?.heartbeat_status;
check("لينكدإن: planned", st("linkedin.manager") === "planned" && st("linkedin.inviter") === "planned");
check("بلا حساب منصة: no_account", st("instagram.inviter") === "no_account" && st("tiktok.analyst") === "no_account");
const { countStates } = await import("../org/overview");
const cs = countStates(reg);
check("خارج «بلا تنفيذ» و«فشل»، ومعدودة وحدها", cs.no_execution === 0 && cs.failed === 0 && cs.planned === 2 && cs.no_account === 4, cs);
const facts = await collectFacts(S);
check("المدير لا يعدّها بلا تنفيذ", !facts.noExecutionEmployees.some((k: string) => /^linkedin\.|inviter|analyst/.test(k)), facts.noExecutionEmployees);
await db.execute(sql`INSERT INTO social_accounts (user_id, platform, profile) VALUES (${S}, 'instagram', 'ig_desk')`);
reg = await orgRegistry(S);
check("له حساب إنستغرام ولم يعمل: no_execution بصدق", st("instagram.analyst") === "no_execution" && st("tiktok.analyst") === "no_account");

let phrased = 0;
const stubPhrase = (text: string) => async () => { phrased++; return text; };
const nA = await AN.runEngagementAnalysis(S, "tiktok", { phrase: stubPhrase("x") });
check("المحلل بلا حساب منصة: no_account بلا نداء", nA.status === "no_account" && phrased === 0);
const empty = await AN.runEngagementAnalysis(S, "instagram", { phrase: stubPhrase("x") });
check("لا بيانات: INSUFFICIENT DATA بلا نموذج", empty.status === "INSUFFICIENT DATA" && phrased === 0, empty);
const [hb] = (await db.execute<any>(sql`SELECT status FROM employee_heartbeats WHERE user_id = ${S} AND employee_key = 'instagram.analyst'`)).rows;
check("ونبضه هو، باسمه", !!hb, hb);
const [post] = (await db.execute<any>(sql`INSERT INTO social_posts (user_id, platform, external_id, url) VALUES (${S}, 'instagram', 'p1', 'https://ig/p1') RETURNING id`)).rows;
await db.execute(sql`INSERT INTO social_comments (user_id, platform, post_id, external_id, author, author_url, text, intent, is_lead, status) VALUES
  (${S}, 'instagram', ${post.id}, 'c1', 'Sara', 'https://ig/sara', 'كم السعر؟', 'interested', true, 'drafted'),
  (${S}, 'instagram', ${post.id}, 'c2', 'Ali', NULL, 'جميل', 'praise', false, 'skipped'),
  (${S}, 'instagram', ${post.id}, 'c3', 'Huda', 'https://ig/huda', 'أبغى خدمة', 'question', true, 'drafted')`);
const good = await AN.runEngagementAnalysis(S, "instagram", { phrase: stubPhrase("جاء 2 من الأسئلة من 3 تعليقات.") });
check("وقائع حقيقية: النموذج يصوغ بأرقامها", good.status === "phrased" && good.facts?.comments === 3 && good.facts?.questions === 2 && phrased === 1, good);
const lie = await AN.runEngagementAnalysis(S, "instagram", { phrase: stubPhrase("ارتفعت المبيعات 40٪") });
check("رقمٌ مخترع: تُكتب الوقائع كما هي", lie.status === "facts_only" && /3 تعليقاً/.test(lie.text ?? ""), lie.text);
await setControl({ scope: "employee", userId: S, target: "instagram.analyst", engaged: true, actor: S });
forgetControls();
const before = phrased;
const halted = await AN.runEngagementAnalysis(S, "instagram", { phrase: stubPhrase("x") });
check("المفتاح يوقف المحلل بلا نداء", halted.status === "halted" && phrased === before);
await setControl({ scope: "employee", userId: S, target: "instagram.analyst", engaged: false, actor: S });
forgetControls();
const inv = await ENG.inviteCommenters(S, "instagram");
const inv2 = await ENG.inviteCommenters(S, "instagram");
const targets = (await db.execute<any>(sql`SELECT handle, source FROM social_targets WHERE user_id = ${S} ORDER BY handle`)).rows;
check("الناقل: المهتم ذو الرابط إلى قائمة الخاص، مرةً واحدة", inv.invited === 2 && inv2.invited === 0 && targets.length === 2 && targets.every((t: any) => t.source === "comment"), { inv, inv2, targets });
check("ولا يرسل شيئاً", (await db.execute<any>(sql`SELECT count(*)::int AS n FROM social_messages WHERE user_id = ${S}`)).rows[0].n === 0);

// ════ ٧. جاهزية الصوت ═══════════════════════════════════════════════
const { setVoiceDeps, resetVoiceDeps } = await import("../org/voice/deps");
const VC = await import("../org/voice/calls");
const { voiceReadiness } = await import("../org/voice/readiness");
const Lim = await import("../org/voice/limits");
const { ensureCeo } = await import("../org/ceo");
await hire(V, "email_analyst", "email.analyst", "محلل"); await hire(W, "email_analyst", "email.analyst", "محلل ب");
await ensureCeo(V); await ensureCeo(W);
const deps = (sttName: string) => setVoiceDeps({
  sttName,
  stt: async () => ({ text: "كيف الحال؟", model: "whisper-large-v3", ms: 7, lang: "ar" as const }),
  tts: async () => ({ audio: Buffer.from("mp3"), voice: "stub-voice" }),
  llm: (async () => ({ text: JSON.stringify({ reply: "بخير.", evidence: [], proposals: [] }), provider: "stub" })) as any,
});
const inApp = async (u: number) => (await voiceReadiness(u)).items.find((x) => x.id === "voice.in_app")!.status;
const turn = async (u: number) => {
  Lim.forgetRates();
  const c = await VC.startCall(u, u, { employeeKey: "email.analyst" });
  const t = await VC.takeTurn(u, Number((c as any).id ?? c.call?.id), { audio: Buffer.alloc(3_000, 1), mime: "audio/webm", durationMs: 2_000, lang: "ar" });
  const callId = Number((t as any).id ?? (t as any).call?.id);
  const emp = (t as any).added.find((x: any) => x.speaker === "employee");
  return { callId, emp };
};
deps("groq");
check("قبل أي دور: NEEDS_TEST", (await inApp(V)) === "NEEDS_TEST");
const tv = await turn(V);
check("دورٌ بلا صوتٍ مولَّد بعد: NEEDS_TEST", !!tv.emp && (await inApp(V)) === "NEEDS_TEST", tv);
await VC.lineAudio(V, tv.callId, Number(tv.emp.id));
check("تفريغ ← جواب ← صوت: READY تلقائياً", (await inApp(V)) === "READY");
check("مسجَّلة مرةً واحدة", (await audits(V, "voice.ready")).length === 1);
await VC.lineAudio(V, tv.callId, Number(tv.emp.id));
check("ولا تتكرر", (await audits(V, "voice.ready")).length === 1);
check("حساب آخر لم يُختبر: NEEDS_TEST", (await inApp(W)) === "NEEDS_TEST");
deps("stub");
const tw = await turn(W);
await VC.lineAudio(W, tw.callId, Number(tw.emp.id));
check("بديل اختبار (ليس Groq): لا يُحسب", (await inApp(W)) === "NEEDS_TEST");
resetVoiceDeps();
delete process.env["GROQ_API_KEY"];
check("بلا مفتاح Groq: BLOCKED حتى لو اختُبر", (await inApp(V)) === "BLOCKED");

check("بلا شبكة", fetched === 0, fetched);
await wipe();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
