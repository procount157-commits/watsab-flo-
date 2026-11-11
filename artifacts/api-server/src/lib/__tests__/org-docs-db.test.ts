// ملف الموظف على قاعدة اختبار حقيقية، بلا شبكة ولا إرسال ولا نموذج: البذر بلا تفعيل، المسودة،
// الفرق، التقديم والتصنيف، الموافقة عبر activatePrompt، الإرجاع، الرفض، الاعتراضات المعلّقة،
// وعزل الحسابات. قاعدة الاختبار وحدها:
//   DATABASE_URL=postgres://t:t@127.0.0.1:55442/t npx tsx src/lib/__tests__/org-docs-db.test.ts
export {};
if (!/127\.0\.0\.1:(55449|55447|55445|55439|55440|55442)\//.test(process.env["DATABASE_URL"] ?? "")) { console.error("على قاعدة الاختبار وحدها"); process.exit(1); }
globalThis.fetch = (async (url: any) => { throw new Error(`no network in this test: ${url}`); }) as any;

const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const D = await import("../org/docs/dossier");
const M = await import("../org/docs/model");
const P = await import("../org/proposals");
const O = await import("../org/docs/objections/index");
const { ensureDocsTables } = await import("../org/docs/schema");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};
const refused = async (p: Promise<unknown>, status?: number) => p.then(() => false, (e) => (e instanceof D.DossierError || e instanceof P.ProposalRefused) && (status == null || e.status === status));
const one = async (q: any) => (await db.execute<any>(q)).rows[0];
const all = async (q: any) => (await db.execute<any>(q)).rows;

const A = 18, B = 19, C = 20; // فلوريت، بروكاونت، حساب ثالث
check("tables are created on top of the pushed schema and the migration", await ensureDocsTables());
check("...and again, idempotently", await ensureDocsTables());
for (const t of ["employee_documentation", "org_audit_log", "employee_prompt_versions", "improvement_proposals", "account_knowledge", "bot_employees", "business_profile"]) {
  await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${A}, ${B}, ${C})`));
}
await db.execute(sql`INSERT INTO business_profile (user_id, name, vertical) VALUES (${A}, 'فلوريت للذهب والمجوهرات (FLORET JEWELRY)', 'jewelry'), (${B}, 'Pro Count for Accounting', 'accounting'), (${C}, 'مطعم الأصيل', 'restaurant')`);
const hire = (u: number, role: string) => db.execute(sql`INSERT INTO bot_employees (user_id, name, role, kind, persona) VALUES (${u}, ${role}, ${role}, 'internal', ${`الشخصية الأصلية ${role}`})`);
for (const r of ["sales", "support", "ops"]) await hire(A, r);
for (const r of ["sales", "email_replies"]) await hire(B, r);
await hire(C, "sales");

// ── البذر ─────────────────────────────────────────────────────────
check("seed: one draft per employee", (await D.seedDossiers(A)) === 3 && (await D.seedDossiers(B)) === 2 && (await D.seedDossiers(C)) === 1);
// seedAllDossiers يمرّ على كل الحسابات، فلا يُنادى هنا: قاعدة الاختبار مشتركة مع اختبارات أخرى.
check("seed again: nothing new", (await D.seedDossiers(A)) === 0 && (await D.seedDossiers(B)) === 0 && (await D.seedDossiers(C)) === 0);
const seeded = await all(sql`SELECT * FROM employee_documentation WHERE user_id IN (${A}, ${B}, ${C})`);
check("seeded rows are drafts by system.seed, none active", seeded.every((r: any) => r.status === "draft" && r.author === "system.seed" && r.version === 1));
check("...with all nineteen sections", seeded.every((r: any) => M.missingSections(r.sections).length === 0));
check("seeding activated nothing: personas untouched, no prompt version", (await all(sql`SELECT persona FROM bot_employees WHERE user_id IN (${A}, ${B}, ${C})`)).every((r: any) => r.persona.startsWith("الشخصية الأصلية"))
  && Number((await one(sql`SELECT count(*)::int AS n FROM employee_prompt_versions WHERE user_id IN (${A}, ${B}, ${C})`)).n) === 0);
check("unique (account, employee, version) holds", await db.execute(sql`INSERT INTO employee_documentation (user_id, employee_key, version, sections, author) VALUES (${A}, 'whatsapp.sales', 1, '{}'::jsonb, 'x')`).then(() => false, () => true));
check("the status check holds", await db.execute(sql`INSERT INTO employee_documentation (user_id, employee_key, version, status, sections, author) VALUES (${A}, 'whatsapp.sales', 99, 'live', '{}'::jsonb, 'x')`).then(() => false, () => true));

// ── الاعتراضات ────────────────────────────────────────────────────
const nFlo = O.libraryRows(O.ACCOUNT_LIBRARIES.floret).length, nPro = O.libraryRows(O.ACCOUNT_LIBRARIES.procount).length;
await D.seedObjections(A); await D.seedObjections(B); await D.seedObjections(C);
const countK = async (u: number) => Number((await one(sql`SELECT count(*)::int AS n FROM account_knowledge WHERE user_id = ${u}`)).n);
check("objections seeded per account, a third gets none", (await countK(A)) === nFlo && (await countK(B)) === nPro && (await countK(C)) === 0);
check("...and not twice", (await D.seedObjections(A)) === 0);
const kA = await all(sql`SELECT * FROM account_knowledge WHERE user_id = ${A}`), kB = await all(sql`SELECT * FROM account_knowledge WHERE user_id = ${B}`);
check("all pending", [...kA, ...kB].every((r: any) => r.approval_status === "pending"));
check("isolation: Floret's rows are Floret's only", kA.every((r: any) => !/accountant|AML|Pro Count/i.test(r.value)) && kA.some((r: any) => r.value.includes("https://floret-royal.io")));
check("isolation: Pro Count's rows are Pro Count's only", kB.every((r: any) => !/floret|فلوريت|المعرض/i.test(r.value)));
check("listing shows the account's own rows only", (await D.listPersuasionKnowledge(A)).length === nFlo && (await D.listPersuasionKnowledge(C)).length === 0);

// ── القراءة والعزل ────────────────────────────────────────────────
const K = "whatsapp.sales";
const dA = await D.getDossier(A, K);
check("dossier: latest v1, nothing active, a runtime preview ≤ 3500", dA.latest?.version === 1 && dA.active === null && !!dA.runtime && dA.runtime.length <= 3500);
check("the preview carries Floret's rules", /لا سعر ولا وزن/.test(dA.runtime!.text) && dA.runtime!.text.includes("https://floret-royal.io"));
check("a pending objection is not in the preview", !dA.runtime!.text.includes("بكم هذي القطعة"));
check("an employee the account does not have: 404", await refused(D.getDossier(C, "email.replies"), 404));
check("B's dossier for the same key carries nothing of A", !M.dossierText((await D.getDossier(B, K)).latest!.sections).includes("فلوريت"));

// ── المسودة والفرق ────────────────────────────────────────────────
const base = dA.latest!.sections;
const d2 = await D.createDraft(A, K, { sections: { mission: `${base.mission}\nسطر جديد من صاحب العمل` }, reason: "تجربة المحرر", actor: A });
check("a draft is a new version", d2.version === 2 && d2.status === "draft" && d2.author === `user:${A}`);
check("its version section is the server's", d2.sections.version.includes("النسخة 2") && d2.sections.version.includes("تجربة المحرر"));
const df = await D.diffVersions(A, K, 1, 2);
check("line diff vs v1 shows the added line", df.diff.some((l) => l.op === "add" && l.text === "سطر جديد من صاحب العمل"));
check("an empty section is refused", await refused(D.createDraft(A, K, { sections: { mission: " " }, reason: "x", actor: A }), 400));
check("a draft needs a reason", await refused(D.createDraft(A, K, { sections: {}, reason: " ", actor: A }), 400));
const d2b = await D.updateDraft(A, K, 2, { sections: { quality: `${base.quality}\nفحص إضافي` }, actor: A });
check("a draft can be edited in place", d2b.sections.quality.includes("فحص إضافي") && d2b.sections.mission.includes("سطر جديد"));

// ── التقديم ───────────────────────────────────────────────────────
check("no activation without an approved proposal (customer-facing)", await refused(P.activatePrompt(A, K, { actor: A }), 403));
const sub = await D.submitVersion(A, K, 2, A, "تحسين الرد");
check("submit: an improvement proposal, approval_required, prompt_external", sub.proposal.risk === "approval_required" && sub.proposal.category === "prompt_external" && sub.proposal.status === "proposed" && sub.proposal.target === `prompt:${K}`);
check("...carrying the dossier version", sub.proposal.new_value?.dossierVersion === 2 && sub.dossier.status === "proposed" && sub.dossier.proposal_id === sub.proposal.change_id);
check("a proposed version is not edited", await refused(D.updateDraft(A, K, 2, { sections: {}, actor: A })));
check("still nothing live", (await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${A} AND role = 'sales'`)).persona === "الشخصية الأصلية sales");
check("another account cannot approve it", await refused(P.approveProposal(B, sub.proposal.change_id, B)) && await refused(D.approveVersion(B, K, 2, B), 404));

// ── الموافقة ──────────────────────────────────────────────────────
const ap = await D.approveVersion(A, K, 2, A);
const emp = await one(sql`SELECT persona, prompt_version FROM bot_employees WHERE user_id = ${A} AND role = 'sales'`);
const runtime2 = (await D.runtimeFor(A, (await D.versionOf(A, K, 2))!)).text;
check("approve: applied through activatePrompt", ap.applied === true && ap.proposal.status === "applied");
check("the persona is the assembled runtime of v2", emp.persona === runtime2 && emp.persona.includes("سطر جديد من صاحب العمل"));
check("...and it is ≤ 3500, with no ▪ documentation line", emp.persona.length <= 3500 && !emp.persona.includes(M.DOC_ONLY));
const pv = await one(sql`SELECT note, active FROM employee_prompt_versions WHERE user_id = ${A} AND employee_key = ${K} AND active`);
check("the prompt version says which dossier", /الملف v2/.test(pv?.note ?? ""), pv);
const v2 = (await D.versionOf(A, K, 2))!;
check("v2 is active, approved by the owner", v2.status === "active" && v2.approved_by === A && !!v2.approved_at && !!v2.activated_at);
check("B's employees untouched", (await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${B} AND role = 'sales'`)).persona === "الشخصية الأصلية sales");

// ── اعتراض معتمد يدخل بعد الموافقة ────────────────────────────────
const how = kA.find((r: any) => r.key === "objection.price.how_much");
check("another account cannot approve A's objection", !(await D.decidePersuasion(B, Number(how.id), "approved", B)));
check("the owner approves it", await D.decidePersuasion(A, Number(how.id), "approved", A));
check("the live persona did not change by itself", (await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${A} AND role = 'sales'`)).persona === runtime2);
const d3 = await D.createDraft(A, K, { sections: {}, reason: "إدخال الاعتراض المعتمد", actor: A });
check("the preview now carries the approved objection", (await D.runtimeFor(A, d3)).text.includes("«بكم هذي القطعة؟»"));
await D.submitVersion(A, K, 3, A);
await D.approveVersion(A, K, 3, A);
const persona3 = (await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${A} AND role = 'sales'`)).persona;
check("v3 live with the approved objection, still none of the pending ones", persona3.includes("«بكم هذي القطعة؟»") && !persona3.includes("«غالية علي.»"));
check("v2 superseded, v3 active, one active only", (await D.versionOf(A, K, 2))!.status === "superseded" && (await D.versionOf(A, K, 3))!.status === "active"
  && Number((await one(sql`SELECT count(*)::int AS n FROM employee_documentation WHERE user_id = ${A} AND employee_key = ${K} AND status = 'active'`)).n) === 1);
check("Pro Count's persona never got Floret's objection", !((await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${B} AND role = 'sales'`)).persona as string).includes("بكم"));

// ── الإرجاع ───────────────────────────────────────────────────────
const rb = await D.rollbackActive(A, K, A);
check("rollback: v3 superseded, v2 active again", rb.rolledBack === 3 && rb.active === 2 && (await D.versionOf(A, K, 3))!.status === "superseded");
check("...and the persona is v2's again", (await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${A} AND role = 'sales'`)).persona === runtime2);
check("the proposal says rolled_back", (await P.getProposal(A, (await D.versionOf(A, K, 3))!.proposal_id!))?.status === "rolled_back");
const rb2 = await D.rollbackActive(A, K, A);
check("rollback again: back to the persona before any dossier, none active", rb2.active === null && (await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${A} AND role = 'sales'`)).persona === "الشخصية الأصلية sales");
check("nothing to roll back now", await refused(D.rollbackActive(A, K, A)));

// ── الرفض ─────────────────────────────────────────────────────────
const d4 = await D.createDraft(A, K, { sections: { mission: "مهمة مختلفة" }, reason: "تجربة الرفض", actor: A });
const s4 = await D.submitVersion(A, K, d4.version, A);
const rj = await D.rejectVersion(A, K, d4.version, A, "لا");
check("reject: proposal rejected, the version back to draft", rj.proposal.status === "rejected" && rj.dossier?.status === "draft" && rj.dossier?.proposal_id === null);
check("...and nothing live changed", (await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${A} AND role = 'sales'`)).persona === "الشخصية الأصلية sales" && s4.proposal.change_id > 0);

// ── الداخلي ومقترح البذر ──────────────────────────────────────────
const so = await D.submitVersion(A, "ops.controller", 1, A);
check("an internal dossier is low risk but still waits for a decision", so.proposal.risk === "low" && so.proposal.status === "proposed" && (await D.versionOf(A, "ops.controller", 1))!.status === "proposed");
await D.approveVersion(A, "ops.controller", 1, A);
check("...and activates on approval", (await D.versionOf(A, "ops.controller", 1))!.status === "active" && !(await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${A} AND role = 'ops'`)).persona.includes(M.STANDARD.injectionGuard));
await P.seedPromptProposals(A);
const seedP = await one(sql`SELECT change_id FROM improvement_proposals WHERE user_id = ${A} AND requested_by = 'system.seed' AND target = 'prompt:whatsapp.support'`);
await P.approveProposal(A, Number(seedP.change_id), A);
check("approving the library's seed proposal activates the seeded dossier", (await D.versionOf(A, "whatsapp.support", 1))!.status === "active"
  && (await one(sql`SELECT persona FROM bot_employees WHERE user_id = ${A} AND role = 'support'`)).persona === (await D.runtimeFor(A, (await D.versionOf(A, "whatsapp.support", 1))!)).text);
check("the third account: still nothing active anywhere", Number((await one(sql`SELECT count(*)::int AS n FROM employee_documentation WHERE user_id = ${C} AND status = 'active'`)).n) === 0);
check("the list per account", (await D.listDossiers(A)).length === 3 && (await D.listDossiers(C)).length === 1 && (await D.listDossiers(C))[0]!.activeVersion === null);
check("audit rows written for the account", Number((await one(sql`SELECT count(*)::int AS n FROM org_audit_log WHERE user_id = ${A} AND action LIKE 'dossier.%'`)).n) >= 4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
