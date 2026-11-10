// ── ملفات الموظفين في قاعدة البيانات ──────────────────────────────
// القاعدة مصدر الحقيقة: نسخةٌ لكل تغيير، بحالة draft → proposed → active → superseded.
// البذر عند الإقلاع ينشئ مسودةً من المكتبة والسجل الفني لكل موظفٍ في كل حساب، مرةً لكل نسخة
// مكتبة، ولا يفعّل شيئاً. التقديم ينشئ مقترح تحسين (proposals.ts يصنّفه من المكتبة:
// externalBehavior ⇒ approval_required)، والموافقة تمرّ على activatePrompt نفسه، والإرجاع على
// rollbackProposal. كل استعلام مقيّد بحساب الجلسة.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../../logger";
import { audit } from "../controls";
import { decideLesson } from "../memory";
import { approveProposal, createProposal, getProposal, promptTarget, ProposalRefused, rejectProposal, rollbackProposal } from "../proposals";
import { PROMPT_LIBRARY } from "../prompts";
import { backfillRegistry } from "../registry";
import { accountOf, approvedPersuasionKnowledge } from "./activation";
import { buildDossierSections, cleanSections, dossierText, lineDiff, renderRuntime, RUNTIME_LIMIT, versionText, type DossierSections } from "./model";
import { libraryFor, libraryRows } from "./objections";
import { ensureDocsTables } from "./schema";

export const SEED_AUTHOR = "system.seed";
export class DossierError extends Error { constructor(msg: string, public status = 409) { super(msg); } }

export interface DossierRow {
  id: number; employee_key: string; version: number; status: string; sections: DossierSections; library_version: number | null;
  author: string; change_reason: string | null; proposal_id: number | null; replaced_version: number | null;
  created_at: unknown; approved_by: number | null; approved_at: unknown; activated_at: unknown;
}
const toRow = (r: any): DossierRow => ({
  ...r, id: Number(r.id), version: Number(r.version), library_version: r.library_version == null ? null : Number(r.library_version),
  proposal_id: r.proposal_id == null ? null : Number(r.proposal_id), replaced_version: r.replaced_version == null ? null : Number(r.replaced_version),
  approved_by: r.approved_by == null ? null : Number(r.approved_by),
});

// ── البذر ─────────────────────────────────────────────────────────
/** مسودةٌ لكل موظفٍ في الحساب له مدخل في المكتبة، مرةً لكل نسخة مكتبة. لا يفعّل شيئاً. */
export async function seedDossiers(userId: number): Promise<number> {
  if (!(await ensureDocsTables())) return 0;
  // seed: false — هذا هو البذر نفسه، فلا يبذر الملء من داخله.
  await backfillRegistry(userId, { seed: false });
  const account = await accountOf(db, userId);
  const staff = (await db.execute<{ employee_key: string }>(sql`SELECT employee_key FROM bot_employees WHERE user_id = ${userId} AND employee_key IS NOT NULL`)).rows;
  let made = 0;
  for (const s of staff) {
    const key = s.employee_key;
    const entry = PROMPT_LIBRARY[key];
    if (!entry) continue;
    const [have] = (await db.execute<any>(sql`SELECT coalesce(max(version), 0)::int AS v, bool_or(library_version = ${entry.version} AND author = ${SEED_AUTHOR}) AS seeded
      FROM employee_documentation WHERE user_id = ${userId} AND employee_key = ${key}`)).rows;
    if (have?.seeded) continue;
    const version = Number(have?.v ?? 0) + 1;
    const reason = `بذرة من المكتبة v${entry.version} وسجل الموظفين الفني`;
    const sections = buildDossierSections(key, entry, account, { version, author: SEED_AUTHOR, reason, libraryVersion: entry.version });
    const r = await db.execute(sql`INSERT INTO employee_documentation (user_id, employee_key, version, status, sections, library_version, author, change_reason)
      VALUES (${userId}, ${key}, ${version}, 'draft', ${JSON.stringify(sections)}::jsonb, ${entry.version}, ${SEED_AUTHOR}, ${reason})
      ON CONFLICT (user_id, employee_key, version) DO NOTHING RETURNING id`);
    made += r.rows.length;
  }
  return made;
}

/** مكتبة اعتراضات الحساب وكتيباته، معلّقةً. لا يكتب فوق صفٍّ قائم (ربما عدّله صاحب العمل أو اعتمده). */
export async function seedObjections(userId: number): Promise<number> {
  if (!(await ensureDocsTables())) return 0;
  const lib = libraryFor(await accountOf(db, userId));
  if (!lib) return 0;
  let made = 0;
  for (const row of libraryRows(lib)) {
    const r = await db.execute(sql`INSERT INTO account_knowledge (user_id, key, value, source_reference, approval_status)
      VALUES (${userId}, ${row.key}, ${row.value}, ${row.source}, 'pending') ON CONFLICT (user_id, key) DO NOTHING RETURNING id`);
    made += r.rows.length;
  }
  return made;
}

export async function seedAllDossiers(): Promise<{ dossiers: number; objections: number }> {
  if (!(await ensureDocsTables())) return { dossiers: 0, objections: 0 };
  const users = (await db.execute<{ user_id: number }>(sql`SELECT DISTINCT user_id FROM bot_employees`)).rows;
  let dossiers = 0, objections = 0;
  for (const u of users) {
    const id = Number(u.user_id);
    dossiers += await seedDossiers(id).catch((err) => { logger.warn({ userId: id, err: String(err?.message ?? err).slice(0, 200) }, "بذر ملفات الموظفين تعذّر"); return 0; });
    objections += await seedObjections(id).catch((err) => { logger.warn({ userId: id, err: String(err?.message ?? err).slice(0, 200) }, "بذر الاعتراضات تعذّر"); return 0; });
  }
  return { dossiers, objections };
}

/** مرورٌ واحد: يملأ مفاتيح من وُظّف حديثاً ثم يبذر ما ينقص. يُعاد بأمان، ولا يفعّل شيئاً. */
export async function docsTick(): Promise<{ dossiers: number; objections: number }> {
  await backfillRegistry().catch(() => 0);
  return seedAllDossiers();
}

let docsTimer: NodeJS.Timeout | null = null;
/** عند الإقلاع: الجدول ثم البذر، بلا انتظار ولا تفعيل. ثم كل ساعة: موظفٌ جديد يأخذ مسودته بلا إعادة تشغيل. */
export function startOrgDocs(): void {
  const run = () => void docsTick().then((n) => { if (n.dossiers || n.objections) logger.info(n, "ملفات الموظفين: بُذرت مسودات معلّقة"); })
    .catch((err) => logger.warn({ err: String(err?.message ?? err).slice(0, 200) }, "ملفات الموظفين: تعذّر البذر"));
  run();
  if (docsTimer) return;
  docsTimer = setInterval(run, 60 * 60_000);
  docsTimer.unref();
}

// ── القراءة ───────────────────────────────────────────────────────
async function assertEmployee(userId: number, key: string): Promise<void> {
  if (!PROMPT_LIBRARY[key]) throw new DossierError("لا ملف لهذا الموظف في المكتبة", 404);
  const [e] = (await db.execute(sql`SELECT 1 FROM bot_employees WHERE user_id = ${userId} AND employee_key = ${key}`)).rows;
  if (!e) throw new DossierError("الموظف ليس في هذا الحساب", 404);
}

export async function versionsOf(userId: number, key: string): Promise<DossierRow[]> {
  await ensureDocsTables();
  const r = await db.execute<any>(sql`SELECT * FROM employee_documentation WHERE user_id = ${userId} AND employee_key = ${key} ORDER BY version DESC`);
  return r.rows.map(toRow);
}
export async function versionOf(userId: number, key: string, version: number): Promise<DossierRow | null> {
  await ensureDocsTables();
  const [r] = (await db.execute<any>(sql`SELECT * FROM employee_documentation WHERE user_id = ${userId} AND employee_key = ${key} AND version = ${version}`)).rows;
  return r ? toRow(r) : null;
}

/** التعليمات المجمَّعة لنسخة: كما ستعمل لو فُعّلت الآن، بمعرفة الحساب المعتمدة. */
export async function runtimeFor(userId: number, row: DossierRow): Promise<{ text: string; length: number; limit: number }> {
  const entry = PROMPT_LIBRARY[row.employee_key];
  const text = renderRuntime({ employeeKey: row.employee_key, sections: row.sections, externalBehavior: entry?.externalBehavior ?? true, account: await accountOf(db, userId), knowledge: await approvedPersuasionKnowledge(db, userId) });
  return { text, length: text.length, limit: RUNTIME_LIMIT };
}

/** تعليمات النسخة النشطة كما تعمل الآن (للمكالمات والاجتماعات). لا نسخة نشطة: null. */
export async function activeRuntime(userId: number, key: string): Promise<string | null> {
  if (!(await ensureDocsTables())) return null;
  const [r] = (await db.execute<any>(sql`SELECT * FROM employee_documentation WHERE user_id = ${userId} AND employee_key = ${key} AND status = 'active' LIMIT 1`)).rows;
  return r ? (await runtimeFor(userId, toRow(r))).text : null;
}

export async function listDossiers(userId: number) {
  await ensureDocsTables();
  const r = await db.execute<any>(sql`SELECT e.employee_key, e.name, e.title, e.role,
      (SELECT version FROM employee_documentation d WHERE d.user_id = e.user_id AND d.employee_key = e.employee_key AND d.status = 'active' LIMIT 1) AS active_version,
      (SELECT max(version) FROM employee_documentation d WHERE d.user_id = e.user_id AND d.employee_key = e.employee_key) AS latest_version,
      (SELECT count(*)::int FROM employee_documentation d WHERE d.user_id = e.user_id AND d.employee_key = e.employee_key AND d.status = 'proposed') AS proposed
    FROM bot_employees e WHERE e.user_id = ${userId} AND e.employee_key IS NOT NULL ORDER BY e.employee_key`);
  return r.rows.filter((x: any) => !!PROMPT_LIBRARY[x.employee_key]).map((x: any) => ({
    employeeKey: x.employee_key, name: x.name, title: x.title, role: x.role, externalBehavior: PROMPT_LIBRARY[x.employee_key]!.externalBehavior,
    activeVersion: x.active_version == null ? null : Number(x.active_version), latestVersion: x.latest_version == null ? null : Number(x.latest_version), proposed: Number(x.proposed ?? 0),
  }));
}

/** ملف موظف: نسخه، النشطة، آخرها، وتعليماتها المجمَّعة، والفرق بين الأخيرة والنشطة. */
export async function getDossier(userId: number, key: string) {
  await assertEmployee(userId, key);
  const versions = await versionsOf(userId, key);
  const active = versions.find((v) => v.status === "active") ?? null;
  const latest = versions[0] ?? null;
  const shown = latest ?? active;
  return {
    employeeKey: key, externalBehavior: PROMPT_LIBRARY[key]!.externalBehavior,
    active, latest,
    history: versions.map(({ sections: _s, ...v }) => v),
    runtime: shown ? await runtimeFor(userId, shown) : null,
    diff: active && latest && latest.version !== active.version ? lineDiff(dossierText(active.sections), dossierText(latest.sections)) : null,
  };
}

export async function diffVersions(userId: number, key: string, from: number | null, to: number) {
  await assertEmployee(userId, key);
  const b = await versionOf(userId, key, to);
  if (!b) throw new DossierError("النسخة ليست في هذا الحساب", 404);
  const a = from != null ? await versionOf(userId, key, from) : (await versionsOf(userId, key)).find((v) => v.status === "active") ?? null;
  return { from: a?.version ?? null, to: b.version, diff: lineDiff(a ? dossierText(a.sections) : "", dossierText(b.sections)) };
}

// ── التحرير ───────────────────────────────────────────────────────
/** مسودة جديدة من نسخةٍ أساس (النشطة، وإلا الأحدث). النسخة رقمٌ جديد دائماً: لا تعديل على تاريخ. */
export async function createDraft(userId: number, key: string, o: { sections: unknown; reason: string; actor: number; baseVersion?: number | null }): Promise<DossierRow> {
  await assertEmployee(userId, key);
  if (!o.reason?.trim()) throw new DossierError("سبب التغيير مطلوب", 400);
  const versions = await versionsOf(userId, key);
  const base = o.baseVersion != null ? versions.find((v) => v.version === o.baseVersion) : versions.find((v) => v.status === "active") ?? versions[0];
  if (!base) throw new DossierError("لا نسخة أساس: لم يُبذر الملف بعد", 409);
  const { sections, error } = cleanSections(o.sections, base.sections);
  if (error) throw new DossierError(error, 400);
  const version = (versions[0]?.version ?? 0) + 1;
  const author = `user:${o.actor}`;
  const entry = PROMPT_LIBRARY[key]!;
  sections.version = versionText({ version, author, reason: o.reason.trim().slice(0, 300), libraryVersion: base.library_version ?? entry.version });
  const [r] = (await db.execute<any>(sql`INSERT INTO employee_documentation (user_id, employee_key, version, status, sections, library_version, author, change_reason)
    VALUES (${userId}, ${key}, ${version}, 'draft', ${JSON.stringify(sections)}::jsonb, ${base.library_version}, ${author}, ${o.reason.trim().slice(0, 2000)}) RETURNING *`)).rows;
  await audit({ userId, action: "dossier.draft", actor: o.actor, kind: key, meta: { version, base: base.version } });
  return toRow(r);
}

/** تعديل مسودةٍ لم تُقدَّم بعد. */
export async function updateDraft(userId: number, key: string, version: number, o: { sections: unknown; reason?: string | null; actor: number }): Promise<DossierRow> {
  await assertEmployee(userId, key);
  const row = await versionOf(userId, key, version);
  if (!row) throw new DossierError("النسخة ليست في هذا الحساب", 404);
  if (row.status !== "draft") throw new DossierError("لا تُعدَّل إلا المسودة؛ أنشئ نسخة جديدة");
  const { sections, error } = cleanSections(o.sections, row.sections);
  if (error) throw new DossierError(error, 400);
  const reason = o.reason?.trim() || row.change_reason || "تعديل مسودة";
  sections.version = versionText({ version, author: `user:${o.actor}`, reason: reason.slice(0, 300), libraryVersion: row.library_version ?? PROMPT_LIBRARY[key]!.version });
  const [r] = (await db.execute<any>(sql`UPDATE employee_documentation SET sections = ${JSON.stringify(sections)}::jsonb, change_reason = ${reason.slice(0, 2000)}, author = ${`user:${o.actor}`}
    WHERE id = ${row.id} AND status = 'draft' RETURNING *`)).rows;
  if (!r) throw new DossierError("تغيّرت حالة المسودة");
  return toRow(r);
}

// ── القرار ────────────────────────────────────────────────────────
/** تقديم المسودة: مقترح تحسين يصنّفه proposals.ts من المكتبة. لا يفعّل شيئاً. */
export async function submitVersion(userId: number, key: string, version: number, actor: number, reason?: string | null) {
  await assertEmployee(userId, key);
  const row = await versionOf(userId, key, version);
  if (!row) throw new DossierError("النسخة ليست في هذا الحساب", 404);
  if (row.status !== "draft") throw new DossierError("لا يُقدَّم إلا ما هو مسودة");
  const active = (await versionsOf(userId, key)).find((v) => v.status === "active") ?? null;
  const d = lineDiff(active ? dossierText(active.sections) : "", dossierText(row.sections));
  const runtime = await runtimeFor(userId, row);
  const proposal = await createProposal({
    userId, requestedBy: `user:${actor}`, target: promptTarget(key), reason: (reason?.trim() || row.change_reason || `ملف ${key} v${version}`).slice(0, 2000),
    newValue: { dossierVersion: version }, impact: PROMPT_LIBRARY[key]!.externalBehavior ? "يغيّر ما يكتبه الموظف أو من يراسله" : "تحليل داخلي: لا أثر مباشر خارج النظام",
    evidence: { dossierVersion: version, againstVersion: active?.version ?? null, added: d.filter((x) => x.op === "add").length, removed: d.filter((x) => x.op === "del").length, runtimeLength: runtime.length },
  });
  const [r] = (await db.execute<any>(sql`UPDATE employee_documentation SET status = 'proposed', proposal_id = ${proposal.change_id} WHERE id = ${row.id} AND status = 'draft' RETURNING *`)).rows;
  if (!r) throw new DossierError("تغيّرت حالة المسودة");
  await audit({ userId, action: "dossier.submitted", actor, kind: key, meta: { version, changeId: proposal.change_id, risk: proposal.risk } });
  return { dossier: toRow(r), proposal };
}

const proposedRow = async (userId: number, key: string, version: number) => {
  await assertEmployee(userId, key);
  const row = await versionOf(userId, key, version);
  if (!row) throw new DossierError("النسخة ليست في هذا الحساب", 404);
  if (row.status !== "proposed" || row.proposal_id == null) throw new DossierError("النسخة لم تُقدَّم للموافقة");
  return row;
};

/** موافقة صاحب الحساب: المقترح يُعتمد ويُفعَّل عبر activatePrompt (persona ونسخة التعليمات). */
export async function approveVersion(userId: number, key: string, version: number, actor: number) {
  const row = await proposedRow(userId, key, version);
  const res = await approveProposal(userId, row.proposal_id!, actor);
  return { ...res, dossier: await versionOf(userId, key, version) };
}

/** الرفض: المقترح يُرفض ويبقى في سجله، والنسخة تعود مسودة لتُعدَّل. */
export async function rejectVersion(userId: number, key: string, version: number, actor: number, why?: string | null) {
  const row = await proposedRow(userId, key, version);
  const proposal = await rejectProposal(userId, row.proposal_id!, actor, why ?? null);
  await db.execute(sql`UPDATE employee_documentation SET status = 'draft', proposal_id = NULL WHERE id = ${row.id} AND status = 'proposed'`);
  await audit({ userId, action: "dossier.rejected", actor, kind: key, why: why ?? null, meta: { version, changeId: proposal.change_id } });
  return { proposal, dossier: await versionOf(userId, key, version) };
}

/** إرجاع النسخة النشطة: rollbackProposal يعيد persona، والنسخة السابقة تعود active. */
export async function rollbackActive(userId: number, key: string, actor: number) {
  await assertEmployee(userId, key);
  const active = (await versionsOf(userId, key)).find((v) => v.status === "active");
  if (!active) throw new DossierError("لا نسخة نشطة لهذا الموظف");
  if (active.proposal_id == null) throw new DossierError("النسخة النشطة بلا مقترح يُعاد");
  const p = await getProposal(userId, active.proposal_id);
  if (!p || p.status !== "applied") throw new DossierError("مقترح النسخة النشطة ليس مطبّقاً");
  const proposal = await rollbackProposal(userId, active.proposal_id, actor);
  const now = (await versionsOf(userId, key)).find((v) => v.status === "active") ?? null;
  return { proposal, rolledBack: active.version, active: now?.version ?? null };
}

// ── الاعتراضات والكتيبات ──────────────────────────────────────────
export async function listPersuasionKnowledge(userId: number) {
  await ensureDocsTables();
  const r = await db.execute<any>(sql`SELECT id, key, value, source_reference, approval_status, version, last_verified_at, updated_at FROM account_knowledge
    WHERE user_id = ${userId} AND (key LIKE 'objection.%' OR key LIKE 'playbook.%') ORDER BY key`);
  return r.rows.map((x: any) => {
    let value: unknown = x.value;
    try { value = JSON.parse(x.value); } catch {}
    return { id: Number(x.id), key: x.key, value, sourceReference: x.source_reference, approvalStatus: x.approval_status, version: Number(x.version), lastVerifiedAt: x.last_verified_at, updatedAt: x.updated_at };
  });
}

/** قرار صاحب الحساب على اعتراضٍ أو كتيب. لا يمسّ إلا صفّ حسابه المعلّق. */
export async function decidePersuasion(userId: number, id: number, status: "approved" | "rejected", actor: number): Promise<boolean> {
  const [row] = (await db.execute(sql`SELECT 1 FROM account_knowledge WHERE id = ${id} AND user_id = ${userId} AND (key LIKE 'objection.%' OR key LIKE 'playbook.%')`)).rows;
  if (!row) return false;
  return decideLesson(userId, "account", id, status, actor);
}

export { ProposalRefused };
