// ── مقترحات التحسين ───────────────────────────────────────────────
// كل تغييرٍ في عمل المنظّمة يمرّ من هنا بنسخته القديمة وسبب ودليل: يُعتمد أو يُرفض،
// يُطبَّق، ويُعاد. التصنيف بالكود لا برأي صاحب الطلب: فئة مجهولة تعني موافقة، ومقترح
// تعليمات يأخذ فئته من المكتبة نفسها مهما قال الطالب.
//
// activatePrompt: تُحفظ الشخصية الحالية نسخةً، ويُكتب النص الجديد في employee_prompt_versions
// وفي bot_employees.persona، فالقرّاء الحاليون يعملون كما هم. الإرجاع يعيد النص نفسه.
// لا شيء يُفعَّل عند الإقلاع: البذر ينشئ مقترحات معلّقة فقط.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { audit } from "./controls";
import { backfillRegistry } from "./registry";
import { ensureOrgTables } from "./schema";
import { PROMPT_LIBRARY, renderPrompt } from "./prompts";
import { activateDossier, DossierRefused, linkDossierProposal, rollbackDossier } from "./docs/activation";

export const APPROVAL_CATEGORIES = ["external_strategy", "pricing", "promises", "limits", "channel_activation", "prompt_external", "permissions", "account_config", "financial", "deletion", "security"] as const;
export const LOW_RISK_CATEGORIES = ["prompt_internal", "memory", "internal_analytics"] as const;
export type Category = (typeof APPROVAL_CATEGORIES)[number] | (typeof LOW_RISK_CATEGORIES)[number];
export interface Classification { risk: "low" | "approval_required"; category: string; why: string }

const CATEGORY_AR: Record<string, string> = {
  external_strategy: "استراتيجية خارجية", pricing: "تسعير", promises: "وعود للعملاء", limits: "حدود الإرسال", channel_activation: "تشغيل قناة",
  prompt_external: "تعليمات تؤثر فيما يخرج للناس", permissions: "صلاحيات", account_config: "إعدادات الحساب", financial: "مالي", deletion: "حذف", security: "أمان",
  prompt_internal: "تعليمات تحليل داخلية", memory: "ذاكرة", internal_analytics: "تحليل داخلي",
};

/** فئة هدف التعليمات تأتي من المكتبة، ولا يُخفضها أحد. غير موجود في المكتبة: موافقة. Pure. */
export function classifyPrompt(entry: { externalBehavior: boolean } | undefined): Classification {
  return classify(entry && !entry.externalBehavior ? "prompt_internal" : "prompt_external");
}

/** منخفض الخطر قائمةٌ مغلقة، وكل ما عداها موافقة. Pure. */
export function classify(category: string | null | undefined): Classification {
  const c = String(category ?? "");
  if ((LOW_RISK_CATEGORIES as readonly string[]).includes(c)) return { risk: "low", category: c, why: `${CATEGORY_AR[c]}: لا أثر خارج النظام` };
  if ((APPROVAL_CATEGORIES as readonly string[]).includes(c)) return { risk: "approval_required", category: c, why: `${CATEGORY_AR[c]}: يتطلب موافقة صاحب الحساب` };
  return { risk: "approval_required", category: c || "unknown", why: "فئة غير معروفة: تُعامل كمتطلبة موافقة" };
}

export const promptTarget = (employeeKey: string) => `prompt:${employeeKey}`;
const keyOfTarget = (t: string | null) => (t?.startsWith("prompt:") ? t.slice(7) : null);

export interface Proposal {
  change_id: number; user_id: number; requested_by: string; approved_by: number | null; target: string | null; reason: string; evidence: unknown; old_value: any; new_value: any;
  impact: string | null; status: string; applied_at: unknown; rollback_version: number | null; created_at: unknown; category: string | null; risk: string | null; decision_note: string | null;
  classification: Classification;
}
const toProposal = (r: any): Proposal => ({ ...r, change_id: Number(r.change_id), user_id: Number(r.user_id), classification: classify(r.category) });

export class ProposalRefused extends Error { constructor(msg: string, public status = 409) { super(msg); } }

// ── الإنشاء والقراءة ───────────────────────────────────────────────
export interface NewProposal {
  userId: number; requestedBy: string; target: string; category?: string | null; reason: string; newValue?: unknown; evidence?: unknown; impact?: string | null;
}

/** ينشئ المقترح ولا يطبّق شيئاً. هدف التعليمات يُصنَّف من المكتبة. */
export async function createProposal(p: NewProposal): Promise<Proposal> {
  await ensureOrgTables();
  if (!p.reason?.trim()) throw new ProposalRefused("المقترح بلا سبب", 400);
  const key = keyOfTarget(p.target);
  const entry = key ? PROMPT_LIBRARY[key] : undefined;
  if (key && !entry) throw new ProposalRefused("لا نسخة لهذا الموظف في المكتبة", 400);
  const cls = key ? classifyPrompt(entry) : classify(p.category);
  const newValue = key ? { libraryVersion: entry!.version, ...(p.newValue as object ?? {}) } : p.newValue ?? null;
  const [r] = (await db.execute<any>(sql`INSERT INTO improvement_proposals (user_id, requested_by, target, reason, evidence, new_value, impact, category, risk)
    VALUES (${p.userId}, ${p.requestedBy.slice(0, 60)}, ${p.target.slice(0, 120)}, ${p.reason.slice(0, 2000)}, ${JSON.stringify(p.evidence ?? null)}::jsonb, ${JSON.stringify(newValue)}::jsonb,
      ${p.impact?.slice(0, 1000) ?? null}, ${cls.category}, ${cls.risk}) RETURNING *`)).rows;
  await audit({ userId: p.userId, action: "proposal.created", kind: cls.category, role: p.requestedBy, meta: { changeId: Number(r.change_id), target: p.target, risk: cls.risk } });
  // منخفض الخطر يُعتمد وحده، بلا أثرٍ خارج سجله. التعليمات تعبر activatePrompt، ولا يفعّل مقترحٌ شيئاً بإنشائه.
  if (cls.risk === "low" && !key) {
    const [auto] = (await db.execute<any>(sql`UPDATE improvement_proposals SET status = 'approved', decision_note = ${"اعتُمد آلياً: منخفض الخطر"} WHERE change_id = ${r.change_id} RETURNING *`)).rows;
    await audit({ userId: p.userId, action: "proposal.auto_approved", kind: cls.category, meta: { changeId: Number(r.change_id) } });
    return toProposal(auto);
  }
  return toProposal(r);
}

export async function listProposals(userId: number, o: { status?: string; target?: string; limit?: number } = {}): Promise<Proposal[]> {
  await ensureOrgTables();
  const r = await db.execute<any>(sql`SELECT * FROM improvement_proposals WHERE user_id = ${userId} ${o.status ? sql`AND status = ${o.status}` : sql``} ${o.target ? sql`AND target = ${o.target}` : sql``}
    ORDER BY change_id DESC LIMIT ${Math.min(Math.max(o.limit ?? 100, 1), 500)}`);
  return r.rows.map(toProposal);
}

export async function getProposal(userId: number, id: number): Promise<Proposal | null> {
  const [r] = (await db.execute<any>(sql`SELECT * FROM improvement_proposals WHERE change_id = ${id} AND user_id = ${userId}`)).rows;
  return r ? toProposal(r) : null;
}

// ── التعليمات ─────────────────────────────────────────────────────
async function nextVersion(tx: any, userId: number, employeeKey: string): Promise<number> {
  const [v] = (await tx.execute(sql`SELECT coalesce(max(version), 0)::int AS v FROM employee_prompt_versions WHERE user_id = ${userId} AND employee_key = ${employeeKey}`)).rows as any[];
  return Number(v.v) + 1;
}

export interface Activation { employeeKey: string; version: number; previousVersion: number; changeId: number }

/**
 * يفعّل نسخة المكتبة لموظفٍ في حساب. ما يؤثر فيما يخرج للناس يتطلب مقترحاً معتمَداً؛ والتحليلي
 * الداخلي يعمل منخفض الخطر فيُكتب له مقترح مطبَّق. لا يعمل إلا إن نودي: لا مؤقّت يفعّل شيئاً.
 */
export async function activatePrompt(userId: number, employeeKey: string, o: { actor?: number | null; changeId?: number | null } = {}): Promise<Activation> {
  await ensureOrgTables();
  const entry = PROMPT_LIBRARY[employeeKey];
  if (!entry) throw new ProposalRefused("لا نسخة لهذا الموظف في المكتبة", 404);
  const target = promptTarget(employeeKey);
  const cls = classifyPrompt(entry);
  const [approved] = (await db.execute<any>(sql`SELECT * FROM improvement_proposals WHERE user_id = ${userId} AND target = ${target} AND status = 'approved'
    ${o.changeId ? sql`AND change_id = ${o.changeId}` : sql``} ORDER BY change_id DESC LIMIT 1`)).rows;
  if (cls.risk === "approval_required" && !approved) {
    await audit({ userId, action: "prompt.refused", kind: cls.category, actor: o.actor ?? null, why: "بلا مقترح معتمَد", meta: { employeeKey } }).catch(() => {});
    throw new ProposalRefused("هذه التعليمات تؤثر فيما يخرج للناس: تتطلب مقترحاً معتمَداً", 403);
  }
  const res = await db.transaction(async (tx) => {
    const [emp] = (await tx.execute<any>(sql`SELECT id, role, name, title, persona, prompt_version FROM bot_employees WHERE user_id = ${userId} AND employee_key = ${employeeKey} FOR UPDATE`)).rows;
    if (!emp) throw new ProposalRefused("الموظف ليس في هذا الحساب", 404);
    const previousVersion = await nextVersion(tx, userId, employeeKey);
    await tx.execute(sql`INSERT INTO employee_prompt_versions (user_id, employee_key, version, prompt, note, active, created_by)
      VALUES (${userId}, ${employeeKey}, ${previousVersion}, ${emp.persona ?? ""}, ${"ما كان يعمل به قبل التفعيل"}, false, ${"system.activate"})`);
    // ملف الموظف مصدر الحقيقة: النسخة التي يحملها المقترح (أو بذرة المكتبة الحالية) تُجمَّع
    // للتشغيل؛ ولا ملف = نص المكتبة كما كان.
    const dossierVersion = approved?.new_value?.dossierVersion == null ? null : Number(approved.new_value.dossierVersion);
    const dossier = await activateDossier(tx, userId, employeeKey, dossierVersion, o.actor ?? null).catch((e) => {
      throw e instanceof DossierRefused ? new ProposalRefused(e.message, e.status) : e;
    });
    const rendered = dossier?.rendered ?? await renderFor(tx, userId, entry);
    const version = previousVersion + 1;
    await tx.execute(sql`UPDATE employee_prompt_versions SET active = false WHERE user_id = ${userId} AND employee_key = ${employeeKey} AND active`);
    await tx.execute(sql`INSERT INTO employee_prompt_versions (user_id, employee_key, version, prompt, note, active, created_by)
      VALUES (${userId}, ${employeeKey}, ${version}, ${rendered}, ${dossier ? `الملف v${dossier.version} (المكتبة v${entry.version})` : `المكتبة v${entry.version}`}, true, ${o.actor ? `user:${o.actor}` : "system.activate"})`);
    await tx.execute(sql`UPDATE bot_employees SET persona = ${rendered}, prompt_version = ${version}, updated_at = now() WHERE id = ${emp.id}`);
    const oldValue = { persona: emp.persona ?? null, promptVersion: emp.prompt_version == null ? null : Number(emp.prompt_version), version: previousVersion };
    const newValue = { libraryVersion: entry.version, version, ...(dossier ? { dossierVersion: dossier.version } : {}) };
    let changeId: number;
    if (approved) {
      await tx.execute(sql`UPDATE improvement_proposals SET status = 'applied', applied_at = now(), old_value = ${JSON.stringify(oldValue)}::jsonb, new_value = ${JSON.stringify(newValue)}::jsonb, rollback_version = ${previousVersion} WHERE change_id = ${approved.change_id}`);
      changeId = Number(approved.change_id);
    } else {
      const [row] = (await tx.execute<any>(sql`INSERT INTO improvement_proposals (user_id, requested_by, target, reason, old_value, new_value, category, risk, status, applied_at, rollback_version)
        VALUES (${userId}, ${o.actor ? `user:${o.actor}` : "system.low_risk"}, ${target}, ${"تفعيل نسخة المكتبة: تحليل داخلي منخفض الخطر"}, ${JSON.stringify(oldValue)}::jsonb, ${JSON.stringify(newValue)}::jsonb, ${cls.category}, ${cls.risk}, 'applied', now(), ${previousVersion}) RETURNING change_id`)).rows;
      changeId = Number(row.change_id);
    }
    if (dossier) await linkDossierProposal(tx, userId, employeeKey, dossier.version, changeId);
    return { employeeKey, version, previousVersion, changeId };
  });
  await audit({ userId, action: "prompt.activated", kind: cls.category, actor: o.actor ?? null, meta: res });
  return res;
}

/** نص الحساب من المكتبة: كتلة الحساب تُختار باسمه ونشاطه كما هما في ملفه. */
async function renderFor(tx: any, userId: number, entry: (typeof PROMPT_LIBRARY)[string]): Promise<string> {
  const [acc] = (await tx.execute(sql`SELECT p.name, p.vertical, u.display_name FROM users u LEFT JOIN business_profile p ON p.user_id = u.id WHERE u.id = ${userId}`)).rows as any[];
  const rendered = renderPrompt(entry, { name: acc?.name ?? acc?.display_name ?? "", vertical: acc?.vertical ?? null });
  if (!rendered?.trim()) throw new ProposalRefused("المكتبة أعادت نصاً فارغاً", 500);
  return rendered;
}

/** يعيد ما كان قبل المقترح. ما عدّله صاحب العمل بعد التفعيل يُحفظ نسخةً قبل الإرجاع. */
export async function rollbackProposal(userId: number, id: number, actor: number | null): Promise<Proposal> {
  const p = await getProposal(userId, id);
  if (!p) throw new ProposalRefused("المقترح ليس لهذا الحساب", 404);
  if (p.status !== "applied") throw new ProposalRefused("لا يُعاد إلا ما طُبّق");
  const key = keyOfTarget(p.target);
  if (!key || p.rollback_version == null) throw new ProposalRefused("لا نسخة سابقة لهذا المقترح");
  await db.transaction(async (tx) => {
    const [emp] = (await tx.execute<any>(sql`SELECT id, persona FROM bot_employees WHERE user_id = ${userId} AND employee_key = ${key} FOR UPDATE`)).rows;
    if (!emp) throw new ProposalRefused("الموظف ليس في هذا الحساب", 404);
    const [cur] = (await tx.execute<any>(sql`SELECT prompt FROM employee_prompt_versions WHERE user_id = ${userId} AND employee_key = ${key} AND active ORDER BY version DESC LIMIT 1`)).rows;
    if ((emp.persona ?? "") !== (cur?.prompt ?? "")) {
      await tx.execute(sql`INSERT INTO employee_prompt_versions (user_id, employee_key, version, prompt, note, active, created_by)
        VALUES (${userId}, ${key}, ${await nextVersion(tx, userId, key)}, ${emp.persona ?? ""}, ${"عدّله صاحب العمل بعد التفعيل، حُفظ قبل الإرجاع"}, false, ${"system.rollback"})`);
    }
    await tx.execute(sql`UPDATE employee_prompt_versions SET active = (version = ${p.rollback_version}) WHERE user_id = ${userId} AND employee_key = ${key}`);
    await tx.execute(sql`UPDATE bot_employees SET persona = ${p.old_value?.persona ?? null}, prompt_version = ${p.old_value?.promptVersion ?? null}, updated_at = now() WHERE id = ${emp.id}`);
    await tx.execute(sql`UPDATE improvement_proposals SET status = 'rolled_back', rolled_back_at = now() WHERE change_id = ${id} AND user_id = ${userId}`);
    await rollbackDossier(tx, userId, key, id);
  });
  await audit({ userId, action: "prompt.rolled_back", kind: p.category, actor, meta: { changeId: id, employeeKey: key, restoredVersion: p.rollback_version } });
  return (await getProposal(userId, id))!;
}

// ── القرار ────────────────────────────────────────────────────────
/** موافقة صاحب الحساب. هدف التعليمات يُفعَّل معها؛ وما لا تطبيق له هنا يبقى approved لينفّذه صاحبه. */
export async function approveProposal(userId: number, id: number, actor: number): Promise<{ proposal: Proposal; applied: boolean }> {
  const [r] = (await db.execute<any>(sql`UPDATE improvement_proposals SET status = 'approved', approved_by = ${actor} WHERE change_id = ${id} AND user_id = ${userId} AND status = 'proposed' RETURNING *`)).rows;
  if (!r) throw new ProposalRefused("المقترح ليس لهذا الحساب أو حالته لا تسمح");
  await audit({ userId, action: "proposal.approved", kind: r.category, actor, meta: { changeId: id, target: r.target } });
  const key = keyOfTarget(r.target);
  if (!key) return { proposal: toProposal(r), applied: false };
  await activatePrompt(userId, key, { actor, changeId: id });
  return { proposal: (await getProposal(userId, id))!, applied: true };
}

export async function rejectProposal(userId: number, id: number, actor: number, why?: string | null): Promise<Proposal> {
  const [r] = (await db.execute<any>(sql`UPDATE improvement_proposals SET status = 'rejected', approved_by = ${actor}, decision_note = ${why?.slice(0, 1000) ?? null} WHERE change_id = ${id} AND user_id = ${userId} AND status IN ('proposed','approved') RETURNING *`)).rows;
  if (!r) throw new ProposalRefused("المقترح ليس لهذا الحساب أو حالته لا تسمح");
  await audit({ userId, action: "proposal.rejected", kind: r.category, actor, why: why ?? null, meta: { changeId: id, target: r.target } });
  return toProposal(r);
}

// ── البذر ─────────────────────────────────────────────────────────
const REQUESTED_BY_SEED = "system.seed";

/** مقترحٌ معلَّق لكل موظفٍ له نسخة في المكتبة، مرةً لكل نسخة. لا يفعّل شيئاً. */
export async function seedPromptProposals(userId: number): Promise<number> {
  await ensureOrgTables();
  await backfillRegistry(userId);
  const staff = (await db.execute<{ employee_key: string; persona: string | null; prompt_version: number | null }>(sql`SELECT employee_key, persona, prompt_version FROM bot_employees WHERE user_id = ${userId} AND employee_key IS NOT NULL`)).rows;
  let made = 0;
  for (const e of staff) {
    const entry = PROMPT_LIBRARY[e.employee_key];
    if (!entry) continue;
    const cls = classifyPrompt(entry);
    const r = await db.execute(sql`INSERT INTO improvement_proposals (user_id, requested_by, target, reason, old_value, new_value, impact, category, risk)
      VALUES (${userId}, ${REQUESTED_BY_SEED}, ${promptTarget(e.employee_key)}, ${"تعليمات المكتبة الجديدة لهذا الموظف"}, ${JSON.stringify({ persona: e.persona, promptVersion: e.prompt_version })}::jsonb,
        ${JSON.stringify({ libraryVersion: String(entry.version) })}::jsonb, ${entry.externalBehavior ? "يغيّر ما يكتبه الموظف أو من يراسله" : "تحليل داخلي: لا أثر مباشر خارج النظام"}, ${cls.category}, ${cls.risk})
      ON CONFLICT (user_id, target, (new_value->>'libraryVersion')) WHERE requested_by = 'system.seed' DO NOTHING RETURNING change_id`);
    made += r.rows.length;
  }
  return made;
}

export async function seedAllPromptProposals(): Promise<number> {
  await ensureOrgTables();
  const users = (await db.execute<{ user_id: number }>(sql`SELECT DISTINCT user_id FROM bot_employees`)).rows;
  let n = 0;
  for (const u of users) n += await seedPromptProposals(Number(u.user_id)).catch((err) => { logger.warn({ userId: u.user_id, err: String(err?.message ?? err).slice(0, 200) }, "بذر المقترحات تعذّر"); return 0; });
  return n;
}
